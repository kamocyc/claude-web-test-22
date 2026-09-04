import { Biquad, Smoothed } from './biquad.ts';
import { DcMotorTone, type DcMotorParams } from './dcMotorVoice.ts';
import { Noise } from './noise.ts';

const TWO_PI = Math.PI * 2;

/** 抵抗制御の主回路の音のパラメータ */
export interface ResistorVoiceParams {
  /** 主接触器が入っているか（惰行では false） */
  readonly gate: boolean;
  /** 定格に対する電機子電流 */
  readonly current: number;
  /** 電機子スロットの通過周波数 [Hz]（主電動機の音程を決める） */
  readonly slotFrequency: number;
  /** ブラシが整流子片を渡る周波数 [Hz] */
  readonly commutatorFrequency: number;
  /** 通風ファンの翼通過周波数 [Hz] */
  readonly ventilationFrequency: number;
  /** 起動抵抗で熱にしている電力（定格に対する比 0..1）。全短絡した段では 0。 */
  readonly resistorPower: number;
  /** このフレームでカム軸が進段した回数 */
  readonly steps: number;
  /** このフレームで直並列の組替えが起きた回数 */
  readonly groupChanges: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_RESISTOR: ResistorVoiceParams = {
  gate: false,
  current: 0,
  slotFrequency: 0,
  commutatorFrequency: 0,
  ventilationFrequency: 0,
  resistorPower: 0,
  steps: 0,
  groupChanges: 0,
  level: 0,
};

/**
 * 接触器の打撃で励振される経路 [中心周波数 Hz, Q, 減衰時定数 s, 重み]。
 *
 * 分岐器や継目と違って、これは**床下の箱の中で金属が閉じる音**である。
 * 質量が小さいので低域は乗らず、短く硬い。カム軸の 1 段は単位スイッチが
 * 1 つ閉じるだけなので軽く、直並列の組替えは主接触器が一斉に動くので重い。
 *
 * | 経路                       | 周波数 | 残る長さ | 聞こえ方 |
 * | -------------------------- | ------ | -------- | -------- |
 * | 機器箱・取付台が揺れる     | 130Hz  | 70ms     | ドッ     |
 * | 接触器の可動部が当たる     | 620Hz  | 25ms     | カッ     |
 * | 接点そのものの金属打撃     | 2400Hz | 8ms      | チッ     |
 */
const CONTACTOR_MODES: ReadonlyArray<readonly [number, number, number, number]> = [
  [130, 1.8, 0.07, 0.9],
  [620, 2.6, 0.025, 1.0],
  [2400, 2.2, 0.008, 0.55],
];

/** 同時に鳴らせる打撃の数 */
const MAX_IMPACTS = 8;

/** 打撃の全体倍率（帯域通過のピーク正規化を補う） */
const IMPACT_GAIN = 5.0;

/** 直並列切替の打撃に掛かる倍率（進段より重い） */
const GROUP_CHANGE_GAIN = 2.2;

/** 同じフレームに複数回進段したときに音をずらす間隔 [s] */
const IMPACT_SPACING = 0.012;

/** 起動抵抗の送風機の回転による脈動 [Hz] */
const BLOWER_FREQUENCY = 28;

/**
 * 抵抗制御車の主回路の音。
 *
 * 3 つの成分でできている:
 *
 *  1. **主電動機**（`DcMotorTone`）— キャリアが無いので音程は回転数だけで決まる。
 *     力行中は限流値で電流がほぼ一定なので、音量が変わらず音程だけが上がっていく。
 *     ノッチを切っても通風音だけは残る。
 *  2. **起動抵抗のうなり** — 抵抗器は電流の 2 乗に比例して発熱し、その送風機と
 *     格子の振動が低い唸りになる。**段が進んで抵抗が短絡されるほど小さくなり、
 *     全短絡した段と弱め界磁域では完全に消える。** 音量を別に決めているのではなく、
 *     物理側が計算した「いま抵抗で捨てている電力」をそのまま渡している。
 *  3. **カム軸の進段音** — 単位スイッチが閉じる短い打撃。直並列の組替えだけは
 *     主接触器が一斉に動くので、はっきり重い音になる。
 *
 * 2 と 3 が VVVF 車には無い音であり、抵抗制御車らしさはほぼこの 2 つが作っている。
 */
export class ResistorVoice {
  private readonly motor: DcMotorTone;
  private readonly noise = new Noise(0x71c3);
  private readonly gridBand: Biquad;
  private readonly gridLow: Biquad;
  private readonly gridSmooth: Smoothed;
  private readonly levelSmooth: Smoothed;

