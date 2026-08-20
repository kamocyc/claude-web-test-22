import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { Alignment } from '../src/core/alignment';
import { curveFromTangents } from '../src/core/curve';
import { VerticalProfile } from '../src/core/profile';
import { getClass } from '../src/network/classes';
import {
  anchorFromNode,
  anchorFromSegment,
  computePlacement,
  placeSegment,
} from '../src/network/editing';
import { solveJunctions } from '../src/network/junction';
import { Network, type NodeId } from '../src/network/network';
import { parallelSpacing } from '../src/network/parallel';
import { checkPlacement } from '../src/network/rules';

/** 2 点を結ぶ直線の線形。 */
function straight(a: Vector3, b: Vector3): Alignment {
  const from = new Vector2(a.x, a.z);
  const to = new Vector2(b.x, b.z);
  const dir = to.clone().sub(from).normalize();
  const horizontal = curveFromTangents(from, dir, to, dir);
  return new Alignment(horizontal, VerticalProfile.linear(a.y, b.y, horizontal.length));
}

/** 直線のセグメントを 1 本足す (端点は近ければ既存ノードに繋ぐ)。 */
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

/** 交差点の形が乱れたことを知らせる警告。 */
function shapeWarnings(network: Network): string[] {
  const out: string[] = [];
  for (const junction of solveJunctions(network).junctions.values()) {
    for (const message of junction.warnings) {
      if (message.includes('短すぎ') || message.includes('乱れ')) out.push(message);
    }
  }
  return out;
}

