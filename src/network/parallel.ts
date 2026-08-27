import { Vector2, Vector3 } from 'three';
import { Alignment } from '../core/alignment';
import {
  bezierDerivative,
  bezierSecondDerivative,
  HorizontalCurve,
  perp,
  reversedCurve,
  type XZ,
} from '../core/curve';
import { VerticalProfile } from '../core/profile';
import { DEG, clamp } from '../core/units';
import type { NetworkClass, NetworkKind } from './classes';
import type { PlacementPreview } from './editing';
import type { Network, NodeId, SegmentId } from './network';
import { junctionReach } from './rules';
import { CROSSING_END_MARGIN } from './editing';

/**
 * 平行スナップ。
 *
 * 複線・側道は「1 本の種別」ではなく、**既存の線形に平行な線形をもう 1 本
 * 敷いたもの**として作る。敷くときに既存の線形へスナップし、その平面形と
 * 縦断をそのまま横にずらして使うので、
 *
 * - 間隔がどこでも一定になる (曲線でも開かない)
 * - 高さが揃うので、橋・トンネルの境界や踏切の位置が自然に一致する
 *
 * ようになる。1 本 1 本は普通のセグメントなので、片側だけ分岐させる・
 * 片側だけ橋にする、といったことは今までどおりできる。
 *
 * 敷いたあとで「どれとどれが平行に並んでいるか」を知りたい所 (橋・
 * トンネルの区間を揃える、架線柱を 1 基にまとめる) では、線形どうしの
 * 形から `findParallelGroups` で求め直す。ノードの分割や撤去で崩れる
 * 参照を持たなくて済む。
 */

/** 平行に並べるときの中心間隔 [m]。舗装 (道床) の縁が触れ合う幅にする。 */
export function parallelSpacing(cls: NetworkClass, other: NetworkClass = cls): number {
  return Math.round((cls.halfWidth + other.halfWidth + 0.2) * 10) / 10;
}

/**
 * 平面線形を横に `offset` [m] ずらした曲線。
 *
 * 端点は法線方向にそのままずらし、制御点の長さは曲率に応じて縮める
 * (半径 R の弧を曲率中心の側へ d ずらすと半径 R - d になる)。この規模の
 * 曲線 (最小半径 45 m 以上、ずらす量は 10 m 程度) では、正確なオフセット
 * 曲線との差は数 cm に収まる。
 */
export function offsetCurve(curve: HorizontalCurve, offset: number): HorizontalCurve {
  if (Math.abs(offset) < 1e-6) return curve;
  const n = curve.pieceCount;
  const shrink = (k: number): number => clamp(1 - offset * k, 0.05, 4);
  // ピースごとにずらす。緩和曲線のように曲率が変わる線形でも、ピースの
  // 端を共有したままずれるので、繋ぎ目が開かない。
  const points: XZ[] = [];
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    const a = curve.points[k];
    const ca = curve.points[k + 1];
    const cb = curve.points[k + 2];
    const b = curve.points[k + 3];
    const ta = new Vector2().subVectors(ca, a).normalize();
    const tb = new Vector2().subVectors(b, cb).normalize();
    const oa = a.clone().add(perp(ta).multiplyScalar(offset));
    const ob = b.clone().add(perp(tb).multiplyScalar(offset));
    const ha = ca.distanceTo(a) * shrink(pieceCurvature(curve, i, 0));
    const hb = cb.distanceTo(b) * shrink(pieceCurvature(curve, i, 1));
    if (i === 0) points.push(oa);
    points.push(oa.clone().addScaledVector(ta, ha), ob.clone().addScaledVector(tb, -hb), ob);
  }
  return new HorizontalCurve(points);
}

/** ピース `i` の端 (t = 0 または 1) における曲率。 */
function pieceCurvature(curve: HorizontalCurve, i: number, t: 0 | 1): number {
  const k = i * 3;
  const p = curve.points;
  const d = bezierDerivative(p[k], p[k + 1], p[k + 2], p[k + 3], t);
  const dd = bezierSecondDerivative(p[k], p[k + 1], p[k + 2], p[k + 3], t);
  const speed = d.length();
  if (speed < 1e-6) return 0;
  return (d.x * dd.y - d.y * dd.x) / (speed * speed * speed);
}

/** 平面線形の向きを反転する (形は変わらない)。 */
export function reverseCurve(curve: HorizontalCurve): HorizontalCurve {
  return reversedCurve(curve);
}

