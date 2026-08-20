import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { getClass } from '../src/network/classes';
import {
  anchorFromNode,
  anchorFromSegment,
  computePlacement,
  placeSegment,
  type Anchor,
} from '../src/network/editing';
import { Network, type NodeId, type SegmentId } from '../src/network/network';
import { Alignment } from '../src/core/alignment';
import { VerticalProfile } from '../src/core/profile';
import { checkPlacement } from '../src/network/rules';

/**
 * 線路の緩和曲線 (敷設ツールを通した振る舞い)。
 *
 * 直線から円曲線にいきなり入ると、繋ぎ目で曲率が 0 から 1/R へ跳ぶ。
 * 線路ではその手前に曲率を弧長に比例して立ち上げる区間を挟む。ここでは
 * 「実際に敷いた線形の曲率が跳ばない」ことを敷設ツールと同じ手順で確かめる。
 */

/** 直線のセグメントを 1 本足す。 */
function addStraight(network: Network, classId: string, a: Vector3, b: Vector3): NodeId[] {
  const na = network.findNodeNear(a, 0.5) ?? network.addNode(a);
  const nb = network.findNodeNear(b, 0.5) ?? network.addNode(b);
  const p0 = new Vector2(a.x, a.z);
  const p1 = new Vector2(b.x, b.z);
  network.addSegment({
    classId,
    a: na.id,
    b: nb.id,
    ctrlA: p0.clone().lerp(p1, 1 / 3),
    ctrlB: p0.clone().lerp(p1, 2 / 3),
    gradeA: 0,
    gradeB: 0,
  });
  return [na.id, nb.id];
}

/** 既存の端点から `target` まで 1 本引く。 */
function extend(
  network: Network,
  classId: string,
  node: NodeId,
  target: Vector3,
): { segment: SegmentId; endNode: NodeId; blocked: string[] } {
  const cls = getClass(classId);
  const anchor = anchorFromNode(network, network.getNode(node), cls);
  const preview = computePlacement(anchor, target, { straight: false, cls });
  const blocked = checkPlacement({
    network,
    cls,
    alignment: new Alignment(
      preview.horizontal,
      new VerticalProfile(
        anchor.pos.y,
        preview.end.y,
        preview.startGrade,
        preview.endGrade,
        preview.horizontal.length,
      ),
    ),
    start: anchor,
    end: { pos: preview.end },
  }).blockers;
  const result = placeSegment(network, classId, anchor, { pos: target }, preview);
  return { segment: result.segment, endNode: result.endNode, blocked };
}

/** ノードの両側で、外向きの曲率がどれだけ食い違っているか [1/m]。 */
function curvatureJump(network: Network, node: NodeId): number {
  const branches = network.branchesAt(node);
  if (branches.length !== 2) throw new Error('2 枝のノードではない');
  // 一方から入って他方へ抜けるので、外向きの曲率は符号が逆になるのが連続。
  return Math.abs(branches[0].curvature + branches[1].curvature);
}

