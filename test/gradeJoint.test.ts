import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { VerticalProfile } from '../src/core/profile';
import { getClass } from '../src/network/classes';
import {
  anchorFromNode,
  computePlacement,
  placeSegment,
  smoothGradeJoint,
  solveVerticalTangents,
} from '../src/network/editing';
import { findGradeBreaks, gradeBreakMessage } from '../src/network/validation';
import { Network } from '../src/network/network';
import { Heightfield } from '../src/terrain/heightfield';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { buildDemoNetwork } from '../src/app/demo';

/**
 * 継ぎ目での勾配の連続性。
 *
 * 敷設時に接続元の勾配を引き継いでも、区間の平均勾配が規格に近いと
 * 引き継ぎきれずに削られる。削り方が過剰だと、繋いだ所で縦断が折れる。
 * ここでは「削るのは本当に必要なときだけ」「残った折れは両側で分け合う」の
 * 2 つを確かめる。
 */

const RAIL = getClass('rail_single');

/** 敷設ツールと同じ手順で、点を順に繋いだ線路を作る。 */
function chain(classId: string, points: Vector3[]): Network {
  const cls = getClass(classId);
  const network = new Network();
  let anchor = { pos: points[0].clone() } as ReturnType<typeof anchorFromNode>;
  for (let i = 1; i < points.length; i++) {
    const preview = computePlacement(anchor, points[i], { straight: true, cls });
    const result = placeSegment(network, classId, anchor, { pos: points[i] }, preview);
    anchor = anchorFromNode(network, network.getNode(result.endNode), cls);
  }
  return network;
}

/** 2 本だけが繋がっているノードでの、外向き勾配の食い違い。 */
function jointGaps(network: Network): { node: number; gap: number }[] {
  const out: { node: number; gap: number }[] = [];
  for (const node of network.nodes.values()) {
    const branches = network.branchesAt(node.id);
    if (branches.length !== 2) continue;
    if (branches.some((b) => b.cls.kind !== 'rail')) continue;
    out.push({ node: node.id, gap: Math.abs(branches[0].grade + branches[1].grade) });
  }
  return out;
}

describe('端点勾配の決め方', () => {
  it('区間内の値域が許すかぎり、引き継いだ勾配をそのまま繋ぐ', () => {
    // 平均 3.3% の区間へ 1.07% で入る (rail_single は規格 5%)。
    // 3 次エルミートの勾配の値域は [avg - d/3, avg + d] なので、
    // d = -2.2% でも区間内は最大 4.0% にしかならず、規格に収まる。
    const solved = solveVerticalTangents(0.0107, 0.03298, RAIL.maxGrade, 90, RAIL.minVerticalRadius);
    expect(solved.startGrade).toBeCloseTo(0.0107, 6);

    const profile = new VerticalProfile(0, 0.03298 * 90, solved.startGrade, solved.endGrade, 90);
    expect(profile.maxGrade(64)).toBeLessThanOrEqual(RAIL.maxGrade + 1e-9);
  });

  it('繋げないところは規格を使い切るまで寄せて止める', () => {
    // 平均 -4.5% の 55 m 区間へ -2.5% で入る。ここは本当に繋げない。
    const solved = solveVerticalTangents(-0.025, -0.045, RAIL.maxGrade, 55, RAIL.minVerticalRadius);
    const profile = new VerticalProfile(0, -0.045 * 55, solved.startGrade, solved.endGrade, 55);
    // 規格は割らない。
    expect(profile.maxGrade(64)).toBeLessThanOrEqual(RAIL.maxGrade + 1e-9);
    // それでいて、使える余地は使い切っている。
    expect(profile.maxGrade(64)).toBeGreaterThan(RAIL.maxGrade - 1e-3);
    // 引き継ぐ側へ寄っている (平均勾配のままではない)。
    expect(solved.startGrade).toBeGreaterThan(-0.045 + 1e-3);
  });

  it('平均勾配が規格を超えていても、始点勾配だけは規格に収める', () => {
    const solved = solveVerticalTangents(0.3, 0.08, RAIL.maxGrade, 300, Infinity);
    expect(Math.abs(solved.startGrade)).toBeLessThanOrEqual(RAIL.maxGrade + 1e-9);
  });
});

