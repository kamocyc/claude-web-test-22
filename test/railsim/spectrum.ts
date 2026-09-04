import { Biquad, OnePoleHighPass } from '../../src/railsim/audio/index.ts';

/**
 * テスト用のスペクトル測定。
 *
 * FFT を持ち込むほどの用は無く、知りたいのは「この周波数に峰が立っているか」
 * だけなので、ゲルツェル法で任意の周波数のパワーを直接測る。
 */

/** 信号 `x` の周波数 `frequency` におけるパワー（振幅の 2 乗に比例） */
export function goertzel(x: Float32Array, sampleRate: number, frequency: number): number {
  const n = x.length;
  const w = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    // 端の不連続による漏れを抑えるためハン窓を掛ける
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s = x[i]! * window + coefficient * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const real = s1 - s2 * Math.cos(w);
  const imag = s2 * Math.sin(w);
  return (real * real + imag * imag) / (n * n);
}

/** 信号全体の実効値 */
export function rms(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / x.length);
}

/**
 * `frequency` のパワーが、その左右 `offset` Hz の「谷」に対して何倍あるか。
 *
 * 絶対的なパワーは共振や 1/f の傾きで大きく変わるため、峰が立っているかどうかは
 * **近傍との比**で判定する。これなら共振の位置に左右されない。
 */
export function peakProminence(
  x: Float32Array,
  sampleRate: number,
  frequency: number,
  offset: number,
): number {
  const peak = goertzel(x, sampleRate, frequency);
  const low = goertzel(x, sampleRate, frequency - offset);
  const high = goertzel(x, sampleRate, frequency + offset);
  const floor = Math.max((low + high) / 2, 1e-30);
  return peak / floor;
}

/**
 * A 特性で重み付けした実効値。
 *
 * 「大きく聞こえるか」を測るには素の実効値では足りない。耳は 60Hz と 1kHz で
 * 30dB 以上も感度が違うので、低い唸りは実効値を稼いでもさほど大きく聞こえず、
 * 逆に高速域の高い成分は実効値が小さくてもよく聞こえる。音源どうしの
 * 「聞こえ方」を比べるときはこちらを使う。
 *
 * IEC 61672 の A 特性を極そのもので組む（20.6Hz の 2 重極・107.7Hz・737.9Hz・
 * 12194Hz の 2 重極）。1kHz で利得 1 になるよう、実際に 1kHz の正弦を通して
 * 正規化するので、係数の書き間違いがあれば正規化の段で露見する。
 */
export function aWeightedRms(x: Float32Array, sampleRate: number): number {
  const build = (): ((v: number) => number) => {
    const hp2 = new Biquad().highPass(sampleRate, 20.6, 0.5);
    const hp1a = new OnePoleHighPass(sampleRate, 107.7);
    const hp1b = new OnePoleHighPass(sampleRate, 737.9);
    const lp2 = new Biquad().lowPass(sampleRate, 12194, 0.5);
    return (v) => lp2.process(hp1b.process(hp1a.process(hp2.process(v))));
  };

  // 1kHz の正弦を通して利得を測り、それで割る
  const probe = build();
  let reference = 0;
  const cycles = Math.floor(sampleRate / 1000) * 20;
  for (let i = 0; i < cycles; i++) {
    const y = probe(Math.sin((2 * Math.PI * 1000 * i) / sampleRate));
    if (i > cycles / 2) reference = Math.max(reference, Math.abs(y));
  }

  const filter = build();
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const y = filter(x[i]!);
    if (i > sampleRate * 0.02) sum += y * y;
  }
  return Math.sqrt(sum / x.length) / reference;
}

/** 帯域 [lo, hi] のパワーを粗く積分する */
export function bandPower(
  x: Float32Array,
  sampleRate: number,
  lo: number,
  hi: number,
  steps = 64,
): number {
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    sum += goertzel(x, sampleRate, lo + ((hi - lo) * i) / steps);
  }
  return sum / (steps + 1);
}