/**
 * 基準線形の `[s0, s1]` を横に `offset` [m] ずらした線形。
 *
 * `s1 < s0` なら向きが逆の線形になる (基準線と反対向きに引いたとき)。
 * 高さと勾配は基準線形から引き継ぐので、並んだ線の縦断が揃う。
 */
export function parallelAlignment(
  reference: Alignment,
  s0: number,
  s1: number,
  offset: number,
): Alignment | null {
  const forward = s1 >= s0;
  const a = Math.min(s0, s1);
  const b = Math.max(s0, s1);
  if (b - a < 1) return null;

  const sub = reference.subAlignment(a, b);
  let horizontal = sub.horizontal;
  let { y0, y1, m0, m1 } = sub.vertical;
  let lateral = offset;
  if (!forward) {
    horizontal = reverseCurve(horizontal);
    // 弧長の向きが逆になると、右手側も勾配の符号も入れ替わる。
    lateral = -offset;
    [y0, y1] = [y1, y0];
    [m0, m1] = [-m1, -m0];
  }

  const shifted = offsetCurve(horizontal, lateral);
  if (shifted.length < 1) return null;
  // 曲線の内側にずらすと弧長が縮む。同じ高低差を短い距離で登ることに
  // なるので、勾配は長さの比で読み替える。
  const scale = horizontal.length / Math.max(1e-6, shifted.length);
  return new Alignment(
    shifted,
    new VerticalProfile(y0, y1, m0 * scale, m1 * scale, shifted.length),
  );
}

/**
 * 続けて敷く線形をまとめて 1 つの敷設プレビューにする (平行スナップ用)。
 *
 * 敷くのは線形ごとに 1 本ずつだが、長さ・最小半径・最大勾配といった
 * 「いま引いている区間ぜんぶ」の値は、まとめて出さないと意味がない。
 * 平面曲線は制御点をそのまま繋ぐ (継ぎ目の点は共有する)。
 */
export function previewFromAlignments(alignments: readonly Alignment[]): PlacementPreview {
  if (alignments.length === 1) return previewFromAlignment(alignments[0]);
  const points: XZ[] = [];
  for (const a of alignments) {
    const own = a.horizontal.points;
    points.push(...(points.length === 0 ? own : own.slice(1)));
  }
  const horizontal = new HorizontalCurve(points);
  const first = alignments[0];
  const last = alignments[alignments.length - 1];
  const start = first.sampleAt(0).pos;
  const end = last.sampleAt(last.length).pos;
  return {
    horizontal,
    start: new Vector3(start.x, start.y, start.z),
    end: new Vector3(end.x, end.y, end.z),
    startGrade: first.vertical.m0,
    endGrade: last.vertical.m1,
    radius: Math.min(...alignments.map((a) => a.horizontal.extremeCurvature(48).minRadius)),
    grade: Math.max(...alignments.map((a) => a.vertical.maxGrade(32))),
    endTangent: last.horizontal.tangentAt(last.length),
    endCurvature: last.horizontal.curvatureAt(last.length),
  };
}

/** 線形をそのまま敷設プレビューにする (平行スナップ用)。 */
export function previewFromAlignment(alignment: Alignment): PlacementPreview {
  const horizontal = alignment.horizontal;
  const length = horizontal.length;
  const start = alignment.sampleAt(0).pos;
  const end = alignment.sampleAt(length).pos;
  return {
    horizontal,
    start: new Vector3(start.x, start.y, start.z),
    end: new Vector3(end.x, end.y, end.z),
    startGrade: alignment.vertical.m0,
    endGrade: alignment.vertical.m1,
    radius: horizontal.extremeCurvature(48).minRadius,
    grade: alignment.vertical.maxGrade(32),
    endTangent: horizontal.tangentAt(length),
    endCurvature: horizontal.curvatureAt(length),
  };
}

// ------------------------------------------------------------ スナップ

/** 平行に敷くときの基準となる既存の線形。 */
export interface ParallelReference {
  segment: SegmentId;
  /** 基準線形の弧長方向から見た横距 [m] (右手が正)。 */
  offset: number;
  /** 基準線形上の弧長 (始点)。 */
  s: number;
  /** その弧長での、平行線上の点。 */
  pos: Vector3;
}

export interface ParallelSnapOptions {
  /** 基準から外れる向き。ここに 2 m 以上進める線形だけを選ぶ。 */
  direction?: Vector2;
  /** 基準にしないセグメント。 */
  exclude?: Iterable<SegmentId>;
  /**
   * `point` の高さからどれだけ離れた線形まで基準にするか [m]。
   * 既定は 25 m (高架の脇にもう 1 本架ける場面まで許す)。
   */
  heightTolerance?: number;
}