describe('継ぎ目の勾配', () => {
  it('規格に収まる範囲では、繋いだ所で勾配が跳ばない', () => {
    // 平均 +4% の区間の先に平均 -1% の区間を繋ぐ。従来の
    // 「|d| <= 規格 - |平均|」では 1% 削られて折れていた。
    const network = chain('rail_single', [
      new Vector3(0, 20, 0),
      new Vector3(120, 24.8, 0),
      new Vector3(240, 23.6, 0),
    ]);
    for (const joint of jointGaps(network)) {
      expect(joint.gap).toBeLessThan(1e-6);
    }
  });

  it('デモの線路の継ぎ目が、どこも 0.3% 以内に収まっている', () => {
    const field = new Heightfield();
    generateTerrain(field, DEFAULT_TERRAIN);
    const network = new Network();
    buildDemoNetwork(network, field);

    const gaps = jointGaps(network);
    expect(gaps.length).toBeGreaterThan(10);
    const worst = Math.max(...gaps.map((g) => g.gap));
    expect(worst).toBeLessThan(0.003);
  });

  it('引き継ぎきれなかったぶんは、両側で分け合う', () => {
    // 平均 +2% の長い区間の先に、平均 -1% の短い区間。短いほうは縦曲線の
    // 半径が効いて 2.5% ぶんしか受け取れないので、残りを手前の区間が呑む。
    const network = chain('rail_single', [
      new Vector3(0, 20, 0),
      new Vector3(200, 24, 0),
      new Vector3(240, 23.6, 0),
    ]);
    for (const joint of jointGaps(network)) expect(joint.gap).toBeLessThan(6e-4);

    // 分け合った結果でも、両方とも規格を割らない。
    for (const seg of network.segments.values()) {
      const vertical = network.alignmentOf(seg.id).vertical;
      expect(vertical.maxGrade(64)).toBeLessThanOrEqual(RAIL.maxGrade + 1e-6);
      expect(vertical.minVerticalRadius()).toBeGreaterThan(RAIL.minVerticalRadius - 1e-6);
    }
  });

  /**
   * 片側が規格でびくとも動かない継ぎ目。
   *
   * 「両側から中点へ寄せる」を 1 回掛けるだけだと、動けるのは片側だけなので
   * 折れは半分しか消えない。動ける側が残り全部を呑むまで寄せ直す。
   */
  it('片側が規格いっぱいなら、動ける側が残りを全部呑む', () => {
    // 平均 +2% の先に平均 -4% の区間。後半は規格 5% を使い切るので、
    // 引き継いだ勾配を受け取りきれず、そこからは 1 mm も動かせない。
    const network = chain('rail_single', [
      new Vector3(0, 20, 0),
      new Vector3(120, 22.4, 0),
      new Vector3(200, 19.2, 0),
    ]);
    const gaps = jointGaps(network);
    expect(gaps.length).toBeGreaterThan(0);
    for (const joint of gaps) expect(joint.gap).toBeLessThan(6e-4);

    // 動かした側も規格を割らない (寄せ幅の判定は 32 点で測っているので、
    // より細かく測ると 0.001% ほど出ることがある)。
    for (const seg of network.segments.values()) {
      const vertical = network.alignmentOf(seg.id).vertical;
      expect(vertical.maxGrade(64)).toBeLessThanOrEqual(RAIL.maxGrade + 1e-4);
      expect(vertical.minVerticalRadius()).toBeGreaterThan(RAIL.minVerticalRadius - 1e-6);
    }
  });

  it('折れていない継ぎ目には手を出さない', () => {
    const network = chain('rail_single', [
      new Vector3(0, 20, 0),
      new Vector3(120, 24.8, 0),
      new Vector3(240, 23.6, 0),
    ]);
    const before = [...network.segments.values()].map((s) => [s.gradeA, s.gradeB]);
    for (const node of network.nodes.values()) {
      expect(smoothGradeJoint(network, node.id)).toBe(false);
    }
    expect([...network.segments.values()].map((s) => [s.gradeA, s.gradeB])).toEqual(before);
  });
});

/**
 * 折れが残ったときの警告。
 *
 * 均しは規格の範囲でしか動かせないので、両側とも規格いっぱいだと折れが
 * 残ります。黙って作らずに報せます。丁字路のように**枝ごとに勾配が違うのが
 * ふつう**の所は交差点の面が繋ぐので、折れとは呼びません。
 */
