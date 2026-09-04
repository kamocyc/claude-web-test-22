import { Biquad } from './biquad.ts';
import { Noise } from './noise.ts';

const TWO_PI = Math.PI * 2;

/** すれ違いざまの圧力波を決める量 */
export interface PassingVoiceParams {
  /** 隣の線路に対向列車がいるか */
  readonly present: boolean;
  /** 相手の先頭端が運転台からどれだけ前方か [m]（負 = すれ違い済み） */
  readonly headGap: number;
  /** 相手の最後尾が運転台からどれだけ前方か [m]（負 = 抜けきった） */
  readonly tailGap: number;
  /** 相対速度 [m/s]（近づく向きが正） */
  readonly closingSpeed: number;
  /** 線路中心間隔 [m] */
  readonly separation: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_PASSING: PassingVoiceParams = {
  present: false,
  headGap: 1e6,
  tailGap: 1e6,
  closingSpeed: 0,
  separation: 3.4,
  level: 0,
};

/**
 * 基準の相対速度 [m/s]（110km/h ＋ 0 に相当）。
 * 圧力波の大きさはこの相対速度で 1 になる。
 */
const REFERENCE_CLOSING = 30;

/** 基準の相対速度・基準の線路中心間隔での圧力波の大きさ */
const PULSE_LEVEL = 0.22;

/** 基準の線路中心間隔 [m]（在来線の交換設備の値） */
const REFERENCE_SEPARATION = 3.4;

/**
 * 圧力波の主成分 [Hz]。
 *
 * 先頭部が押しのけた空気の圧力場が通り過ぎる時間は「先頭部の長さ / 相対速度」で、
 * 20m 級の先頭部と相対 30m/s なら 0.5 秒あまり。その逆数の帯域（数 Hz）は耳に
 * 聞こえないので、実際に聞こえるのは**その圧力変化に車体（側窓・妻面）が
 * 応答して鳴る音**である。側窓のガラスと戸袋がまとめて動く帯がこのあたりにある。
 */
const PULSE_BODY = 46;
/** 側窓のがたつき（圧力の急変で建具が鳴る）の帯域 [Hz] */
const PULSE_RATTLE = 380;

/**
 * すれ違いざまの圧力波。
 *
 * **相手の走らせる音そのものはここには無い。** 相手の転動音も歯車もインバータも
 * 継目も、自列車とまったく同じ音源（`RemoteTrainVoice` が抱える
 * `TrainNoiseSynth`）が鳴らしており、遅れ・ドップラー・距離減衰・車体の遮音は
 * その伝わり方として掛かる。この音源が受け持つのは、**音として伝わってくるので
 * はない**ただ 1 つの成分だけである。
 *
 * すれ違いの瞬間、相手の先頭部が押しのけた空気が自分の車体を叩く。車体表面の
 * 圧力変化は動圧に比例するので**相対速度の 2 乗**で効く。停まっているところを
 * 100km/h で抜かれても、50km/h どうしですれ違っても同じ、というのがこの音の
 * 勘どころである。最後尾が抜ける瞬間には逆向き（引かれる側）の圧が来るので、
 * 対になって「バン…（相手の走行音）…バン」になる。
 *
 * この成分だけ車体の遮音（`CarBodyInsulation`）を通さないのも同じ理由で、
 * 窓を透過してくる音ではなく**車体そのものを押している**からである。すれ違いで
 * 「音は意外にこもっているのに、ドンという衝撃だけは体に来る」のはこの違いによる。
 */
export class PassingVoice {
  private readonly noise = new Noise(0x6ac5);
  private readonly rattleBand = new Biquad();

  /** 圧力波の包絡と位相 */
  private pulseEnvelope = 0;
  private rattleEnvelope = 0;
  private pulsePhase = 0;
  private pulseSign = 1;
  private readonly pulseDecay: number;
  private readonly rattleDecay: number;

  private previousHead = 0;
  private previousTail = 0;
  private tracking = false;
  private readonly dt: number;

  constructor(sampleRate: number) {
    this.dt = 1 / sampleRate;
    this.rattleBand.bandPass(sampleRate, PULSE_RATTLE, 1.1);
    // 車体が圧力の階段に応答して鳴る時間と、建具ががたつく時間
    this.pulseDecay = Math.exp(-1 / (sampleRate * 0.16));
    this.rattleDecay = Math.exp(-1 / (sampleRate * 0.05));
    this.setParams(SILENT_PASSING);
  }

  setParams(p: PassingVoiceParams): void {
    if (!p.present) {
      this.tracking = false;
      return;
    }
    const separation = Math.max(0.5, p.separation);

    // 圧力波は「先頭が並んだ瞬間」と「最後尾が抜けた瞬間」に来る。前フレームからの
    // 符号の変わり目で捉える（すれ違いは数秒かかるので、フレーム精度で足りる）。
    if (this.tracking) {
      const strength =
        Math.pow(Math.max(0, p.closingSpeed) / REFERENCE_CLOSING, 2) *
        (REFERENCE_SEPARATION / separation) *
        p.level *
        PULSE_LEVEL;
      if (this.previousHead > 0 && p.headGap <= 0) this.firePulse(strength, 1);
      // 最後尾が抜けるときは押されるのではなく引かれる（負圧）ので、向きが逆になる
      if (this.previousTail > 0 && p.tailGap <= 0) this.firePulse(strength * 0.8, -1);
    }
    this.previousHead = p.headGap;
    this.previousTail = p.tailGap;
    this.tracking = true;
  }

  private firePulse(strength: number, sign: number): void {
    this.pulseEnvelope = strength;
    this.rattleEnvelope = strength * 0.6;
    this.pulsePhase = 0;
    this.pulseSign = sign;
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      let sound = 0;
      if (this.pulseEnvelope > 1e-5) {
        this.pulsePhase = wrap(this.pulsePhase + TWO_PI * PULSE_BODY * this.dt);
        sound += Math.sin(this.pulsePhase) * this.pulseEnvelope * this.pulseSign;
        this.pulseEnvelope *= this.pulseDecay;
      }
      if (this.rattleEnvelope > 1e-5) {
        sound += this.rattleBand.process(this.noise.next()) * this.rattleEnvelope;
        this.rattleEnvelope *= this.rattleDecay;
      }
      if (sound !== 0) out[i] = out[i]! + sound;
    }
  }

  reset(): void {
    this.rattleBand.reset();
    this.pulseEnvelope = 0;
    this.rattleEnvelope = 0;
    this.tracking = false;
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