/**
 * 連結 3 次ベジエは制御点の凸包の中に収まるので、制御点の外接矩形との距離が
 * `radius` を超えていれば、その線形は確実にそれより遠い。スナップの
 * 判定は毎フレーム全セグメントに対して走るので、まずここで落とす。
 */
function farFrom(alignment: Alignment, x: number, z: number, radius: number): boolean {
  const h = alignment.horizontal;
  const xs = h.points.map((p) => p.x);
  const zs = h.points.map((p) => p.y);
  const dx = Math.max(Math.min(...xs) - x, 0, x - Math.max(...xs));
  const dz = Math.max(Math.min(...zs) - z, 0, z - Math.max(...zs));
  return dx * dx + dz * dz > radius * radius;
}

/** 線形上で、その点にいちばん近い弧長。 */
export function stationOf(alignment: Alignment, x: number, z: number): number {
  const length = alignment.length;
  const steps = Math.max(8, Math.ceil(length / 2));
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i <= steps; i++) {
    const s = (length * i) / steps;
    const p = alignment.horizontal.pointAt(s);
    const d = (p.x - x) ** 2 + (p.y - z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = s;
    }
  }
  // 粗い刻みのまわりを 1 段だけ詰める。
  const span = length / steps;
  for (let i = -4; i <= 4; i++) {
    const s = clamp(best + (span * i) / 4, 0, length);
    const p = alignment.horizontal.pointAt(s);
    const d = (p.x - x) ** 2 + (p.y - z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = s;
    }
  }
  return best;
}

/**
 * その地点から平行に敷ける既存の線形を探す。
 *
 * 見つかった線形の路肩がちょうど触れ合う位置 (`parallelSpacing`) に
 * スナップする。既に並んでいる線の隣を選べば、そのまま 3 線・4 線と
 * 増やしていける。
 */
export function findParallelReference(
  network: Network,
  cls: NetworkClass,
  point: Vector3,
  options: ParallelSnapOptions = {},
): ParallelReference | null {
  const exclude = new Set(options.exclude ?? []);
  let best: ParallelReference | null = null;
  let bestScore = Infinity;

  for (const seg of network.segments.values()) {
    if (exclude.has(seg.id)) continue;
    const other = network.classOf(seg);
    if (other.kind !== cls.kind) continue;

    const alignment = network.alignmentOf(seg.id);
    const spacing = parallelSpacing(cls, other);
    if (farFrom(alignment, point.x, point.z, spacing * 1.9)) continue;

    const s = stationOf(alignment, point.x, point.z);
    const sample = alignment.sampleAt(s);
    const dx = point.x - sample.pos.x;
    const dz = point.z - sample.pos.z;
    const lateral = dx * sample.right.x + dz * sample.right.z;
    const along = dx * sample.forward.x + dz * sample.forward.z;
    const distance = Math.hypot(dx, dz);
    // 端の外側にはみ出している所からは平行に引けない (線形が無い)。
    if (Math.abs(along) > spacing) continue;
    // 重なるほど近い所は「途中に取り付く」場面なので譲る。
    if (distance < spacing * 0.45 || distance > spacing * 1.9) continue;
    // 高架や掘割の脇では、地形とその線形の高さが大きく違う。そこへ並べる
    // (もう 1 本の高架を架ける) のは普通の使い方なので許すが、地表の
    // 線形が近くにあればそちらを優先する。
    const rise = Math.abs(point.y - sample.pos.y);
    if (rise > (options.heightTolerance ?? 25)) continue;

    // 続けて引くときは、その向きに進める線形だけを基準にする。
    // ノードの上では前後 2 本が同じだけ近いので、これで決まる。
    if (options.direction) {
      const ahead = sample.forward.x * options.direction.x + sample.forward.z * options.direction.y;
      const room = ahead >= 0 ? alignment.length - s : s;
      if (room < 2) continue;
    }

    const side = lateral >= 0 ? 1 : -1;
    const offset = side * spacing;
    const at = new Vector3(
      sample.pos.x + sample.right.x * offset,
      sample.pos.y,
      sample.pos.z + sample.right.z * offset,
    );
    // その隣がもう埋まっているなら、そこには敷けない。既に並んでいる線の
    // 外側を指せば、そちらが基準になって 3 線目・4 線目が足せる。
    if (occupiedSlot(network, cls, at, seg.id)) continue;

    const score = Math.abs(distance - spacing) + rise * 0.3;
    if (score < bestScore) {
      bestScore = score;
      best = { segment: seg.id, offset, s, pos: at };
    }
  }
  return best;
}

