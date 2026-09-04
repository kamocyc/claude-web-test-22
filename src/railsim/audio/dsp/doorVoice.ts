import { Biquad, OnePoleLowPass, Smoothed } from './biquad.ts';
import { Noise } from './noise.ts';

const TWO_PI = Math.PI * 2;

/** 客用扉の音のパラメータ */
export interface DoorVoiceParams {
  /** 扉が動いているか */
  readonly moving: boolean;
  /** 閉じる向きに動いているか（開くときとは空気の抜け方が違う） */
  readonly closing: boolean;
  /** ドアチャイムが鳴っているか */
  readonly chiming: boolean;
  /** このフレームで閉じ切って施錠された回数 */
  readonly latches: number;
  /** このフレームで開き切った回数 */
  readonly opens: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_DOOR: DoorVoiceParams = {
  moving: false,
  closing: false,
  chiming: false,
  latches: 0,
  opens: 0,
  level: 0,
};

/**
 * ドアチャイムの 2 音 [Hz]。
 *
 * 「ピンポーン」は完全 4 度の 2 音である。高いほうから低いほうへ下がるのが
 * 日本の車両で広く使われている形で、上がると呼び出し音に聞こえてしまう。
 * B5 → F#5（1975.5 → 1480.0Hz の 1 オクターブ下）。
 */
const CHIME_TONES: readonly [number, number] = [987.77, 739.99];

/** チャイム 1 音の長さ [s] */
const CHIME_TONE_TIME = 0.42;
/** チャイムの繰り返し周期 [s]（2 音 + 間） */
const CHIME_PERIOD = 1.1;
/** チャイムの減衰時定数 [s]（打鐘のように減衰する） */
const CHIME_DECAY = 0.22;

/**
 * 戸当たりで励振される経路 [中心周波数 Hz, Q, 減衰時定数 s, 重み]。
 *
 * 戸閉めの「ガシャン」は 2 つの音が重なっている。1 つは扉の framing が戸先で
 * 突き当たる金属音、もう 1 つは戸先ゴムが潰れる鈍い音である。ゴムがあるぶん
 * 接触器（`resistorVoice.ts`）より低く、そのぶん長く残る。
 *
 * | 経路                     | 周波数 | 残る長さ | 聞こえ方 |
 * | ------------------------ | ------ | -------- | -------- |
 * | 戸袋・側構体が揺れる     | 95Hz   | 110ms    | ドン     |
 * | 扉本体の板の振動         | 430Hz  | 45ms     | ガシャ   |
 * | 戸先の金具が当たる       | 1800Hz | 12ms     | チャッ   |
 */
const IMPACT_MODES: ReadonlyArray<readonly [number, number, number, number]> = [
  [95, 1.6, 0.11, 1.0],
  [430, 2.4, 0.045, 0.9],
  [1800, 2.0, 0.012, 0.45],
];

/** 同時に鳴らせる戸当たりの数 */
const MAX_IMPACTS = 4;

/** 戸当たりの全体倍率（帯域通過のピーク正規化を補う） */
const IMPACT_GAIN = 3.2;

/**
 * 開き切ったときの倍率。
 * 戸袋へ入って止まるだけなので、戸先どうしが突き当たる戸閉めより軽い。
 */
const OPEN_STOP_GAIN = 0.45;

/** 空気の抜ける音の立ち上がり・立ち下がり時定数 [s] */
const AIR_ATTACK = 0.04;
const AIR_RELEASE = 0.12;

/**
 * チャイムの全体倍率。
 *
 * 実測で決めてある。物差しは走行音ではなく**運転台の報知音**（`cab.ts` の ATS
 * チャイムと打鐘）で、鳴っている瞬間の A 特性実効値がそれと同じ水準になる。
 * 車内で鳴る合図はどれも近くで鳴るので、走行音より小さくても十分に通る。
 */
const CHIME_GAIN = 0.18;

/**
 * 空気音の全体倍率。
 * 戸閉め装置は目立つ音だが、主電動機と張り合うほどではない。
 */
const AIR_GAIN = 0.25;

/**
 * 客用扉の音。
 *
 * 3 つの成分でできている。
 *
 *  1. **ドアチャイム** — 完全 4 度の 2 音を繰り返す。核が鳴っているあいだだけ鳴り、
 *     長さは扉装置（`packages/core/src/door/system.ts`）が決める。閉めるときは
 *     チャイムが先に鳴り、少し置いてから扉が動き出す（閉扉予告）ので、
 *     「ピンポーン…（間）…プシュー」という順番が自然に出る。
 *  2. **戸閉め装置の空気音** — 扉が動いているあいだだけ鳴る帯域雑音。閉めるときは
 *     排気が絞られるぶん低く長く、開くときは勢いよく抜けるので高く短い。
 *  3. **戸当たり** — 閉まり切った瞬間の「ガシャン」と、開き切って戸袋に当たる音。
 *     どちらも撃力でモーダルに励振する。前者のほうがはっきり重い。
 */
export class DoorVoice {
  private readonly noise = new Noise(0x3d97);
  private readonly airBand: Biquad;
  private readonly airTilt: OnePoleLowPass;
  /**
   * 空気音の包絡。立ち上がりと立ち下がりで時定数が違うので、`Smoothed` ではなく
   * 非対称な 1 次で持つ。弁が開くのは速く、抜け切るのはゆっくりである。
   */
  private airEnvelope = 0;
  private readonly airAttack: number;
  private readonly airRelease: number;
  private readonly levelSmooth: Smoothed;
  private readonly chimeLevel: Smoothed;

