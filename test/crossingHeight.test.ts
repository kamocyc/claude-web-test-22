import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { Alignment } from '../src/core/alignment';
import { HorizontalCurve } from '../src/core/curve';
import { VerticalProfile } from '../src/core/profile';
import { anchorFromNode, computePlacement, placeSegment, solveChainProfile } from '../src/network/editing';
import { planCrossingHeights } from '../src/network/crossingHeight';
import { getClass } from '../src/network/classes';
import { Network, type NetNode } from '../src/network/network';
import { BuildTool } from '../src/app/buildTool';
import { solveJunctions } from '../src/network/junction';
import { WorldBuilder } from '../src/render/worldBuilder';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { Heightfield } from '../src/terrain/heightfield';
import { MeshBasicMaterial } from 'three';
import { testField } from './support/field';

/**
 * 高さの決まった節点を通る縦断。
 *
 * 交点の高さに合わせるときは、節点の高さが先に決まっている。区間ごとに
 * 端点勾配を解くと交点で縦断が折れ、そこは枝が 4 本あるので後から均せない。
 * ここでは「節点で折れない」「高さをぴったり通る」「収まらないなら収まらないと
 * 言う」の 3 つを確かめる。
 */

const RAIL = getClass('rail_single');
const STANDARD = { maxGrade: RAIL.maxGrade, minVerticalRadius: RAIL.minVerticalRadius };

/** 解いた勾配から区間の縦断を組み立てる。 */
function profiles(
  heights: number[],
  lengths: number[],
  grades: number[],
): VerticalProfile[] {
  return lengths.map(
    (L, i) => new VerticalProfile(heights[i], heights[i + 1], grades[i], grades[i + 1], L),
  );
}

describe('高さの決まった節点を通る縦断', () => {
  it('節点の勾配は 1 つだけなので、そこで縦断が折れない', () => {
    const heights = [0, 1.2, 0.4];
    const lengths = [120, 90];
    const solved = solveChainProfile(heights, lengths, { start: 0, end: null }, STANDARD);
    const [first, second] = profiles(heights, lengths, solved.grades);
    // 前の区間の終点勾配と、次の区間の始点勾配が一致する。
    expect(first.gradeAt(first.length)).toBeCloseTo(second.gradeAt(0), 12);
  });

  it('節点の高さをぴったり通る', () => {
    const heights = [3, 5.5, 2];
    const lengths = [140, 160];
    const solved = solveChainProfile(heights, lengths, { start: 0.01, end: null }, STANDARD);
    const [first, second] = profiles(heights, lengths, solved.grades);
    expect(first.yAt(first.length)).toBeCloseTo(5.5, 9);
    expect(second.yAt(0)).toBeCloseTo(5.5, 9);
    expect(solved.feasible).toBe(true);
  });

  it('規格に収まる配置では、どの区間も最大勾配を割らない', () => {
    const heights = [0, 1.5, 0];
    const lengths = [200, 200];
    const solved = solveChainProfile(heights, lengths, { start: 0, end: 0 }, STANDARD);
    expect(solved.feasible).toBe(true);
    for (const p of profiles(heights, lengths, solved.grades)) {
      expect(p.maxGrade(32)).toBeLessThanOrEqual(RAIL.maxGrade + 1e-9);
      expect(p.minVerticalRadius()).toBeGreaterThanOrEqual(RAIL.minVerticalRadius - 1e-6);
    }
  });

  it('短い区間で大きな高低差を吸収しようとすると feasible: false', () => {
    // 1.8 m を 20 m で。線路の規格 5% では 1 m しか上がれない。
    const solved = solveChainProfile([0, 1.8, 1.8], [20, 60], { start: 0, end: 0 }, STANDARD);
    expect(solved.feasible).toBe(false);
  });

  it('区間が 1 本だけなら、両端の勾配をそのまま返す', () => {
    const solved = solveChainProfile([0, 2], [100], { start: 0.01, end: 0.03 }, STANDARD);
    expect(solved.grades).toEqual([0.01, 0.03]);
  });

  it('節点の勾配は、短い区間の平均勾配に近づく (相手の長さで重み付け)', () => {
    // 短い区間 (30 m) が 2%、長い区間 (300 m) が 0%。重み付けが無ければ 1%。
    const heights = [0, 0.6, 0.6];
    const lengths = [30, 300];
    const solved = solveChainProfile(heights, lengths, { start: 0.02, end: 0 }, STANDARD);
    // 相手の長さで重み付けするので、短い区間の 2% がほぼそのまま残る。
    expect(solved.grades[1]).toBeGreaterThan(0.015);
  });
});

