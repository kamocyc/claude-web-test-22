import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector3 } from 'three';
import { BuildTool } from '../src/app/buildTool';
import { solveJunctions } from '../src/network/junction';
import { Network, type NetNode } from '../src/network/network';
import { parallelSpacing } from '../src/network/parallel';
import { getClass } from '../src/network/classes';
import { findCrossings } from '../src/network/crossings';
import { WorldBuilder } from '../src/render/worldBuilder';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { Heightfield } from '../src/terrain/heightfield';
import { testField } from './support/field';

/**
 * 複線を横切る。
 *
 * 複線は平行に並んだ 2 本の線路でしかないので、横切れば交点が 2 つできる。
 * その 2 つは複線の間隔 (`parallelSpacing` = 4.6 m) しか離れていない。交差に
 * 要る余裕をそれより広く求めると、**複線は原理的に横切れなくなる**。
 * ここでは単線×複線・複線×複線を、高さが揃っている場合とずれている場合の
 * 両方で敷いてみる。
 */

const RAIL = getClass('rail_single');
const GAP = parallelSpacing(RAIL);
const MODS = { straight: true, noSnap: false };

function flatField(y = 0): Heightfield {
  const field = testField();
  field.base.fill(y);
  field.resetWork();
  return field;
}

function clickAt(tool: BuildTool, x: number, z: number): void {
  tool.update(new Vector3(x, 0, z), MODS);
  tool.click();
}

/** 東西にまっすぐな線路を 1 本、地表から `y` [m] の高さに敷く。 */
function layEastWest(tool: BuildTool, z: number, y: number): void {
  tool.setClass('rail_single');
  tool.adjustElevation(y / 3);
  clickAt(tool, -250, z);
  clickAt(tool, 250, z);
  tool.cancel();
  tool.adjustElevation(-y / 3);
}

/**
 * 東西の複線を持つネットワーク。
 *
 * 2 本目は**平行スナップ**で敷く (実際の作り方と同じ)。間隔は
 * `parallelSpacing` が決めるので、指す位置はおおよそでよい。
 */
function eastWestDouble(y: number): { tool: BuildTool; network: Network; field: Heightfield } {
  const network = new Network();
  const field = flatField();
  const tool = new BuildTool(network, field, () => {});
  tool.setParallelSnap(false);
  layEastWest(tool, 0, y);
  tool.setParallelSnap(true);
  layEastWest(tool, GAP, y);
  tool.setParallelSnap(false);
  return { tool, network, field };
}

/** 枝が 4 本ある (= 交差になっている) ノード。 */
function crossingNodes(network: Network): NetNode[] {
  return [...network.nodes.values()].filter((n) => n.segments.length >= 4);
}

function railCrossings(network: Network): number {
  return [...solveJunctions(network).junctions.values()].filter((j) => j.kind === 'railCrossing')
    .length;
}

function rebuildWarnings(network: Network, field: Heightfield): string[] {
  const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
  return world.rebuild().warnings.map((w) => w.message);
}

