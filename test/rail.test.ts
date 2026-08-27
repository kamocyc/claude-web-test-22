import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { SLEEPER_COLOR, SLEEPER_PITCH } from '../src/build/rail';
import { SURFACE_LIFT } from '../src/core/units';
import { getClass } from '../src/network/classes';
import { anchorFromNode, computePlacement, placeSegment, type Anchor } from '../src/network/editing';
import { Network } from '../src/network/network';
import type { Junction } from '../src/network/junction';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { testField } from './support/field';

/** 建設ツールと同じ手順で線形を引く (経由点は絶対座標)。 */
function draw(
  network: Network,
  classId: string,
  points: Vector3[],
  options: { straight?: boolean } = {},
): void {
  const cls = getClass(classId);
  const straight = options.straight ?? true;
  const existing = network.findNodeNear(points[0], 3);
  let anchor: Anchor = existing
    ? anchorFromNode(network, existing, cls)
    : { pos: points[0].clone() };
  for (let i = 1; i < points.length; i++) {
    const preview = computePlacement(anchor, points[i], { straight, cls });
    const result = placeSegment(network, classId, anchor, { pos: points[i].clone() }, preview);
    const endNode = network.nodes.get(result.endNode);
    if (!endNode) break;
    anchor = {
      pos: endNode.pos.clone(),
      node: endNode.id,
      tangent: preview.endTangent.clone(),
      grade: preview.endGrade,
    };
  }
}

function makeWorld(build: (network: Network, field: Heightfield) => void) {
  const field = testField();
  generateTerrain(field, DEFAULT_TERRAIN);
  const network = new Network();
  build(network, field);
  const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
  const result = world.rebuild();
  const meshes = new Map<string, Mesh>();
  for (const child of world.group.children) {
    if ((child as Mesh).isMesh) meshes.set(child.name, child as Mesh);
  }
  return { field, network, world, result, meshes };
}

/** その XZ を覆う面のうち、いちばん高いものの高さ。無ければ null。 */
function surfaceTopAt(mesh: Mesh, x: number, z: number): number | null {
  const position = mesh.geometry.attributes.position;
  const index = mesh.geometry.getIndex();
  if (!index) return null;
  let top: number | null = null;
  const ax = new Vector3();
  const bx = new Vector3();
  const cx = new Vector3();
  for (let i = 0; i < index.count; i += 3) {
    ax.fromBufferAttribute(position, index.getX(i));
    bx.fromBufferAttribute(position, index.getX(i + 1));
    cx.fromBufferAttribute(position, index.getX(i + 2));
    const y = heightInTriangle(ax, bx, cx, x, z);
    if (y !== null && (top === null || y > top)) top = y;
  }
  return top;
}

function heightInTriangle(a: Vector3, b: Vector3, c: Vector3, x: number, z: number): number | null {
  const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(d) < 1e-12) return null;
  const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
  const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
  const w = 1 - u - v;
  if (u < 0 || v < 0 || w < 0) return null;
  return u * a.y + v * b.y + w * c.y;
}

/**
 * 半径 `radius` 以内でいちばん高い頂点。レール頭頂面を測るのに使う。
 * 架線・架線柱を拾わないよう、`ceiling` より上は無視する。
 */
function highestVertexNear(
  mesh: Mesh,
  x: number,
  z: number,
  radius: number,
  ceiling: number,
): { y: number; count: number } {
  const position = mesh.geometry.attributes.position;
  let top = -Infinity;
  let count = 0;
  for (let i = 0; i < position.count; i++) {
    const dx = position.getX(i) - x;
    const dz = position.getZ(i) - z;
    if (dx * dx + dz * dz > radius * radius) continue;
    const y = position.getY(i);
    if (y > ceiling) continue;
    count++;
    if (y > top) top = y;
  }
  return { y: top, count };
}