describe('敷設できるかどうかの判定', () => {
  /**
   * 判定の要:「余裕をもって離れているか」ではなく「交差点の形が保てるか」。
   *
   * 敷設を許した配置では、交差点を解いたときに形が乱れてはならない。
   * 逆に形が乱れる配置は、置く前に必ず止まっていなければならない。
   */
  it('直線どうしの交差では、敷設できた配置で交差点の形が乱れない', () => {
    const missed: string[] = [];
    let allowed = 0;
    let blocked = 0;

    for (const classId of ['road_small', 'road_medium', 'road_large']) {
      for (const deg of [25, 35, 50, 70, 90]) {
        for (const half of [12, 20, 35, 60]) {
          for (const at of [0, 100, 140]) {
            const network = new Network();
            addStraight(network, 'road_medium', new Vector3(-150, 0, 0), new Vector3(150, 0, 0));
            const rad = (deg * Math.PI) / 180;
            const dir = new Vector3(Math.cos(rad), 0, Math.sin(rad));
            const center = new Vector3(at, 0, 0);
            const start = center.clone().addScaledVector(dir, -half);
            const end = center.clone().addScaledVector(dir, half);
            const cls = getClass(classId);
            const alignment = straight(start, end);
            const check = checkPlacement({
              network,
              cls,
              alignment,
              start: { pos: start },
              end: { pos: end },
            });

            const name = `${classId} ${deg}° 半長${half}m @x=${at}`;
            if (check.blockers.length > 0) {
              blocked++;
              continue;
            }
            allowed++;
            // 実際に置いて、交差点の形が保たれることを確かめる。
            const preview = computePlacement({ pos: start }, end, { straight: true, cls });
            placeSegment(network, classId, { pos: start }, { pos: end }, preview);
            for (const warning of shapeWarnings(network)) {
              missed.push(`${name}: ${warning}`);
            }
          }
        }
      }
    }

    // 判定が「全部通す」「全部止める」に潰れていないこと。
    expect(allowed).toBeGreaterThan(25);
    expect(blocked).toBeGreaterThan(10);
    expect(missed.slice(0, 5)).toEqual([]);
  }, 60000);

  /**
   * 既存の道路の途中に T 字で取り付ける場合も同じ。分割してできる 2 本が
   * 取り付き長を飲み込めるなら置ける。
   */
  it('T 字の取り付きでも、形が保てる角度なら置ける', () => {
    const missed: string[] = [];
    const allowed: number[] = [];
    for (const deg of [5, 10, 15, 20, 30, 45, 60, 90]) {
      const network = new Network();
      addStraight(network, 'road_medium', new Vector3(-150, 0, 0), new Vector3(150, 0, 0));
      const hit = network.findSegmentNear(new Vector3(0, 0, 0), 5)!;
      const anchor = anchorFromSegment(network, hit.segment, hit.s);
      const rad = (deg * Math.PI) / 180;
      const target = new Vector3(Math.cos(rad) * 90, 0, Math.sin(rad) * 90);
      const cls = getClass('road_small');
      const check = checkPlacement({
        network,
        cls,
        alignment: straight(anchor.pos, target),
        start: anchor,
        end: { pos: target },
      });
      if (check.blockers.length > 0) continue;
      allowed.push(deg);
      const preview = computePlacement(anchor, target, { straight: true, cls });
      placeSegment(network, 'road_small', anchor, { pos: target }, preview);
      for (const warning of shapeWarnings(network)) missed.push(`${deg}°: ${warning}`);
    }
    // 直角の T 字は当然置けること (以前は角度によらず必ず止まっていた)。
    expect(allowed).toContain(90);
    expect(allowed).toContain(45);
    // 交差点が何十 m にもなる浅い角度は止まること。
    expect(allowed).not.toContain(5);
    expect(missed).toEqual([]);
  });

  it('直角に交わるだけなら、端まで 25 m あれば置ける', () => {
    const network = new Network();
    addStraight(network, 'road_medium', new Vector3(-150, 0, 0), new Vector3(150, 0, 0));
    // 以前は「交差点の半幅 + 8 m」の余裕を求めていたので、この配置
    // (端まで 25 m) でも置けなかった。
    const start = new Vector3(0, 0, -25);
    const end = new Vector3(0, 0, 25);
    const check = checkPlacement({
      network,
      cls: getClass('road_medium'),
      alignment: straight(start, end),
      start: { pos: start },
      end: { pos: end },
    });
    expect(check.blockers).toEqual([]);
  });

  it('交差点の面の外なら、10 m 先で終わらせてもよい', () => {
    const network = new Network();
    addStraight(network, 'road_medium', new Vector3(-120, 0, 0), new Vector3(0, 0, 0));
    addStraight(network, 'road_medium', new Vector3(0, 0, 0), new Vector3(120, 0, 0));
    addStraight(network, 'road_medium', new Vector3(0, 0, 0), new Vector3(0, 0, 120));
    // 交差点 (原点) から 10 m 離れた所で終わる道路。舗装は重ならない。
    const start = new Vector3(10, 0, -100);
    const end = new Vector3(10, 0, -10);
    const check = checkPlacement({
      network,
      cls: getClass('road_small'),
      alignment: straight(start, end),
      start: { pos: start },
      end: { pos: end },
    });
    expect(check.blockers).toEqual([]);
  });

  it('交差点の面の中で終わらせることはできない', () => {
    const network = new Network();
    addStraight(network, 'road_large', new Vector3(-120, 0, 0), new Vector3(0, 0, 0));
    addStraight(network, 'road_large', new Vector3(0, 0, 0), new Vector3(120, 0, 0));
    addStraight(network, 'road_large', new Vector3(0, 0, 0), new Vector3(0, 0, 120));
    const start = new Vector3(4, 0, -100);
    const end = new Vector3(4, 0, -4);
    const check = checkPlacement({
      network,
      cls: getClass('road_small'),
      alignment: straight(start, end),
      start: { pos: start },
      end: { pos: end },
    });
    expect(check.blockers.join(' ')).toContain('交差点');
  });

  it('隣の交差点まで届かない所に枝を足すことはできない', () => {
    // 交差点どうしが 10 m しか離れていない配置。ここに 3 本目を繋ぐと、
    // 間のセグメントが両側からトリムされて形が保てない。
    const network = new Network();
    addStraight(network, 'road_medium', new Vector3(-120, 0, 0), new Vector3(0, 0, 0));
    addStraight(network, 'road_medium', new Vector3(0, 0, 0), new Vector3(10, 0, 0));
    addStraight(network, 'road_medium', new Vector3(10, 0, 0), new Vector3(130, 0, 0));
    addStraight(network, 'road_medium', new Vector3(0, 0, 0), new Vector3(0, 0, -120));
    const node = network.findNodeNear(new Vector3(10, 0, 0), 0.5)!;

    const start = new Vector3(10, 0, 0);
    const end = new Vector3(10, 0, 120);
    const check = checkPlacement({
      network,
      cls: getClass('road_medium'),
      alignment: straight(start, end),
      start: { pos: start, node: node.id },
      end: { pos: end },
    });
    expect(check.blockers.join(' ')).toContain('交差点が近すぎます');
  });
});

/**
 * 中心線が交わらなくても、路面 (帯) は重なる。
 *
 * 中心線どうしの距離だけを見ていると、突き当たる形・すれ違う形で
 * 「交差点でも踏切でもないのに舗装が重なる」配置が通ってしまう。
 * 幅を持った帯として見て、重なりと桁下を判定する。
 */
