/**
 * 水文格子の基盤 — 値ノイズ・fBm・分位点・ミンヒープ。
 *
 * 移植元 (ctest105_city_terrain_generator の `src/generator/grid.ts`) は格子の
 * 一辺を定数 `GRID_SIZE = 128` に固定していたが、こちらはマップの広さから
 * 決めるので、格子の大きさを `HydroGrid` として引き回す。
 *
 * ノイズは外部ライブラリではなく**整数ハッシュの値ノイズ**である。
 * simplex に差し替えると振幅も模様も変わり、下流の分位点で決めている
 * 海面・河川のしきい値まで動くので、そのまま持ち込んでいる。
 */

/** 8 近傍の相対座標 (中心を含まない)。 */
export const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
export const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * 格子。`len` は格子点の総数で、`cell` は 1 セルの辺長 [m]。
 *
 * 水文の定数はすべて「セル単位の距離」で書かれているので、`cell` は
 * 移植元と同じ 40 m を保つ (マップを広げるときは格子の数を増やす)。
 */
export interface HydroGrid {
  readonly n: number;
  readonly len: number;
  readonly cell: number;
  /** 添字 0 に対応するワールド座標 (X, Z 共通)。 */
  readonly origin: number;
  /** 格子座標 → ワールド座標 [m]。 */
  worldAt(index: number): number;
  /** ワールド座標 [m] → 格子座標 (実数)。 */
  cellAt(world: number): number;
}

export function makeGrid(n: number, cell = 40, origin = -((n - 1) * cell) / 2): HydroGrid {
  return {
    n,
    len: n * n,
    cell,
    origin,
    worldAt: (index: number) => origin + index * cell,
    cellAt: (world: number) => (world - origin) / cell,
  };
}

export const clamp = (v: number, a = 0, b = 1): number => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => t * t * (3 - 2 * t);

export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty) * 2 - 1;
}

/**
 * fBm。振幅の合計で割るので、オクターブ数によらず概ね -1..1 に収まる。
 * 目盛り (2.03) は軸に揃った模様が出ないよう 2 から少しずらしてある。
 */
export function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amplitude = 0.56;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    sum += valueNoise(x * frequency, y * frequency, seed + octave * 1013) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return sum / total;
}

/** 陸地だけの高さの範囲。 */
export function normalizeLand(h: Float32Array, sea: Uint8Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (sea[i]) continue;
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 1];
}

/**
 * 分位点。
 *
 * 移植元は `number[]` に積んで比較関数付きソートをしていた。格子が 16 倍に
 * なると効くので、型付き配列の数値ソートに置き換えてある (結果は同じ)。
 */
export function quantile(values: Float32Array | Float64Array, q: number, mask?: Uint8Array): number {
  let count = 0;
  if (mask) {
    for (let i = 0; i < values.length; i++) if (mask[i]) count++;
  } else {
    count = values.length;
  }
  if (count === 0) return 0;
  const list = new Float64Array(count);
  let k = 0;
  for (let i = 0; i < values.length; i++) if (!mask || mask[i]) list[k++] = values[i];
  list.sort();
  return list[Math.max(0, Math.min(count - 1, Math.floor(q * (count - 1))))];
}

/**
 * ミンヒープ。
 *
 * 移植元は `[key, index]` のタプルを push していた。50 万セルの Priority-Flood を
 * 4 回回すと配列を 200 万個作ることになるので、キーと値を別々の型付き配列で
 * 持つ。`pop()` は値を返し、そのときのキーを `lastKey` に置く。
 */
export class MinHeap {
  private keys: Float64Array;
  private values: Int32Array;
  private size = 0;
  /** 直前の `pop()` が取り出した要素のキー。 */
  lastKey = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(Math.max(1, capacity));
    this.values = new Int32Array(Math.max(1, capacity));
  }

  get length(): number {
    return this.size;
  }

  push(key: number, value: number): void {
    if (this.size === this.keys.length) this.grow();
    const keys = this.keys;
    const values = this.values;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      values[i] = values[p];
      i = p;
    }
    keys[i] = key;
    values[i] = value;
  }

  pop(): number {
    const keys = this.keys;
    const values = this.values;
    const rootValue = values[0];
    this.lastKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n];
      const value = values[n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const child = r < n && keys[r] < keys[l] ? r : l;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = key;
      values[i] = value;
    }
    return rootValue;
  }

  private grow(): void {
    const keys = new Float64Array(this.keys.length * 2);
    const values = new Int32Array(this.values.length * 2);
    keys.set(this.keys);
    values.set(this.values);
    this.keys = keys;
    this.values = values;
  }
}

/**
 * 添字のキュー。
 *
 * 距離変換は「より短い距離が見つかったら入れ直す」ので、1 セルが何度も
 * 積まれうる。移植元の固定長 (`Int32Array(LEN)`) は原理的に溢れるため、
 * 伸びるようにしてある。
 */
export class IndexQueue {
  private items: Int32Array;
  private head = 0;
  private tail = 0;

  constructor(capacity = 1024) {
    this.items = new Int32Array(Math.max(1, capacity));
  }

  get length(): number {
    return this.tail - this.head;
  }

  push(value: number): void {
    if (this.tail === this.items.length) {
      if (this.head > this.items.length >> 1) {
        this.items.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      } else {
        const items = new Int32Array(this.items.length * 2);
        items.set(this.items);
        this.items = items;
      }
    }
    this.items[this.tail++] = value;
  }

  shift(): number {
    return this.items[this.head++];
  }
}