/** その位置が、既にある線形と重なるか。 */
function occupiedSlot(
  network: Network,
  cls: NetworkClass,
  at: Vector3,
  reference: SegmentId,
): boolean {
  for (const seg of network.segments.values()) {
    if (seg.id === reference) continue;
    const other = network.classOf(seg);
    if (other.kind !== cls.kind) continue;
    const reach = parallelSpacing(cls, other) * 0.8;
    const alignment = network.alignmentOf(seg.id);
    if (farFrom(alignment, at.x, at.z, reach)) continue;

    const s = stationOf(alignment, at.x, at.z);
    const sample = alignment.sampleAt(s);
    if (Math.abs(sample.pos.y - at.y) > 6) continue;
    const dx = at.x - sample.pos.x;
    const dz = at.z - sample.pos.z;
    // 舗装 (道床) の縁が触れ合うより近ければ、そこはもう埋まっている。
    if (Math.hypot(dx, dz) < reach) return true;
  }
  return false;
}

// ---------------------------------------------------- ルートに沿った平行線

/** 平行に敷く区間 1 本ぶん。1 本のセグメントとして敷かれる。 */
export interface ParallelLeg {
  /** 基準にした既存セグメント (ふつうは 1 本)。 */
  references: SegmentId[];
  /** 横にずらした線形。 */
  alignment: Alignment;
}

export interface ParallelRouteOptions {
  /** たどってよい全長 [m]。 */
  maxLength?: number;
  /** たどってよい区間数。 */
  maxLegs?: number;
}

/** 既定の追跡上限。1 回のドラッグで敷ける長さと本数を抑える。 */
const ROUTE_MAX_LENGTH = 1200;
const ROUTE_MAX_LEGS = 16;
/** 基準の端を「越えている」と認める距離 [m]。 */
const ROUTE_BEYOND = 0.5;
/** 隣の枝へ進んでよい向きの一致度 (cos)。折り返しや急な分岐へは入らない。 */
const ROUTE_STRAIGHT_COS = 0.3;
/** 交差点の面をよけるために、その先へ食い込ませてよい長さの上限 [m]。 */
const ROUTE_CLEARANCE_MAX = 40;

/**
 * 始点の隣から終点の隣まで、既存の線形の**ルートをたどった**平行線。
 *
 * 基準にした線形の端まで来たら、そこで止めずにノードの先へ続ける。既存の
 * 複線が途中で分割されていても (橋・トンネル・踏切・分岐でノードが入る)、
 * 端から端まで一度に隣を敷ける。
 *
 * 返すのは**区間ごとの線形の列**で、1 本には繋げていない。縦断は区間ごとに
 * 3 次エルミート 1 本なので、全部まとめると途中の高さを拾えないため。区切りは
 * 基準と同じ位置に入るので、橋・トンネルの境目が隣どうしで揃う。
 *
 * 分岐 (枝が 3 本以上のノード) では、カーソルの向きに最も合う枝へ進む。
 * ただし来た向きから大きく折れる枝には入らないので、引き返すことはない。
 */
export function parallelRoute(
  network: Network,
  cls: NetworkClass,
  reference: ParallelReference,
  from: Vector3,
  to: Vector3,
  options: ParallelRouteOptions = {},
): ParallelLeg[] {
  const spans = traceRoute(network, cls, reference, from, to, options);
  const legs: ParallelLeg[] = [];
  for (const group of groupSpans(network, cls, spans)) {
    const alignment = legFromSpans(network, group);
    if (alignment) legs.push({ references: group.map((span) => span.segment), alignment });
  }
  return chainLegs(legs);
}

/** ルートの 1 区間 (どのセグメントの、どこからどこまでを、どちらへずらすか)。 */
interface RouteSpan {
  segment: SegmentId;
  /** 基準セグメント上の弧長。`s1 < s0` なら基準と逆向きに進む。 */
  s0: number;
  s1: number;
  /** 基準セグメントの弧長方向から見た横距 [m]。 */
  offset: number;
  /** この区間の終わりにあるノード (ルートの終端なら null)。 */
  node: NodeId | null;
}

