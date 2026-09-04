import { Biquad, DcBlocker, OnePoleHighPass, OnePoleLowPass, Smoothed } from './biquad.ts';
import {
  DcMotorTone,
  DC_MOTOR_RESONANCES,
  MASS_CONTROLLED_FREQUENCY,
  type DcMotorParams,
} from './dcMotorVoice.ts';

const TWO_PI = Math.PI * 2;

/** 電機子チョッパの主回路の音のパラメータ */
export interface ChopperVoiceParams {
  /** チョッパが動作しているか（惰行では false） */
  readonly gate: boolean;
  /** 定格に対する電機子電流（直流分） */
  readonly current: number;
  /** 通流率 0..1 */
  readonly duty: number;
  /** チョッパ周波数 [Hz] */
  readonly chopFrequency: number;
  /** 電機子スロットの通過周波数 [Hz]（主電動機の音程を決める） */
  readonly slotFrequency: number;
  /** ブラシが整流子片を渡る周波数 [Hz] */
  readonly commutatorFrequency: number;
  /** 通風ファンの翼通過周波数 [Hz] */
  readonly ventilationFrequency: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_CHOPPER: ChopperVoiceParams = {
  gate: false,
  current: 0,
  duty: 0,
  chopFrequency: 0,
  slotFrequency: 0,
  commutatorFrequency: 0,
  ventilationFrequency: 0,
  level: 0,
};

/** 平滑リアクトルの一致周波数 [Hz]（`dcMotorVoice.ts` と同じ考え方） */
const COINCIDENCE_FREQUENCY = 2200;

/** 放射効率と質量制御のロールオフを入れたことによる全体の落ちを補う */
const RADIATION_GAIN = 2.4;

/** リップル電流の漏れ積分のカットオフ [Hz]（直流分だけを落とす） */
const RIPPLE_LEAK_FREQUENCY = 40;

/**
 * リップル電流を可聴域の振幅へ写す倍率。
 *
 * 値は実測で決めてある。チョッパ音は**この車の音のいちばんの特徴**なので、主電動機の
 * 音に埋もれてはいけない。電動機の音程を担うスロット通過の線と基音どうしで比べて、
 * 起動直後は 2.8 倍、40km/h で 1.5 倍、60km/h では逆に 0.4 倍になる。これより下げると、
 * 通流率を動かしても音がほとんど変わらなくなる。
 *
 * 速度とともに比が下がるのは、チョッパ周波数が 400Hz に固定されているのに対し、
 * スロット通過は回転とともに上がって構造共振と放射効率のよいところへ入っていく
 * ためである。実車でも高速では電動機の唸りがチョッパ音を覆う。
 */
const RIPPLE_GAIN = 620;

/**
 * 電機子チョッパの音。
 *
 * `inverterVoice.ts` と同じく**波形を実際に作る**。発振器で「チョッパ音」を鳴らす
 * のではなく、通流率 δ の方形波を刻み、その電圧をインダクタンスで積分して
 * リップル電流を作り、力を電流の 2 乗として取り出す。すると実車の 3 つの特徴が
 * 個別に作り込まなくても出てくる:
 *
 *  1. **音程が速度に依らない。** チョッパ周波数は固定なので、加速しても音程が
 *     まったく上がらない。VVVF の「上がっていく音」とも、抵抗制御の「回転数だけで
 *     決まる音」とも違う、チョッパ車特有の平板な唸りになる。
 *  2. **倍音の構成が通流率で変わる。** 方形波の n 次成分は `sin(nπδ)/n` なので、
 *     δ が動くと音色だけが変わる。加速につれて音が「開いていく」のはこれである。
 *  3. **全通流で消える。** δ → 1 では電圧が切れ目なく掛かるのでリップルが
 *     生まれない。チョッパ音が消えて主電動機の音 — スロット通過の唸りと通風音
 *     （`dcMotorVoice.ts`）— だけが残る。実車で全界磁最終段に入った瞬間に
 *     静かになるのと同じである。このとき音程の担い手が入れ替わるのが面白いところで、
 *     それまで鳴っていた速度に依らない音が引き、代わりに回転数に比例して上がって
 *     いく音が出てくる。
 *
 * 惰行では主電動機の音（`DcMotorTone`）— といっても電流が無いので通風音 — だけが残る。
 */
export class ChopperVoice {
  private readonly motor: DcMotorTone;
  private readonly resonators: Biquad[] = [];
  private readonly weights: number[] = [];
  private readonly radiation: OnePoleHighPass;
  /** 質量制御域のロールオフ（`dcMotorVoice.ts` と同じ理由・同じ傾き） */
  private readonly massRolloff: OnePoleLowPass;
  private readonly dcBlock: DcBlocker;
  private readonly levelSmooth: Smoothed;
  private readonly dutySmooth: Smoothed;
  private readonly currentSmooth: Smoothed;
  private readonly rippleLeak: number;

