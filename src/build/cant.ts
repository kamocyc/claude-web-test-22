import type { XZ } from '../core/curve';
import { RAIL_GAUGE, clamp } from '../core/units';
import type { NetworkClass } from '../network/classes';
import { turnoutTangentLength } from '../network/junction';
import type { Branch, Network, NodeId, SegmentId } from '../network/network';
import type { Crossing } from '../network/crossings';

/**
 * 線路のカント (曲線で外側のレールを高くする量)。
 *
 * 曲率から直に導く。緩和曲線では曲率が弧長に比例して立ち上がるので、
 * カントもそのまま比例して立ち上がる (実物のカント逓減と同じ形になる)。
 * 別に「カント逓減区間」を持つ必要がない。
 *
 * ただし**交差点の面と踏切には持ち込まない**。
 *
 * - 分岐器では、直進側にカントがあって分岐側に無いと交差点の面 (道床) が
 *   ねじれる。実物でも分岐器はカントを抜いた所に置く。
 * - 踏切では舗装をレール頭頂面に合わせるので、カントが付いていると
 *   道路側がそのぶん捻れる。
 *
 * どちらも面にかかる手前で 0 に戻す。
 */

/** カントを抜くのに使う長さ [m]。 */
const RUNOFF = 18;

/** 交差点の面にかかる手前で、さらに空けておく余裕 [m]。 */
const FACE_MARGIN = 2;

/** 交差点の面が広がる長さの上限 [m] (`rules.ts` のトリム上限と同じ)。 */
const MAX_FACE = 40;

/** 分かれた 2 本の重なりを追う刻み [m]。 */
const OVERLAP_STEP = 2;

/** 重なりを追う長さの上限 [m]。これより長く重なる分岐は想定しない。 */
const MAX_OVERLAP = 140;

/** 曲率 `curvature` [1/m] における横断勾配 (中心から右へ 1 m あたりの上がり)。 */
export function cantRoll(cls: NetworkClass, curvature: number): number {
  if (cls.kind !== 'rail' || cls.maxCant <= 0) return 0;
  const radius = Math.abs(curvature) > 1e-9 ? 1 / Math.abs(curvature) : Infinity;
  // 標準半径 (`smoothRadius`) でカント最大。緩い曲線では半径に反比例して
  // 小さくなり、標準より急な曲線では逆に**抜いていく**。急曲線は徐行して
  // 通るので、実物でもカントは付けない (最小半径で 0 になる)。
  const ratio =
    radius >= cls.smoothRadius
      ? cls.smoothRadius / radius
      : clamp((radius - cls.minRadius) / Math.max(cls.smoothRadius - cls.minRadius, 1e-3), 0, 1);
  const cant = cls.maxCant * ratio;
  // 外側 (曲率中心の反対側) のレールが上がる。右カーブ (曲率が正) なら
  // 右が下がるので、右向きの傾きは負。
  return -Math.sign(curvature) * (cant / RAIL_GAUGE);
}

/** セグメント上で、カントを抜いておきたい所。 */
interface FlatZone {
  /** 中心の弧長 [m]。 */
  s: number;
  /** そこから前後、完全に 0 にする長さ [m]。 */
  flat: number;
}

/** セグメントごとのカント (描画・当たり判定で使う横断勾配)。 */
export type CantProfile = (s: number) => number;

/**
 * 分岐したあと、2 本の道床がまだ重なっている長さ [m]。
 *
 * 分岐器を出てすぐは、分かれた 2 本が同じ所を通っている。左右のレールが
 * 離れきるまでは 1 つの構造物なので、そこに違うカントを付けると、同じ場所に
 * 高さの違う面が 2 枚できてしまう。実物でも、分岐器とその先の重なりが
 * 解けるまでは水平な 1 枚の面に載せる。
 *
 * 同じ弧長の点どうしの距離を追い、道床の幅ぶん離れた所を重なりの終わりと
 * みなす。
 */
function overlapReach(network: Network, a: Branch, b: Branch): number {
  const need = a.cls.halfWidth + b.cls.halfWidth;
  const als = [network.alignmentOf(a.segment), network.alignmentOf(b.segment)];
  const brs = [a, b];
  const limit = Math.min(MAX_OVERLAP, als[0].length, als[1].length);
  const at = (i: number, s: number): XZ => {
    const L = als[i].length;
    return als[i].horizontal.pointAt(brs[i].atStart ? Math.min(s, L) : Math.max(0, L - s));
  };
  let s = 0;
  for (; s < limit; s = Math.min(s + OVERLAP_STEP, limit)) {
    const next = Math.min(s + OVERLAP_STEP, limit);
    if (at(0, next).distanceTo(at(1, next)) >= need) return next;
    if (next >= limit) break;
  }
  return limit;
}

