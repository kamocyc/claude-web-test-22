import { Biquad, DcBlocker, OnePoleHighPass, Smoothed } from './biquad.ts';

const TWO_PI = Math.PI * 2;

/** インバータの変調から音を作るのに必要な量（`InverterState` から素直に写せる） */
export interface InverterVoiceParams {
  /**
   * ゲートが開いているか（主回路がスイッチングしているか）。
   *
   * `false` のあいだは**素子が全部オフ**なので、相電圧は 0 になる。音量を 0 に
   * するのではなく電圧を 0 にするのが要点で、こうすると磁束は還流ダイオードを
   * 通って電動機自身の時定数で減衰する。ノッチを切ったときの音の消え方は
   * この減衰そのものであり、包絡線を別に用意する必要はない。
   */
  readonly gate: boolean;
  /**
   * インバータ出力（固定子）周波数 [Hz]。
   *
   * ゲートが閉じているあいだも**回転子周波数を渡し続けること**。0 へ落とすと、
   * 磁束が積分（利得 ∝ 1/f）であるために消えぎわで利得が跳ね上がり、
   * 短い掃引音（「ピッ」）が出る。実機の再投入も、空転して回っている回転子の
   * 速度に合った周波数から入る（合わせないと大電流が流れる）。
   */
  readonly fundamental: number;
  /** キャリア（スイッチング）周波数 [Hz]。0 = 搬送波なし */
  readonly carrier: number;
  /** 変調率 0..1 */
  readonly modulation: number;
  /** 出力 1 周期あたりのパルス数（0 = 非同期、1 = 一パルス） */
  readonly pulses: number;
  /** 回転子スロット高調波の周波数 [Hz] */
  readonly slotFrequency: number;
  /** 音量 0..1（主回路が切れていれば 0） */
  readonly level: number;
}

/** 主回路が動いていないときのインバータ音（VVVF 以外の車両で使う） */
export const SILENT_INVERTER: InverterVoiceParams = {
  gate: false,
  fundamental: 0,
  carrier: 0,
  modulation: 0,
  pulses: 0,
  slotFrequency: 0,
  level: 0,
};

export interface InverterVoiceOptions {
  /**
   * オーバーサンプリング倍率。比較器の出力は理想的な矩形波なので、
   * 出力サンプルレートのまま作ると折り返し（エイリアシング）が可聴帯域に落ちる。
   * さらに磁束を 2 乗する段で帯域が倍に広がるため、2 乗まで済ませてから
   * 低域通過させて間引く。
   */
  readonly oversample?: number;
  /**
   * 固定子鉄心・フレームの構造共振 [周波数 Hz, Q, 重み]。
   *
   * 実際の電動機は電磁力そのものを放射しているのではなく、その力で構造が
   * 変形して音になる。どの周波数がよく響くかは固定子の形状で決まり、
   * これが「その形式らしい音色」の正体である。磁束の積分で高域が 1/f で
   * 落ちるぶんをここが持ち上げるのも、実機とまったく同じ関係になっている。
   *
   * 1 次元のモデルでは表せない空間次数（低次の変形モードだけがよく放射する）の
   * 効果も、実質的にここが代役をしている。
   */
  readonly resonances?: ReadonlyArray<readonly [number, number, number]>;
  /** 回転子スロットによる磁気抵抗（パーミアンス）変動の深さ */
  readonly slotDepth?: number;
}

/*
 * 先頭の 400Hz は固定子の**楕円モード（円周方向の次数 m = 2）**である。
 *
 * 固定子鉄心を輪と見ると、円周方向に m 個の腹を持つ変形が並ぶ。半径力波が次数 m の
 * 変形を励振したときの振れ幅は `1/(m² − 1)²` に比例するので、m = 2 が他を圧して大きく
 * （m = 3 の 16 倍、m = 4 の 56 倍）、しかも輪の曲げ剛性が最も低いので**いちばん低い
 * 周波数**に来る。電気機械の騒音でまず問題になるのは常にこのモードである。
 *
 * それが表に無く、いちばん下が 620Hz から始まっていた。600Hz 以下には共振の裾しか
 * 無いところへ放射効率の落ち（下の一致周波数の項）が重なるので、この帯に音程を持つ
 * 車両 — 音階インバータの階段は 196〜587Hz にある — だけが不当に静かになっていた。
 */