/** 既存の線形をたどって、区間の列にする。 */
function traceRoute(
  network: Network,
  cls: NetworkClass,
  reference: ParallelReference,
  from: Vector3,
  to: Vector3,
  options: ParallelRouteOptions,
): RouteSpan[] {
  if (!network.segments.has(reference.segment)) return [];
  const maxLength = options.maxLength ?? ROUTE_MAX_LENGTH;
  const maxLegs = options.maxLegs ?? ROUTE_MAX_LEGS;

  const spans: RouteSpan[] = [];
  const visited = new Set<SegmentId>();
  let total = 0;
  let side = 0;
  let step: RouteStep | null = null;

  for (let guard = 0; guard < maxLegs && total < maxLength; guard++) {
    const segment: SegmentId = step ? step.segment : reference.segment;
    if (visited.has(segment)) break;
    visited.add(segment);

    const alignment = network.alignmentOf(segment);
    const s0: number = step ? step.s0 : stationOf(alignment, from.x, from.z);
    const target = stationOf(alignment, to.x, to.z);
    // 最初の区間だけは、始点とカーソルの投影の前後関係で向きが決まる。
    const forward: boolean = step ? step.forward : target >= s0;
    const exit: number = forward ? alignment.length : 0;
    // 「進む向きの右手が正」で測った敷く側。区間をまたいでも変わらない。
    if (side === 0) side = (reference.offset >= 0 ? 1 : -1) * (forward ? 1 : -1);

    const spacing = parallelSpacing(cls, network.classOf(network.getSegment(segment)));
    const offset = side * spacing * (forward ? 1 : -1);
    const beyond: boolean =
      Math.abs(target - exit) < ROUTE_BEYOND && aheadOfEnd(alignment, exit, forward, to);
    const next: RouteStep | null = beyond
      ? nextStep(network, cls, segment, alignment, exit, forward, to, visited)
      : null;
    const seg = network.getSegment(segment);
    spans.push({
      segment,
      s0,
      s1: beyond ? exit : target,
      offset,
      node: next ? (forward ? seg.b : seg.a) : null,
    });
    total += Math.abs((beyond ? exit : target) - s0);
    if (!next) break;
    step = next;
  }

  // 長さ 0 の区間 (端ぴったりから引き始めたとき) は捨てる。
  return spans.filter((span, i) => Math.abs(span.s1 - span.s0) >= 1 || i === spans.length - 1);
}

/** ルートの次の区間 (どのセグメントへ、どちら向きに入るか)。 */
interface RouteStep {
  segment: SegmentId;
  s0: number;
  forward: boolean;
}

/** カーソルが、その端より先まで来ているか。 */
function aheadOfEnd(
  alignment: Alignment,
  exit: number,
  forward: boolean,
  to: Vector3,
): boolean {
  const sample = alignment.sampleAt(exit);
  const sign = forward ? 1 : -1;
  const along =
    (to.x - sample.pos.x) * sample.forwardXZ.x * sign +
    (to.z - sample.pos.z) * sample.forwardXZ.y * sign;
  return along > ROUTE_BEYOND;
}

/**
 * 端のノードから続く枝を選ぶ。
 *
 * カーソルの向きに最も合う枝へ進む (分岐でどちらへ行きたいかは、指している
 * 所が決める)。ただし来た向きから大きく折れる枝は候補にしない。駅の構内線
 * にも入らない — 駅の脇に線路をもう 1 本足すのは、ホームを増やす操作とは
 * 別のことなので。
 */
function nextStep(
  network: Network,
  cls: NetworkClass,
  segment: SegmentId,
  alignment: Alignment,
  exit: number,
  forward: boolean,
  to: Vector3,
  visited: ReadonlySet<SegmentId>,
): RouteStep | null {
  const seg = network.getSegment(segment);
  const nodeId = forward ? seg.b : seg.a;
  const node = network.nodes.get(nodeId);
  if (!node) return null;

  const tangent = alignment.horizontal.tangentAt(exit);
  const inDir = forward ? tangent.clone() : tangent.clone().negate();
  const toCursor = new Vector2(to.x - node.pos.x, to.z - node.pos.z);
  if (toCursor.lengthSq() > 1e-6) toCursor.normalize();
  else toCursor.copy(inDir);

  let best: { segment: SegmentId; atStart: boolean } | null = null;
  let bestScore = -Infinity;
  for (const branch of network.branchesAt(nodeId)) {
    if (branch.segment === segment || visited.has(branch.segment)) continue;
    if (branch.cls.kind !== cls.kind) continue;
    if (network.getSegment(branch.segment).stationTrack !== undefined) continue;
    if (branch.dir.dot(inDir) < ROUTE_STRAIGHT_COS) continue;
    const score = branch.dir.dot(toCursor);
    if (score > bestScore) {
      bestScore = score;
      best = { segment: branch.segment, atStart: branch.atStart };
    }
  }
  if (!best) return null;
  const next = network.alignmentOf(best.segment);
  return { segment: best.segment, s0: best.atStart ? 0 : next.length, forward: best.atStart };
}