describe('複線を単線で横切る', () => {
  it('高さが揃っていれば横切れる', () => {
    const { tool, network, field } = eastWestDouble(0);
    tool.setClass('rail_single');
    clickAt(tool, 0, -200);
    tool.update(new Vector3(0, 0, 200), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    tool.cancel();

    expect(crossingNodes(network)).toHaveLength(2);
    expect(railCrossings(network)).toBe(2);
    expect(rebuildWarnings(network, field)).toEqual([]);
  });

  it('高さが 1 m ずれていても、合わせて横切れる', () => {
    const { tool, network, field } = eastWestDouble(1);
    tool.setClass('rail_single');
    clickAt(tool, 0, -200);
    tool.update(new Vector3(0, 0, 200), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    tool.cancel();

    const nodes = crossingNodes(network);
    expect(nodes).toHaveLength(2);
    // どちらの交点も既設の線路の高さ。
    for (const node of nodes) expect(node.pos.y).toBeCloseTo(1, 6);
    expect(railCrossings(network)).toBe(2);
    expect(rebuildWarnings(network, field)).toEqual([]);
  });

  it('斜めに横切っても同じ', () => {
    const { tool, network, field } = eastWestDouble(1);
    tool.setClass('rail_single');
    clickAt(tool, -150, -200);
    tool.update(new Vector3(150, 0, 200), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    tool.cancel();
    expect(crossingNodes(network)).toHaveLength(2);
    expect(rebuildWarnings(network, field)).toEqual([]);
  });
});

describe('横切ったあとで隣に 2 本目を敷く', () => {
  it('平行スナップで、既に横切られている線路の隣に敷ける', () => {
    // 東西の単線を、南北の線路が横切っている所を作る。
    const network = new Network();
    const field = flatField();
    const tool = new BuildTool(network, field, () => {});
    tool.setParallelSnap(false);
    layEastWest(tool, 0, 0);
    tool.setClass('rail_single');
    clickAt(tool, 0, -200);
    clickAt(tool, 0, 200);
    tool.cancel();
    expect(crossingNodes(network)).toHaveLength(1);

    // その南北の線路の隣へ、平行スナップで 2 本目を敷く。
    tool.setParallelSnap(true);
    tool.update(new Vector3(GAP, 0, -200), MODS);
    tool.click();
    tool.update(new Vector3(GAP, 0, 200), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    tool.cancel();

    // 2 本目も東西の線路と交差になっている。
    expect(crossingNodes(network)).toHaveLength(2);
    expect(rebuildWarnings(network, field)).toEqual([]);
  });
});

describe('複線を複線で横切る', () => {
  it('4 か所すべてが交差になる', () => {
    const { tool, network, field } = eastWestDouble(0);
    tool.setClass('rail_single');
    tool.setParallelSnap(false);
    clickAt(tool, 0, -200);
    clickAt(tool, 0, 200);
    tool.cancel();

    tool.setParallelSnap(true);
    tool.update(new Vector3(GAP, 0, -200), MODS);
    tool.click();
    tool.update(new Vector3(GAP, 0, 200), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    tool.cancel();

    expect(crossingNodes(network)).toHaveLength(4);
    expect(railCrossings(network)).toBe(4);
    expect(rebuildWarnings(network, field)).toEqual([]);
  });
});

describe('交差点の真横で区間を切らない', () => {
  /** 東西の線路を南北の線路が原点で横切っている所を作る。 */
  function crossed(): { tool: BuildTool; network: Network; field: Heightfield } {
    const network = new Network();
    const field = flatField();
    const tool = new BuildTool(network, field, () => {});
    tool.setParallelSnap(false);
    layEastWest(tool, 0, 0);
    tool.setClass('rail_single');
    clickAt(tool, 0, -200);
    clickAt(tool, 0, 200);
    tool.cancel();
    return { tool, network, field };
  }

  it('平行に敷いた区間の切れ目が、横切っている線路の上に落ちない', () => {
    const { tool, network } = crossed();
    tool.setParallelSnap(true);
    tool.update(new Vector3(-200, 0, GAP), MODS);
    tool.click();
    tool.update(new Vector3(200, 0, GAP), MODS);
    tool.click();
    tool.cancel();

    // 敷いた区間 (z = GAP を東西に走る線形) の端が、南北の線路の道床
    // (半幅 2.2 m) から出ている。
    const laid = [...network.segments.values()].filter(
      (seg) =>
        Math.abs(network.getNode(seg.a).pos.z - GAP) < 1 &&
        Math.abs(network.getNode(seg.b).pos.z - GAP) < 1,
    );
    expect(laid.length).toBeGreaterThan(1);
    for (const seg of laid) {
      for (const node of [network.getNode(seg.a), network.getNode(seg.b)]) {
        // 交差になっているノード (4 枝) は相手の上にあってよい。
        if (node.segments.length >= 4) continue;
        expect(Math.abs(node.pos.x), `端点 x=${node.pos.x}`).toBeGreaterThan(RAIL.halfWidth);
      }
    }
  });

  it('置いたあとに「同一平面で交差しています」が出ない', () => {
    const { tool, network } = crossed();
    tool.setParallelSnap(true);
    tool.update(new Vector3(-200, 0, GAP), MODS);
    tool.click();
    tool.update(new Vector3(200, 0, GAP), MODS);
    tool.click();
    tool.cancel();
    expect(findCrossings(network).filter((c) => c.kind === 'conflict')).toEqual([]);
  });
});
