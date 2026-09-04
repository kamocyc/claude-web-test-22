/**
 * 決定論的な白色雑音源。
 *
 * `@railsim/core` の `Rng` と同じ mulberry32 だが、こちらは意図的に自前で持つ。
 * この DSP は AudioWorklet のバンドルに入るため、物理コアの barrel をまるごと
 * 引き込みたくないという理由による（音の合成に軌道線形も信号も要らない）。
 */
export class Noise {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [-1, 1) の一様乱数 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
  }
}

/**
 * ピンク雑音への整形（-3dB/oct）。
 *
 * 転動音も風切り音も、実測のスペクトルは白色ではなく高域へ向かって
 * なだらかに下がる。Paul Kellet の 3 段近似を使う。
 */
export class PinkFilter {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;

  process(white: number): number {
    this.b0 = 0.99765 * this.b0 + white * 0.099046;
    this.b1 = 0.963 * this.b1 + white * 0.2965164;
    this.b2 = 0.57 * this.b2 + white * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + white * 0.1848) * 0.2;
  }

  reset(): void {
    this.b0 = 0;
    this.b1 = 0;
    this.b2 = 0;
  }
}
