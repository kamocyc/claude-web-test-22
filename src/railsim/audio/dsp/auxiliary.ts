import { Biquad, Smoothed } from './biquad.ts';
import { Noise } from './noise.ts';

const TWO_PI = Math.PI * 2;

/** 補機（空気圧縮機）の音を決める量 */
export interface AuxiliaryParams {
  /** 空気圧縮機の吐出し能力 0..1（起動直後は 0 から立ち上がる） */
  readonly compressor: number;
  /** 全体の音量 0..1 */
  readonly level: number;
}

/** 往復式圧縮機の回転数 [Hz]。2 気筒なので吐出しはこの 2 倍の周期で起きる。 */
const CRANK_FREQUENCY = 16.5;

/**
 * 全開時の音量。
 *
 * **80km/h で惰行しているときの走行音より 10dB 下**になるよう実測して決めてある
 * （走行音 rms 0.067 に対して 0.021）。耳で決めると、ほかに何も鳴っていない
 * 停車中に合わせてしまって走行中に過大になる — 実際そうなっていた。
 *
 * この値でも停車中は編成でいちばん大きい音になる。実車で「止まると急に
 * うるさくなる」のは補機が大きいからではなく、走行音が消えるからである。
 */
const FULL_LEVEL = 0.11;

/**
 * 補機の音。いまは空気圧縮機だけを持つ。
 *
 * 往復式の圧縮機は「1 回転に何回か、ピストンが空気を押し出す」ため、
 * 正弦ではなく**短いパルスの列**として聞こえる。パルスを 2 つの共振に
 * 通すことで、実車の「ドドドド…」という低い連打と、駆動電動機の
 * うなりが同時に出る。
 *
 * 車内で最も存在感のある補機音でありながら、運転操作とは無関係な周期で
 * 突然始まって突然止まる。その「唐突さ」こそが再現の目的なので、
 * 起動・停止は元空気溜め圧のモデル（`AirCompressor`）に任せている。
 */
export class AuxiliaryVoice {
  private readonly noise = new Noise(0x4c19);
  private readonly thump = new Biquad();
  private readonly body = new Biquad();
  private readonly motorBand = new Biquad();
  private readonly level: Smoothed;

  private theta = 0;
  private target = 0;
  private readonly dt: number;

  constructor(sampleRate: number) {
    this.dt = 1 / sampleRate;
    this.level = new Smoothed(sampleRate, 0.08);
    this.thump.bandPass(sampleRate, 95, 1.4);
    this.body.bandPass(sampleRate, 320, 2.2);
    this.motorBand.bandPass(sampleRate, 640, 6);
    this.setParams({ compressor: 0, level: 0 });
  }

  setParams(p: AuxiliaryParams): void {
    this.target = p.level * FULL_LEVEL * Math.max(0, Math.min(1, p.compressor));
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const level = this.level.process(this.target);
      this.theta = this.theta + TWO_PI * CRANK_FREQUENCY * this.dt;
      if (this.theta >= TWO_PI) this.theta -= TWO_PI;

      // 1 回転に 2 回、鋭いパルスを出す（2 気筒の吐出し）
      const phase = (this.theta / TWO_PI) * 2;
      const frac = phase - Math.floor(phase);
      const pulse = frac < 0.06 ? 1 - frac / 0.06 : 0;

      const thump = this.thump.process(pulse) * 2.4;
      const body = this.body.process(pulse) * 1.6;
      const motor = this.motorBand.process(this.noise.next()) * 0.5;
      out[i] = out[i]! + (thump + body + motor) * level;
    }
  }

  reset(): void {
    this.thump.reset();
    this.body.reset();
    this.motorBand.reset();
    this.theta = 0;
    this.level.set(0);
  }
}