const DEFAULT_RESONANCES: ReadonlyArray<readonly [number, number, number]> = [
  [400, 5, 1.2],
  [620, 7, 1.0],
  [1180, 9, 0.7],
  [2350, 11, 0.45],
  [3400, 12, 0.3],
  [4900, 14, 0.2],
];

/**
 * 放射効率の一致（コインシデンス）周波数 [Hz]。
 *
 * 構造の振動がそのまま音になるわけではない。曲げ波の速度が音速に追いつく
 * 周波数（一致周波数）より下では、板が動いても空気が横へ逃げてしまうため
 * 放射効率が **f² に比例して**低く、それより上では平坦になる。厚さ数 mm の
 * 鋼板ならこのあたりに来る。
 *
 * これを入れていないと、高速域が実際より遥かに静かになる。弱め界磁で磁束が
 * 1/f₁ に落ちるので力は 1/f₁²、つまり −40·log₁₀f で落ちる一方、成分は高域へ
 * 動いていく。放射効率の +6dB/oct はその半分を打ち消す（正味 −20·log₁₀f）。
 * 実車で高速域でも電動機の音が聞こえ続けるのはこの釣り合いによる。
 */
const COINCIDENCE_FREQUENCY = 2500;

/** 放射効率を入れたことによる全体の落ちを補う（低速の音量を元の水準に戻す） */
const RADIATION_GAIN = 3.2;

/**
 * 磁束の正規化基準周波数 [Hz]。
 * V/f 一定制御では磁束が一定に保たれるので、基底周波数付近で磁束が 1 前後に
 * なるよう正規化しておくと、弱め界磁に入ってから磁束が落ちる（＝高速域で
 * 磁気音が弱まる）という実機の関係がそのまま出る。
 */
const FLUX_REFERENCE = 50;

/**
 * VVVF インバータと主電動機の音を、**実際の PWM 波形から**合成する。
 *
 * 発振器を並べてキャリアとサイドバンドを 1 本ずつ作るのではなく、実機と同じ
 * 手順を音声サンプルレートで踏む。
 *
 * ```
 * 1. 三角波キャリア c(θc) と 3 相の正弦変調波 m_x(θ₁) を比較して相電圧 ±1 を作る
 * 2. 線間中性点電圧 v_an = v_a − (v_a+v_b+v_c)/3
 * 3. 磁束 λ = ∫v_an dt          （固定子電圧はほぼ磁束の微分）
 * 4. 電磁半径力 ∝ λ²            （マクスウェル応力は磁束密度の 2 乗）
 * 5. 構造共振を通して放射音にする
 * ```
 *
 * 4 の 2 乗が要である。`λ = λ₁ + λ_h` を 2 乗すると交差項 `2λ₁λ_h` が現れるので、
 * **キャリア ± 出力周波数のサイドバンドと 2f₁ の磁気音が、個別に作り込まなくても
 * 自動的に出てくる**。同期モードへの移行も、過変調も、一パルスの矩形波音も、
 * 比較の結果として現れるだけで特別扱いは要らない。
 *
 * 同期モードではキャリアの位相を出力の位相へロックする（`θc = N·θ₁`）。これが
 * 同期の定義であり、非同期のときのようなうなりが出ないのはこのためである。
 * パルス数が切り替わる瞬間は位相のオフセットを付け替えて連続にする（実機の
 * モード切替も電圧に段差を作らないように再同期する）。
 *
 * ノッチの入切も、音量ではなく**ゲート（相電圧）**で表す。切れば電圧が 0 に
 * なって磁束が電動機自身の時定数で減衰し、入れれば磁束が立ち上がる。音の
 * 消え方も始まり方も、そうして初めて過渡そのものになる。
 */