describe('踏切', () => {
  /**
   * 勾配のある線路を道路が横切る踏切。
   *
   * 線路が優先なので、舗装の方が線路の面に合わせて上下・傾斜する。舗装の
   * どこを取ってもレール頭頂面が上に出ていなければ、列車は走れない。
   */
  for (const [label, skew] of [
    ['直角', 0],
    ['斜め 30°', 30],
    ['斜め 45°', 45],
  ] as const) {
    it(`勾配 3% の線路を ${label} に横切っても、レールが舗装の上に出ている`, () => {
      const grade = 0.03;
      const railY = (x: number): number => 40 + grade * x;
      const angle = (skew * Math.PI) / 180;
      const scene = makeWorld((network) => {
        draw(network, 'rail_single', [
          new Vector3(-200, railY(-200), 0),
          new Vector3(200, railY(200), 0),
        ]);
        // 交点は原点。道路は線路と同じ高さで通す (踏切になる条件)。
        const dir = new Vector3(Math.sin(angle), 0, Math.cos(angle));
        draw(network, 'road_medium', [
          new Vector3(-dir.x * 120, railY(0), -dir.z * 120),
          new Vector3(dir.x * 120, railY(0), dir.z * 120),
        ]);
      });

      const level = scene.result.stats.levelCrossings;
      expect(level).toBe(1);

      const surfaces = scene.meshes.get('surfaces')!;
      const structures = scene.meshes.get('structures')!;
      const cls = getClass('road_medium');

      // 線路に沿って、道路の footprint を跨ぐ範囲を見る。
      let checked = 0;
      const problems: string[] = [];
      // 路端ぴったりは帯の境界なので、少し内側までを対象にする。
      const reach = cls.halfWidth - 0.3;
      for (let t = -reach; t <= reach + 1e-6; t += 0.5) {
        // 斜め踏切では、道路の幅を横切るのに線路の弧長がより必要になる。
        const along = t / Math.max(0.2, Math.cos(angle));
        const pavement = surfaceTopAt(surfaces, along, 0);
        if (pavement === null) continue;
        // レール頭頂面より上にある構造物 (架線・電柱) は見ない。
        const rail = highestVertexNear(structures, along, 0, 1.1, railY(along) + 0.1);
        if (rail.count === 0) continue;
        checked++;
        const proud = rail.y - pavement;
        if (proud < 0.005) {
          problems.push(`x=${along.toFixed(1)} でレールが舗装より ${(-proud).toFixed(3)} m 下`);
        }
        // 逆に出過ぎていると、路面から段差として飛び出してしまう。
        if (proud > 0.3) {
          problems.push(`x=${along.toFixed(1)} でレールが舗装より ${proud.toFixed(3)} m 上`);
        }
      }
      expect(checked).toBeGreaterThan(20);
      expect(problems).toEqual([]);
    });
  }

  it('踏切のまわりでは縁石の段差が消え、レールが歩道の帯に潜らない', () => {
    const scene = makeWorld((network) => {
      draw(network, 'rail_single', [new Vector3(-200, 40, 0), new Vector3(200, 40, 0)]);
      draw(network, 'road_small', [new Vector3(0, 40, -120), new Vector3(0, 40, 120)]);
    });
    expect(scene.result.stats.levelCrossings).toBe(1);

    const surfaces = scene.meshes.get('surfaces')!;
    const cls = getClass('road_small');
    // 踏切の中心の断面: 中心も路端もレール頭頂面のすぐ下に揃っていること。
    const railY = 40 + SURFACE_LIFT;
    for (const offset of [0, cls.carriagewayHalfWidth - 0.2, cls.halfWidth - 0.2]) {
      const y = surfaceTopAt(surfaces, offset, 0);
      expect(y).not.toBeNull();
      expect(y!).toBeLessThan(railY - 0.005);
      expect(y!).toBeGreaterThan(railY - 0.3);
    }

    // 踏切から 30 m 離れれば、縁石の段差 (0.15 m) が戻っている。
    const far = 30;
    const carriageway = surfaceTopAt(surfaces, 0, far)!;
    const sidewalk = surfaceTopAt(surfaces, cls.halfWidth - 0.2, far)!;
    expect(sidewalk - carriageway).toBeGreaterThan(cls.curbHeight * 0.8);
  });
});

