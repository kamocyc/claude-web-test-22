import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { Alignment } from '../src/core/alignment';
import { arcFromTangent, curveFromTangents } from '../src/core/curve';
import { VerticalProfile } from '../src/core/profile';
import { DEG } from '../src/core/units';
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

describe('規格最大勾配', () => {
  /**
   * 縦断勾配の規格は、実物の基準 (生活道路 12%、線路 3.5% など) より
   * 5 割ほど緩めてある。地形の起伏に対して敷地が狭く、実物どおりでは
   * 思うように繋げられないため。
   */
  const cases: [string, number, number][] = [
    // 種別, 置ける勾配, 置けない勾配
    ['road_small', 0.17, 0.19],
    ['road_medium', 0.13, 0.14],
    ['road_large', 0.1, 0.11],
    ['road_highway', 0.07, 0.08],
    ['road_ramp', 0.11, 0.13],
    ['rail_single', 0.048, 0.055],
    ['rail_yard', 0.028, 0.032],
  ];

  for (const [classId, ok, tooSteep] of cases) {
    it(`${classId} は ${(ok * 100).toFixed(1)}% で置けて ${(tooSteep * 100).toFixed(1)}% では置けない`, () => {
      const cls = getClass(classId);
      const network = new Network();
      const check = (grade: number): string[] => {
        const length = 300;
        const a = new Vector3(0, 20, 0);
        const b = new Vector3(length, 20 + grade * length, 0);
        return checkPlacement({
          network,
          cls,
          alignment: straight(a, b),
          start: { pos: a },
          end: { pos: b },
        }).blockers;
      };
      expect(check(ok)).toEqual([]);
      expect(check(tooSteep).join(' ')).toContain('勾配');
    });
  }
});

describe('規格最小曲線半径', () => {
  /**
   * 曲線の規格も、実物の基準よりだいぶ緩めてある。1 区画 40 m の縮尺では
   * 実物どおりの半径を求めると、街の中に線路も道路も収まらないため。
   */
  const cases: [string, number][] = [
    ['road_small', 7],
    ['road_medium', 18],
    ['road_large', 26],
    ['road_highway', 70],
    ['road_ramp', 26],
    ['rail_single', 50],
    ['rail_yard', 30],
  ];

  /** 始点で +x を向き、半径 `radius` で 60° 曲がる円弧の線形。 */
  function bend(radius: number): Alignment {
    const sweep = Math.PI / 3;
    const a = new Vector2(0, 0);
    const b = new Vector2(radius * Math.sin(sweep), radius * (1 - Math.cos(sweep)));
    const { curve } = arcFromTangent(a, new Vector2(1, 0), b);
    return new Alignment(curve, VerticalProfile.linear(20, 20, curve.length));
  }

  for (const [classId, minRadius] of cases) {
    it(`${classId} の最小半径は ${minRadius} m`, () => {
      const cls = getClass(classId);
      expect(cls.minRadius).toBe(minRadius);
      const network = new Network();
      const check = (radius: number): string[] => {
        const alignment = bend(radius);
        return checkPlacement({
          network,
          cls,
          alignment,
          start: { pos: alignment.sampleAt(0).pos.clone() },
          end: { pos: alignment.sampleAt(alignment.length).pos.clone() },
        }).blockers;
      };
      expect(check(minRadius * 1.05)).toEqual([]);
      expect(check(minRadius * 0.9).join(' ')).toContain('最小半径');
    });
  }

  /**
   * 最小半径は「ここまでなら敷ける」限界で、ふだんの線形はもっと緩い。
   * 標準半径 (`smoothRadius`) までは緩和曲線とカントを入れるが、それより
   * 急な曲線は徐行区間として素の円弧で敷く。円弧は必ず指した点を通るので、
   * 緩和曲線が届かずに終点がずれることもない。
   */
  it('標準半径より急な繋ぎ方は、緩和曲線を挟まずに円弧で解く', () => {
    const cls = getClass('rail_single');
    const from = { pos: new Vector3(0, 20, 0), tangent: new Vector2(1, 0) };

    // 半径 75 m ぶんの曲がり (標準半径 120 m より急、最小半径 50 m より緩い)。
    const tight = computePlacement(from, new Vector3(60, 20, 30), { straight: false, cls });
    expect(tight.radius).toBeGreaterThan(cls.minRadius);
    expect(tight.radius).toBeLessThan(cls.smoothRadius);
    // 円弧なので、始点から終点まで曲率が一定。
    expect(tight.horizontal.curvatureAt(0)).toBeCloseTo(1 / tight.radius, 3);
    // 指した点にちょうど届く。
    expect(tight.end.distanceTo(new Vector3(60, 20, 30))).toBeLessThan(0.05);

    // 緩い曲線では今までどおり緩和曲線が入る (始点の曲率は 0 のまま)。
    const gentle = computePlacement(from, new Vector3(240, 20, 30), { straight: false, cls });
    expect(gentle.radius).toBeGreaterThan(cls.smoothRadius);
    expect(Math.abs(gentle.horizontal.curvatureAt(0))).toBeLessThan(1e-4);
    expect(gentle.end.distanceTo(new Vector3(240, 20, 30))).toBeLessThan(0.05);
  });
});

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

  /**
   * 止めた理由の**場所**。
   *
   * 「交差点が近すぎます」「交差点の中に端点があります」と言われても、
   * どの交差点の話なのかは文言から分からない。敷設ツールはここを目印で
   * 囲って示すので、原因のノードの位置が返ることを確かめる。
   */
  it('交差点の中で終わらせたときは、その交差点の位置が返る', () => {
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
    expect(check.places).toHaveLength(1);
    expect(check.places[0].distanceTo(new Vector3(0, 0, 0))).toBeLessThan(0.01);
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
    // 詰まっている相手 = 10 m 先の交差点。
    expect(check.places.some((p) => p.distanceTo(new Vector3(0, 0, 0)) < 0.01)).toBe(true);
  });
});