/**
 * ノードのまわりでカントを抜いておく長さ [m]。0 ならそのまま通してよい。
 *
 * 見るのは 3 つ。
 *
 *  - **交差点の面**が広がっている範囲。面の中でカントが枝ごとに違うと
 *    道床がねじれる。`solveJunctions` を解く前に要るので、枝の形だけから
 *    見積もる。
 *  - 分岐したあと**道床が重なっている**範囲 (`overlapReach`)。浅い分岐ほど
 *    長く、交差点の面よりずっと先まで続く。
 *  - 面が無い継ぎ目でも、**両側のカントが食い違う**なら 0 に戻す。曲線と
 *    直線がほぼ一直線に繋がっている所では、そのままだと帯に段差ができる。
 */
function flatReach(network: Network, node: NodeId): number {
  const branches = network.branchesAt(node);
  if (branches.length === 0) return 0;

  let face = 0;
  let overlap = 0;
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const dot = clamp(branches[i].dir.dot(branches[j].dir), -1, 1);
      // 同じ側へ出ていく枝どうしだけが重なる。向かい合う枝 (線形の続き)
      // は最初から離れていくので測るまでもない。
      if (dot > 0) overlap = Math.max(overlap, overlapReach(network, branches[i], branches[j]));
      const deflection = Math.PI - Math.acos(dot);
      // ほぼ一直線に繋がる継ぎ目には交差点の面ができない。
      if (deflection < 2 * (Math.PI / 180)) continue;
      const radius = Math.min(branches[i].cls.smoothRadius, branches[j].cls.smoothRadius);
      face = Math.max(
        face,
        turnoutTangentLength(radius, deflection),
        branches[i].cls.halfWidth + branches[j].cls.halfWidth,
      );
    }
  }
  const reach = Math.max(Math.min(face, MAX_FACE), Math.min(overlap, MAX_OVERLAP));
  if (reach > 0) return reach + FACE_MARGIN;

  // 面が無い継ぎ目。カントが繋がっていれば触らない。外向きに測った
  // 曲率は符号が逆になるので、繋がっていれば横断勾配の和が 0 になる。
  const rails = branches.filter((b) => b.cls.kind === 'rail');
  if (rails.length !== 2 || rails.length !== branches.length) {
    return branches.some((b) => cantRoll(b.cls, b.curvature) !== 0) ? FACE_MARGIN : 0;
  }
  const gap = Math.abs(cantRoll(rails[0].cls, rails[0].curvature) + cantRoll(rails[1].cls, rails[1].curvature));
  return gap > 1e-4 ? FACE_MARGIN : 0;
}

/**
 * 線路のカントをセグメントごとに用意する。
 *
 * 交差点の面・踏切の手前で 0 に戻すため、ネットワーク全体を見る必要がある。
 */
export function computeCant(network: Network, crossings: Crossing[]): Map<SegmentId, CantProfile> {
  const zones = new Map<SegmentId, FlatZone[]>();
  const add = (segment: SegmentId, zone: FlatZone): void => {
    const list = zones.get(segment);
    if (list) list.push(zone);
    else zones.set(segment, [zone]);
  };

  const reachOf = new Map<NodeId, number>();
  for (const seg of network.segments.values()) {
    if (network.classOf(seg).kind !== 'rail') continue;
    const length = network.alignmentOf(seg.id).length;
    for (const [node, s] of [
      [seg.a, 0],
      [seg.b, length],
    ] as const) {
      let reach = reachOf.get(node);
      if (reach === undefined) {
        reach = flatReach(network, node);
        reachOf.set(node, reach);
      }
      if (reach > 0) add(seg.id, { s, flat: reach });
    }
  }

  for (const crossing of crossings) {
    if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
    add(crossing.rail.segment, {
      s: crossing.rail.s,
      flat: crossing.road.cls.halfWidth + FACE_MARGIN,
    });
  }

  const out = new Map<SegmentId, CantProfile>();
  for (const seg of network.segments.values()) {
    const cls = network.classOf(seg);
    if (cls.kind !== 'rail' || cls.maxCant <= 0) continue;
    const alignment = network.alignmentOf(seg.id);
    const list = zones.get(seg.id) ?? [];
    out.set(seg.id, (s: number) => {
      const roll = cantRoll(cls, alignment.horizontal.curvatureAt(s));
      if (roll === 0) return 0;
      let factor = 1;
      for (const zone of list) {
        const d = Math.abs(s - zone.s);
        if (d <= zone.flat) return 0;
        factor = Math.min(factor, Math.min(1, (d - zone.flat) / RUNOFF));
      }
      return roll * factor;
    });
  }
  return out;
}
