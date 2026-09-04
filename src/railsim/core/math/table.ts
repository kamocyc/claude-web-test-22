import { binarySearchLE } from './scalar.ts';

/** 距離程 s に紐づく点データ（地上子・信号機・停止位置目標など） */
export interface PointEntry<T> {
  readonly s: number;
  readonly value: T;
}

/**
 * 距離程順に並んだ点データのテーブル。
 *
 * 高速走行時に地上子を取りこぼさないため、点の通過判定は「その瞬間に一致したか」ではなく
 * 「前ステップ位置と現ステップ位置の区間を跨いだか」で行う。`crossing()` がそれを提供する。
 */
export class PointTable<T> {
  private readonly keys: number[];
  private readonly entries: ReadonlyArray<PointEntry<T>>;

  constructor(entries: ReadonlyArray<PointEntry<T>>) {
    const sorted = [...entries].sort((a, b) => a.s - b.s);
    this.entries = sorted;
    this.keys = sorted.map((e) => e.s);
  }

  get all(): ReadonlyArray<PointEntry<T>> {
    return this.entries;
  }

  get length(): number {
    return this.entries.length;
  }

  /**
   * 区間 (sFrom, sTo] に含まれる点を距離程順に返す（前進時）。
   * 後退時（sTo < sFrom）は [sTo, sFrom) を逆順に返す。
   */
  crossing(sFrom: number, sTo: number): ReadonlyArray<PointEntry<T>> {
    if (sTo === sFrom) return [];
    if (sTo > sFrom) {
      const from = binarySearchLE(this.keys, sFrom) + 1;
      const to = binarySearchLE(this.keys, sTo);
      if (to < from) return [];
      return this.entries.slice(from, to + 1);
    }
    const from = binarySearchLE(this.keys, sTo - Number.EPSILON) + 1;
    const to = binarySearchLE(this.keys, sFrom) - 1;
    if (to < from) return [];
    return this.entries.slice(from, to + 1).reverse();
  }

  /** s 以下で最も近い点 */
  lastAtOrBefore(s: number): PointEntry<T> | undefined {
    const i = binarySearchLE(this.keys, s);
    return i < 0 ? undefined : this.entries[i];
  }

  /** s より先で最も近い点 */
  firstAfter(s: number): PointEntry<T> | undefined {
    const i = binarySearchLE(this.keys, s);
    return this.entries[i + 1];
  }

  /** 区間 [sFrom, sTo] に含まれる点 */
  inRange(sFrom: number, sTo: number): ReadonlyArray<PointEntry<T>> {
    const from = binarySearchLE(this.keys, sFrom - Number.EPSILON) + 1;
    const to = binarySearchLE(this.keys, sTo);
    if (to < from) return [];
    return this.entries.slice(from, to + 1);
  }
}

/**
 * 階段状に値が変化するテーブル（速度制限・トンネル区間フラグなど）。
 * ある距離程で値が切り替わり、次の切替点まで同じ値が続く。
 */
export class StepTable<T> {
  private readonly keys: number[];
  private readonly values: T[];

  constructor(
    entries: ReadonlyArray<PointEntry<T>>,
    private readonly fallback: T,
  ) {
    const sorted = [...entries].sort((a, b) => a.s - b.s);
    this.keys = sorted.map((e) => e.s);
    this.values = sorted.map((e) => e.value);
  }

  at(s: number): T {
    const i = binarySearchLE(this.keys, s);
    return i < 0 ? this.fallback : this.values[i]!;
  }

  /** 値の切替点の距離程（イベントキューへの登録用） */
  get boundaries(): readonly number[] {
    return this.keys;
  }

  /**
   * 区間 [sFrom, sTo] に現れる値（始点 `sFrom` の時点の値を含む）。
   * 在線範囲にかかっている最も低い制限速度を求めるのに使う。
   */
  entriesInRange(sFrom: number, sTo: number): ReadonlyArray<PointEntry<T>> {
    const out: PointEntry<T>[] = [];
    out.push({ s: sFrom, value: this.at(sFrom) });
    const from = binarySearchLE(this.keys, sFrom) + 1;
    for (let i = from; i < this.keys.length && this.keys[i]! <= sTo; i++) {
      out.push({ s: this.keys[i]!, value: this.values[i]! });
    }
    return out;
  }
}

/** 区間 [start, end) に値を持つテーブル。区間が重なることも許す。 */
export interface Span<T> {
  readonly start: number;
  readonly end: number;
  readonly value: T;
}

export class SpanTable<T> {
  private readonly spans: ReadonlyArray<Span<T>>;
  private readonly startKeys: number[];
  private readonly maxEndPrefix: number[];

  constructor(spans: ReadonlyArray<Span<T>>) {
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    this.spans = sorted;
    this.startKeys = sorted.map((s) => s.start);
    // 「start が s 以下の区間のうち end の最大値」を前方累積で持ち、探索の打ち切りに使う
    const prefix: number[] = [];
    let maxEnd = -Infinity;
    for (const sp of sorted) {
      maxEnd = Math.max(maxEnd, sp.end);
      prefix.push(maxEnd);
    }
    this.maxEndPrefix = prefix;
  }

  get all(): ReadonlyArray<Span<T>> {
    return this.spans;
  }

  /** 距離程 s を含む区間をすべて返す */
  at(s: number): ReadonlyArray<Span<T>> {
    const last = binarySearchLE(this.startKeys, s);
    if (last < 0) return [];
    if (this.maxEndPrefix[last]! <= s) return [];
    const out: Span<T>[] = [];
    for (let i = last; i >= 0; i--) {
      if (this.maxEndPrefix[i]! <= s) break;
      const sp = this.spans[i]!;
      if (sp.start <= s && s < sp.end) out.push(sp);
    }
    return out.reverse();
  }

  /** 区間 [a, b) と重なる区間をすべて返す */
  overlapping(a: number, b: number): ReadonlyArray<Span<T>> {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const out: Span<T>[] = [];
    for (const sp of this.spans) {
      if (sp.start >= hi) break;
      if (sp.end > lo) out.push(sp);
    }
    return out;
  }
}