  private readonly delays = new Float64Array(MAX_IMPACTS);
  private readonly amplitudes = new Float64Array(MAX_IMPACTS);
  private readonly envelopes = new Float64Array(MAX_IMPACTS * IMPACT_MODES.length);
  private readonly started = new Uint8Array(MAX_IMPACTS);
  private readonly active = new Uint8Array(MAX_IMPACTS);
  private readonly filters: Biquad[] = [];
  private readonly weights: number[] = [];
  private readonly decays: number[] = [];
  private readonly excitation = new Float64Array(IMPACT_MODES.length);

  /** チャイムの繰り返しの中での位置 [s] */
  private chimePhase = 0;
  private thetaA = 0;
  private thetaB = 0;
  private params: DoorVoiceParams = SILENT_DOOR;

  constructor(readonly sampleRate: number) {
    this.airBand = new Biquad().bandPass(sampleRate, 1100, 0.6);
    this.airTilt = new OnePoleLowPass(sampleRate, 2600);
    this.airAttack = Math.exp(-1 / (sampleRate * AIR_ATTACK));
    this.airRelease = Math.exp(-1 / (sampleRate * AIR_RELEASE));
    this.levelSmooth = new Smoothed(sampleRate, 0.02);
    this.chimeLevel = new Smoothed(sampleRate, 0.01);
    for (const [frequency, q, tau, weight] of IMPACT_MODES) {
      this.filters.push(new Biquad().bandPass(sampleRate, frequency, q));
      this.weights.push(weight);
      this.decays.push(Math.exp(-1 / (sampleRate * tau)));
    }
  }

  setParams(params: DoorVoiceParams): void {
    const wasChiming = this.params.chiming;
    this.params = params;
    // チャイムが鳴り始めたら繰り返しの頭から
    if (params.chiming && !wasChiming) this.chimePhase = 0;
    for (let i = 0; i < params.latches; i++) this.trigger(1);
    for (let i = 0; i < params.opens; i++) this.trigger(OPEN_STOP_GAIN);
  }

  private trigger(strength: number): void {
    for (let i = 0; i < MAX_IMPACTS; i++) {
      if (this.active[i]) continue;
      this.active[i] = 1;
      this.started[i] = 0;
      this.delays[i] = 0;
      this.amplitudes[i] = strength;
      for (let m = 0; m < IMPACT_MODES.length; m++) {
        this.envelopes[i * IMPACT_MODES.length + m] = 0;
      }
      return;
    }
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    this.renderChime(out);
    this.renderAir(out);
    this.renderImpacts(out);
  }

