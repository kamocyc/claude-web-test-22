import { Rng } from '../math/rng.ts';
import type { Meters } from '../units.ts';

/** 軌道狂い（軌道の不整）の量 */
export interface IrregularitySample {
  /** 高低狂い [m]（上下方向の凹凸。左右レールの平均） */
  readonly vertical: Meters;
  /** 通り狂い [m]（左右方向の蛇行） */
  readonly lateral: Meters;
  /** 水準狂い [m]（左右レールの高さの差。車体をロールさせる） */
  readonly crossLevel: Meters;
}

export interface IrregularityParams {
  /** 高低狂いの標準偏差 [m] */
  readonly verticalAmplitude: number;
  /** 通り狂いの標準偏差 [m] */
  readonly lateralAmplitude: number;
  /** 水準狂いの標準偏差 [m] */
  readonly crossLevelAmplitude: number;
  /** 最短波長 [m] */
  readonly minWavelength: Meters;
  /** 最長波長 [m] */
  readonly maxWavelength: Meters;
  /** 重ね合わせる正弦波の本数 */
  readonly components: number;
}

export const DEFAULT_IRREGULARITY: IrregularityParams = {
  // 在来線の整備された軌道の代表値（10m 弦正矢で数 mm 程度）
  verticalAmplitude: 0.0025,
  lateralAmplitude: 0.002,
  crossLevelAmplitude: 0.0022,
  minWavelength: 2.5,
  maxWavelength: 45,
  components: 9,
};

interface Channel {
  readonly amplitude: Float64Array;
  readonly waveNumber: Float64Array;
  readonly phase: Float64Array;
}

/**
 * 軌道狂い（軌道の不整）。
 *
 * 実際の軌道狂いは「線路のその場所に固有の形状」であり、時間ではなく**距離程の関数**である。
 * 同じ地点を何度通っても同じ揺れ方をし、逆走すれば揺れの順序が反転する。
 * そのため乱数を毎ステップ引くのではなく、シードから決めた位相を持つ正弦波の
 * 重ね合わせとして s の関数を構成する。
 *
 * 振幅は波長に比例させている。これは軌道狂いのパワースペクトル密度が
 * おおむね空間周波数の -3 乗に比例する（長い波長ほど大きな狂いを持つ）という
 * 実測の傾向に対応する。
 */
export class TrackIrregularity {
  private readonly verticalCh: Channel;
  private readonly lateralCh: Channel;
  private readonly crossLevelCh: Channel;
  readonly params: IrregularityParams;

  constructor(seed: number, params: IrregularityParams = DEFAULT_IRREGULARITY, scale = 1) {
    this.params = params;
    const rng = new Rng(seed);
    this.verticalCh = buildChannel(rng.fork(1), params, params.verticalAmplitude * scale);
    this.lateralCh = buildChannel(rng.fork(2), params, params.lateralAmplitude * scale);
    this.crossLevelCh = buildChannel(rng.fork(3), params, params.crossLevelAmplitude * scale);
  }

  /** 距離程 s における軌道狂い */
  at(s: Meters): IrregularitySample {
    return {
      vertical: evaluate(this.verticalCh, s),
      lateral: evaluate(this.lateralCh, s),
      crossLevel: evaluate(this.crossLevelCh, s),
    };
  }

  verticalAt(s: Meters): Meters {
    return evaluate(this.verticalCh, s);
  }

  lateralAt(s: Meters): Meters {
    return evaluate(this.lateralCh, s);
  }

  crossLevelAt(s: Meters): Meters {
    return evaluate(this.crossLevelCh, s);
  }
}

function buildChannel(rng: Rng, params: IrregularityParams, sigma: number): Channel {
  const n = Math.max(1, params.components);
  const amplitude = new Float64Array(n);
  const waveNumber = new Float64Array(n);
  const phase = new Float64Array(n);
  const ratio = params.maxWavelength / params.minWavelength;

  // まず波長に比例した相対振幅を置き、全体の標準偏差が sigma になるよう正規化する
  let power = 0;
  for (let i = 0; i < n; i++) {
    const lambda = params.minWavelength * Math.pow(ratio, n === 1 ? 0 : i / (n - 1));
    waveNumber[i] = (2 * Math.PI) / lambda;
    amplitude[i] = lambda;
    phase[i] = rng.range(0, 2 * Math.PI);
    power += (lambda * lambda) / 2;
  }
  const norm = power > 0 ? sigma / Math.sqrt(power) : 0;
  for (let i = 0; i < n; i++) amplitude[i]! *= norm;

  return { amplitude, waveNumber, phase };
}

function evaluate(ch: Channel, s: number): number {
  let sum = 0;
  for (let i = 0; i < ch.amplitude.length; i++) {
    sum += ch.amplitude[i]! * Math.sin(ch.waveNumber[i]! * s + ch.phase[i]!);
  }
  return sum;
}

/** 狂いのない軌道（テスト用） */
export const SMOOTH_TRACK = new TrackIrregularity(0, DEFAULT_IRREGULARITY, 0);
