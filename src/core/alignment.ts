import { Vector2, Vector3 } from 'three';
import { HorizontalCurve, perp, type XZ } from './curve';
import { VerticalProfile } from './profile';
import { SAMPLE_SPACING, SAMPLE_SPACING_MIN, clamp } from './units';

/** 線形上の 1 点における幾何情報。 */
export interface AlignmentSample {
  /** 水平弧長 [m]。 */
  s: number;
  /** 中心線上の 3 次元位置。 */
  pos: Vector3;
  /** 進行方向の単位ベクトル (3 次元、勾配込み)。 */
  forward: Vector3;
  /** 水平面内の進行方向 (単位ベクトル)。 */
  forwardXZ: Vector2;
  /** 進行方向の右手側の単位ベクトル (水平)。 */
  right: Vector3;
  /** 曲率 [1/m] (符号付き、右カーブが正)。 */
  curvature: number;
  /** 縦断勾配 dy/ds。 */
  grade: number;
  /**
   * 横断勾配 (中心線から右へ 1 m につき上がる量)。
   *
   * 線形そのものは持たない。踏切で線路の勾配に舗装を合わせるときだけ、
   * 描画用のサンプル列に後から加える (`applySurfaceBlend`)。
   */
  roll?: number;
}

/**
 * 平面線形と縦断線形を組み合わせた 3 次元の線形。
 *
 * 平面と縦断を分けているため、「カーブはきついが平坦」「直線だが急勾配」を
 * それぞれ独立に評価でき、規格チェック (最小半径・最大勾配) が素直に書ける。
 */
export class Alignment {
  readonly horizontal: HorizontalCurve;
  readonly vertical: VerticalProfile;

  constructor(horizontal: HorizontalCurve, vertical: VerticalProfile) {
    this.horizontal = horizontal;
    this.vertical = vertical;
  }

  static create(
    horizontal: HorizontalCurve,
    y0: number,
    y1: number,
    m0?: number,
    m1?: number,
  ): Alignment {
    const L = horizontal.length;
    const avg = L > 1e-6 ? (y1 - y0) / L : 0;
    return new Alignment(horizontal, new VerticalProfile(y0, y1, m0 ?? avg, m1 ?? avg, L));
  }

  get length(): number {
    return this.horizontal.length;
  }

  sampleAt(s: number): AlignmentSample {
    const h = this.horizontal;
    const p = h.pointAt(s);
    const t = h.tangentAt(s);
    const grade = this.vertical.gradeAt(s);
    const forward = new Vector3(t.x, grade, t.y).normalize();
    const r = perp(t);
    return {
      s,
      pos: new Vector3(p.x, this.vertical.yAt(s), p.y),
      forward,
      forwardXZ: t,
      right: new Vector3(r.x, 0, r.y),
      curvature: h.curvatureAt(s),
      grade,
    };
  }

  /**
   * 線形全体をサンプリングする。曲率が大きい所は自動的に細かくなる。
   * 端点は必ず含まれる。
   */
  sample(spacing = SAMPLE_SPACING): AlignmentSample[] {
    const L = this.horizontal.length;
    if (L < 1e-4) return [this.sampleAt(0)];

    const stations: number[] = [0];
    let s = 0;
    while (s < L) {
      const k = Math.abs(this.horizontal.curvatureAt(s));
      // 曲率半径の 1/24 程度の弦長になるよう刻む。直線では既定間隔のまま。
      const byCurvature = k > 1e-6 ? Math.max(SAMPLE_SPACING_MIN, 1 / k / 24) : spacing;
      const step = clamp(Math.min(spacing, byCurvature), SAMPLE_SPACING_MIN, spacing);
      s = Math.min(L, s + step);
      stations.push(s);
    }
    if (stations[stations.length - 1] < L - 1e-6) stations.push(L);
    return stations.map((st) => this.sampleAt(st));
  }

  /**
   * 部分区間 [s0, s1] を切り出した新しい線形を返す。
   * 橋・トンネル区間の生成や交差点による端部トリムで使う。
   */
  subAlignment(s0: number, s1: number): Alignment {
    const L = this.horizontal.length;
    const a = clamp(s0, 0, L);
    const b = clamp(s1, a, L);
    const h = this.horizontal;
    const t0 = h.tAtDistance(a);
    const t1 = h.tAtDistance(b);
    const sub = splitBezier(h, t0, t1);
    const len = sub.length;
    return new Alignment(
      sub,
      new VerticalProfile(
        this.vertical.yAt(a),
        this.vertical.yAt(b),
        this.vertical.gradeAt(a),
        this.vertical.gradeAt(b),
        len,
      ),
    );
  }
}

/** 3 次ベジエの媒介変数区間 [t0, t1] を切り出す (de Casteljau)。 */
export function splitBezier(curve: HorizontalCurve, t0: number, t1: number): HorizontalCurve {
  const right = subdivideRight(curve.p0, curve.c0, curve.c1, curve.p1, t0);
  // t0 で切った後半における t1 の位置に対応する媒介変数。
  const u = t1 >= 1 - 1e-9 ? 1 : (t1 - t0) / Math.max(1e-9, 1 - t0);
  const both = subdivideLeft(right[0], right[1], right[2], right[3], clamp(u, 0, 1));
  return new HorizontalCurve(both[0], both[1], both[2], both[3]);
}

function subdivideRight(p0: XZ, c0: XZ, c1: XZ, p1: XZ, t: number): [XZ, XZ, XZ, XZ] {
  const a = p0.clone().lerp(c0, t);
  const b = c0.clone().lerp(c1, t);
  const c = c1.clone().lerp(p1, t);
  const d = a.clone().lerp(b, t);
  const e = b.clone().lerp(c, t);
  const f = d.clone().lerp(e, t);
  return [f, e, c, p1.clone()];
}

function subdivideLeft(p0: XZ, c0: XZ, c1: XZ, p1: XZ, t: number): [XZ, XZ, XZ, XZ] {
  const a = p0.clone().lerp(c0, t);
  const b = c0.clone().lerp(c1, t);
  const c = c1.clone().lerp(p1, t);
  const d = a.clone().lerp(b, t);
  const e = b.clone().lerp(c, t);
  const f = d.clone().lerp(e, t);
  return [p0.clone(), a, d, f];
}