describe('線路の緩和曲線', () => {
  it('直線から曲線へ入るとき、繋ぎ目で曲率が跳ばない', () => {
    const network = new Network();
    const [, tip] = addStraight(network, 'rail_single', new Vector3(-300, 0, 0), new Vector3(0, 0, 0));
    const { segment } = extend(network, 'rail_single', tip, new Vector3(240, 0, 70));
    const curve = network.alignmentOf(segment).horizontal;
    // 入口の曲率はほぼ 0 (直線のまま)。
    const design = 1 / curve.extremeCurvature(48).minRadius;
    expect(Math.abs(curve.curvatureAt(0))).toBeLessThan(design * 0.05);
    // 終端では設計曲率まで達している。
    expect(Math.abs(curve.curvatureAt(curve.length))).toBeGreaterThan(design * 0.9);
    // 曲率が弧長に沿って単調に増え、0 と設計値の間を通っていく。
    const ks: number[] = [];
    for (let i = 0; i <= 40; i++) ks.push(Math.abs(curve.curvatureAt((i / 40) * curve.length)));
    for (let i = 1; i < ks.length; i++) expect(ks[i]).toBeGreaterThan(ks[i - 1] - 1e-5);
    const ramping = ks.filter((k) => k > design * 0.1 && k < design * 0.9).length;
    expect(ramping).toBeGreaterThan(1);
  });

  it('道路は今までどおり円弧のまま (曲率は入口から立ち上がっている)', () => {
    const network = new Network();
    const [, tip] = addStraight(network, 'road_medium', new Vector3(-300, 0, 0), new Vector3(0, 0, 0));
    const { segment } = extend(network, 'road_medium', tip, new Vector3(240, 0, 70));
    const curve = network.alignmentOf(segment).horizontal;
    const design = 1 / curve.extremeCurvature(48).minRadius;
    expect(Math.abs(curve.curvatureAt(0))).toBeGreaterThan(design * 0.9);
    expect(curve.pieceCount).toBe(1);
  });

  it('繋いでいくと、どの繋ぎ目でも曲率が連続になる', () => {
    const network = new Network();
    const [, tip] = addStraight(network, 'rail_single', new Vector3(-300, 0, 0), new Vector3(0, 0, 0));
    let node = tip;
    const joints: NodeId[] = [];
    for (const target of [
      new Vector3(200, 0, 50),
      new Vector3(380, 0, 170),
      new Vector3(470, 0, 350),
    ]) {
      joints.push(node);
      node = extend(network, 'rail_single', node, target).endNode;
    }
    for (const joint of joints) {
      // 曲率半径 120 m でも曲率は 8.3e-3。跳びが 5e-4 未満なら、
      // 半径にして 2000 m 相当より緩やかな食い違いしかない。
      expect(curvatureJump(network, joint)).toBeLessThan(5e-4);
    }
  });

  it('緩和曲線が入っても規格の最小半径を割らない', () => {
    const network = new Network();
    for (const classId of ['rail_single', 'rail_yard']) {
      const cls = getClass(classId);
      for (const [dx, dz] of [
        [240, 70],
        [180, -90],
        [120, 60],
        [320, 40],
        [90, 45],
      ]) {
        const net = new Network();
        const [, tip] = addStraight(net, classId, new Vector3(-300, 0, 0), new Vector3(0, 0, 0));
        const { segment } = extend(net, classId, tip, new Vector3(dx, 0, dz));
        const { minRadius } = net.alignmentOf(segment).horizontal.extremeCurvature(48);
        expect(minRadius).toBeGreaterThan(cls.minRadius - 1e-6);
      }
    }
    void network;
  });

  it('曲線の途中から分岐すると、親の曲率から緩和して離れる', () => {
    const network = new Network();
    const [, tip] = addStraight(network, 'rail_single', new Vector3(-300, 0, 0), new Vector3(0, 0, 0));
    const { segment } = extend(network, 'rail_single', tip, new Vector3(240, 0, 70));
    const parent = network.alignmentOf(segment);
    const s = parent.length * 0.75;
    const at = parent.sampleAt(s);
    expect(Math.abs(at.curvature)).toBeGreaterThan(1e-3); // 曲線の途中であること

    const cls = getClass('rail_yard');
    const anchor = anchorFromSegment(network, segment, s);
    expect(anchor.curvature).toBeCloseTo(at.curvature, 6);
    const target = new Vector3(at.pos.x + 150, 0, at.pos.z + 120);
    const preview = computePlacement(anchor, target, { straight: false, cls });
    // 分岐した枝は親と同じ曲率から始まる (繋ぎ目で跳ばない)。
    expect(preview.horizontal.curvatureAt(0)).toBeCloseTo(at.curvature, 3);
  });

  it('分岐した枝を実際に置いても、分割された親と曲率が繋がる', () => {
    const network = new Network();
    const [, tip] = addStraight(network, 'rail_single', new Vector3(-300, 0, 0), new Vector3(0, 0, 0));
    const { segment } = extend(network, 'rail_single', tip, new Vector3(240, 0, 70));
    const parent = network.alignmentOf(segment);
    const s = parent.length * 0.6;
    const at = parent.sampleAt(s);

    const cls = getClass('rail_yard');
    const anchor: Anchor = anchorFromSegment(network, segment, s);
    const target = new Vector3(at.pos.x + 160, 0, at.pos.z + 130);
    const preview = computePlacement(anchor, target, { straight: false, cls });
    const result = placeSegment(network, 'rail_yard', anchor, { pos: target }, preview);
    const node = network.getNode(result.startNode);
    const branches = network.branchesAt(node.id);
    expect(branches.length).toBe(3);

    // 親の 2 本 (分割された前後) の曲率が繋がったままであること。
    const mains = branches.filter((b) => b.cls.id === 'rail_single');
    expect(mains.length).toBe(2);
    expect(Math.abs(mains[0].curvature + mains[1].curvature)).toBeLessThan(5e-4);
    // 枝は親の曲率から出る。
    const branch = branches.find((b) => b.cls.id === 'rail_yard')!;
    expect(Math.abs(Math.abs(branch.curvature) - Math.abs(at.curvature))).toBeLessThan(2e-3);
  });

  it('既存線路の端点へ向かって引いても、着地点で曲率が跳ばない', () => {
    const network = new Network();
    // 東から西を向いて終わっている線路。そこへ南西から取り付く。
    addStraight(network, 'rail_single', new Vector3(300, 0, 0), new Vector3(60, 0, 0));
    const node = network.findNodeNear(new Vector3(60, 0, 0), 0.5)!;
    const cls = getClass('rail_single');
    const end = anchorFromNode(network, node, cls);
    const start: Anchor = { pos: new Vector3(-220, 0, 90) };
    const preview = computePlacement(start, end, { straight: false, cls });
    const curve = preview.horizontal;
    // 着地側 (既存の直線に繋がる側) の曲率がほぼ 0。
    const design = 1 / curve.extremeCurvature(48).minRadius;
    expect(Math.abs(curve.curvatureAt(curve.length))).toBeLessThan(design * 0.05);
    // 接線も揃っている。
    expect(curve.tangentAt(curve.length).x).toBeGreaterThan(0.999);
  });

  it('straight 指定では緩和曲線も曲率の引き継ぎも効かない', () => {
    const network = new Network();
    const [, tip] = addStraight(network, 'rail_single', new Vector3(-300, 0, 0), new Vector3(0, 0, 0));
    const cls = getClass('rail_single');
    const anchor = anchorFromNode(network, network.getNode(tip), cls);
    const preview = computePlacement(anchor, new Vector3(240, 0, 70), { straight: true, cls });
    expect(preview.horizontal.pieceCount).toBe(1);
    expect(preview.horizontal.p1.distanceTo(new Vector2(240, 70))).toBeLessThan(1e-6);
  });
});