describe('中心線が交わらない重なり', () => {
  /** x 軸に沿う既存の道路を 1 本置いたネットワーク。 */
  function withMainRoad(classId = 'road_medium', y = 0): Network {
    const network = new Network();
    addStraight(network, classId, new Vector3(-150, y, 0), new Vector3(150, y, 0));
    return network;
  }

  function check(network: Network, classId: string, a: Vector3, b: Vector3): string[] {
    return checkPlacement({
      network,
      cls: getClass(classId),
      alignment: straight(a, b),
      start: { pos: a },
      end: { pos: b },
    }).blockers;
  }

  it('舗装の中で行き止まる道路は置けない (交差点にならない突き当たり)', () => {
    // 幹線道路の舗装は |z| <= 8.9 m。その中で終わる枝は、交差点にも
    // ならないまま舗装が重なる。
    const network = withMainRoad();
    const blockers = check(
      network,
      'road_small',
      new Vector3(40, 0, -100),
      new Vector3(40, 0, -6),
    );
    expect(blockers.join(' ')).toContain('重なります');
  });

  it('舗装の外で行き止まるなら置ける', () => {
    const network = withMainRoad();
    const blockers = check(
      network,
      'road_small',
      new Vector3(40, 0, -100),
      new Vector3(40, 0, -10),
    );
    expect(blockers).toEqual([]);
  });

  it('中心線まで届く枝は交差点になるので置ける', () => {
    const network = withMainRoad();
    const blockers = check(
      network,
      'road_small',
      new Vector3(40, 0, -100),
      new Vector3(40, 0, 30),
    );
    expect(blockers).toEqual([]);
  });

  it('舗装の縁をかすめて跨ぐ高架は、桁下が足りなければ置けない', () => {
    // 中心線は交わらない (道路の手前で終わる) が、桁は舗装の上を通る。
    const network = withMainRoad();
    const low = check(
      network,
      'road_small',
      new Vector3(40, 5, -100),
      new Vector3(40, 5, -6),
    );
    expect(low.join(' ')).toContain('建築限界');
    // 桁下が取れていれば同じ形でも置ける。
    const high = check(
      network,
      'road_small',
      new Vector3(40, 6, -100),
      new Vector3(40, 6, -6),
    );
    expect(high).toEqual([]);
  });

  it('少し高い所を並走する高架も、桁下が足りなければ置けない', () => {
    // 平面では舗装が 1.5 m 重なり、高さは 3 m しか違わない。中心線が
    // 交わらないので、以前は何も言えなかった。
    const network = withMainRoad();
    const blockers = check(
      network,
      'road_small',
      new Vector3(-100, 3, 12),
      new Vector3(100, 3, 12),
    );
    expect(blockers.join(' ')).toContain('建築限界');
  });

  it('平行スナップの間隔 (舗装の縁が触れ合う幅) は置ける', () => {
    const cls = getClass('rail_single');
    const network = new Network();
    addStraight(network, 'rail_single', new Vector3(-150, 0, 0), new Vector3(150, 0, 0));
    const gap = parallelSpacing(cls);
    const blockers = check(
      network,
      'rail_single',
      new Vector3(-120, 0, gap),
      new Vector3(120, 0, gap),
    );
    expect(blockers).toEqual([]);
    // 1 m 詰めれば重なる。
    const tight = check(
      network,
      'rail_single',
      new Vector3(-120, 0, gap - 1),
      new Vector3(120, 0, gap - 1),
    );
    expect(tight.join(' ')).toContain('重な');
  });
});

