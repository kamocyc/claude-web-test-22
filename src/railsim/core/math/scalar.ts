/** スカラー数値ユーティリティ。すべて副作用なし・決定論的。 */

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** t を [0,1] にクランプした線形補間 */
export function lerpClamped(a: number, b: number, t: number): number {
  return lerp(a, b, clamp(t, 0, 1));
}

/** x を [x0,x1] から [0,1] へ写す（x0 === x1 のときは 0） */
export function inverseLerp(x0: number, x1: number, x: number): number {
  if (x1 === x0) return 0;
  return (x - x0) / (x1 - x0);
}

/** 符号（0 のときは 0） */
export function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/**
 * 変化率制限（レートリミッタ）。
 * 指令値 target へ、1 秒あたり最大 rate だけ現在値 current を近づける。
 */
export function rateLimit(current: number, target: number, rate: number, dt: number): number {
  const maxDelta = Math.abs(rate) * dt;
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + sign(delta) * maxDelta;
}

/**
 * 一次遅れ（時定数 tau）の 1 ステップ更新。
 * 厳密解 y' = y + (u - y) * (1 - exp(-dt/tau)) を用いるので、
 * dt が tau に対して大きくても発散しない。
 */
export function firstOrderLag(current: number, input: number, tau: number, dt: number): number {
  if (tau <= 0) return input;
  const alpha = 1 - Math.exp(-dt / tau);
  return current + (input - current) * alpha;
}

/** 数値が有限であることを保証する（NaN 混入の早期検出用） */
export function assertFinite(x: number, what: string): number {
  if (!Number.isFinite(x)) {
    throw new Error(`${what} が有限値ではありません: ${x}`);
  }
  return x;
}

/**
 * ソート済み配列 keys に対し、keys[i] <= x を満たす最大の i を返す。
 * x がどの要素より小さい場合は -1。
 */
export function binarySearchLE(keys: readonly number[], x: number): number {
  let lo = 0;
  let hi = keys.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]! <= x) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 折れ線（区分線形）関数。x は昇順であること。
 * 定義域の外側では端点の値を保持する（外挿しない）。
 */
export class PiecewiseLinear {
  private readonly xs: readonly number[];
  private readonly ys: readonly number[];

  constructor(points: ReadonlyArray<readonly [number, number]>) {
    if (points.length === 0) throw new Error('PiecewiseLinear には 1 点以上必要です');
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (i > 0 && p[0] < xs[i - 1]!) {
        throw new Error('PiecewiseLinear の x は昇順である必要があります');
      }
      xs.push(p[0]);
      ys.push(p[1]);
    }
    this.xs = xs;
    this.ys = ys;
  }

  at(x: number): number {
    const n = this.xs.length;
    if (x <= this.xs[0]!) return this.ys[0]!;
    if (x >= this.xs[n - 1]!) return this.ys[n - 1]!;
    const i = binarySearchLE(this.xs, x);
    const x0 = this.xs[i]!;
    const x1 = this.xs[i + 1]!;
    const y0 = this.ys[i]!;
    const y1 = this.ys[i + 1]!;
    if (x1 === x0) return y1;
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
}

/**
 * 2 次方程式的な制動パターン速度。
 * 目標地点で速度 vTarget にするために、距離 distance 手前で許容される速度。
 *   v = sqrt(vTarget^2 + 2 * decel * distance)
 * distance が負（目標地点を過ぎている）なら vTarget を返す。
 */
export function brakingPatternSpeed(vTarget: number, decel: number, distance: number): number {
  if (distance <= 0) return vTarget;
  return Math.sqrt(vTarget * vTarget + 2 * decel * distance);
}

/** 数値配列から 32bit の決定論的ハッシュを作る（再現性テスト用） */
export function hashNumbers(values: Iterable<number>): number {
  // FNV-1a を float の 64bit 表現に適用する
  const buf = new ArrayBuffer(8);
  const f64 = new Float64Array(buf);
  const u32 = new Uint32Array(buf);
  let h = 0x811c9dc5;
  for (const v of values) {
    f64[0] = v === 0 ? 0 : v; // -0 を 0 に正規化
    for (let k = 0; k < 2; k++) {
      let word = u32[k]!;
      for (let b = 0; b < 4; b++) {
        h ^= word & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
        word >>>= 8;
      }
    }
  }
  return h >>> 0;
}
