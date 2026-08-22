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
    const joint = jointGaps(network).find((g) => g.gap > 0)!;
    // 片側だけを削ったときの食い違い (0.5%) より、はっきり小さい。
    expect(joint.gap).toBeLessThan(0.003);

    // 分け合った結果でも、両方とも規格を割らない。
    for (const seg of network.segments.values()) {
      const vertical = network.alignmentOf(seg.id).vertical;
      expect(vertical.maxGrade(64)).toBeLessThanOrEqual(RAIL.maxGrade + 1e-6);
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