export class InverterVoice {
  private readonly oversample: number;
  private readonly innerRate: number;
  private readonly innerDt: number;
  private readonly resonators: Biquad[] = [];
  private readonly resonanceWeights: number[] = [];
  private readonly decimation: Biquad[] = [];
  private readonly dcBlock: DcBlocker;
  private readonly radiation: OnePoleHighPass;
  private readonly levelSmooth: Smoothed;
  private readonly modulationSmooth: Smoothed;
  private readonly frequencySmooth: Smoothed;
  private readonly slotDepth: number;

  private theta1 = 0;
  private thetaCarrier = 0;
  private thetaSlot = 0;
  private syncOffset = 0;
  private lastPulses = 0;
  private flux = 0;
  private readonly fluxLeak: number;

  private params: InverterVoiceParams = {
    gate: false,
    fundamental: 0,
    carrier: 0,
    modulation: 0,
    pulses: 0,
    slotFrequency: 0,
    level: 0,
  };

  constructor(
    readonly sampleRate: number,
    options: InverterVoiceOptions = {},
  ) {
    this.oversample = Math.max(1, Math.floor(options.oversample ?? 4));
    this.innerRate = sampleRate * this.oversample;
    this.innerDt = 1 / this.innerRate;
    this.slotDepth = options.slotDepth ?? 0.18;

    for (const [frequency, q, weight] of options.resonances ?? DEFAULT_RESONANCES) {
      this.resonators.push(new Biquad().bandPass(this.innerRate, frequency, q));
      this.resonanceWeights.push(weight);
    }
    // 間引きのための低域通過（2 乗で広がった帯域を出力のナイキスト以下へ落とす）
    if (this.oversample > 1) {
      for (let i = 0; i < 2; i++) {
        this.decimation.push(new Biquad().lowPass(this.innerRate, sampleRate * 0.42));
      }
    }
    this.dcBlock = new DcBlocker(this.innerRate, 25);
    this.radiation = new OnePoleHighPass(this.innerRate, COINCIDENCE_FREQUENCY);
    this.levelSmooth = new Smoothed(sampleRate, 0.02);
    /*
     * 変調率の鈍り ＝ 磁束を確立するのに掛ける時間。
     *
     * 磁束の無い電動機へ電圧をいきなり全開で掛けると、掛け始めた位相に応じて
     * 磁束に直流分が乗る（変圧器の励磁突入と同じ現象で、最悪 2 倍まで振れる）。
     * 力は磁束の 2 乗なので、これがノッチ投入の瞬間の突出として聞こえる。
     * 実機のインバータも突入を避けるために電圧を絞って入るので、その立ち上がりを
     * ここで表す。60ms は出力周波数の 1 周期より十分に長い。
     */
    this.modulationSmooth = new Smoothed(sampleRate, 0.06);
    this.frequencySmooth = new Smoothed(sampleRate, 0.005);
    // 磁束の漏れ積分。8Hz 以上ではほぼ真の積分として働き、直流の暴走だけを防ぐ。
    this.fluxLeak = Math.exp(-TWO_PI * 8 * this.innerDt);
  }

  setParams(params: InverterVoiceParams): void {
    this.params = params;
  }

  /** 出力バッファへ加算せず上書きする */
  render(out: Float32Array): void {
    const p = this.params;
    const os = this.oversample;

    for (let i = 0; i < out.length; i++) {
      const level = this.levelSmooth.process(p.level);
      const modulation = this.modulationSmooth.process(p.modulation);
      const f1 = this.frequencySmooth.process(p.fundamental);
      let sample = 0;

      for (let k = 0; k < os; k++) {
        sample = this.renderInner(f1, modulation, p);
      }
      out[i] = sample * level;
    }
  }

