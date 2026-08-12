import { Vector2 } from 'three';
import { clamp } from './units';

/**
 * 平面 (XZ) 座標。`x` はワールド X、`y` はワールド Z に対応する。
 */
export type XZ = Vector2;

export function xz(x: number, z: number): XZ {
  return new Vector2(x, z);
}

/**
 * 平面ベクトルを 90 度回した法線。
 *
 * XZ を `Vector2(x = X, y = Z)` として扱うと、この回転はワールドで進行方向の
 * 右手側 (`forward × up`) に一致する。
 */
export function perp(v: XZ, out = new Vector2()): XZ {
  return out.set(-v.y, v.x);
}

export function bezierPoint(p0: XZ, c0: XZ, c1: XZ, p1: XZ, t: number, out = new Vector2()): XZ {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return out.set(
    a * p0.x + b * c0.x + c * c1.x + d * p1.x,
    a * p0.y + b * c0.y + c * c1.y + d * p1.y,
  );
}

export function bezierDerivative(p0: XZ, c0: XZ, c1: XZ, p1: XZ, t: number, out = new Vector2()): XZ {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const c = 3 * t * t;
  return out.set(
    a * (c0.x - p0.x) + b * (c1.x - c0.x) + c * (p1.x - c1.x),
    a * (c0.y - p0.y) + b * (c1.y - c0.y) + c * (p1.y - c1.y),
  );
}

export function bezierSecondDerivative(p0: XZ, c0: XZ, c1: XZ, p1: XZ, t: number, out = new Vector2()): XZ {
  const u = 1 - t;
  return out.set(
    6 * u * (c1.x - 2 * c0.x + p0.x) + 6 * t * (p1.x - 2 * c1.x + c0.x),
    6 * u * (c1.y - 2 * c0.y + p0.y) + 6 * t * (p1.y - 2 * c1.y + c0.y),
  );
}

const LUT_SEGMENTS = 128;

/**
 * XZ 平面上の 3 次ベジエ曲線。弧長パラメータ (s) で評価できるように
 * 生成時に弧長テーブルを作る。
 */
export class HorizontalCurve {
  readonly p0: XZ;
  readonly c0: XZ;
  readonly c1: XZ;
  readonly p1: XZ;
  /** 弧長テーブル。`arc[i]` は `t = i / LUT_SEGMENTS` までの弧長。 */
  private readonly arc: Float64Array;
  readonly length: number;

  constructor(p0: XZ, c0: XZ, c1: XZ, p1: XZ) {
    this.p0 = p0.clone();
    this.c0 = c0.clone();
    this.c1 = c1.clone();
    this.p1 = p1.clone();

    const arc = new Float64Array(LUT_SEGMENTS + 1);
    const prev = new Vector2().copy(p0);
    const cur = new Vector2();
    let total = 0;
    for (let i = 1; i <= LUT_SEGMENTS; i++) {
      bezierPoint(p0, c0, c1, p1, i / LUT_SEGMENTS, cur);
      total += cur.distanceTo(prev);
      arc[i] = total;
      prev.copy(cur);
    }
    this.arc = arc;
    this.length = total;
  }

  /** 直線区間として 2 点から生成する。 */
  static straight(a: XZ, b: XZ): HorizontalCurve {
    const c0 = a.clone().lerp(b, 1 / 3);
    const c1 = a.clone().lerp(b, 2 / 3);
    return new HorizontalCurve(a, c0, c1, b);
  }

