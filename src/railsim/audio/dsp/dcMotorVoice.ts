import { Biquad, DcBlocker, OnePoleHighPass, OnePoleLowPass, Smoothed } from './biquad.ts';
import { Noise, PinkFilter } from './noise.ts';

const TWO_PI = Math.PI * 2;

/**
 * 直流直巻電動機の固定子・フレームの構造共振 [周波数 Hz, Q, 重み]。
 *
 * 誘導電動機（`inverterVoice.ts` の既定値）より低いところに寄っている。直流機は
 * 界磁鉄心と継鉄で外殻が組まれていて重く、しかも冷却のために大きな送風路が
 * 空いているので、箱として低く鳴る。VVVF 車と抵抗制御車の音色の違いは、
 * 変調のあるなしだけでなくこの共振の位置の違いでもある。
 */
export const DC_MOTOR_RESONANCES: ReadonlyArray<readonly [number, number, number]> = [
  [420, 4, 1.0],
  [980, 5, 0.7],
  [1850, 6, 0.5],
  [3100, 7, 0.32],
];

/**
 * 放射効率の一致（コインシデンス）周波数 [Hz]。
 * `inverterVoice.ts` と同じ理由でここから上が平坦、下は f² で落ちる。
 */
const COINCIDENCE_FREQUENCY = 2200;

/**
 * 電磁音（構造伝搬）の全体倍率。
 *
 * 放射効率と質量制御のロールオフを入れたことによる全体の落ちを補う。値は実測して
 * 決めてある。ミキサのつまみを 1.0 にしたとき、A 特性実効値がインバータ音
 * （`inverterVoice.ts`）とおおむね揃うようにしてある。揃えていないと車両を切り替える
 * たびに音量を取り直すことになる。
 */
const RADIATION_GAIN = 1.2;