  private readonly delays = new Float64Array(MAX_IMPACTS);
  private readonly amplitudes = new Float64Array(MAX_IMPACTS);
  private readonly envelopes = new Float64Array(MAX_IMPACTS * CONTACTOR_MODES.length);
  private readonly started = new Uint8Array(MAX_IMPACTS);
  private readonly active = new Uint8Array(MAX_IMPACTS);
  private readonly filters: Biquad[] = [];
  private readonly weights: number[] = [];
  private readonly decays: number[] = [];
  private readonly excitation = new Float64Array(CONTACTOR_MODES.length);

  private blowerPhase = 0;
  private params: ResistorVoiceParams = SILENT_RESISTOR;

  constructor(readonly sampleRate: number) {
    this.motor = new DcMotorTone(sampleRate);
    this.gridBand = new Biquad().bandPass(sampleRate, 260, 0.55);
    this.gridLow = new Biquad().lowPass(sampleRate, 900);
    this.gridSmooth = new Smoothed(sampleRate, 0.05);
    this.levelSmooth = new Smoothed(sampleRate, 0.02);
    for (const [frequency, q, tau, weight] of CONTACTOR_MODES) {
      this.filters.push(new Biquad().bandPass(sampleRate, frequency, q));
      this.weights.push(weight);
      this.decays.push(Math.exp(-1 / (sampleRate * tau)));
    }
  }

  setParams(params: ResistorVoiceParams): void {
    this.params = params;
    // 主接触器が切れていても電動機は回り続けるので、周波数はそのまま渡す。
    // 切れて消えるのは電流が作る電磁音だけで、通風音は残る。
    const motor: DcMotorParams = {
      slotFrequency: params.slotFrequency,
      commutatorFrequency: params.commutatorFrequency,
      ventilationFrequency: params.ventilationFrequency,
      current: params.gate ? params.current : 0,
      level: params.level,
    };
    this.motor.setParams(motor);
    this.scheduleImpacts(params);
  }

  /** 進段・組替えの打撃を予約する */
  private scheduleImpacts(params: ResistorVoiceParams): void {
    const spacing = Math.round(IMPACT_SPACING * this.sampleRate);
    // 組替えは進段の一種でもあるので、重い音を先に置いてから残りを軽い音にする。
    const heavy = Math.min(params.groupChanges, MAX_IMPACTS);
    const light = Math.max(0, Math.min(params.steps - params.groupChanges, MAX_IMPACTS - heavy));
    let slot = 0;
    for (let i = 0; i < heavy; i++) this.trigger(slot++ * spacing, GROUP_CHANGE_GAIN);
    for (let i = 0; i < light; i++) this.trigger(slot++ * spacing, 1);
  }

  private trigger(delay: number, strength: number): void {
    for (let i = 0; i < MAX_IMPACTS; i++) {
      if (this.active[i]) continue;
      this.active[i] = 1;
      this.started[i] = 0;
      this.delays[i] = Math.max(0, delay);
      this.amplitudes[i] = strength;
      for (let m = 0; m < CONTACTOR_MODES.length; m++) {
        this.envelopes[i * CONTACTOR_MODES.length + m] = 0;
      }
      return;
    }
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    this.motor.render(out);
    this.renderGrid(out);
    this.renderImpacts(out);
  }

  /** 起動抵抗のうなり */
  private renderGrid(out: Float32Array): void {
    const p = this.params;
    const dt = 1 / this.sampleRate;
    const drive = p.gate ? p.resistorPower : 0;

    for (let i = 0; i < out.length; i++) {
      const level = this.levelSmooth.process(p.level);
      const power = this.gridSmooth.process(drive);
      this.blowerPhase = wrap(this.blowerPhase + TWO_PI * BLOWER_FREQUENCY * dt);
      if (power <= 1e-4 || level <= 1e-5) continue;
      // 送風機の回転で風量が周期的に変わるので、うなりも脈動する。
      const pulsation = 1 + 0.25 * Math.sin(this.blowerPhase);
      const n = this.noise.next();
      const band = this.gridBand.process(n) * 1.6 + this.gridLow.process(n) * 0.5;
      out[i] = out[i]! + band * power * pulsation * level;
    }
  }

  /** カム軸・接触器の打撃 */
  private renderImpacts(out: Float32Array): void {
    const modes = CONTACTOR_MODES.length;
    const excitation = this.excitation;
    const level = this.params.level;

    for (let i = 0; i < out.length; i++) {
      excitation.fill(0);
      let ringing = false;

      for (let v = 0; v < MAX_IMPACTS; v++) {
        if (!this.active[v]) continue;
        if (this.delays[v]! > 0) {
          this.delays[v]!--;
          ringing = true;
          continue;
        }
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
    this.motor.reset();
    this.active.fill(0);
    this.started.fill(0);
    this.envelopes.fill(0);
    this.blowerPhase = 0;
    this.gridBand.reset();
    this.gridLow.reset();
    this.gridSmooth.set(0);
    this.levelSmooth.set(0);
    for (const f of this.filters) f.reset();
    this.params = SILENT_RESISTOR;
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