  /** 弧長 s [m] に対応するベジエ媒介変数 t を返す。 */
  tAtDistance(s: number): number {
    const target = clamp(s, 0, this.length);
    const arc = this.arc;
    let lo = 0;
    let hi = LUT_SEGMENTS;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (arc[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = arc[hi] - arc[lo];
    const frac = span > 1e-9 ? (target - arc[lo]) / span : 0;
    return (lo + frac) / LUT_SEGMENTS;
  }

  pointAt(s: number, out = new Vector2()): XZ {
    return bezierPoint(this.p0, this.c0, this.c1, this.p1, this.tAtDistance(s), out);
  }

  pointAtT(t: number, out = new Vector2()): XZ {
    return bezierPoint(this.p0, this.c0, this.c1, this.p1, t, out);
  }

  /** 弧長 s における単位接線ベクトル。 */
  tangentAt(s: number, out = new Vector2()): XZ {
    const t = this.tAtDistance(s);
    bezierDerivative(this.p0, this.c0, this.c1, this.p1, t, out);
    const len = out.length();
    if (len < 1e-9) {
      // 制御点が退化している場合は端点同士の方向で代用する。
      out.set(this.p1.x - this.p0.x, this.p1.y - this.p0.y);
      const l2 = out.length();
      return l2 < 1e-9 ? out.set(1, 0) : out.divideScalar(l2);
    }
    return out.divideScalar(len);
  }

  /** 弧長 s における曲率 [1/m] (符号付き、左カーブが正)。 */
  curvatureAt(s: number): number {
    const t = this.tAtDistance(s);
    const d = bezierDerivative(this.p0, this.c0, this.c1, this.p1, t, _d1);
    const dd = bezierSecondDerivative(this.p0, this.c0, this.c1, this.p1, t, _d2);
    const cross = d.x * dd.y - d.y * dd.x;
    const speed = d.length();
    if (speed < 1e-6) return 0;
    return cross / (speed * speed * speed);
  }

  /** 曲率の最大絶対値と、それに対応する最小曲率半径。 */
  extremeCurvature(samples = 32): { maxCurvature: number; minRadius: number } {
    let maxK = 0;
    for (let i = 0; i <= samples; i++) {
      const k = Math.abs(this.curvatureAt((i / samples) * this.length));
      if (k > maxK) maxK = k;
    }
    return { maxCurvature: maxK, minRadius: maxK < 1e-6 ? Infinity : 1 / maxK };
  }
}

const _d1 = new Vector2();
const _d2 = new Vector2();

const ZERO = new Vector2(0, 0);

/** 単一の 3 次ベジエで円弧を近似する際に許す最大掃引角。 */
export const MAX_ARC_SWEEP = 120 * (Math.PI / 180);

/**
 * 始点 `a` とそこでの接線 `ta` に接し、終点 `b` を通る円弧を 3 次ベジエで返す。
 *
 * 掃引角は `MAX_ARC_SWEEP` でクランプされるため、結果の曲線は必ずしも `b` で
 * 終わらない。実際の終点は `curve.p1` を参照すること。
 */
export function arcFromTangent(
  a: XZ,
  ta: XZ,
  b: XZ,
): { curve: HorizontalCurve; radius: number; sweep: number; endTangent: XZ } {
  const chord = new Vector2().subVectors(b, a);
  const chordLen = chord.length();
  const dir = ta.clone().normalize();

  if (chordLen < 1e-4) {
    const end = a.clone().addScaledVector(dir, 1e-3);
    return { curve: HorizontalCurve.straight(a, end), radius: Infinity, sweep: 0, endTangent: dir };
  }

  const n = perp(dir);
  // 弦を始点のローカル座標系に射影する。along = 進行方向成分、side = 右手側成分。
  const along = chord.dot(dir);
  const side = chord.dot(n);

  if (Math.abs(side) < 1e-7) {
    // 接線の延長線上にある → 直線。真後ろ指定でも直線で結ぶ。
    const endTangent = along >= 0 ? dir : chord.clone().normalize();
    return { curve: HorizontalCurve.straight(a, b), radius: Infinity, sweep: 0, endTangent };
  }

  // a で ta に接し b を通る円の半径 (符号付き、正なら右カーブ)。
  const radius = (chordLen * chordLen) / (2 * side);

  // 円弧の掃引角。中心から見た始点・終点の角度差を、曲がる向きに合わせて取る。
  const thStart = Math.atan2(-radius, 0);
  const thEnd = Math.atan2(side - radius, along);
  let sweep = thEnd - thStart;
  const twoPi = Math.PI * 2;
  if (radius > 0) {
    while (sweep <= 0) sweep += twoPi;
    while (sweep > twoPi) sweep -= twoPi;
  } else {
    while (sweep >= 0) sweep -= twoPi;
    while (sweep < -twoPi) sweep += twoPi;
  }

  const clamped = Math.max(-MAX_ARC_SWEEP, Math.min(MAX_ARC_SWEEP, sweep));
  const center = a.clone().addScaledVector(n, radius);
  const curve = arcToBezier(center, a, clamped);
  const endTangent = dir.clone().rotateAround(ZERO, clamped);
  return { curve, radius: Math.abs(radius), sweep: clamped, endTangent };
}

/**
 * 中心 `center`・始点 `start`・掃引角 `sweep` (反時計回りが正) の円弧を
 * 3 次ベジエで近似する。
 */
export function arcToBezier(center: XZ, start: XZ, sweep: number): HorizontalCurve {
  const r0 = new Vector2().subVectors(start, center);
  const end = center.clone().add(r0.clone().rotateAround(ZERO, sweep));
  if (Math.abs(sweep) < 1e-6) return HorizontalCurve.straight(start, end);

  // 制御点距離の係数。円弧を単一 3 次ベジエで近似する標準的な値。
  const k = (4 / 3) * Math.tan(sweep / 4);
  const rEnd = new Vector2().subVectors(end, center);
  const c0 = start.clone().add(new Vector2(-r0.y, r0.x).multiplyScalar(k));
  const c1 = end.clone().sub(new Vector2(-rEnd.y, rEnd.x).multiplyScalar(k));
  return new HorizontalCurve(start, c0, c1, end);
}

/**
 * 両端の位置と接線方向から 3 次ベジエを作る (エルミート相当)。
 * 制御点の距離は弦長の 1/3 を基準にする。
 */
export function curveFromTangents(a: XZ, ta: XZ, b: XZ, tb: XZ, tension = 1 / 3): HorizontalCurve {
  const d = a.distanceTo(b);
  const handle = Math.max(d * tension, 0.01);
  const c0 = a.clone().addScaledVector(ta.clone().normalize(), handle);
  const c1 = b.clone().addScaledVector(tb.clone().normalize(), -handle);
  return new HorizontalCurve(a, c0, c1, b);
}