/** 直流電動機の音を決める量 */
export interface DcMotorParams {
  /**
   * 電機子スロットの通過周波数 [Hz] = 回転数/60 × スロット数。
   * **電磁音の音程はこれで決まる**。
   */
  readonly slotFrequency: number;
  /** ブラシが整流子片を渡る周波数 [Hz] = 回転数/60 × 整流子片数 */
  readonly commutatorFrequency: number;
  /** 通風ファンの翼通過周波数 [Hz] = 回転数/60 × 翼数 */
  readonly ventilationFrequency: number;
  /** 定格に対する電機子電流 0..（1 を超えてよい）。惰行では 0。 */
  readonly current: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_DC_MOTOR: DcMotorParams = {
  slotFrequency: 0,
  commutatorFrequency: 0,
  ventilationFrequency: 0,
  current: 0,
  level: 0,
};

/**
 * スロット通過の調波の重み。
 *
 * 空隙のパーミアンスはスロットが 1 つ通るごとに 1 周期ぶん変わるが、その形は
 * 矩形ではなく丸まっている（スロット開口の幅と空隙長で鈍る）ので、次数が上がるほど
 * 成分が落ちる。およそ `1/n²`。
 */
const SLOT_HARMONIC_WEIGHTS: readonly number[] = [1.0, 0.25, 0.11];

/**
 * 整流子の成分に掛ける重み。
 *
 * ブラシが整流子片を渡るたびに転流して電磁力が跳ねるのは事実だが、**これで
 * 電動機の音程が決まるわけではない**。整流子片数はスロット数の 2〜3 倍あるので、
 * この周波数はスロット通過よりずっと高いところに出る。しかも整流子はフレームの
 * 奥にあってブラシ保持器と外被で二重に囲まれており、放射に寄与する割合が小さい。
 *
 * ここを主役に据えると（かつてそうしていた）、40km/h で 2.1kHz の澄んだ音程が
 * 立ってしまい、実車よりはっきり高く聞こえる。実車で聞こえるのは音程ではなく
 * 「シャー」というかすれのほうなので、基本波だけを弱く残し、あとはブラシの
 * 接触抵抗のゆらぎ（`BRUSH_NOISE_DEPTH`）に任せる。
 *
 * 値は加振の重みなので、そのまま聞こえ方の比にはならない。整流子の周波数は構造の
 * 整形（放射効率 × 質量制御）と 1850Hz の共振の両方に持ち上げられる位置にあるため、
 * 加振で 24dB 落としてもスペクトルの線としては −9dB あたりにしかならない。
 */
const COMMUTATOR_WEIGHT = 0.06;

/**
 * 構造が質量制御に入る周波数 [Hz]。
 *
 * 共振より十分上では、固定子とフレームは剛性ではなく**質量**で応答が決まるので、
 * 加振力に対する応答が落ちていく。
 *
 * インバータ音（`inverterVoice.ts`）ではこの役目を磁束の積分（利得 ∝ 1/f）が
 * 果たしていた。スロット・整流子の加振には積分が無いので、代わりにこれを置かないと
 * 高域が上がりっぱなしになる。
 *
 * 傾きは 1 極（−6dB/oct）にしてある。一致周波数より上では放射効率が平坦なので、
 * 正味 `−20·log₁₀f` — インバータ音とまったく同じ傾きになる。
 */
export const MASS_CONTROLLED_FREQUENCY = 1600;

/** ブラシの接触抵抗のゆらぎ（広帯域のかすれ）の深さ */
const BRUSH_NOISE_DEPTH = 0.35;

/**
 * 通風音の基準となる翼通過周波数 [Hz]。
 * 翼数 34・車速 40km/h（電動機 1382rpm）にあたり、在来線の常用速度域の下のほう。
 */
const VENTILATION_REFERENCE = 780;

/**
 * 通風音の速度依存の指数（振幅 ∝ 翼通過周波数 ^ この値）。
 *
 * 自由音場のファン則なら音響パワー ∝ 回転数⁵、すなわち振幅 ∝ 回転数^2.5 になるが、
 * 電動機の通風音は自由音場に出るのではなく、**吸気口と排気口という決まった開口を
 * 通ってしか出られない**。流量が増えても放射に使える開口は増えないので、車内で
 * 測ると増え方はもっと緩い。転動音（`runningGear.ts`）に使っているのと同じ指数を
 * 採る。ここを 2.5 にすると、起動時に聞こえず高速で他をすべて覆う音になる。
 */
const VENTILATION_EXPONENT = 1.5;

/**
 * 基準回転での通風音の大きさ。
 *
 * 力行中の電磁音に対して −12dB あたりに置いてある。これより上げると通風音の広帯域が
 * スロットの音程を覆ってしまい、下げると惰行で電動機が消えてしまう。
 */
const VENTILATION_GAIN = 0.25;

/** 通風音の広帯域成分の帯域中心 [Hz]（翼通過周波数に対する比と下駄） */
const VENTILATION_BAND_BASE = 190;
const VENTILATION_BAND_TRACKING = 0.42;
/** 広帯域成分の Q。1 未満にして「峰」ではなく「帯」にする */
const VENTILATION_BAND_Q = 0.5;

/**
 * 通風音の上の切れ [Hz]（翼通過周波数に対する比と下駄、2 極）。
 *
 * 送風騒音のスペクトルは翼通過のあたりで峰になり、その上は落ちていく。開口から
 * 出るまでに通風路と外被でも切られるので、実車では耳障りな高域はほとんど残らない。
 * これを置かないと、広帯域が 10kHz 台まで伸びて砂を撒いたような音になる。
 */
const VENTILATION_LOWPASS_BASE = 400;
const VENTILATION_LOWPASS_TRACKING = 1.6;

/** 翼通過の峰の Q と、広帯域に対する深さ */
const BLADE_Q = 1.2;
const BLADE_DEPTH = 0.35;

/** これより低い翼通過周波数では峰を立てない（ほぼ停止） */
const BLADE_MIN_FREQUENCY = 40;

/**
 * 直流電動機そのものの音（抵抗制御・チョッパに共通）。
 *
 * VVVF の音といちばん違うのは、**キャリアが無い**ことである。音程を決める量が
 * 回転数しかないので、力行しているあいだ音程は速度に比例して素直に上がり続け、
 * 途中で飛んだり落ちたりしない。段が進んでも、界磁を弱めても、音程は変わらない
 * （変わるのは音量だけ）。抵抗制御車の走行音が「モーターがただ唸って上がっていく」
 * ように聞こえるのはこのためである。
 *
 * 回転数が同じでも**次数の違う加振が 3 つ**あり、これを 1 つにまとめてはいけない。
 * 40km/h（1382rpm）でそれぞれ:
 *
 * | 経路               | 次数 | 周波数 | 伝わり方   | 駆動する量 |
 * | ------------------ | ---- | ------ | ---------- | ---------- |
 * | 通風（ファン）     | 34   | 783Hz  | 空気伝搬   | 回転数だけ |
 * | 電機子スロット     | 31   | 714Hz  | 構造伝搬   | 電流²      |
 * | 整流子・ブラシ     | 93   | 2142Hz | 構造伝搬   | 電流²      |
 *
 * 音程を作っているのは上の 2 つで、整流子はその上に乗るかすれにすぎない。
 * 歯車のかみ合い（15 次・345Hz、`runningGear.ts` の `GearVoice`）と合わせると、
 * 実車どおり 1 オクターブ幅に主要な成分が集まる。
 *
 * 力は磁束 × 電流で、直巻機の磁束は電流が作るので、電磁音の音量はおおむね電流の
 * 2 乗に比例する。限流値制御をしているあいだ電流はほぼ一定なので、**起動から
 * 加速中は電磁音の音量が変わらず音程だけが上がる**。いっぽう通風音は電流に
 * 関係しないので、**ノッチを切っても消えない** — 惰行で主回路の音だけがすっと
 * 引いて、電動機が回っている音が残るのは実車どおりである。
 */
export class DcMotorTone {
  private readonly resonators: Biquad[] = [];
  private readonly weights: number[] = [];
  private readonly radiation: OnePoleHighPass;
  private readonly dcBlock: DcBlocker;
  private readonly noise = new Noise(0x27b1);
  private readonly noiseBand: Biquad;
  /** 質量制御域のロールオフ（1 極・−6dB/oct） */
  private readonly massRolloff: OnePoleLowPass;
  private readonly levelSmooth: Smoothed;
  private readonly currentSmooth: Smoothed;
  private readonly slotSmooth: Smoothed;
  private readonly commutatorSmooth: Smoothed;