/**
 * 交点の高さ合わせの立案。
 *
 * ネットワークを変えずに「どこで分けて、縦断をどう変えるか」だけを出す所。
 * プレビューも確定もこの立案を元にするので、ここが両者の食い違いを防ぐ。
 */

const ROAD = getClass('road_medium');

/** 敷設ツールと同じ手順で、点を順に繋いだ線形を敷く。 */
function chain(network: Network, classId: string, points: Vector3[]): void {
  const cls = getClass(classId);
  let anchor = { pos: points[0].clone() } as ReturnType<typeof anchorFromNode>;
  for (let i = 1; i < points.length; i++) {
    const preview = computePlacement(anchor, points[i], { straight: true, cls });
    const result = placeSegment(network, classId, anchor, { pos: points[i] }, preview);
    anchor = anchorFromNode(network, network.getNode(result.endNode), cls);
  }
}

/** 立案にかける「いま引いている線形」(まっすぐ・一定勾配)。 */
function straight(from: Vector3, to: Vector3): Alignment {
  const horizontal = HorizontalCurve.straight(
    new Vector2(from.x, from.z),
    new Vector2(to.x, to.z),
  );
  return new Alignment(horizontal, VerticalProfile.linear(from.y, to.y, horizontal.length));
}

/** 東西にまっすぐな既設の線形を 1 本持つネットワーク。 */
function withExisting(classId: string, y = 0): Network {
  const network = new Network();
  chain(network, classId, [new Vector3(-250, y, 0), new Vector3(250, y, 0)]);
  return network;
}

const ENDS = { startGrade: 0, endGrade: null };

