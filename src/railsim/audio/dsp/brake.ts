import { Biquad, Smoothed } from './biquad.ts';
import { Noise, PinkFilter } from './noise.ts';

/** ブレーキと空気の音を決める量 */
export interface BrakeParams {
  /** 車速の大きさ [m/s] */
  readonly speed: number;
  /** ブレーキシリンダ圧（最大圧に対する比 0..1） */
  readonly cylinderPressure: number;
  /**
   * BC 圧の変化率（最大圧に対する比 / 秒）。
   * 正 = 込め（弱い「シュッ」）、負 = 緩め（強い「プシュー」）。
   */
  readonly pressureRate: number;
  /** 全体の音量 0..1 */
  readonly level: number;
}

/**
 * 基礎ブレーキと空気の音。
 *
 * - **摩擦音**: 制輪子／ディスクが擦れる広帯域音。押付力（BC 圧）と
 *   すべり速度（車速）の積、つまり摩擦の消費電力にほぼ比例する。
 *   止まる寸前に消えるのは速度が 0 になるからで、圧力が抜けるからではない。
 * - **鳴き**: 低速で押付力が高いときに出る自励振動。摩擦係数の速度勾配が
 *   負になる領域で摩擦面が固着と滑りを繰り返すために起きるので、
 *   停止直前の数秒だけ現れるという条件がそのまま再現になる。
 * - **空気音**: BC 圧の**変化率**から出す。込めるときは供給側の絞りを
 *   通る音で弱く、緩めるときは大気へ放出するので強い。緩解の
 *   「プシュー」が込めより目立つのはこの非対称による。
 */
export class BrakeVoice {
  private readonly noise = new Noise(0x9e37);
  private readonly pink = new PinkFilter();
  private readonly frictionBand = new Biquad();
  private readonly squealBand = new Biquad();
  private readonly airBand = new Biquad();

  private readonly frictionLevel: Smoothed;
  private readonly squealLevel: Smoothed;
  private readonly airLevel: Smoothed;

  private targetFriction = 0;
  private targetSqueal = 0;
  private targetAir = 0;

  constructor(private readonly sampleRate: number) {
    this.frictionLevel = new Smoothed(sampleRate, 0.04);
    this.squealLevel = new Smoothed(sampleRate, 0.12);
    this.airLevel = new Smoothed(sampleRate, 0.03);
    this.frictionBand.bandPass(sampleRate, 900, 0.8);
    // 鳴きは摩擦面の自励振動。かなり鋭い共振として出る。
    this.squealBand.bandPass(sampleRate, 2600, 34);
    this.airBand.bandPass(sampleRate, 2600, 0.7);
    this.setParams({ speed: 0, cylinderPressure: 0, pressureRate: 0, level: 0 });
  }

  setParams(p: BrakeParams): void {
    const v = Math.abs(p.speed);
    const pressure = Math.max(0, Math.min(1, p.cylinderPressure));

    // 摩擦音 ∝ 押付力 × すべり速度
    this.targetFriction = p.level * 1.1 * pressure * Math.min(1, v / 12);
    this.frictionBand.bandPass(this.sampleRate, 700 + 500 * pressure, 0.8);

    // 鳴きは「押付力が強い」かつ「低速」でのみ立ち上がる
    const slow = v > 0.4 && v < 7 ? 1 - Math.abs(v - 2.5) / 4.5 : 0;
    this.targetSqueal = p.level * 2.4 * pressure * Math.max(0, slow) * (pressure > 0.35 ? 1 : 0);

    // 空気音: 緩め（負）のほうが大気開放なので大きく、帯域も低い
    const rate = p.pressureRate;
    if (rate < 0) {
      this.targetAir = p.level * Math.min(1, -rate * 0.9);
      this.airBand.bandPass(this.sampleRate, 1800, 0.5);
    } else {
      this.targetAir = p.level * Math.min(1, rate * 0.35);
      this.airBand.bandPass(this.sampleRate, 3200, 0.8);
    }
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const white = this.noise.next();
      const pink = this.pink.process(white);
      const friction =
        this.frictionBand.process(pink) * this.frictionLevel.process(this.targetFriction);
      const squeal = this.squealBand.process(white) * this.squealLevel.process(this.targetSqueal);
      const air = this.airBand.process(white) * this.airLevel.process(this.targetAir);
      out[i] = out[i]! + friction + squeal + air;
    }
  }

  reset(): void {
    this.pink.reset();
    this.frictionBand.reset();
    this.squealBand.reset();
    this.airBand.reset();
    this.frictionLevel.set(0);
    this.squealLevel.set(0);
    this.airLevel.set(0);
  }
}
