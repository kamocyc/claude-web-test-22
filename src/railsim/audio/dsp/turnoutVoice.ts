import { Biquad } from './biquad.ts';
import { Noise } from './noise.ts';

/** 分岐器の 1 要素を 1 軸が踏んだイベント */
export interface TurnoutImpact {
  /** 発音までの遅れ [サンプル数]（フレーム内の位置をサンプル精度で表す） */
  readonly delay: number;
  /** 衝撃の強さ 0..1 */
  readonly strength: number;
  /** クロッシング（欠線）か、トングレールか */
  readonly crossing: boolean;
}

/** 同時に鳴らせる衝撃の数（4 両 16 軸 × 2 要素が重なることはない） */
const MAX_VOICES = 32;

/**
 * 打撃で励振される経路 [中心周波数 Hz, Q, 減衰時定数 s, 重み]。
 *
 * レール継目より**重く長い**のが分岐器の音の特徴である。継目の段差は数 mm だが、
 * クロッシングの欠線では車輪がいったん支えを失って翼レールへ落ちるため、
 * ばね下がまるごと上下する。分岐器は前後 20m 以上にわたって長いまくらぎと
 * 分岐器用の重い部材で組まれており、その全体が鳴る。
 *
 * | 経路                                 | 周波数 | 残る長さ | 聞こえ方 |
 * | ------------------------------------ | ------ | -------- | -------- |
 * | 分岐器全体（長まくらぎ・道床）       | 55Hz   | 320ms    | ゴ〜     |
 * | 台車枠・軸箱（ばね下）が落ちて着く   | 180Hz  | 110ms    | ドン     |
 * | 車輪踏面と翼レール・ノーズの打撃     | 1100Hz | 22ms     | ガチャ   |
 */
const MODES: ReadonlyArray<readonly [number, number, number, number]> = [
  [55, 1.4, 0.18, 1.0],
  [180, 2.2, 0.075, 1.1],
  [1100, 1.8, 0.018, 0.7],
];

/**
 * 全体の倍率。帯域通過はピークゲインが 1 に正規化してあるため、衝撃のような
 * 短い入力に対する出力は帯域幅のぶんだけ小さくなる。継目音と同じ測り方で決めた値。
 */
const IMPACT_GAIN = 8.5;

/** トングレール側の衝撃に掛かる倍率（欠線を踏むクロッシングよりは軽い） */
const POINTS_GAIN = 0.55;

/**
 * 分岐器（ポイント）を通過する音。
 *
 * 継目音と同じ「サンプル精度で予約する打撃」だが、鳴り方が違う。1 つの分岐器で
 * 軸ごとに 2 回 — トングレール先端とクロッシング — 踏むので、
 * **「ガタン…ガタン」が対で来て、それが軸の数だけ続く**。間隔はトングレールから
 * クロッシングまでの距離（リード長）を速度で割った時間そのものなので、
 * 番数が大きい（＝リードが長い）分岐器ほど 2 つの音が離れて聞こえる。
 *
 * 継目音（`RailJointVoice`）と分けてあるのは、鳴り方が違うだけでなく、
 * ミキサで別々に音量を調整できるようにするためでもある。
 */
export class TurnoutVoice {
  private readonly noise = new Noise(0x5b21);
  private readonly delays = new Float64Array(MAX_VOICES);
  private readonly amplitudes = new Float64Array(MAX_VOICES);
  /** 声 × 経路 の包絡 */
  private readonly envelopes = new Float64Array(MAX_VOICES * MODES.length);
  private readonly started = new Uint8Array(MAX_VOICES);
  private readonly active = new Uint8Array(MAX_VOICES);
  private readonly filters: Biquad[] = [];
  private readonly weights: number[] = [];
  private readonly decays: number[] = [];
  private readonly excitation = new Float64Array(MODES.length);

  constructor(sampleRate: number) {
    for (const [frequency, q, tau, weight] of MODES) {
      this.filters.push(new Biquad().bandPass(sampleRate, frequency, q));
      this.weights.push(weight);
      this.decays.push(Math.exp(-1 / (sampleRate * tau)));
    }
  }

  /** 衝撃を予約する。バッファの先頭から `delay` サンプル後に鳴る。 */
  trigger(impact: TurnoutImpact): void {
    for (let i = 0; i < MAX_VOICES; i++) {
      if (this.active[i]) continue;
      this.active[i] = 1;
      this.started[i] = 0;
      this.delays[i] = Math.max(0, impact.delay);
      this.amplitudes[i] = impact.strength * (impact.crossing ? 1 : POINTS_GAIN);
      for (let m = 0; m < MODES.length; m++) this.envelopes[i * MODES.length + m] = 0;
      return;
    }
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    const modes = MODES.length;
    const excitation = this.excitation;

    for (let i = 0; i < out.length; i++) {
      excitation.fill(0);
      let ringing = false;

      for (let v = 0; v < MAX_VOICES; v++) {
        if (!this.active[v]) continue;
        if (this.delays[v]! > 0) {
          this.delays[v]!--;
          ringing = true;
          continue;
        }
        const base = v * modes;
        if (!this.started[v]) {
          // 立ち上がりの 1 サンプルが衝撃そのもの。すべての経路を同時に叩く。
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
      out[i] = out[i]! + sum * IMPACT_GAIN;
    }
  }

  reset(): void {
    this.active.fill(0);
    this.started.fill(0);
    this.envelopes.fill(0);
    for (const f of this.filters) f.reset();
  }
}