/**
 * 区間をセグメント 1 本ぶんずつのまとまりに分ける。
 *
 * ふつうは基準の区切り (ノード) がそのまま区切りになる。ただし**交差点の
 * ノード**の真横で区切ると、そこにできる端点が交差点の面の中に入ってしまい
 * 敷けない。そういう所では区切らずに、面から出た所まで次の区間へ食い込ませる。
 */
function groupSpans(network: Network, cls: NetworkClass, spans: RouteSpan[]): RouteSpan[][] {
  const groups: RouteSpan[][] = [];
  const rest = [...spans];
  let current: RouteSpan[] = [];

  for (let i = 0; i < rest.length; i++) {
    const span = rest[i];
    current.push(span);
    if (span.node === null) break;

    const need = clearanceAt(network, cls, span);
    if (need <= 0) {
      groups.push(current);
      current = [];
      continue;
    }
    const next = rest[i + 1];
    if (!next) break;
    const room = Math.abs(next.s1 - next.s0);
    // 次の区間ごと飲み込んでしまうなら、その先の区切りで切る。
    if (room <= need + 1) continue;
    const cut = next.s0 + Math.sign(next.s1 - next.s0) * need;
    current.push({ ...next, s1: cut, node: null });
    groups.push(current);
    current = [];
    rest[i + 1] = { ...next, s0: cut };
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

/** 交差している枝とみなす角度の下限 (これより一直線に近い枝は線形の続き)。 */
const CROSSING_BRANCH_SIN = Math.sin(5 * DEG);

/**
 * そのノードを横切っている線路をよけるのに、ノードの先へどれだけ進めばよいか [m]。
 *
 * 線路の交差点は面を持たない (`junctionReach` が 0) ので、面だけを見ていると
 * 交差点のちょうど真横で区間を切ってしまう。**面が無くても相手の道床は
 * 横たわっている**ので、平行線の端がその上に落ちる。そこで切ると、端点が
 * 相手の路面に重なるうえ、交点が区間の端に来るので相手と繋がれない
 * (`resolveAutoJunctions` も `planCrossingHeights` も端の近くの交点は扱わない)。
 *
 * 平行線が相手を横切る所を求め、そこから**道床 2 本分**か
 * **`CROSSING_END_MARGIN` の内側**か、遠い方だけ先へ進める。前者で端点が
 * 相手の路面から出て、後者で交点が区間の内側に入るので、あとはふつうの
 * 交差として分割・接続される。
 */
function branchClearance(
  network: Network,
  cls: NetworkClass,
  span: RouteSpan,
): number {
  const node = span.node;
  if (node === null) return 0;
  const alignment = network.alignmentOf(span.segment);
  const tangent = alignment.horizontal.tangentAt(span.s1);
  const normal = perp(tangent);
  const ahead = Math.sign(span.s1 - span.s0) || 1;
  let need = 0;

  for (const branch of network.branchesAt(node)) {
    if (branch.segment === span.segment) continue;
    if (branch.cls.kind !== cls.kind) continue;
    const sin = tangent.x * branch.dir.y - tangent.y * branch.dir.x;
    // 一直線に繋がる枝は「線形の続き」で、横切ってはいない。
    if (Math.abs(sin) < CROSSING_BRANCH_SIN) continue;
    // 平行線が相手の中心線を横切る所 (ノードからの弧長、進む向きが正)。
    const side = normal.x * branch.dir.y - normal.y * branch.dir.x;
    const at = ahead * -span.offset * (side / sin);
    // 端点が相手の路面から出て、なおかつ交点が区間の端から
    // `CROSSING_END_MARGIN` 以上内側に入る距離。
    const clear = Math.max(
      (cls.halfWidth + branch.cls.halfWidth) / Math.abs(sin),
      CROSSING_END_MARGIN + 1,
    );
    // 交点がもう区間の中 (区切りから `clear` 以上離れている) なら動かさない。
    // 浅く交わる所では交点が遠いので、ここで無駄に食い込ませない。
    if (Math.abs(at) >= clear) continue;
    need = Math.max(need, at + clear);
  }
  return Math.min(Math.max(0, need), ROUTE_CLEARANCE_MAX);
}

/**
 * その交差点の面から出るのに、ノードの先へどれだけ進めばよいか [m]。
 *
 * 平行線はもともと横に離れているので、面の広がりがそれより小さければ
 * 進まなくてよい。判定は敷設の規則 (`checkJunctionSpacing`) と同じ半径を
 * 見るので、通した所は必ず置ける。面を持たない線路の交差点では、代わりに
 * 横たわっている道床をよける (`branchClearance`)。
 */
function clearanceAt(network: Network, cls: NetworkClass, span: RouteSpan): number {
  const node = span.node;
  if (node === null) return 0;
  const lateral = Math.abs(span.offset);
  const reach = junctionReach(network, node) + cls.halfWidth * 0.5 + 1;
  const byFace =
    reach <= lateral
      ? 0
      : Math.min(Math.sqrt(reach * reach - lateral * lateral), ROUTE_CLEARANCE_MAX);
  return Math.max(byFace, branchClearance(network, cls, span));
}

/** まとまりを 1 本の線形にする。 */
function legFromSpans(network: Network, group: RouteSpan[]): Alignment | null {
  const parts: Alignment[] = [];
  for (const span of group) {
    const part = parallelAlignment(network.alignmentOf(span.segment), span.s0, span.s1, span.offset);
    if (part) parts.push(part);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];

  // 交差点の面をよけるために繋いだ区間。平面は制御点をそのまま繋ぎ、縦断は
  // 両端の高さと勾配で 1 本の 3 次エルミートにする (基準の縦断は繋ぎ目で
  // 勾配が揃えてあるので、途中の高さもほぼそのままなぞる)。
  const points: XZ[] = [];
  let at: XZ | null = null;
  for (const part of parts) {
    const own = part.horizontal.points.map((p) => p.clone());
    if (at) own[0] = at.clone();
    points.push(...(points.length === 0 ? own : own.slice(1)));
    at = part.horizontal.pointAt(part.length);
  }
  const horizontal = new HorizontalCurve(points);
  const first = parts[0].vertical;
  const last = parts[parts.length - 1].vertical;
  return new Alignment(
    horizontal,
    new VerticalProfile(first.y0, last.y1, first.m0, last.m1, horizontal.length),
  );
}

/**
 * 区間どうしの継ぎ目を閉じる。
 *
 * 基準の線形がノードで少しでも折れていると、その前後の区間は**それぞれの
 * 接線に直角**にずれるので、平行線の端がわずかに食い違う。敷くときは前の
 * 区間の終点ノードにそのまま繋がるので、プレビューもそこへ寄せておく。
 */
function chainLegs(legs: ParallelLeg[]): ParallelLeg[] {
  for (let i = 1; i < legs.length; i++) {
    const before = legs[i - 1].alignment;
    const at = before.horizontal.pointAt(before.length);
    legs[i] = { ...legs[i], alignment: withStart(legs[i].alignment, at, before.vertical.y1) };
  }
  return legs;
}

/** 始点を差し替えた線形。 */
function withStart(alignment: Alignment, at: XZ, y: number): Alignment {
  const points = alignment.horizontal.points.map((p) => p.clone());
  points[0] = at.clone();
  const horizontal = new HorizontalCurve(points);
  const v = alignment.vertical;
  return new Alignment(horizontal, new VerticalProfile(y, v.y1, v.m0, v.m1, horizontal.length));
}

// ------------------------------------------------------------ 平行な組

/** 平行に並んでいる線形のまとまり。 */
export interface ParallelGroup {
  kind: NetworkKind;
  /** 並んでいるセグメント (ID の昇順)。 */
  members: SegmentId[];
}

/** 中心間隔として認める倍率の幅。 */
const SPACING_MIN = 0.55;
const SPACING_MAX = 1.7;
/** 平行とみなす向きの一致度 (cos)。 */
const PARALLEL_COS = 0.985;
/** 平行とみなす高低差 [m]。 */
const PARALLEL_HEIGHT = 1.5;
/** 相手に沿っていると認める割合。 */
const PARALLEL_COVERAGE = 0.6;

interface Trace {
  s: number;
  x: number;
  z: number;
  y: number;
  dx: number;
  dz: number;
}

function trace(network: Network, id: SegmentId, step = 4): Trace[] {
  const alignment = network.alignmentOf(id);
  const n = Math.max(1, Math.ceil(alignment.length / step));
  const out: Trace[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (alignment.length * i) / n;
    const sample = alignment.sampleAt(s);
    out.push({
      s,
      x: sample.pos.x,
      z: sample.pos.z,
      y: sample.pos.y,
      dx: sample.forwardXZ.x,
      dz: sample.forwardXZ.y,
    });
  }
  return out;
}

/** `a` の各点が `b` に沿っている割合。 */
function coverage(a: Trace[], b: Trace[], min: number, max: number): number {
  let paired = 0;
  for (const p of a) {
    let best: Trace | null = null;
    let bestDistance = Infinity;
    for (const q of b) {
      const d = (p.x - q.x) ** 2 + (p.z - q.z) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = q;
      }
    }
    if (!best) continue;
    const distance = Math.sqrt(bestDistance);
    if (distance < min || distance > max) continue;
    if (Math.abs(p.y - best.y) > PARALLEL_HEIGHT) continue;
    if (Math.abs(p.dx * best.dx + p.dz * best.dz) < PARALLEL_COS) continue;
    paired++;
  }
  return a.length > 0 ? paired / a.length : 0;
}

/**
 * 平行に並んでいるセグメントの組を、線形の形から見つける。
 *
 * 敷設のときの操作 (平行スナップを使ったか) は覚えていない。分割・撤去・
 * サンプルの読み込みなど、どんな作られ方をした複線でも同じように扱いたい
 * ためで、判定は「間隔がだいたい一定で、向きが揃っていて、高さも近い」
 * という見た目そのままの条件にする。
 */
export function findParallelGroups(network: Network): ParallelGroup[] {
  const segments = [...network.segments.values()];
  const traces = new Map<SegmentId, Trace[]>();
  const bounds = new Map<SegmentId, { minX: number; maxX: number; minZ: number; maxZ: number }>();
  for (const seg of segments) {
    const points = trace(network, seg.id);
    traces.set(seg.id, points);
    bounds.set(seg.id, {
      minX: Math.min(...points.map((p) => p.x)),
      maxX: Math.max(...points.map((p) => p.x)),
      minZ: Math.min(...points.map((p) => p.z)),
      maxZ: Math.max(...points.map((p) => p.z)),
    });
  }

  const parent = new Map<SegmentId, SegmentId>();
  const find = (id: SegmentId): SegmentId => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const seg of segments) parent.set(seg.id, seg.id);

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i];
      const b = segments[j];
      const clsA = network.classOf(a);
      const clsB = network.classOf(b);
      if (clsA.kind !== clsB.kind) continue;
      // 端点を共有していれば「並んでいる」ではなく「繋がっている」。
      if (a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b) continue;

      const spacing = parallelSpacing(clsA, clsB);
      const max = spacing * SPACING_MAX;
      const ba = bounds.get(a.id)!;
      const bb = bounds.get(b.id)!;
      if (
        ba.maxX + max < bb.minX ||
        bb.maxX + max < ba.minX ||
        ba.maxZ + max < bb.minZ ||
        bb.maxZ + max < ba.minZ
      ) {
        continue;
      }

      const ta = traces.get(a.id)!;
      const tb = traces.get(b.id)!;
      const min = spacing * SPACING_MIN;
      // 短い方が長い方に沿っていれば平行とみなす (途中で分割された
      // 相手でも、その区間だけは並んでいる)。
      const along = Math.max(coverage(ta, tb, min, max), coverage(tb, ta, min, max));
      if (along < PARALLEL_COVERAGE) continue;

      const ra = find(a.id);
      const rb = find(b.id);
      if (ra !== rb) parent.set(ra, rb);
    }
  }

  const byRoot = new Map<SegmentId, SegmentId[]>();
  for (const seg of segments) {
    const root = find(seg.id);
    const list = byRoot.get(root) ?? [];
    list.push(seg.id);
    byRoot.set(root, list);
  }

  const groups: ParallelGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    members.sort((p, q) => p - q);
    groups.push({ kind: network.classOf(network.getSegment(members[0])).kind, members });
  }
  groups.sort((p, q) => p.members[0] - q.members[0]);
  return groups;
}

/**
 * 基準線形の弧長 `s` の断面で、相手の線形までの横距 [m]。
 * 相手が端の外まで来ていない (並んでいない) 所では null。
 */
export function lateralOffsetAt(
  leader: Alignment,
  s: number,
  other: Alignment,
  tolerance = 2,
): number | null {
  const sample = leader.sampleAt(s);
  const t = stationOf(other, sample.pos.x, sample.pos.z);
  // 相手の端で折り返している (そこまで並んでいない) 場合は外す。
  if (t < 1e-3 || t > other.length - 1e-3) {
    const end = other.sampleAt(t).pos;
    const dx = end.x - sample.pos.x;
    const dz = end.z - sample.pos.z;
    if (Math.abs(dx * sample.forward.x + dz * sample.forward.z) > tolerance) return null;
  }
  const p = other.sampleAt(t).pos;
  const dx = p.x - sample.pos.x;
  const dz = p.z - sample.pos.z;
  return dx * sample.right.x + dz * sample.right.z;
}
