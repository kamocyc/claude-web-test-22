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

/** 弧長テーブルの刻み数 (ピース 1 つあたり)。 */
const LUT_PER_PIECE = 128;

/**
 * XZ 平面上の連結 3 次ベジエ曲線。弧長パラメータ (s) で評価できるように
 * 生成時に弧長テーブルを作る。
 *
 * 制御点は `points` に `3n+1` 個並べる (n = ピース数)。ピース `i` の制御点は
 * `points[3i] … points[3i+3]` で、隣り合うピースは節点を共有する。緩和曲線
 * (クロソイド) のように 1 本の 3 次ベジエでは表せない線形を、セグメントを
 * 分けずに 1 本の線形として扱うためにこの形にしている。
 *
 * ほとんどの線形はピース 1 つ (ただの 3 次ベジエ) なので、4 点を渡す
 * 従来どおりの作り方も残してある。
 */
export class HorizontalCurve {
  /** 制御点列 (長さ `3n+1`)。 */
  readonly points: readonly XZ[];
  /**
   * 弧長テーブル。`arc[i]` は媒介変数 `T = i / LUT_PER_PIECE` までの弧長。
   * `T` はピース番号を整数部に持つ通し媒介変数 (0 … ピース数)。
   */
  private readonly arc: Float64Array;
  readonly length: number;

  constructor(p0: XZ, c0: XZ, c1: XZ, p1: XZ);
  constructor(points: readonly XZ[]);
  constructor(a: XZ | readonly XZ[], c0?: XZ, c1?: XZ, p1?: XZ) {
    const src = Array.isArray(a) ? (a as readonly XZ[]) : [a as XZ, c0!, c1!, p1!];
    if (src.length < 4 || (src.length - 1) % 3 !== 0) {
      throw new Error(`HorizontalCurve: 制御点は 3n+1 個必要 (${src.length} 個)`);
    }
    this.points = src.map((p) => p.clone());

    const pieces = (src.length - 1) / 3;
    const steps = pieces * LUT_PER_PIECE;
    const arc = new Float64Array(steps + 1);
    const prev = new Vector2().copy(this.points[0]);
    const cur = new Vector2();
    let total = 0;
    for (let i = 1; i <= steps; i++) {
      this.pointAtT((i / steps) * pieces, cur);
      total += cur.distanceTo(prev);
      arc[i] = total;
      prev.copy(cur);
    }
    this.arc = arc;
    this.length = total;
  }

  /** ピース数。 */
  get pieceCount(): number {
    return (this.points.length - 1) / 3;
  }

  get p0(): XZ {
    return this.points[0];
  }

  /** 始点側の端の制御点。 */
  get c0(): XZ {
    return this.points[1];
  }

  /** 終点側の端の制御点。 */
  get c1(): XZ {
    return this.points[this.points.length - 2];
  }

  get p1(): XZ {
    return this.points[this.points.length - 1];
  }

  /**
   * `c0` と `c1` の間にある点 (節点と中間の制御点)。ピース 1 つなら空。
   * `NetSegment.via` に入れて保存する形そのもの。
   */
  get via(): XZ[] {
    return this.points.slice(2, this.points.length - 2).map((p) => p.clone());
  }

  /** 直線区間として 2 点から生成する。 */
  static straight(a: XZ, b: XZ): HorizontalCurve {
    const c0 = a.clone().lerp(b, 1 / 3);
    const c1 = a.clone().lerp(b, 2 / 3);
    return new HorizontalCurve(a, c0, c1, b);
  }