  /** オーバーサンプリングされた内部レートでの 1 サンプル */
  private renderInner(f1: number, modulation: number, p: InverterVoiceParams): number {
    // --- 位相を進める ---
    this.theta1 = wrap(this.theta1 + TWO_PI * f1 * this.innerDt);
    this.thetaSlot = wrap(this.thetaSlot + TWO_PI * p.slotFrequency * this.innerDt);

    const pulses = p.pulses;
    if (pulses !== this.lastPulses) {
      // モードが変わる瞬間、キャリアの位相が飛ばないようオフセットを付け替える
      if (pulses >= 2) this.syncOffset = this.thetaCarrier - pulses * this.theta1;
      this.lastPulses = pulses;
    }
    if (pulses >= 2) {
      // 同期モード: キャリアは出力の整数倍に位相までロックされる
      this.thetaCarrier = wrap(pulses * this.theta1 + this.syncOffset);
    } else {
      this.thetaCarrier = wrap(this.thetaCarrier + TWO_PI * p.carrier * this.innerDt);
    }

    // --- 3 相の変調波と比較 ---
    const ma = modulation * Math.sin(this.theta1);
    const mb = modulation * Math.sin(this.theta1 - TWO_PI / 3);
    const mc = modulation * Math.sin(this.theta1 + TWO_PI / 3);

    let va: number;
    let vb: number;
    let vc: number;
    if (!p.gate) {
      // ゲート遮断: 素子が全部オフなので電圧が掛からない。以降、磁束は漏れ
      // 積分の時定数（≒20ms）で減衰し、力はその 2 乗なので倍の速さで消える。
      va = 0;
      vb = 0;
      vc = 0;
    } else if (pulses === 1 || p.carrier <= 0) {
      // 一パルス: 搬送波が無く、変調波の符号がそのまま相電圧になる（矩形波）。
      //
      // 振幅に変調率を掛けてあるのは、磁束を確立している最中を表すため。
      // 一パルスは定義上、変調率が飽和した状態（＝1）なので定常では何も変わらない。
      // 実機も遮断状態からいきなり一パルスへ入ることはなく、PWM で電圧を入れて
      // 磁束を立ててから移る。それをこの 1 つの係数で代表させている。
      va = (ma >= 0 ? 1 : -1) * modulation;
      vb = (mb >= 0 ? 1 : -1) * modulation;
      vc = (mc >= 0 ? 1 : -1) * modulation;
    } else {
      const carrier = triangle(this.thetaCarrier);
      va = ma > carrier ? 1 : -1;
      vb = mb > carrier ? 1 : -1;
      vc = mc > carrier ? 1 : -1;
    }
    // 中性点電位を引いて相電圧にする（3 相 3 線なので零相分は流れない）
    const van = va - (va + vb + vc) / 3;

    // --- 磁束と電磁力 ---
    this.flux = this.flux * this.fluxLeak + van * this.innerDt;
    // 回転子スロットによるパーミアンス変動。積の形にすることで
    // スロット周波数 ± 2f₁ のサイドバンドが自動的に生まれる。
    const flux =
      this.flux * TWO_PI * FLUX_REFERENCE * (1 + this.slotDepth * Math.sin(this.thetaSlot));
    // マクスウェル応力 ∝ 磁束密度の 2 乗
    const force = this.dcBlock.process(flux * flux);

    // --- 構造共振を通す ---
    let radiated = force * 0.3;
    for (let r = 0; r < this.resonators.length; r++) {
      radiated += this.resonators[r]!.process(force) * this.resonanceWeights[r]!;
    }
    // 構造の振動 → 空気への放射。一致周波数より下は放射効率が f² で落ちる。
    let y = this.radiation.process(radiated) * RADIATION_GAIN;
    for (const filter of this.decimation) y = filter.process(y);
    return y;
  }

  reset(): void {
    this.theta1 = 0;
    this.thetaCarrier = 0;
    this.thetaSlot = 0;
    this.syncOffset = 0;
    this.lastPulses = 0;
    this.flux = 0;
    this.dcBlock.reset();
    this.radiation.reset();
    for (const f of this.resonators) f.reset();
    for (const f of this.decimation) f.reset();
    this.levelSmooth.set(0);
    this.modulationSmooth.set(0);
    this.frequencySmooth.set(0);
  }
}

/** 位相を [0, 2π) に畳む */
function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}

/** 位相 [0, 2π) から三角波 [-1, 1] */
function triangle(theta: number): number {
  const p = theta / TWO_PI;
  return p < 0.5 ? -1 + 4 * p : 3 - 4 * p;
}