  /** 通風音（空気伝搬なので構造の経路を通さない） */
  private readonly fanNoise = new Noise(0x5c47);
  private readonly pink = new PinkFilter();
  private readonly fanBand = new Biquad();
  private readonly fanRolloff = new Biquad();
  private readonly bladeBand = new Biquad();
  private readonly fanSmooth: Smoothed;
  private readonly bladeSmooth: Smoothed;
  private fanTarget = 0;
  private bladeTarget = 0;

  private thetaSlot = 0;
  private thetaCommutator = 0;
  private params: DcMotorParams = SILENT_DC_MOTOR;

  constructor(readonly sampleRate: number) {
    for (const [frequency, q, weight] of DC_MOTOR_RESONANCES) {
      this.resonators.push(new Biquad().bandPass(sampleRate, frequency, q));
      this.weights.push(weight);
    }
    this.radiation = new OnePoleHighPass(sampleRate, COINCIDENCE_FREQUENCY);
    this.dcBlock = new DcBlocker(sampleRate, 25);
    this.noiseBand = new Biquad().bandPass(sampleRate, 1400, 0.5);
    this.massRolloff = new OnePoleLowPass(sampleRate, MASS_CONTROLLED_FREQUENCY);
    this.levelSmooth = new Smoothed(sampleRate, 0.02);
    // 電流の鈍り。実機の電流も電機子回路のインダクタンスで鈍るが、ここでは
    // 制御周期（10ms）ごとの階段を均すためだけのごく短い平滑。
    this.currentSmooth = new Smoothed(sampleRate, 0.015);
    this.slotSmooth = new Smoothed(sampleRate, 0.01);
    this.commutatorSmooth = new Smoothed(sampleRate, 0.01);
    this.fanSmooth = new Smoothed(sampleRate, 0.05);
    this.bladeSmooth = new Smoothed(sampleRate, 0.05);
    this.setParams(SILENT_DC_MOTOR);
  }

