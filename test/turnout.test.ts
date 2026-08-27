import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector2, Vector3 } from 'three';
import type { AlignmentSample } from '../src/core/alignment';
import { Alignment } from '../src/core/alignment';
import { curveFromTangents } from '../src/core/curve';
import { MeshBuilder } from '../src/core/meshbuilder';
import { VerticalProfile } from '../src/core/profile';
import { RAIL_GAUGE, SURFACE_LIFT } from '../src/core/units';
import {
  TURNOUT_STEP,
  buildTurnouts,
  reverseSamples,
  solveTurnout,
  turnoutRoutes,
  type TurnoutOptions,
} from '../src/build/turnout';
import { getClass } from '../src/network/classes';
import { anchorFromNode, computePlacement, placeSegment, type Anchor } from '../src/network/editing';
import type { Approach, Junction } from '../src/network/junction';
import { Network } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { testField } from './support/field';

const HALF_GAUGE = RAIL_GAUGE / 2;

/** 建設ツールと同じ手順で線形を引く。 */
function draw(network: Network, classId: string, points: Vector3[]): void {
  const cls = getClass(classId);
  const existing = network.findNodeNear(points[0], 3);
  let anchor: Anchor = existing
    ? anchorFromNode(network, existing, cls)
    : { pos: points[0].clone() };
  for (let i = 1; i < points.length; i++) {
    const end = { pos: points[i].clone() };
    const preview = computePlacement(anchor, end, { straight: true, cls });
    const result = placeSegment(network, classId, anchor, end, preview);
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

function makeWorld(build: (network: Network) => void) {
  const field = testField();
  generateTerrain(field, DEFAULT_TERRAIN);
  const network = new Network();
  build(network);
  const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
  world.rebuild();
  return { network, world };
}

/** 本線の途中から浅い角度で側線を分ける。 */
function switchScene(branchDeg = 16) {
  const rad = (branchDeg * Math.PI) / 180;
  return makeWorld((network) => {
    draw(network, 'rail_single', [
      new Vector3(-260, 40, 0),
      new Vector3(0, 40, 0),
      new Vector3(260, 40, 0),
    ]);
    const node = network.findNodeNear(new Vector3(0, 40, 0), 5);
    if (!node) throw new Error('分岐元のノードが見つかりません');
    draw(network, 'rail_yard', [
      node.pos.clone(),
      new Vector3(240, node.pos.y, 240 * Math.tan(rad)),
    ]);
  });
}

function railSwitches(world: WorldBuilder): Junction[] {
  return [...world.junctions.values()].filter(
    (j) => j.kind === 'railSwitch' && j.approaches.length >= 3,
  );
}

/** 枝のセグメントをノードから外向きにたどる (`WorldBuilder` と同じ手順)。 */
function branchPathOf(network: Network): TurnoutOptions['branchPath'] {
  return (approach: Approach, distance: number): AlignmentSample[] => {
    const alignment = network.alignmentOf(approach.branch.segment);
    const atStart = approach.branch.atStart;
    const from = atStart ? approach.trim : alignment.length - approach.trim;
    const to = Math.max(
      0,
      Math.min(alignment.length, atStart ? from + distance : from - distance),
    );
    const s0 = Math.min(from, to);
    const s1 = Math.max(from, to);
    const steps = Math.max(1, Math.ceil((s1 - s0) / TURNOUT_STEP));
    const out: AlignmentSample[] = [];
    for (let i = 0; i <= steps; i++) out.push(alignment.sampleAt(s0 + ((s1 - s0) * i) / steps));
    return atStart ? out : reverseSamples(out);
  };
}

/** トウを先頭にした 2 本の進路 (直進側・分岐側)。 */
function routesOf(junction: Junction, network: Network) {
  const routes = turnoutRoutes(junction, { branchPath: branchPathOf(network) });
  expect(routes).toHaveLength(1);
  return routes[0];
}

/** 中心線から一定の横距にあるレールの通り。 */
function railPath(samples: AlignmentSample[], offset: number): Vector3[] {
  return samples.map(
    (s) =>
      new Vector3(
        s.pos.x + s.right.x * offset,
        s.pos.y + SURFACE_LIFT,
        s.pos.z + s.right.z * offset,
      ),
  );
}

/** 点から折れ線までの水平距離。 */
function distanceToPath(path: Vector3[], p: Vector3): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
    const qx = a.x + dx * t - p.x;
    const qz = a.z + dz * t - p.z;
    best = Math.min(best, Math.hypot(qx, qz));
  }
  return best;
}

/** 直線の進路 (交差点の軌道と同じ仕組みで作る)。 */
function straightRoute(from: Vector3, headingDeg: number, length: number): AlignmentSample[] {
  const rad = (headingDeg * Math.PI) / 180;
  const dir = new Vector2(Math.sin(rad), Math.cos(rad));
  const a = new Vector2(from.x, from.z);
  const b = a.clone().addScaledVector(dir, length);
  const horizontal = curveFromTangents(a, dir, b, dir);
  const vertical = new VerticalProfile(from.y, from.y, 0, 0, horizontal.length);
  return new Alignment(horizontal, vertical).sample(1.2);
}