describe('交点の高さ合わせの立案', () => {
  it('交差しなければ null (従来どおり 1 本で敷く)', () => {
    const network = withExisting('rail_single');
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, 60), new Vector3(0, 0, 260)),
      ENDS,
    );
    expect(plan).toBeNull();
  });

  it('高低差が 3 m あれば合わせにいかない (立体交差にする人の邪魔をしない)', () => {
    const network = withExisting('rail_single');
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 3, -200), new Vector3(0, 3, 200)),
      ENDS,
    );
    expect(plan).toBeNull();
  });

  it('高低差 1 m の交差では区間が 2 本に分かれ、境目が既設の高さになる', () => {
    const network = withExisting('rail_single', 1);
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, -200), new Vector3(0, 0, 200)),
      ENDS,
    );
    expect(plan).not.toBeNull();
    expect(plan!.legs).toHaveLength(2);
    const [first, second] = plan!.legs;
    // 境目は既設の線路の高さ (1 m) ちょうど。
    expect(first.alignment.sampleAt(first.alignment.length).pos.y).toBeCloseTo(1, 6);
    expect(second.alignment.sampleAt(0).pos.y).toBeCloseTo(1, 6);
    // 両端は指したままの高さ。
    expect(first.alignment.sampleAt(0).pos.y).toBeCloseTo(0, 6);
    expect(second.alignment.sampleAt(second.alignment.length).pos.y).toBeCloseTo(0, 6);
    expect(plan!.blockers).toEqual([]);
  });

  it('分けた区間の継ぎ目で縦断が折れない', () => {
    const network = withExisting('rail_single', 1);
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, -200), new Vector3(0, 0, 200)),
      ENDS,
    )!;
    const [first, second] = plan.legs;
    expect(first.alignment.vertical.gradeAt(first.alignment.length)).toBeCloseTo(
      second.alignment.vertical.gradeAt(0),
      12,
    );
  });

  it('どの区間も規格の最大勾配に収まる', () => {
    const network = withExisting('rail_single', 1.8);
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, -200), new Vector3(0, 0, 200)),
      ENDS,
    )!;
    expect(plan.blockers).toEqual([]);
    for (const leg of plan.legs) {
      expect(leg.alignment.vertical.maxGrade(32)).toBeLessThanOrEqual(RAIL.maxGrade + 1e-9);
    }
  });

  it('短い区間で合わせられないときは、分けずに理由を出す', () => {
    // 1.8 m の高低差を 25 m で吸収しようとする。線路の規格は 5%。
    const network = withExisting('rail_single', 1.8);
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, -25), new Vector3(0, 0, 25)),
      ENDS,
    )!;
    expect(plan.legs).toHaveLength(1);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0].message).toContain('最大勾配');
  });

  it('立案はネットワークを変更しない', () => {
    const network = withExisting('rail_single', 1);
    const before = network.version;
    planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, -200), new Vector3(0, 0, 200)),
      ENDS,
    );
    expect(network.version).toBe(before);
    expect(network.segments.size).toBe(1);
  });

  it('端から 2 m 以内の交差は合わせにいかない', () => {
    const network = withExisting('rail_single', 1);
    // 交点が引いている線形の始点のすぐ先に来る。
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, -1), new Vector3(0, 0, 200)),
      ENDS,
    );
    expect(plan).toBeNull();
  });

  it('駅構内の線路は合わせにいかない', () => {
    const network = withExisting('rail_single', 1);
    const [segment] = [...network.segments.values()];
    segment.stationTrack = { station: 1 as never, index: 0 };
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, -200), new Vector3(0, 0, 200)),
      ENDS,
    );
    expect(plan).toBeNull();
  });

  it('交差角が浅すぎる交差は合わせにいかない (従来の規則に任せる)', () => {
    const network = withExisting('road_medium', 1);
    // 道路どうしは 20 度が下限。10 度で交わらせる。
    const dz = Math.tan((10 * Math.PI) / 180) * 200;
    const plan = planCrossingHeights(
      network,
      ROAD,
      straight(new Vector3(-200, 0, -dz), new Vector3(200, 0, dz)),
      ENDS,
    );
    expect(plan).toBeNull();
  });

  it('道路を線路の上に引くと、引いている道路が合わせる', () => {
    const network = withExisting('rail_single', 1);
    const plan = planCrossingHeights(
      network,
      ROAD,
      straight(new Vector3(0, 0, -200), new Vector3(0, 0, 200)),
      ENDS,
    )!;
    expect(plan.legs).toHaveLength(2);
    expect(plan.roadEdits).toEqual([]);
    expect(plan.legs[0].alignment.sampleAt(plan.legs[0].alignment.length).pos.y).toBeCloseTo(1, 6);
  });

  it('線路を道路の上に引くと、線路は動かず既設の道路が変わる', () => {
    const network = withExisting('road_medium', 1);
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, -200), new Vector3(0, 0, 200)),
      ENDS,
    )!;
    // 線路は分かれない。
    expect(plan.legs).toHaveLength(1);
    expect(plan.legs[0].alignment.sampleAt(200).pos.y).toBeCloseTo(0, 6);
    // 道路側の変更が 1 つ出て、合わせる高さはレールの高さ。
    expect(plan.roadEdits).toHaveLength(1);
    expect(plan.roadEdits[0].y).toBeCloseTo(0, 6);
    expect(plan.blockers).toEqual([]);
  });

  it('道路の勾配制限を超えるなら、変更せずに理由を出す', () => {
    // 短い道路の真ん中を、2 m 低い線路が横切る。
    const network = new Network();
    chain(network, 'road_medium', [new Vector3(-15, 1.9, 0), new Vector3(15, 1.9, 0)]);
    const plan = planCrossingHeights(
      network,
      RAIL,
      straight(new Vector3(0, 0, -200), new Vector3(0, 0, 200)),
      ENDS,
    )!;
    expect(plan.roadEdits).toEqual([]);
    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0].message).toContain('最大勾配');
  });
});

/**
 * 敷設ツールを通した交点の高さ合わせ。
 *
 * 立案どおりに敷けているか、交点のノードが既存の高さのまま残るか、
 * プレビューと置いた形が食い違わないかを、実際にクリックして確かめる。
 */

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

