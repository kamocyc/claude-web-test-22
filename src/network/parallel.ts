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
import { clamp } from '../core/units';
import type { NetworkClass, NetworkKind } from './classes';
import type { PlacementPreview } from './editing';
import type { Network, SegmentId } from './network';

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

/** 線形をそのまま敷設プレビューにする (平行スナップ用)。 */
export function previewFromAlignment(alignment: Alignment): PlacementPreview {
  const horizontal = alignment.horizontal;
  const length = horizontal.length;
  const end = alignment.sampleAt(length).pos;
  return {
    horizontal,
    end: new Vector3(end.x, end.y, end.z),
    startGrade: alignment.vertical.m0,
    endGrade: alignment.vertical.m1,
    radius: horizontal.extremeCurvature(48).minRadius,
    grade: alignment.vertical.maxGrade(32),
    endTangent: horizontal.tangentAt(length),
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