describe('線路の分岐', () => {
  /**
   * 本線を引き、その中ほどのノードから分岐させる。
   *
   * 線路の分岐は接線に沿ってしか作れない (`checkPlacement`) ので、
   * 分岐側は接線を引き継いで引く。
   */
  function switchScene() {
    return makeWorld((network) => {
      draw(network, 'rail_single', [
        new Vector3(-260, 40, 0),
        new Vector3(0, 40, 0),
        new Vector3(260, 40, 0),
      ]);
      const node = network.findNodeNear(new Vector3(0, 40, 0), 5);
      if (!node) throw new Error('分岐元のノードが見つかりません');
      draw(network, 'rail_yard', [node.pos.clone(), new Vector3(240, node.pos.y, 70)], {
        straight: false,
      });
    });
  }

  function switchJunctions(scene: ReturnType<typeof switchScene>): Junction[] {
    return [...scene.world.junctions.values()].filter(
      (j) => j.kind === 'railSwitch' && j.approaches.length >= 3,
    );
  }

  /**
   * 線路の交差点には中身が無い。トリムして空いた所を別の面で塗ると、地形に
   * 沿う道床の帯とは別の平らな板が現れ、そこを通る軌道の枕木も帯と揃わない。
   */
  it('交差点の面を作らず、帯をノードまで通す', () => {
    const scene = switchScene();
    const junctions = switchJunctions(scene);
    expect(junctions).toHaveLength(1);
    const junction = junctions[0];
    expect(junction.rings).toEqual([]);
    expect(junction.ring).toEqual([]);
    for (const ap of junction.approaches) {
      expect(ap.trim).toBe(0);
      const range = scene.result.ranges.get(ap.branch.segment)!;
      const length = scene.network.alignmentOf(ap.branch.segment).length;
      // 引っ込めていないので、帯はノードのある端まで届いている。
      if (ap.branch.atStart) expect(range.s0).toBeCloseTo(0, 6);
      else expect(range.s1).toBeCloseTo(length, 6);
    }
  });

  /**
   * 枕木は帯の刻み (`SLEEPER_PITCH`) だけが並べる。交差点の中に別の軌道を
   * 引くと、そこだけ刻みの粗い枕木が二重に置かれる。
   */
  it('分岐の所にも、余分な枕木が置かれない', () => {
    const scene = switchScene();
    const structures = scene.meshes.get('structures')!;
    const color = structures.geometry.attributes.color;
    let sleeperVertices = 0;
    for (let i = 0; i < color.count; i++) {
      const rgb = [color.getX(i), color.getY(i), color.getZ(i)];
      if (rgb.every((v, k) => Math.abs(v - SLEEPER_COLOR[k]) < 1e-6)) sleeperVertices++;
    }
    // 箱 1 つ = 6 面 × 4 頂点。
    const sleepers = sleeperVertices / 24;
    const expected = [...scene.network.segments.values()].reduce((sum, seg) => {
      const range = scene.result.ranges.get(seg.id)!;
      return sum + Math.floor((range.s1 - range.s0) / SLEEPER_PITCH) + 1;
    }, 0);
    expect(sleepers).toBe(expected);
  });

  /**
   * 分岐の所の道床は、帯の道床がそのまま重なったもの。別の面を塗ると、
   * 断面の道床色とわずかに食い違って、そこだけ色が変わって見える。
   */
  it('分岐の所の道床の色が、線路の道床の色と同じ', () => {
    const scene = switchScene();
    const junction = switchJunctions(scene)[0];
    const node = scene.network.getNode(junction.node).pos;
    const surfaces = scene.meshes.get('surfaces')!;
    const position = surfaces.geometry.attributes.position;
    const normal = surfaces.geometry.attributes.normal;
    const color = surfaces.geometry.attributes.color;

    const tones = new Set<string>();
    let counted = 0;
    for (let i = 0; i < position.count; i++) {
      // 道床の天端 (上向きの面) だけを見る。法面は別の色でよい。
      if (normal.getY(i) < 0.9) continue;
      const dx = position.getX(i) - node.x;
      const dz = position.getZ(i) - node.z;
      if (dx * dx + dz * dz > 25 * 25) continue;
      counted++;
      tones.add(
        [color.getX(i), color.getY(i), color.getZ(i)].map((v) => v.toFixed(3)).join(','),
      );
    }
    expect(counted).toBeGreaterThan(10);
    expect([...tones]).toHaveLength(1);
  });
});