/**
 * 東西にまっすぐな既設の線形を 1 本敷いて、南北に引く用意までする。
 * 既設は地表から `y` [m] の高さに置く (高さ設定を使うので地形は平ら)。
 */
function scene(
  existingClass: string,
  drawClass: string,
  y: number,
): { tool: BuildTool; network: Network; field: Heightfield } {
  const network = new Network();
  const field = flatField();
  const tool = new BuildTool(network, field, () => {});
  tool.setClass(existingClass);
  tool.adjustElevation(y / 3);
  clickAt(tool, -250, 0);
  clickAt(tool, 250, 0);
  tool.cancel();
  tool.adjustElevation(-y / 3);
  tool.setClass(drawClass);
  return { tool, network, field };
}

/** 引いている線形と既存の線形が交わるノード (枝が 3 本以上ある所)。 */
function crossingNodes(network: Network): NetNode[] {
  return [...network.nodes.values()].filter((n) => n.segments.length >= 4);
}

describe('線路どうしの交差で高さを合わせる', () => {
  it('あとから引いた線路が、先にある線路の高さで交わる', () => {
    const { tool, network } = scene('rail_single', 'rail_single', 1.5);
    clickAt(tool, 0, -220);
    clickAt(tool, 0, 220);
    tool.cancel();

    const nodes = crossingNodes(network);
    expect(nodes).toHaveLength(1);
    // 交点の高さは既設の線路のまま。引いた側が合わせている。
    expect(nodes[0].pos.y).toBeCloseTo(1.5, 6);
    // 既設 2 本 + 引いた 2 本。
    expect(network.segments.size).toBe(4);
  });

  it('4 枝のノードになり、クロッシングとして解ける', () => {
    const { tool, network } = scene('rail_single', 'rail_single', 1.5);
    clickAt(tool, 0, -220);
    clickAt(tool, 0, 220);
    tool.cancel();
    const junctions = [...solveJunctions(network).junctions.values()];
    expect(junctions.filter((j) => j.kind === 'railCrossing')).toHaveLength(1);
    expect(junctions.flatMap((j) => j.warnings)).toEqual([]);
  });

  it('交点で縦断が折れない', () => {
    const { tool, network } = scene('rail_single', 'rail_single', 1.5);
    clickAt(tool, 0, -220);
    clickAt(tool, 0, 220);
    tool.cancel();
    const node = crossingNodes(network)[0];
    // 引いた線路の 2 本 (南北) の、外向き勾配は打ち消し合う。
    const drawn = network
      .branchesAt(node.id)
      .filter((b) => Math.abs(b.dir.y) > Math.abs(b.dir.x));
    expect(drawn).toHaveLength(2);
    expect(Math.abs(drawn[0].grade + drawn[1].grade)).toBeLessThan(5e-4);
  });

  it('組み立てても交差の警告が出ない', () => {
    const { tool, network, field } = scene('rail_single', 'rail_single', 1.5);
    clickAt(tool, 0, -220);
    clickAt(tool, 0, 220);
    tool.cancel();
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = world.rebuild();
    expect(result.warnings.map((w) => w.message)).toEqual([]);
  });

  it('高低差が 3 m あれば合わせず、従来どおり立体交差になる', () => {
    const { tool } = scene('rail_single', 'rail_single', 3);
    clickAt(tool, 0, -220);
    tool.update(new Vector3(0, 0, 220), MODS);
    // 桁下が足りないので置けない (今までと同じ)。
    expect(tool.status().blockers.join(' ')).toContain('桁下');
  });

  it('合わせると勾配制限を超える所では、理由を出して置かせない', () => {
    const { tool, network } = scene('rail_single', 'rail_single', 1.8);
    // 交点まで 20 m しかない短い線路。1.8 m を吸収できない。
    clickAt(tool, 0, -20);
    tool.update(new Vector3(0, 0, 20), MODS);
    expect(tool.status().blockers.join(' ')).toContain('最大勾配');
    const before = network.segments.size;
    tool.click();
    expect(network.segments.size).toBe(before);
  });

  it('同じ線路を 2 回横切っても、交点が 2 つできる', () => {
    const { tool, network } = scene('rail_single', 'rail_single', 1.5);
    // 東西の線路を南から北へ跨いで、また南へ戻る (V 字)。
    clickAt(tool, -160, -160);
    clickAt(tool, 0, 160);
    clickAt(tool, 160, -160);
    tool.cancel();
    expect(crossingNodes(network)).toHaveLength(2);
    for (const node of crossingNodes(network)) {
      expect(node.pos.y).toBeCloseTo(1.5, 6);
    }
  });

  it('プレビューの勾配が、置いた後の勾配と一致する', () => {
    const { tool, network } = scene('rail_single', 'rail_single', 1.5);
    clickAt(tool, 0, -220);
    tool.update(new Vector3(0, 0, 220), MODS);
    const previewGrade = tool.status().grade;
    expect(previewGrade).toBeGreaterThan(0);
    tool.click();
    tool.cancel();
    const drawn = [...network.segments.values()].filter((s) => {
      const a = network.getNode(s.a).pos;
      const b = network.getNode(s.b).pos;
      return Math.abs(b.z - a.z) > Math.abs(b.x - a.x);
    });
    const built = Math.max(...drawn.map((s) => network.alignmentOf(s.id).vertical.maxGrade(32)));
    expect(built).toBeCloseTo(previewGrade, 6);
  });
});

