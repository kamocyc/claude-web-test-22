/**
 * 縦断線形。水平弧長 s を引数に高さ y を返す 3 次エルミート曲線。
 *
 * 実際の道路設計と同じく、平面線形とは独立に「縦断勾配」として持つ。
 * 端点の勾配 (m0, m1) を指定できるので、既存の線形へ接続したときに
 * 勾配を連続させる (縦断曲線を作る) ことができる。
 */
export class VerticalProfile {
  constructor(
    readonly y0: number,
    readonly y1: number,
    /** 始点の勾配 dy/ds。 */
    readonly m0: number,
    /** 終点の勾配 dy/ds。 */
    readonly m1: number,
    /** 水平弧長 [m]。 */
    readonly length: number,
  ) {}

  /** 端点勾配を平均勾配に揃えた (= 直線的な) 縦断を作る。 */
  static linear(y0: number, y1: number, length: number): VerticalProfile {
    const g = length > 1e-6 ? (y1 - y0) / length : 0;
    return new VerticalProfile(y0, y1, g, g, length);
  }

  yAt(s: number): number {
    const L = this.length;
    if (L <= 1e-6) return this.y0;
    const t = Math.max(0, Math.min(1, s / L));
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * this.y0 + h10 * (this.m0 * L) + h01 * this.y1 + h11 * (this.m1 * L);
  }

  /** 弧長 s における勾配 dy/ds (0.05 = 5%)。 */
  gradeAt(s: number): number {
    const L = this.length;
    if (L <= 1e-6) return 0;
    const t = Math.max(0, Math.min(1, s / L));
    const t2 = t * t;
    const d00 = 6 * t2 - 6 * t;
    const d10 = 3 * t2 - 4 * t + 1;
    const d01 = -6 * t2 + 6 * t;
    const d11 = 3 * t2 - 2 * t;
    return (d00 * this.y0 + d01 * this.y1) / L + d10 * this.m0 + d11 * this.m1;
  }

  /**
   * 弧長 s における 2 階微分 d²y/ds²。
   *
   * 3 次エルミートなので `t` について線形。つまり極値は必ず両端にあり、
   * 縦曲線の一番きつい所を探すのにサンプリングは要らない。
   */
  secondDerivativeAt(s: number): number {
    const L = this.length;
    if (L <= 1e-6) return 0;
    const t = Math.max(0, Math.min(1, s / L));
    const d2 =
      (12 * t - 6) * this.y0 +
      (6 * t - 4) * this.m0 * L +
      (-12 * t + 6) * this.y1 +
      (6 * t - 2) * this.m1 * L;
    return d2 / (L * L);
  }

  /** 弧長 s における縦曲線の半径 [m]。真っ直ぐなら `Infinity`。 */
  verticalRadiusAt(s: number): number {
    const g = this.gradeAt(s);
    const k = Math.abs(this.secondDerivativeAt(s)) / Math.pow(1 + g * g, 1.5);
    return k < 1e-9 ? Infinity : 1 / k;
  }

  /**
   * 区間内で一番きつい縦曲線の半径 [m]。真っ直ぐなら `Infinity`。
   *
   * 2 階微分は弧長について線形なので、極値は必ず両端にあります。
   * 端点勾配を `m1 = 平均勾配`, `m0 = 平均勾配 + d` にした標準の形では
   * `L / (4|d|)` になる。敷設時のクランプはその式を直接使っている。
   */
  minVerticalRadius(): number {
    const L = this.length;
    if (L <= 1e-6) return Infinity;
    return Math.min(this.verticalRadiusAt(0), this.verticalRadiusAt(L));
  }

  /** 区間内の最大勾配 (絶対値)。 */
  maxGrade(samples = 24): number {
    let m = 0;
    for (let i = 0; i <= samples; i++) {
      const g = Math.abs(this.gradeAt((i / samples) * this.length));
      if (g > m) m = g;
    }
    return m;
  }
}