  /** ドアチャイム（完全 4 度の 2 音） */
  private renderChime(out: Float32Array): void {
    const p = this.params;
    const dt = 1 / this.sampleRate;

    for (let i = 0; i < out.length; i++) {
      const level = this.levelSmooth.process(p.level);
      const gate = this.chimeLevel.process(p.chiming ? 1 : 0);
      this.thetaA = wrap(this.thetaA + TWO_PI * CHIME_TONES[0] * dt);
      this.thetaB = wrap(this.thetaB + TWO_PI * CHIME_TONES[1] * dt);
      if (gate <= 1e-4 || level <= 1e-5) {
        this.chimePhase = 0;
        continue;
      }
      this.chimePhase += dt;
      if (this.chimePhase >= CHIME_PERIOD) this.chimePhase -= CHIME_PERIOD;

      // 「ピン」（高いほう）→「ポーン」（低いほう）の順。どちらも打鐘のように減衰する。
      let sound = 0;
      if (this.chimePhase < CHIME_TONE_TIME) {
        const envelope = Math.exp(-this.chimePhase / CHIME_DECAY);
        sound = Math.sin(this.thetaA) * envelope;
      } else if (this.chimePhase < CHIME_TONE_TIME * 2) {
        const envelope = Math.exp(-(this.chimePhase - CHIME_TONE_TIME) / CHIME_DECAY);
        // 低いほうは少しだけ長く残す（実際の鐘も低い音のほうが減衰が遅い）
        sound = Math.sin(this.thetaB) * envelope * 1.15;
      }
      out[i] = out[i]! + sound * gate * level * CHIME_GAIN;
    }
  }

  /** 戸閉め装置の空気音 */
  private renderAir(out: Float32Array): void {
    const p = this.params;
    // 閉めるときは排気を絞るので低く長く、開くときは勢いよく抜けるので高く短い。
    const drive = p.moving ? (p.closing ? 0.75 : 1.0) : 0;

    for (let i = 0; i < out.length; i++) {
      const level = this.levelSmooth.process(p.level);
      const coefficient = drive > this.airEnvelope ? this.airAttack : this.airRelease;
      this.airEnvelope = drive + (this.airEnvelope - drive) * coefficient;
      const envelope = this.airEnvelope;
      if (envelope <= 1e-4 || level <= 1e-5) continue;
      const n = this.noise.next();
      const band = this.airBand.process(n) * 1.4 + this.airTilt.process(n) * 0.6;
      out[i] = out[i]! + band * envelope * level * AIR_GAIN;
    }
  }

  /** 戸当たりの撃力 */
  private renderImpacts(out: Float32Array): void {
    const modes = IMPACT_MODES.length;
    const excitation = this.excitation;
    const level = this.params.level;

    for (let i = 0; i < out.length; i++) {
      excitation.fill(0);
      let ringing = false;

      for (let v = 0; v < MAX_IMPACTS; v++) {
        if (!this.active[v]) continue;
        const base = v * modes;
        if (!this.started[v]) {
          this.started[v] = 1;
          const amplitude = this.amplitudes[v]!;
          for (let m = 0; m < modes; m++) {
            this.envelopes[base + m] = amplitude;
            excitation[m] = excitation[m]! + amplitude;
          }
          ringing = true;
          continue;
        }
        let alive = false;
        for (let m = 0; m < modes; m++) {
          const env = this.envelopes[base + m]!;
          if (env < 1e-4) continue;
          excitation[m] = excitation[m]! + env * this.noise.next() * 0.6;
          this.envelopes[base + m] = env * this.decays[m]!;
          alive = true;
        }
        if (alive) ringing = true;
        else this.active[v] = 0;
      }

      if (!ringing) continue;
      let sum = 0;
      for (let m = 0; m < modes; m++) {
        sum += this.filters[m]!.process(excitation[m]!) * this.weights[m]!;
      }
      out[i] = out[i]! + sum * IMPACT_GAIN * level;
    }
  }

  reset(): void {
    this.active.fill(0);
    this.started.fill(0);
    this.envelopes.fill(0);
    this.chimePhase = 0;
    this.thetaA = 0;
    this.thetaB = 0;
    this.airBand.reset();
    this.airTilt.reset();
    this.airEnvelope = 0;
    this.levelSmooth.set(0);
    this.chimeLevel.set(0);
    for (const f of this.filters) f.reset();
    this.params = SILENT_DOOR;
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