describe('勾配の折れの警告', () => {
  it('均しきれない継ぎ目を見つけて、大きさを述べる', () => {
    // 前半は規格 5% ちょうどの登り。後半は短い下りで、最大勾配のぶんしか
    // 受け取れない。どちらも動かせないので折れが残る。
    const network = chain('rail_single', [
      new Vector3(0, 20, 0),
      new Vector3(100, 25, 0),
      new Vector3(140, 24.6, 0),
    ]);
    const breaks = findGradeBreaks(network);
    expect(breaks.length).toBe(1);
    expect(breaks[0].gap).toBeGreaterThan(0.015);
    expect(gradeBreakMessage(breaks[0])).toContain(
      `${(breaks[0].gap * 100).toFixed(1)}% 折れています`,
    );
  });

  it('繋がっている線形では鳴らない', () => {
    const network = chain('rail_single', [
      new Vector3(0, 20, 0),
      new Vector3(120, 24.8, 0),
      new Vector3(240, 23.6, 0),
    ]);
    expect(findGradeBreaks(network)).toEqual([]);

    const field = new Heightfield();
    generateTerrain(field, DEFAULT_TERRAIN);
    const demo = new Network();
    buildDemoNetwork(demo, field);
    expect(findGradeBreaks(demo)).toEqual([]);
  });

  it('丁字路の枝道が本線と違う勾配で取り付いても鳴らない (面が繋ぐ)', () => {
    // 3% で登る本線の途中から、下り勾配の枝道を出す。
    const network = chain('road_small', [
      new Vector3(-150, 20, 0),
      new Vector3(0, 24.5, 0),
      new Vector3(150, 29, 0),
    ]);
    const cls = getClass('road_small');
    const node = network.findNodeNear(new Vector3(0, 24.5, 0), 3)!;
    const anchor = anchorFromNode(network, node, cls);
    // 規格 18% ぎりぎりの急な下り。引き継いだ勾配を保てないので、枝道は
    // 本線とまったく違う勾配で出ていく。
    const target = new Vector3(0, 14.3, 60);
    const preview = computePlacement(anchor, target, { straight: true, cls });
    placeSegment(network, 'road_small', anchor, { pos: target }, preview);

    // 枝道と本線の勾配差は 15% 以上 (空振り防止)。
    const branches = network.branchesAt(node.id);
    expect(branches.length).toBe(3);
    const side = branches.find((b) => Math.abs(b.dir.y) > 0.5)!;
    const main = branches.find((b) => b.dir.x > 0.5)!;
    expect(Math.abs(side.grade - main.grade)).toBeGreaterThan(0.15);
    // それでも「同じ道が続いている組」は繋がっているので鳴らない。
    expect(findGradeBreaks(network)).toEqual([]);
  });

  it('三叉路で枝ごとに勾配が違っても、折れとは呼ばない', () => {
    // 中心から 120° ずつ 3 方向へ、それぞれ違う高さへ引く。
    const cls = getClass('road_small');
    const network = new Network();
    const centre = new Vector3(0, 20, 0);
    for (const [deg, dy] of [
      [0, 6],
      [120, -9],
      [240, 1],
    ]) {
      const rad = (deg * Math.PI) / 180;
      const target = new Vector3(Math.cos(rad) * 100, 20 + dy, Math.sin(rad) * 100);
      const node = network.findNodeNear(centre, 3);
      const anchor = node ? anchorFromNode(network, node, cls) : { pos: centre.clone() };
      const preview = computePlacement(anchor, target, { straight: true, cls });
      placeSegment(network, 'road_small', anchor, { pos: target }, preview);
    }
    const node = network.findNodeNear(centre, 3)!;
    const grades = network.branchesAt(node.id).map((b) => b.grade);
    expect(grades.length).toBe(3);
    // 枝ごとの勾配は 5% 以上ばらついている (空振り防止)。
    expect(Math.max(...grades) - Math.min(...grades)).toBeGreaterThan(0.05);
    // 交差点の面が繋ぐ所なので、折れとしては報せない。
    expect(findGradeBreaks(network)).toEqual([]);
  });
});

describe('分岐での勾配の引き継ぎ', () => {
  it('出ていく向きの反対側にある枝から引き継ぐ', () => {
    // 東へ 3% で登る本線。その途中のノードから、さらに東へ分岐する。
    const network = chain('rail_single', [
      new Vector3(-150, 20, 0),
      new Vector3(0, 24.5, 0),
      new Vector3(150, 29, 0),
    ]);
    const node = network.findNodeNear(new Vector3(0, 24.5, 0), 3)!;
    const anchor = anchorFromNode(network, node, getClass('rail_yard'));

    // 東へ出るなら、西を向いている枝 (= 登ってきた側) の続きになる。
    const east = computePlacement(anchor, new Vector3(140, 28, 60), {
      straight: true,
      cls: getClass('rail_yard'),
    });
    expect(east.startGrade).toBeCloseTo(0.03, 3);

    // 西へ出るなら、逆側の枝の続き。登ってきた向きが逆になるので符号も逆。
    const west = computePlacement(anchor, new Vector3(-140, 21, 60), {
      straight: true,
      cls: getClass('rail_yard'),
    });
    expect(west.startGrade).toBeCloseTo(-0.03, 3);

    // 選べるように、枝は方位ごと全部渡している。
    expect(anchor.branches?.length).toBe(2);
  });
});