describe('分岐器の割り出し', () => {
  it('トングレールが軌間の内側を通り、先端はトウに揃う', () => {
    const through = straightRoute(new Vector3(0, 10, 0), 0, 40);
    const diverging = straightRoute(new Vector3(0, 10, 0), 12, 40);
    const turnout = solveTurnout(through, diverging)!;
    expect(turnout).not.toBeNull();

    expect(turnout.blades).toHaveLength(2);
    // 2 本のトングレールは軌道をはさんで反対側にある。
    expect(Math.sign(turnout.blades[0].offset)).toBe(-Math.sign(turnout.blades[1].offset));
    for (const blade of turnout.blades) {
      // 基本レールより内側 (レールに重ねると面がちらつく)。
      expect(Math.abs(blade.offset)).toBeLessThan(HALF_GAUGE);
      expect(Math.abs(blade.offset)).toBeGreaterThan(HALF_GAUGE - 0.15);
      // 先端はトウ。
      expect(blade.path[0].s).toBeCloseTo(0, 6);
      const length = blade.path[blade.path.length - 1].s;
      expect(length).toBeGreaterThanOrEqual(4);
      expect(length).toBeLessThanOrEqual(11);
    }
  });

  it('分岐側がどちらへ離れるかで、トングレールの左右が入れ替わる', () => {
    const through = straightRoute(new Vector3(0, 10, 0), 0, 40);
    const right = solveTurnout(through, straightRoute(new Vector3(0, 10, 0), 12, 40))!;
    const left = solveTurnout(through, straightRoute(new Vector3(0, 10, 0), -12, 40))!;
    expect(right.side).toBe(-left.side);
    expect(right.blades[0].offset).toBeCloseTo(-left.blades[0].offset, 6);
  });

  it('クロッシングは、2 本のレールが実際に交わる所にできる', () => {
    const through = straightRoute(new Vector3(0, 10, 0), 0, 60);
    const diverging = straightRoute(new Vector3(0, 10, 0), 12, 60);
    const turnout = solveTurnout(through, diverging)!;
    const frog = turnout.frog!;
    expect(frog).not.toBeNull();

    // 交点は、両方の「相手に近い側」のレールの上に乗っている。
    expect(distanceToPath(railPath(through, turnout.side * HALF_GAUGE), frog.at)).toBeLessThan(0.02);
    expect(distanceToPath(railPath(diverging, -turnout.side * HALF_GAUGE), frog.at)).toBeLessThan(0.02);

    // 中心線どうしが軌間だけ離れた所 = 交点。12° なら軌間 / sin12°。
    const expected = RAIL_GAUGE / Math.sin((12 * Math.PI) / 180);
    expect(Math.hypot(frog.at.x, frog.at.z)).toBeGreaterThan(expected * 0.9);
    expect(Math.hypot(frog.at.x, frog.at.z)).toBeLessThan(expected * 1.1);

    // ガードレールは向かい合う基本レール (相手から遠い側) の内側に付く。
    expect(frog.guards).toHaveLength(2);
    for (const guard of frog.guards) {
      expect(Math.abs(guard.offset)).toBeLessThan(HALF_GAUGE);
      expect(Math.abs(guard.offset)).toBeGreaterThan(HALF_GAUGE - 0.2);
    }
    expect(Math.sign(frog.guards[0].offset)).toBe(-turnout.side);
    expect(Math.sign(frog.guards[1].offset)).toBe(turnout.side);
  });

  it('分岐角が浅くてレールが交わらない所にはクロッシングを置かない', () => {
    // 30 m しかない進路では、0.5° の分岐は軌間ぶんも開かない。
    const through = straightRoute(new Vector3(0, 10, 0), 0, 30);
    const diverging = straightRoute(new Vector3(0, 10, 0), 0.5, 30);
    expect(solveTurnout(through, diverging)?.frog ?? null).toBeNull();
  });

  it('分かれていない進路・トウを共有しない進路は分岐器にならない', () => {
    const through = straightRoute(new Vector3(0, 10, 0), 0, 40);
    expect(solveTurnout(through, straightRoute(new Vector3(0, 10, 0), 0, 40))).toBeNull();
    expect(solveTurnout(through, straightRoute(new Vector3(50, 10, 0), 12, 40))).toBeNull();
  });
});