/**
 * 線路どうしの交差 (ダイヤモンドクロッシング)。
 *
 * 線路の交差点は面を持たない (`junction.ts` の冒頭の説明) ので、道路の
 * 交差点のように取り付き長を空ける必要がない。渡り線・シーサスは既存の
 * ノードのすぐ近くで交わることが多いので、ここで止めては作れなくなる。
 */
describe('線路どうしの交差に要る余裕', () => {
  /** 原点で交わる 2 本の線路。既存側は `end` で切れている。 */
  function crossing(end: number, angle: number): { network: Network; alignment: Alignment } {
    const network = new Network();
    addStraight(network, 'rail_single', new Vector3(-200, 0, 0), new Vector3(end, 0, 0));
    const dx = Math.cos(angle) * 200;
    const dz = Math.sin(angle) * 200;
    const start = new Vector3(-dx, 0, -dz);
    const stop = new Vector3(dx, 0, dz);
    return { network, alignment: straight(start, stop) };
  }

  function check(end: number, angle: number): string[] {
    const { network, alignment } = crossing(end, angle);
    return checkPlacement({
      network,
      cls: getClass('rail_single'),
      alignment,
      start: { pos: alignment.sampleAt(0).pos.clone() },
      end: { pos: alignment.sampleAt(alignment.length).pos.clone() },
    }).blockers;
  }

  it('浅い角度でも、交点の 10 m 先で相手が終わっていれば置ける', () => {
    // 交差角 10°。従来は取り付き長 26 m を求めて止めていた。
    expect(check(10, 10 * DEG)).toEqual([]);
  });

  it('交点が相手の端点に重なるほど近ければ止まる', () => {
    expect(check(1, 10 * DEG).join(' ')).toContain('交差点が近すぎます');
  });

  /**
   * 要る余裕は幅ではなく「そこで分けられるか」で決まる。
   *
   * 交点で双方を分けるのは `resolveAutoJunctions` と `splitAtCrossing` で、
   * どちらも端から `CROSSING_END_MARGIN` 以内では分けない。判定がそれより
   * 緩いと「置けたのに繋がらない」交差ができ、厳しいと**複線が横切れない**
   * (交点が複線の間隔 = 半幅の和 + 0.2 m で並ぶため)。
   */
  it('複線の間隔だけ離れていれば、直角でも交差できる', () => {
    const gap = parallelSpacing(getClass('rail_single'));
    expect(check(gap, 90 * DEG)).toEqual([]);
  });

  it('分けられないほど端に寄った交点は、直角でも止まる', () => {
    expect(check(1.5, 90 * DEG).join(' ')).toContain('交差点が近すぎます');
  });

  it('側線の複線の間隔 (3.8 m) でも交差できる', () => {
    const gap = parallelSpacing(getClass('rail_yard'));
    expect(check(gap, 90 * DEG)).toEqual([]);
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

  it('線形の始点は、どんな繋ぎ方でもクリックした点から動かない', () => {
    // 接続点 (枝が 2 本のノード) から、隣の線路へ渡り線を引く。終点側は
    // 既存線路に接するので、解き方は「終点から逆向き」になる。始点の位置は
    // クリックした点そのものなので、ここが動いてはいけない。
    const cls = getClass('rail_single');
    for (const span of [140, 90, 60, 40, 30, 20]) {
      const network = new Network();
      addStraight(network, 'rail_single', new Vector3(-200, 0, 0), new Vector3(0, 0, 0));
      addStraight(network, 'rail_single', new Vector3(0, 0, 0), new Vector3(200, 0, 0));
      addStraight(network, 'rail_single', new Vector3(-200, 0, 4.6), new Vector3(200, 0, 4.6));
      const joint = network.findNodeNear(new Vector3(0, 0, 0), 0.5)!;
      expect(network.branchesAt(joint.id)).toHaveLength(2);
      const anchor = anchorFromNode(network, joint, cls);

      const mate = [...network.segments.values()].find(
        (seg) => network.getNode(seg.a).pos.z > 1,
      )!;
      const end = anchorFromSegment(network, mate.id, 200 + span);
      const preview = computePlacement(anchor, end, { straight: false, cls });
      const start = preview.horizontal.p0;
      expect(Math.hypot(start.x - anchor.pos.x, start.y - anchor.pos.z), `span=${span}`).toBeLessThan(
        0.05,
      );
      // 終点は指した所のまま。
      expect(preview.end.distanceTo(end.pos), `span=${span}`).toBeLessThan(0.05);
    }
  });

  /**
   * 継ぎ目 (枝が 2 本のノード) は、線形としては区間の途中と変わらない。
   * 接線を引き継がないと、継ぎ目に当たった所だけ分岐が線路に沿わなくなる。
   */
  it('継ぎ目から分岐しても、区間の途中と同じように接線に沿う', () => {
    const cls = getClass('rail_single');
    const network = new Network();
    addStraight(network, 'rail_single', new Vector3(-200, 0, 0), new Vector3(0, 0, 0));
    addStraight(network, 'rail_single', new Vector3(0, 0, 0), new Vector3(200, 0, 0));
    const joint = network.findNodeNear(new Vector3(0, 0, 0), 0.5)!;
    expect(network.branchesAt(joint.id)).toHaveLength(2);
    const anchor = anchorFromNode(network, joint, cls);

    // 継ぎ目から 1 m だけ離れた、区間の途中と見比べる。
    const mate = [...network.segments.values()].find(
      (seg) => network.getNode(seg.a).pos.x >= 0,
    )!;
    const inside = anchorFromSegment(network, mate.id, 1);

    for (const side of [-1, 1]) {
      for (const z of [30, -30]) {
        const target = new Vector3(side * 120, 0, z);
        const here = computePlacement(anchor, target, { straight: false, cls });
        const there = computePlacement(inside, target, { straight: false, cls });
        // 出ていく向きは線路の接線そのもの (カーソルの側を向く)。
        const tangent = here.horizontal.tangentAt(0);
        expect(tangent.x * side).toBeGreaterThan(0.999);
        expect(Math.abs(tangent.y)).toBeLessThan(1e-6);
        // 区間の途中から引いたときと同じ形になる (1 m ぶんの差だけ)。
        expect(Math.abs(here.radius - there.radius) / there.radius).toBeLessThan(0.05);
        // 始点も終点もクリックした点のまま。
        expect(Math.hypot(here.horizontal.p0.x, here.horizontal.p0.y)).toBeLessThan(0.05);
        expect(here.end.distanceTo(target)).toBeLessThan(0.05);
      }
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
