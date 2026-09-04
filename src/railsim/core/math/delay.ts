/**
 * むだ時間（純遅れ）を表す固定長のリングバッファ。
 *
 * ブレーキ指令からブレーキシリンダに空気が入り始めるまでの遅れのように、
 * 「時定数による鈍りではなく、単純に時間がずれる」現象を表す。
 */
export class DelayLine {
  private readonly buffer: Float64Array;
  private index = 0;

  constructor(delaySeconds: number, dt: number, initialValue = 0) {
    const n = Math.max(1, Math.round(delaySeconds / dt));
    this.buffer = new Float64Array(n).fill(initialValue);
  }

  /** 値を投入し、むだ時間だけ前に投入された値を取り出す */
  push(value: number): number {
    const out = this.buffer[this.index]!;
    this.buffer[this.index] = value;
    this.index = (this.index + 1) % this.buffer.length;
    return out;
  }

  /** 現在バッファに入っている最も古い値（取り出さない） */
  peek(): number {
    return this.buffer[this.index]!;
  }

  reset(value = 0): void {
    this.buffer.fill(value);
    this.index = 0;
  }

  get length(): number {
    return this.buffer.length;
  }
}