  setParams(params: DcMotorParams): void {
    this.params = params;

    // 通風音の帯は回転とともに上へずれる。フィルタ係数はフレームごとに置き直せば
    // 足りる（転動音（`runningGear.ts`）と同じ扱い）。
    const blade = Math.max(0, params.ventilationFrequency);
    this.fanBand.bandPass(
      this.sampleRate,
      VENTILATION_BAND_BASE + VENTILATION_BAND_TRACKING * blade,
      VENTILATION_BAND_Q,
    );
    this.fanRolloff.lowPass(
      this.sampleRate,
      VENTILATION_LOWPASS_BASE + VENTILATION_LOWPASS_TRACKING * blade,
    );
    const speedRatio = Math.pow(blade / VENTILATION_REFERENCE, VENTILATION_EXPONENT);
    this.fanTarget = params.level * VENTILATION_GAIN * speedRatio;
    if (blade > BLADE_MIN_FREQUENCY) {
      this.bladeBand.bandPass(this.sampleRate, blade, BLADE_Q);
      this.bladeTarget = this.fanTarget * BLADE_DEPTH;
    } else {
      this.bladeTarget = 0;
    }
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    const p = this.params;
    const dt = 1 / this.sampleRate;

    for (let i = 0; i < out.length; i++) {
      const level = this.levelSmooth.process(p.level);
      const current = this.currentSmooth.process(p.current);
      const slot = this.slotSmooth.process(p.slotFrequency);
      const commutator = this.commutatorSmooth.process(p.commutatorFrequency);

      // 位相とフィルタは鳴っていないあいだも回し続ける（再投入で不連続にならないように）
      this.thetaSlot = wrap(this.thetaSlot + TWO_PI * slot * dt);
      this.thetaCommutator = wrap(this.thetaCommutator + TWO_PI * commutator * dt);

      const fan = this.fanSmooth.process(this.fanTarget);
      const blade = this.bladeSmooth.process(this.bladeTarget);
      let y = 0;

      // --- 通風音（空気伝搬・電流に依存しない）---
      if (fan > 1e-6) {
        const pink = this.fanRolloff.process(this.pink.process(this.fanNoise.next()));
        y += this.fanBand.process(pink) * fan + this.bladeBand.process(pink) * blade;
      }

      // --- 電磁音（構造伝搬・電流²）---
      if (level > 1e-5 && current > 1e-4) {
        let excitation = 0;
        for (let h = 0; h < SLOT_HARMONIC_WEIGHTS.length; h++) {
          excitation += SLOT_HARMONIC_WEIGHTS[h]! * Math.sin((h + 1) * this.thetaSlot);
        }
        // 整流子は音程ではなくかすれとして乗せる。ブラシの接触抵抗のゆらぎは
        // 整流子の位相に同期して強弱がつく。
        excitation +=
          COMMUTATOR_WEIGHT * Math.sin(this.thetaCommutator) +
          this.noiseBand.process(this.noise.next()) *
            BRUSH_NOISE_DEPTH *
            (1 + 0.5 * Math.sin(this.thetaCommutator));

        // 電磁力 ∝ 磁束 × 電流。直巻機は磁束を電流が作るので、実質 電流² になる。
        const force = this.dcBlock.process(excitation * current * current);

        let radiated = force * 0.25;
        for (let r = 0; r < this.resonators.length; r++) {
          radiated += this.resonators[r]!.process(force) * this.weights[r]!;
        }
        // 放射効率（一致周波数より下は f² で落ちる）→ 質量制御のロールオフ の順に通す。
        // 前者が高域を持ち上げ、後者が落とす。正味の傾きがこの音の性格を決める。
        y += this.massRolloff.process(this.radiation.process(radiated)) * RADIATION_GAIN * level;
      }

      out[i] = out[i]! + y;
    }
  }

  reset(): void {
    this.thetaSlot = 0;
    this.thetaCommutator = 0;
    this.dcBlock.reset();
    this.radiation.reset();
    this.noiseBand.reset();
    for (const f of this.resonators) f.reset();
    this.massRolloff.reset();
    this.pink.reset();
    this.fanBand.reset();
    this.fanRolloff.reset();
    this.bladeBand.reset();
    this.levelSmooth.set(0);
    this.currentSmooth.set(0);
    this.slotSmooth.set(0);
    this.commutatorSmooth.set(0);
    this.fanSmooth.set(0);
    this.bladeSmooth.set(0);
    this.setParams(SILENT_DC_MOTOR);
  }
}

/** 位相を [0, 2π) に畳む */
export function wrapPhase(theta: number): number {
  return wrap(theta);
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