describe('既存の線形への取り付き', () => {
  it('線路途中のクリック位置を接点にして、指した側へ接線分岐する', () => {
    const network = new Network();
    addStraight(network, 'rail_yard', new Vector3(-120, 0, 0), new Vector3(120, 0, 0));
    const [segment] = [...network.segments.keys()];
    const alignment = network.alignmentOf(segment);
    const anchor = anchorFromSegment(network, segment, alignment.length / 2);

    for (const side of [-1, 1]) {
      const preview = computePlacement(anchor, new Vector3(side * 90, 0, 25), {
        straight: false,
        cls: getClass('rail_yard'),
      });
      const tangent = preview.horizontal.tangentAt(0);
      expect(tangent.x * side).toBeGreaterThan(0.999);
      expect(Math.abs(tangent.y)).toBeLessThan(1e-6);
    }
  });

  it('既存線路の端点へ、プレビューの時点から接線を揃えて接続する', () => {
    const network = new Network();
    addStraight(network, 'rail_yard', new Vector3(-120, 0, 0), new Vector3(0, 0, 0));
    const node = network.findNodeNear(new Vector3(0, 0, 0), 0.5)!;
    const end = anchorFromNode(network, node, getClass('rail_yard'));
    const start = { pos: new Vector3(90, 0, 35) };
    const preview = computePlacement(start, end, { straight: false, cls: getClass('rail_yard') });
    const tangent = preview.horizontal.tangentAt(preview.horizontal.length);
    expect(tangent.x).toBeLessThan(-0.999);
    expect(Math.abs(tangent.y)).toBeLessThan(1e-6);
  });

  /** 既存の道路の端に、角度 `deg` で新しい道路を繋ぐ。 */
  function joinAt(deg: number, classId = 'road_medium') {
    const network = new Network();
    addStraight(network, classId, new Vector3(-120, 0, 0), new Vector3(0, 0, 0));
    const node = network.findNodeNear(new Vector3(0, 0, 0), 0.5)!;
    const rad = (deg * Math.PI) / 180;
    const target = new Vector3(Math.cos(rad) * 100, 0, Math.sin(rad) * 100);
    const anchor = { pos: node.pos.clone(), node: node.id };
    const preview = computePlacement(anchor, target, { straight: false, cls: getClass(classId) });
    const result = placeSegment(network, classId, anchor, { pos: target }, preview);
    const branches = network.branchesAt(node.id);
    const deflection =
      Math.PI - Math.acos(Math.max(-1, Math.min(1, branches[0].dir.dot(branches[1].dir))));
    return { network, node, result, branches, deflection: (deflection * 180) / Math.PI };
  }

  /**
   * 引いたばかりの線形を既存の端に繋ぐと、そのままでは折れて「角」になる。
   * 実際の道路と同じように、既存側も少し振って滑らかに繋ぐ。
   */
  it('浅い角度で取り付くと、折れが消えてなめらかに繋がる', () => {
    for (const deg of [10, 25, 40, 55]) {
      const joined = joinAt(deg);
      expect(joined.result.smoothed).toContain(joined.node.id);
      expect(joined.deflection).toBeLessThan(0.5);
    }
  });

  it('なめらかにした線形も規格 (最小半径) を守る', () => {
    for (const deg of [10, 25, 40, 55]) {
      const joined = joinAt(deg);
      for (const branch of joined.branches) {
        const alignment = joined.network.alignmentOf(branch.segment);
        const { minRadius } = alignment.horizontal.extremeCurvature(48);
        expect(minRadius).toBeGreaterThanOrEqual(branch.cls.minRadius - 1e-6);
      }
    }
  });

  it('ノードや反対側の端点は動かさない (繋がっている相手に影響しない)', () => {
    const joined = joinAt(40);
    expect(joined.node.pos.x).toBeCloseTo(0, 6);
    expect(joined.node.pos.z).toBeCloseTo(0, 6);
    const far = joined.network.getNode(
      joined.network.getSegment(joined.branches[0].segment).a,
    );
    const ends = [...joined.network.nodes.values()].map((n) => `${n.pos.x.toFixed(2)}`);
    expect(ends).toContain('-120.00');
    expect(far).toBeDefined();
  });

  /**
   * 始点と終点をどちらも同じ線形の途中に取り付けると、始点を分割した時点で
   * 終点の相手が消える。分かれた片方に取り付き直して、例外にしない。
   */
  it('同じ線形の 2 か所に取り付いても例外にならない', () => {
    const network = new Network();
    // 大きく曲がった道路。その内側を突っ切る近道を引く。
    const a = network.addNode(new Vector3(-150, 0, 0));
    const b = network.addNode(new Vector3(150, 0, 0));
    network.addSegment({
      classId: 'road_medium',
      a: a.id,
      b: b.id,
      ctrlA: new Vector2(-90, 180),
      ctrlB: new Vector2(90, 180),
      gradeA: 0,
      gradeB: 0,
    });
    const [existing] = [...network.segments.keys()];
    const alignment = network.alignmentOf(existing);
    const start = anchorFromSegment(network, existing, alignment.length * 0.25);
    const end = anchorFromSegment(network, existing, alignment.length * 0.75);
    const preview = computePlacement(start, end.pos.clone(), {
      straight: true,
      cls: getClass('road_medium'),
    });
    expect(() => placeSegment(network, 'road_medium', start, { ...end }, preview)).not.toThrow();
    // 元の線形は 2 か所で分割され、近道が 1 本増える。
    expect(network.segments.size).toBeGreaterThanOrEqual(4);
  });

  it('急な折れは「角」の意図とみなしてそのまま残す', () => {
    const joined = joinAt(75);
    expect(joined.result.smoothed).toEqual([]);
    expect(joined.deflection).toBeGreaterThan(70);
  });
});