describe('分岐器の表示', () => {
  it('線路の分岐に分岐器ができ、部品が描かれたレールの上に乗る', () => {
    const { network, world } = switchScene();
    const junctions = railSwitches(world);
    expect(junctions).toHaveLength(1);

    const { through, diverging } = routesOf(junctions[0], network);
    const turnout = solveTurnout(through, diverging)!;
    expect(turnout).not.toBeNull();
    expect(turnout.frog).not.toBeNull();

    // トングレールは、それぞれの進路の「相手に近い側」のレールの脇を通る。
    const inner = [
      railPath(through, turnout.side * HALF_GAUGE),
      railPath(diverging, -turnout.side * HALF_GAUGE),
    ];
    turnout.blades.forEach((blade, i) => {
      for (const sample of blade.path) {
        const at = new Vector3(
          sample.pos.x + sample.right.x * blade.offset,
          sample.pos.y,
          sample.pos.z + sample.right.z * blade.offset,
        );
        const gap = distanceToPath(inner[i], at);
        expect(gap).toBeGreaterThan(0.02);
        expect(gap).toBeLessThan(0.15);
      }
    });

    // クロッシングは、描かれた 2 本のレールが交わる所。
    expect(distanceToPath(inner[0], turnout.frog!.at)).toBeLessThan(0.05);
    expect(distanceToPath(inner[1], turnout.frog!.at)).toBeLessThan(0.05);
  });

  it('分岐器の造作が交差点のメッシュに入る', () => {
    const { network, world } = switchScene();
    const junction = railSwitches(world)[0];
    const mb = new MeshBuilder();
    buildTurnouts(mb, junction, { branchPath: branchPathOf(network) });
    expect(mb.isEmpty).toBe(false);

    const geometry = mb.build();
    const position = geometry.attributes.position;
    const node = junction.approaches[0].center;
    let top = -Infinity;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      // 造作は分岐器のまわりだけに出る (交差点の外へはみ出さない)。
      expect(Math.hypot(x - node.x, z - node.z)).toBeLessThan(60);
      top = Math.max(top, position.getY(i));
    }
    // いちばん高いのは転てつ器標識。レール面から 1.5 m は超えない。
    const railTop = junction.approaches[0].center.y;
    expect(top).toBeGreaterThan(railTop + 0.4);
    expect(top).toBeLessThan(railTop + 1.5);
  });

  it('接線で分かれる分岐 (交差点のトリムが 0) でも分岐器ができる', () => {
    // 建設ツールで既設の線路から引くと、分岐は本線の接線に沿って始まる。
    // ノードには折れ角がないので交差点の面はできず、分岐器の造作は枝の
    // セグメントそのものの上に載ることになる。
    const { network, world } = makeWorld((net) => {
      draw(net, 'rail_single', [new Vector3(-260, 40, 0), new Vector3(260, 40, 0)]);
      const hit = net.findSegmentNear(new Vector3(0, 40, 0), 10)!;
      const node = net.splitSegment(hit.segment, hit.s);
      const cls = getClass('rail_yard');
      let anchor = anchorFromNode(net, node, cls);
      for (const to of [new Vector3(120, 40, 26), new Vector3(240, 40, 96)]) {
        const end = { pos: to };
        const preview = computePlacement(anchor, end, { straight: false, cls });
        const result = placeSegment(net, 'rail_yard', anchor, end, preview);
        const endNode = net.nodes.get(result.endNode)!;
        anchor = {
          pos: endNode.pos.clone(),
          node: endNode.id,
          tangent: preview.endTangent.clone(),
          grade: preview.endGrade,
        };
      }
    });

    const junctions = railSwitches(world);
    expect(junctions).toHaveLength(1);
    // 接線で分かれているので、交差点はトリムされていない。
    for (const approach of junctions[0].approaches) expect(approach.trim).toBeLessThan(1e-3);

    const { through, diverging } = routesOf(junctions[0], network);
    // 交差点の中が空でも、枝の続きから進路が組み上がっている。
    expect(through[through.length - 1].s).toBeGreaterThan(40);
    const turnout = solveTurnout(through, diverging)!;
    expect(turnout).not.toBeNull();
    expect(turnout.frog).not.toBeNull();

    const inner = [
      railPath(through, turnout.side * HALF_GAUGE),
      railPath(diverging, -turnout.side * HALF_GAUGE),
    ];
    expect(distanceToPath(inner[0], turnout.frog!.at)).toBeLessThan(0.05);
    expect(distanceToPath(inner[1], turnout.frog!.at)).toBeLessThan(0.05);
  });

  it('分岐でない線路の継ぎ目には分岐器を作らない', () => {
    // 45° の折れ点。枝は 2 本しかないので、進路は 1 本きりで分岐器はない。
    const { network, world } = makeWorld((net) => {
      draw(net, 'rail_single', [
        new Vector3(-200, 40, 0),
        new Vector3(0, 40, 0),
        new Vector3(160, 40, 160),
      ]);
    });
    const kinks = [...world.junctions.values()].filter((j) => j.approaches.length === 2);
    expect(kinks.length).toBeGreaterThan(0);
    for (const junction of kinks) {
      const mb = new MeshBuilder();
      buildTurnouts(mb, junction, { branchPath: branchPathOf(network) });
      expect(mb.isEmpty).toBe(true);
    }
  });
});