  /**
   * 弧長 s [m] に対応する媒介変数 t (0…1) を返す。
   * ピース内の媒介変数ではなく、曲線全体を 0…1 で見た値。
   */
  tAtDistance(s: number): number {
    const target = clamp(s, 0, this.length);
    const arc = this.arc;
    const steps = arc.length - 1;
    let lo = 0;
    let hi = steps;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (arc[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = arc[hi] - arc[lo];
    const frac = span > 1e-9 ? (target - arc[lo]) / span : 0;
    return (lo + frac) / steps;
  }

  /** 通し媒介変数 `T` (0 … ピース数) をピース番号とピース内の t に分ける。 */
  private locate(T: number): { i: number; t: number } {
    const n = this.pieceCount;
    let i = Math.floor(T);
    if (i >= n) i = n - 1;
    if (i < 0) i = 0;
    return { i, t: clamp(T - i, 0, 1) };
  }

  pointAt(s: number, out = new Vector2()): XZ {
    return this.pointAtT(this.tAtDistance(s) * this.pieceCount, out);
  }

  /** 通し媒介変数 `T` (0 … ピース数) で評価する。 */
  pointAtT(T: number, out = new Vector2()): XZ {
    const { i, t } = this.locate(T);
    const k = i * 3;
    const p = this.points;
    return bezierPoint(p[k], p[k + 1], p[k + 2], p[k + 3], t, out);
  }

  /** 弧長 s における単位接線ベクトル。 */
  tangentAt(s: number, out = new Vector2()): XZ {
    const { i, t } = this.locate(this.tAtDistance(s) * this.pieceCount);
    const k = i * 3;
    const p = this.points;
    bezierDerivative(p[k], p[k + 1], p[k + 2], p[k + 3], t, out);
    const len = out.length();
    if (len < 1e-9) {
      // 制御点が退化している場合は端点同士の方向で代用する。
      out.set(this.p1.x - this.p0.x, this.p1.y - this.p0.y);
      const l2 = out.length();
      return l2 < 1e-9 ? out.set(1, 0) : out.divideScalar(l2);
    }
    return out.divideScalar(len);
  }

  /**
   * 弧長 s における曲率 [1/m]。
   * 符号は曲率中心のある側で、`perp` (進行方向の右手) 側なら正 = 右カーブ。
   */
  curvatureAt(s: number): number {
    const { i, t } = this.locate(this.tAtDistance(s) * this.pieceCount);
    return this.curvatureAtPiece(i, t);
  }

  /** ピース `i` の媒介変数 `t` における曲率。ピース境界の片側を見るのに使う。 */
  private curvatureAtPiece(i: number, t: number): number {
    const k = i * 3;
    const p = this.points;
    const d = bezierDerivative(p[k], p[k + 1], p[k + 2], p[k + 3], t, _d1);
    const dd = bezierSecondDerivative(p[k], p[k + 1], p[k + 2], p[k + 3], t, _d2);
    const cross = d.x * dd.y - d.y * dd.x;
    const speed = d.length();
    if (speed < 1e-6) return 0;
    return cross / (speed * speed * speed);
  }

  /**
   * 曲率の最大絶対値と、それに対応する最小曲率半径。
   *
   * 弧長で等間隔に見るほか、**ピースの境目を両側から**必ず見る。連結ベジエ
   * では曲率のピークが境目に来るので、等間隔のサンプルだけだと見落とす。
   */
  extremeCurvature(samples = 32): { maxCurvature: number; minRadius: number } {
    let maxK = 0;
    for (let i = 0; i <= samples; i++) {
      const k = Math.abs(this.curvatureAt((i / samples) * this.length));
      if (k > maxK) maxK = k;
    }
    const n = this.pieceCount;
    if (n > 1) {
      for (let i = 0; i < n; i++) {
        const a = Math.abs(this.curvatureAtPiece(i, 0));
        const b = Math.abs(this.curvatureAtPiece(i, 1));
        if (a > maxK) maxK = a;
        if (b > maxK) maxK = b;
      }
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

/** 制御点列を逆順にした曲線 (向きが反転する)。 */
export function reversedCurve(curve: HorizontalCurve): HorizontalCurve {
  return new HorizontalCurve([...curve.points].reverse());
}