  private theta = 0;
  private ripple = 0;
  private params: ChopperVoiceParams = SILENT_CHOPPER;

  constructor(readonly sampleRate: number) {
    this.motor = new DcMotorTone(sampleRate);
    for (const [frequency, q, weight] of DC_MOTOR_RESONANCES) {
      this.resonators.push(new Biquad().bandPass(sampleRate, frequency, q));
      this.weights.push(weight);
    }
    this.radiation = new OnePoleHighPass(sampleRate, COINCIDENCE_FREQUENCY);
    this.massRolloff = new OnePoleLowPass(sampleRate, MASS_CONTROLLED_FREQUENCY);
    this.dcBlock = new DcBlocker(sampleRate, 25);
    this.levelSmooth = new Smoothed(sampleRate, 0.02);
    // 通流率は電流制御ループが動かす量なので、階段を均す程度の短い平滑でよい。
    this.dutySmooth = new Smoothed(sampleRate, 0.02);
    this.currentSmooth = new Smoothed(sampleRate, 0.015);
    this.rippleLeak = Math.exp(-TWO_PI * RIPPLE_LEAK_FREQUENCY * (1 / sampleRate));
  }

  setParams(params: ChopperVoiceParams): void {
    this.params = params;
    // チョッパが切れていても電動機は回り続ける。消えるのは電磁音だけで通風音は残る。
    const motor: DcMotorParams = {
      slotFrequency: params.slotFrequency,
      commutatorFrequency: params.commutatorFrequency,
      ventilationFrequency: params.ventilationFrequency,
      current: params.gate ? params.current : 0,
      level: params.level,
    };
    this.motor.setParams(motor);
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    this.motor.render(out);

    const p = this.params;
    const dt = 1 / this.sampleRate;

    for (let i = 0; i < out.length; i++) {
      const level = this.levelSmooth.process(p.level);
      const duty = this.dutySmooth.process(p.gate ? p.duty : 0);
      const current = this.currentSmooth.process(p.gate ? p.current : 0);
      this.theta = wrap(this.theta + TWO_PI * p.chopFrequency * dt);

      if (level <= 1e-5 || p.chopFrequency <= 0) {
        this.ripple *= this.rippleLeak;
        continue;
      }

      // 通流率 δ の方形波。オンのあいだ 1、オフのあいだ 0。
      const on = this.theta < TWO_PI * duty ? 1 : 0;
      // インダクタンスに掛かるのは平均を引いた分。これを積分すると三角波の
      // リップルになる。振幅は δ(1−δ) に比例するので、δ→1 で自然に消える。
      this.ripple = this.ripple * this.rippleLeak + (on - duty) * dt * RIPPLE_GAIN;

      // 力 ∝ (I_直流 + i_リップル)²。交差項 2·I·i がリップルと同じ周波数で、
      // i² がその倍の周波数で出る — 実機のチョッパ音の構成そのもの。
      const total = current + this.ripple;
      const force = this.dcBlock.process(total * total);

      let radiated = force * 0.25;
      for (let r = 0; r < this.resonators.length; r++) {
        radiated += this.resonators[r]!.process(force) * this.weights[r]!;
      }
      const y = this.massRolloff.process(this.radiation.process(radiated));
      out[i] = out[i]! + y * RADIATION_GAIN * level;
    }
  }

  reset(): void {
    this.motor.reset();
    this.theta = 0;
    this.ripple = 0;
    this.dcBlock.reset();
    this.radiation.reset();
    this.massRolloff.reset();
    for (const f of this.resonators) f.reset();
    this.levelSmooth.set(0);
    this.dutySmooth.set(0);
    this.currentSmooth.set(0);
    this.params = SILENT_CHOPPER;
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