describe('線路と道路の交差で高さを合わせる', () => {
  it('道路を線路の上に引くと、道路の方が合わせて踏切になる', () => {
    const { tool, network, field } = scene('rail_single', 'road_medium', 1.5);
    clickAt(tool, 0, -220);
    clickAt(tool, 0, 220);
    tool.cancel();
    // 線路は 1 本のまま (分かれない)。道路は交点で 2 本に分かれる。
    expect(network.segments.size).toBe(3);
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = world.rebuild();
    expect(result.stats.levelCrossings).toBe(1);
  });

  it('線路を道路の上に引くと、線路は動かず既設の道路が曲がる', () => {
    const { tool, network, field } = scene('road_medium', 'rail_single', 1.5);
    clickAt(tool, 0, -220);
    clickAt(tool, 0, 220);
    tool.cancel();

    // 線路は分かれず、高さも指したまま (地表 0 m)。
    const rails = [...network.segments.values()].filter(
      (s) => network.classOf(s).kind === 'rail',
    );
    expect(rails).toHaveLength(1);
    expect(network.alignmentOf(rails[0].id).sampleAt(220).pos.y).toBeCloseTo(0, 6);

    // 道路は交点で分かれ、そのノードがレールの高さまで下りている。
    const joints = [...network.nodes.values()].filter(
      (n) => n.segments.length === 2 && Math.abs(n.pos.x) < 1 && Math.abs(n.pos.z) < 1,
    );
    expect(joints).toHaveLength(1);
    expect(joints[0].pos.y).toBeCloseTo(0, 2);

    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    expect(world.rebuild().stats.levelCrossings).toBe(1);
  });

  it('既設の道路の両端の高さと勾配は変わらない', () => {
    const { tool, network } = scene('road_medium', 'rail_single', 1.5);
    const [road] = [...network.segments.values()];
    const before = { gradeA: road.gradeA, gradeB: road.gradeB, y: network.getNode(road.a).pos.y };
    clickAt(tool, 0, -220);
    clickAt(tool, 0, 220);
    tool.cancel();

    const roads = [...network.segments.values()].filter(
      (s) => network.classOf(s).kind === 'road',
    );
    expect(roads).toHaveLength(2);
    // 端のノードは動いていない。
    const ends = roads.map((s) =>
      Math.abs(network.getNode(s.a).pos.x) > 100 ? network.getNode(s.a) : network.getNode(s.b),
    );
    for (const end of ends) expect(end.pos.y).toBeCloseTo(before.y, 6);
    // 外向きの端点勾配もそのまま。
    const outer = roads.map((s) =>
      Math.abs(network.getNode(s.a).pos.x) > 100 ? s.gradeA : s.gradeB,
    );
    for (const grade of outer) {
      expect(Math.abs(grade)).toBeCloseTo(Math.abs(before.gradeA), 6);
    }
  });
});
