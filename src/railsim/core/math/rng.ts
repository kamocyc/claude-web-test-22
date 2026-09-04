/**
 * 決定論的な擬似乱数生成器 (mulberry32)。
 *
 * コアは `Math.random()` を使わない。シナリオのシード値からこの RNG を作り、
 * 同一シード + 同一入力ならビット単位で同一の結果になることを保証する。
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) の一様乱数 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [lo, hi) の一様乱数 */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** 平均 0・標準偏差 1 の正規乱数（Box-Muller） */
  normal(): number {
    const u1 = Math.max(this.next(), Number.MIN_VALUE);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** 確率 p で true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 独立した派生 RNG を作る（サブシステムごとに乱数列を分離する） */
  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt, 0x9e3779b9)) >>> 0);
  }
}

/**
 * 一次のガウス・マルコフ過程（時間相関のあるノイズ）。
 * レール踏面状態のゆらぎのように「じわじわ変化する」量の表現に使う。
 */
export class CorrelatedNoise {
  private value = 0;

  constructor(
    private readonly rng: Rng,
    private readonly sigma: number,
    private readonly tau: number,
  ) {}

  update(dt: number): number {
    if (this.tau <= 0) {
      this.value = this.sigma * this.rng.normal();
      return this.value;
    }
    const beta = Math.exp(-dt / this.tau);
    const q = this.sigma * Math.sqrt(1 - beta * beta);
    this.value = beta * this.value + q * this.rng.normal();
    return this.value;
  }

  get current(): number {
    return this.value;
  }
}
