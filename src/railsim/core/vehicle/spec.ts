import type {
  Amperes,
  Henries,
  Hertz,
  Kilograms,
  Meters,
  MetersPerSecond,
  MetersPerSecondSquared,
  NewtonMeters,
  Newtons,
  Ohms,
  Pascals,
  Radians,
  Seconds,
  Volts,
} from '../units.ts';

/**
 * 走行抵抗の係数。比抵抗 r [N/kg] = a + b*v + c*v^2（v は m/s）。
 * 日本形の慣用式 (kgf/t, km/h) からは `davisFromKgfPerTon()` で変換する。
 */
export interface DavisCoefficients {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

/**
 * パルスモードの 1 段。
 *
 * VVVF インバータは、出力周波数が上がるほどキャリア（スイッチング）周波数を
 * 素子の能力内に収める必要がある。そのため低速では出力周波数と無関係な
 * **非同期**キャリアを使い、ある周波数から先は**同期**モードへ移って
 * キャリアを出力周波数の整数倍（27 → 15 → 9 → 5 → 3 → 1 パルス）に固定し、
 * 速度が上がるにつれてこの整数を段階的に落としていく。
 *
 * この段階の切り替わりが、日本の VVVF 車で聞こえる「音程が上がっていって
 * 途中でガクッと落ちる」の正体である。
 */
export interface PulseModeStep {
  /** この段へ切り替わる出力周波数の下限 [Hz] */
  readonly minFrequency: Hertz;
  /**
   * 出力 1 周期あたりのパルス数。
   * 0 = 非同期（キャリアは出力周波数と無関係）、1 = 一パルス（矩形波・搬送波なし）。
   */
  readonly pulses: number;
}

/**
 * インバータの変調と、電動機・駆動装置の音を決める諸元。
 *
 * ここに入るのは**引張力には影響しない**量だけである。引張力は 3 領域の
 * トルク特性（`motorTorqueAt`）で決まっており、変調方式はその同じ出力を
 * どういうスイッチングで作るかという話にすぎない。したがってこのブロックを
 * 差し替えても走りは 1 ミリも変わらず、音と表示だけが変わる。
 */
export interface InverterSpec {
  /** 極対数（4 極機なら 2）。回転子周波数 = 極対数 × 回転数/60 */
  readonly polePairs: number;
  /** 定格トルクを出しているときのすべり周波数 [Hz] */
  readonly ratedSlipFrequency: Hertz;
  /**
   * 基底周波数 [Hz]。ここまでは V/f 一定で変調率が比例して上がり、
   * ここで変調率が 1 に飽和して以降は定電圧（弱め界磁）になる。
   * 定トルク域の上限速度に対応する出力周波数を入れる。
   */
  readonly baseFrequency: Hertz;
  /**
   * 低周波電圧ブースト（一次抵抗降下の補償）0..1。
   *
   * V/f 一定を素直に守ると、出力周波数が 0 へ近づくにつれて印加電圧も 0 へ落ちる。
   * ところが電圧の一部は一次巻線の抵抗降下 `I·R₁` に食われるので、磁束を作るのに
   * 使える電圧は `V − I·R₁` しかない。V を 0 にすれば磁束も 0 になり、**起動時に
   * 定格トルクを出せない**。実機の V/f 制御はこのぶんを上乗せして入る。
   *
   * 抵抗降下は電流に比例するので、上乗せ量も負荷（トルク比）に比例する:
   *
   *   変調率 = min(1, f₁/f_基底 + ブースト × |トルク比|)
   *
   * 引張力はトルク特性の側で決まっているので、この値を変えても走りは変わらない。
   * 変わるのは磁束、つまり**起動直後の磁気音の大きさ**である。入れていなかった
   * ころは、起動の 1 音目だけが 15dB ほど落ち込んでいた。
   */
  readonly voltageBoost: number;
  /**
   * 非同期モードのキャリア周波数 [出力周波数 Hz, キャリア Hz] の折れ線。
   * この表 1 つで、GTO の段階的な変化・IGBT の一定キャリア・
   * 音階インバータ（起動時に音程が階段状に上がる）をすべて表せる。
   */
  readonly asyncCarrier: ReadonlyArray<readonly [Hertz, Hertz]>;
  /** パルスモードの梯子（出力周波数の昇順） */
  readonly pulseModes: readonly PulseModeStep[];
  /** モード切替のヒステリシス幅 [Hz]（実機もチャタリング防止に持つ） */
  readonly modeHysteresis: Hertz;
  /** 回転子スロット数。スロット高調波 = スロット数 × 回転数/60 が磁気音に乗る */
  readonly rotorSlots: number;
  /** 小歯車の歯数。かみ合い周波数 = 電動機回転数/60 × 歯数 */
  readonly pinionTeeth: number;
}

/**
 * 制御方式によらず共通の駆動諸元。
 *
 * 電動機のトルクを車輪周の引張力へ換算するのに要る量と、電力の勘定に要る量だけを
 * ここに置く。**どの方式でもこの換算はまったく同じ**であり、方式ごとに違うのは
 * 「そのトルクをどうやって作るか」だけである。
 */
export interface TractionSpecBase {
  /** 1 両あたりの主電動機数 */
  readonly motorCount: number;
  /** 歯車比（電動機回転数 / 車軸回転数） */
  readonly gearRatio: number;
  /** 歯車・軸受を含む駆動効率 */
  readonly driveEfficiency: number;
  /** 公称架線電圧 [V] */
  readonly lineVoltage: Volts;
  /** 主変換装置（インバータ・チョッパ・接触器）の効率（電力計算用） */
  readonly converterEfficiency: number;
}

/** VVVF インバータ制御・誘導電動機の仕様 */
export interface VvvfTractionSpec extends TractionSpecBase {
  readonly kind: 'vvvf';
  /** 電動機 1 台あたりの最大トルク [N*m]（定トルク域） */
  readonly maxMotorTorque: NewtonMeters;
  /** 定トルク域の上限速度 [m/s] */
  readonly constantTorqueSpeed: MetersPerSecond;
  /** 定出力域の上限速度 [m/s]。これ以上は特性領域（トルク ∝ 1/v^2）。 */
  readonly constantPowerSpeed: MetersPerSecond;
  /** 電気（回生）ブレーキ時の電動機 1 台あたり最大トルク [N*m] */
  readonly maxBrakingMotorTorque: NewtonMeters;
  /** 回生の絞り込みが始まる速度 [m/s] */
  readonly regenFadeStartSpeed: MetersPerSecond;
  /** 回生が完全に失効する速度 [m/s] */
  readonly regenFadeEndSpeed: MetersPerSecond;
  /** 変調方式と音に関わる諸元 */
  readonly inverter: InverterSpec;
}

/**
 * GTO サイリスタ素子の通勤形の代表的な変調（車輪径 0.86m・歯車比 7.07・4 極）。
 *
 * 定トルク域の上限 35km/h が出力周波数 53Hz にあたるので、そこで変調率が飽和して
 * 一パルスへ入る。素子の許容スイッチング周波数が低いため、同期モードのパルス数を
 * 15 → 9 → 5 → 3 と落としながらキャリアを 500Hz 以下に抑えている。
 */
export const DEFAULT_INVERTER: InverterSpec = {
  polePairs: 2,
  ratedSlipFrequency: 2.0,
  baseFrequency: 53,
  // 定格電流での一次抵抗降下が定格電圧の 6% ほどにあたる、という想定。
  voltageBoost: 0.06,
  // GTO は素子の損失が大きいのでキャリアを高くできない。段階的に上げる。
  asyncCarrier: [
    [0, 250],
    [6, 250],
    [7, 350],
    [12, 350],
    [13, 480],
    [18, 480],
  ],
  pulseModes: [
    { minFrequency: 0, pulses: 0 },
    { minFrequency: 18, pulses: 15 },
    { minFrequency: 28, pulses: 9 },
    { minFrequency: 38, pulses: 5 },
    { minFrequency: 47, pulses: 3 },
    { minFrequency: 53, pulses: 1 },
  ],
  modeHysteresis: 1.5,
  rotorSlots: 44,
  pinionTeeth: 17,
};

/**
 * 直流直巻電動機の仕様。抵抗制御・電機子チョッパ制御が共有する。
 *
 * 誘導電動機と決定的に違うのは、**トルクも回転数も電機子回路の解として出てくる**点で
 * ある。VVVF なら「定トルク → 定出力 → 特性領域」という 3 領域の曲線を仕様として
 * 与えられるが、直流機でその曲線を与えてはいけない。曲線は回路から出てくる結果で
 * あって、原因ではないからである。
 *
 * 直巻とは界磁巻線が電機子と**直列**につながっているということで、界磁磁束が電機子
 * 電流そのもので作られる。磁化曲線を
 *
 * ```
 * φ(I) = I / (I + I_飽和)        （0..1、鉄心の飽和で 1 に漸近）
 * ```
 *
 * と置くと、直巻機の 2 つの顔が 1 本の式から出る:
 *
 *  - 小電流 `φ ≒ I / I_飽和` → `T ∝ I²`（起動時に大きな引張力が出る）
 *  - 大電流 `φ → 1`          → `T ∝ I`（鉄心が飽和して他励機と同じになる）
 *
 * さらにこの形なら発電ブレーキの自励条件が閉じた式で解ける（`selfExcitedCurrent`）。
 * 飽和電流 `I_飽和` ただ 1 つで曲線の形が決まるので、諸元としても書きやすい。
 */
export interface DcSeriesMotorSpec {
  /** 電機子抵抗（直巻界磁巻線・ブラシを含む合計）[Ω]（1 台あたり） */
  readonly armatureResistance: Ohms;
  /** 磁化曲線の飽和電流 I_飽和 [A] */
  readonly saturationCurrent: Amperes;
  /** 完全飽和・全界磁での磁束定数 kΦ_max [V*s/rad]（= [N*m/A]） */
  readonly fluxConstant: number;
  /** 連続定格電流 [A]（表示と音量の正規化基準） */
  readonly ratedCurrent: Amperes;
  /** 電機子回路のインダクタンス [H]（1 台あたり） */
  readonly armatureInductance: Henries;
  /**
   * 電機子スロット数。スロット通過周波数 = 電動機回転数/60 × スロット数。
   *
   * 電機子が 1 スロット進むごとに空隙のパーミアンスが変わり、界磁極を引く半径方向の
   * 力が脈動する。**直流機の電磁音の主役はこれ**であって、整流子片の通過ではない。
   */
  readonly armatureSlots: number;
  /**
   * 整流子片数。ブラシの通過周波数 = 電動機回転数/60 × 片数。
   *
   * スロット数の 2〜3 倍（1 スロットに入るコイル辺の数）になるので、この周波数は
   * スロット通過よりずっと高い。実機ではフレームの奥にあって減衰が強く、音程を持った
   * 基音ではなく広帯域のかすれとして乗る（`dcMotorVoice.ts` を見よ）。
   */
  readonly commutatorBars: number;
  /**
   * 通風ファンの翼数。翼通過周波数 = 電動機回転数/60 × 翼数。
   *
   * 自己通風の直流機は電機子軸にファンを持つ。その騒音は広帯域が主で、翼通過に
   * ゆるい峰が立つ。**電磁音と違って電流に依存しない**ので、惰行しても回っている
   * かぎり鳴り続ける。
   */
  readonly fanBlades: number;
  /** 小歯車の歯数。かみ合い周波数 = 電動機回転数/60 × 歯数 */
  readonly pinionTeeth: number;
}

/**
 * カム軸の 1 段。
 *
 * 「電動機を何台直列につないで、どれだけ抵抗を残して、界磁をどれだけ弱めているか」
 * の 3 つで主回路は完全に決まる。進段とはこの 3 つ組を順に切り替えていくことである。
 */
export interface CamStep {
  /** 1 分岐に直列に入る主電動機の数（4 = 全直列、2 = 直並列、1 = 全並列） */
  readonly motorsInSeries: number;
  /** 1 分岐に直列に残っている起動抵抗 [Ω]（0 = 全短絡） */
  readonly resistance: Ohms;
  /** 界磁率（1 = 全界磁、0.4 = 40% 弱め界磁） */
  readonly fieldRatio: number;
}

/**
 * 抵抗制御（カム軸進段・直並列切替・弱め界磁）の仕様。
 *
 * 起動時は電動機に全電圧を掛けられない（逆起電力が無いので短絡に近い電流が流れる）。
 * そこで起動抵抗を直列に入れて電流を抑え、速度が上がって電流が進段電流まで落ちるたび
 * に抵抗を 1 段ずつ短絡していく。これがカム軸の進段である。抵抗を使い切ったら電動機の
 * つなぎ方を直列から並列へ組み替えて 1 台あたりの電圧を上げ、また抵抗を入れ直して
 * 同じことを繰り返す。最後は界磁を弱めてさらに回転を伸ばす。
 *
 * 進段表 `camSteps` はデータ側に直接書かず、限流値・進段電流・つなぎ方から
 * コンパイラが幾何級数として生成する（`packages/data/src/compile/vehicle.ts`）。
 */
export interface ResistorTractionSpec extends TractionSpecBase {
  readonly kind: 'resistor';
  readonly motor: DcSeriesMotorSpec;
  /** 進段表（起動の順）。最終段が最弱め界磁。 */
  readonly camSteps: readonly CamStep[];
  /** 限流値 [A]（1 台あたり）。段が進んだ直後の電流がこの値になる。 */
  readonly currentLimit: Amperes;
  /** 進段電流 [A]。電流がこれを下回るとカム軸が 1 段進む。限流値より小さいこと。 */
  readonly stepCurrent: Amperes;
  /**
   * 1 段あたりの最短滞留時間 [s]。
   *
   * これは**カム軸を回すパイロットモータの機械的な速度**であって、進段の間隔そのもの
   * ではない。限流継電器がカム軸を止めているあいだは進めないので、ふつう間隔を
   * 決めているのは電流条件（`stepCurrent`）のほうである。起動から加速していく場面なら
   * 電流が限流値から進段電流まで落ちるのに 1.5〜2 秒かかるので、この値は効かない。
   *
   * 効くのは**限流継電器が最初から復帰している場面** — つまり高速からの再力行である。
   * 逆起電力が大きいので、全抵抗が入った 1 段目でも電流が進段電流を大きく下回る
   * （70km/h で 52A、限流値 480A の 11%）。進段条件が最初から満たされているため、
   * カム軸は電流を待たずに機械的な速度で回りきる。ノッチを入れてから進段音が
   * 連打され、加速が戻るまで数秒かかるのはこれで、実車どおりの挙動である。
   * 70km/h からなら 17 段ぶん、およそ 5 秒かかる。
   */
  readonly stepDwell: Seconds;
  /**
   * 直並列の組替え（渡り）に要する時間 [s]。
   *
   * このあいだは主回路が開いていてトルクが出ない。抵抗の入れ替えだけの進段と違い、
   * 組替えでは電動機のつなぎ方そのものを変えるため、いったん回路を切る必要がある。
   * 加速中に一瞬つんのめる「渡りのショック」はこの時間そのものである。
   */
  readonly transitionTime: Seconds;
  /** 各力行ノッチで到達を許す最終段（`camSteps` の添字。要素数 = notchCount） */
  readonly notchFinalStep: readonly number[];
  /** 発電ブレーキを持つか */
  readonly hasDynamicBrake: boolean;
  /** 発電ブレーキの制動抵抗 [Ω]（1 分岐）。自励の下限速度を決める。 */
  readonly brakeResistance: Ohms;
  /** 発電ブレーキの限流値 [A] */
  readonly brakeCurrentLimit: Amperes;
  /** 発電ブレーキ時に 1 分岐へ直列に入る電動機数 */
  readonly brakeMotorsInSeries: number;
  /** 発電ブレーキの界磁率 */
  readonly brakeFieldRatio: number;
}

/**
 * 電機子チョッパ制御の仕様。
 *
 * 起動抵抗の代わりにサイリスタチョッパで電機子電圧を刻む。通流率を連続に変えられる
 * ので段が無く、抵抗で熱にしていた分をそのまま省エネにできる。回生ブレーキも
 * 同じ回路を昇圧動作させるだけで作れる。電動機そのものは抵抗制御車と同じ直流直巻機
 * であり、**違うのは電圧の作り方だけ**である。
 */
export interface ChopperTractionSpec extends TractionSpecBase {
  readonly kind: 'chopper';
  readonly motor: DcSeriesMotorSpec;
  /** 1 分岐に直列に入る主電動機の数（固定。チョッパは組替えをしない） */
  readonly motorsInSeries: number;
  /** チョッピング周波数 [Hz]（固定周波数・可変通流率） */
  readonly chopFrequency: Hertz;
  /** 通流率の上限（素子の転流に要る最小オフ時間のぶんだけ 1 を切る） */
  readonly maxDuty: number;
  /** 通流率の変化速度 [1/s]（電流制御ループの応答） */
  readonly dutyRate: number;
  /** 弱め界磁の下限（分路界磁の最小界磁率） */
  readonly minFieldRatio: number;
  /** 界磁率の変化速度 [1/s] */
  readonly fieldRate: number;
  /** 力行の限流値 [A] */
  readonly currentLimit: Amperes;
  /** 回生の限流値 [A] */
  readonly brakeCurrentLimit: Amperes;
  /** 回生の絞り込みが始まる速度 [m/s] */
  readonly regenFadeStartSpeed: MetersPerSecond;
  /** 回生が完全に失効する速度 [m/s] */
  readonly regenFadeEndSpeed: MetersPerSecond;
}

export type VehicleTractionSpec = VvvfTractionSpec | ResistorTractionSpec | ChopperTractionSpec;

/** 制御方式の種別 */
export type TractionKind = VehicleTractionSpec['kind'];

/** 基礎ブレーキ装置（車両側） */
export interface VehicleBrakeSpec {
  /** 踏面ブレーキ（鋳鉄・レジン制輪子）か、ディスクブレーキか */
  readonly kind: 'tread' | 'disc';
  /**
   * ブレーキシリンダ圧 1 Pa あたりに車輪周で発生する制動力 [N/Pa]。
   * てこ比・シリンダ断面積・基礎ブレーキ倍率・摩擦材の基準 μ を畳み込んだ値。
   */
  readonly forcePerPressure: number;
  /** ブレーキシリンダの最大圧力 [Pa] */
  readonly maxCylinderPressure: Pascals;
  /** 指令から BC 圧が動き始めるまでのむだ時間 [s] */
  readonly deadTime: Seconds;
  /** BC 圧の一次遅れ時定数（込め）[s] */
  readonly fillTimeConstant: Seconds;
  /** BC 圧の一次遅れ時定数（緩め）[s] */
  readonly releaseTimeConstant: Seconds;
  /**
   * 摩擦材の μ の速度依存。[速度 m/s, 基準 μ に対する比] の折れ線。
   * 鋳鉄制輪子は高速で μ が大きく低下し、レジン・ディスクは比較的平坦。
   */
  readonly frictionSpeedCurve: ReadonlyArray<readonly [MetersPerSecond, number]>;
  /** ブレーキが作用する軸の割合（1 = 全軸） */
  readonly brakedAxleRatio: number;
}

/** 粘着特性 */
export interface AdhesionSpec {
  /** 停止時のピーク粘着係数（乾燥レール基準） */
  readonly mu0: number;
  /** 速度依存係数 k [1/(km/h)]。μ_max(V) = mu0 / (1 + k V) */
  readonly speedCoefficient: number;
  /** ピーク粘着を与えるすべり率 */
  readonly peakCreep: number;
  /**
   * 横クリープ力が飽和するすべり角 [rad]。
   *
   * 横方向の creep 力は微小域では `f₂₂ ξ` と線形に立ち上がり、摩擦限界 `μN` で
   * 頭打ちになるので、飽和すべり率は `ξ_飽和 = μN / f₂₂` である。Kalker の線形理論に
   * 代表的な接触諸元（軸重 10t・接触楕円 6×5mm・C₂₂ ≈ 3.5）を入れると 1.7mrad に
   * なるが、線形理論は接触面の部分すべり域を無視するぶんクリープ係数を過大に見積もる
   * ので、実際の飽和はもう少し先に来る。
   *
   * この値と固定軸距から**軋み音の出はじめる曲線半径**が決まる
   * （`squealOnsetRadius`）。3mrad・軸距 2.1m なら R350。曲線の軋み音が急曲線と
   * 小番数の分岐器でだけ聞こえて、本線の R400〜600 では聞こえないのはこの閾値による。
   */
  readonly lateralCreepSaturation: number;
  /** 大すべり域の μ / ピーク μ（滑走時の摩擦係数比） */
  readonly kineticRatio: number;
  /** 砂撒き時の粘着係数の倍率 */
  readonly sandingFactor: number;
  /** すべり率の分母に用いる速度の下限 [m/s]（低速での特異点回避） */
  readonly creepReferenceSpeed: MetersPerSecond;
}

/**
 * 車体を支えるばね（枕ばね・軸ばね）の特性。
 * 車体の動揺は各自由度の固有振動数と減衰比で決まるため、
 * ばね定数そのものではなく振動特性としてパラメータ化する。
 */
export interface SuspensionSpec {
  /** ロールの固有振動数 [Hz] */
  readonly rollFrequency: number;
  /** ロールの減衰比 */
  readonly rollDamping: number;
  /**
   * 車体傾斜率（フレキシビリティ係数）。
   * 横加速度によるつり合い角に対して、車体がどれだけ余分に外側へ傾くかの比。
   * 空気ばね車で 0.2〜0.4 程度。大きいほど乗客の感じる横 G が増える。
   */
  readonly rollFlexibility: number;
  /** 上下動の固有振動数 [Hz] */
  readonly bounceFrequency: number;
  /** 上下動の減衰比 */
  readonly bounceDamping: number;
  /** ピッチングの固有振動数 [Hz] */
  readonly pitchFrequency: number;
  /** ピッチングの減衰比 */
  readonly pitchDamping: number;
  /** 前後加速度 1 m/s^2 あたりのピッチ角 [rad] */
  readonly pitchGain: number;
  /** 左右動の固有振動数 [Hz] */
  readonly swayFrequency: number;
  /** 左右動の減衰比 */
  readonly swayDamping: number;
  /** 横加速度 1 m/s^2 あたりの左右変位 [m] */
  readonly swayGain: number;
  /** ヨーイングの固有振動数 [Hz] */
  readonly yawFrequency: number;
  /** ヨーイングの減衰比 */
  readonly yawDamping: number;
}

/** 空気ばね付き通勤形電車の代表的な動揺特性 */
export const DEFAULT_SUSPENSION: SuspensionSpec = {
  rollFrequency: 0.85,
  rollDamping: 0.22,
  rollFlexibility: 0.3,
  bounceFrequency: 1.2,
  bounceDamping: 0.28,
  pitchFrequency: 1.35,
  pitchDamping: 0.32,
  pitchGain: 0.006,
  swayFrequency: 1.0,
  swayDamping: 0.24,
  swayGain: 0.012,
  yawFrequency: 1.5,
  yawDamping: 0.3,
};

/**
 * 車内の乗客の仕様。
 *
 * 吊り革は**物**なので減衰振り子（天井の握り棒からリングまで 0.5〜0.7m、固有周期は
 * `T = 2π√(L/g)` で 1.4〜1.7 秒）。立っている乗客は**人**なので、足首を支点とした
 * 倒立振子に、むだ時間を持つ姿勢制御を載せたものとして扱う。
 * 数値は姿勢制御の生理学で使われる代表値による。
 *
 * 吊り革の減衰は支点の摩擦だけなので弱い。減衰比 ζ のステップ応答の
 * 行き過ぎ量は `exp(-πζ/√(1-ζ²))` で、
 *
 *   ζ = 0.45 → 20%   ζ = 0.2 → 53%   ζ = 0.1 → 73%
 *
 * 実車で急停車したときの吊り革は、前へ振られたぶんの半分ほど後ろへ戻ってから
 * 数回揺れて収まる。ζ = 0.2 がその挙動になる。
 */
export interface PassengerSpec {
  /** 吊り革の長さ [m] */
  readonly strapLength: Meters;
  /** 吊り革の減衰比（0 = 減衰なし、1 = 臨界減衰） */
  readonly strapDamping: number;

  /** 立っている乗客の重心高さ [m]（身長のおよそ 55%） */
  readonly comHeight: Meters;
  /** 支持基底面: くるぶしから爪先まで [m] */
  readonly footForward: Meters;
  /** 支持基底面: くるぶしから踵まで [m]。爪先側より狭いので後ろへは倒れやすい。 */
  readonly footBackward: Meters;
  /** 支持基底面: 左右（両足の間隔の半分 + 足幅）[m] */
  readonly footLateral: Meters;
  /**
   * 吊り革・手すりにつかまることで増える支持余裕 [m]（足圧中心の可動域に換算）。
   * 手は重心より高い位置で力を出せるので、実際には足だけの場合より効きが大きい。
   */
  readonly handSupport: Meters;
  /**
   * 姿勢制御のむだ時間 [s]。感覚の伝導・中枢の処理・電気機械遅延の合計で 0.1〜0.2 秒。
   * **急な加速度変化でよろけ、緩やかな変化には抵抗できる**のはこの遅れによる。
   */
  readonly reactionDelay: Seconds;
  /** 筋張力の立ち上がり時定数 [s] */
  readonly muscleTimeConstant: Seconds;
  /**
   * 姿勢の比例ゲイン（重心高さに対する比）。傾き 1 rad あたり足圧中心を
   * `stiffnessRatio × 重心高さ` [m] 動かす。**1 を超えていないと倒立振子の
   * 不安定性に勝てず、そもそも立っていられない。** */
  readonly stiffnessRatio: number;
  /**
   * 姿勢の微分ゲイン [m/(rad/s)]。
   *
   * むだ時間があると比例項が `k_p τ` ぶんの**負の減衰**として働くため、
   * 遅れの無い系で必要な値よりかなり大きくないと揺れが収まらない。
   * 人が「速く動いているほど強く踏ん張る」のはこれを埋め合わせている。
   */
  readonly dampingGain: number;
  /**
   * 倒れたと見なす傾き [rad]。これを超えたら支えきれずに倒れた（あるいは
   * まわりの人にぶつかって止まった）ものとして、そこで角度を止める。
   */
  readonly maxLean: Radians;
  /** 片足支持（踏み出し中）の支持基底面の縮小率 */
  readonly singleSupportFactor: number;
  /** 一歩の最大長さ [m] */
  readonly stepLength: Meters;
  /** 踏み出しから着地までの時間 [s] */
  readonly stepDuration: Seconds;
  /** 着地で角速度が減る割合（0 = 完全に止まる、1 = そのまま） */
  readonly stepDissipation: number;
}

export const DEFAULT_PASSENGER: PassengerSpec = {
  strapLength: 0.6,
  strapDamping: 0.2,
  comHeight: 0.95,
  footForward: 0.12,
  footBackward: 0.07,
  footLateral: 0.085,
  handSupport: 0.05,
  reactionDelay: 0.14,
  muscleTimeConstant: 0.06,
  stiffnessRatio: 1.35,
  dampingGain: 0.45,
  maxLean: 0.5,
  singleSupportFactor: 0.45,
  stepLength: 0.22,
  stepDuration: 0.35,
  stepDissipation: 0.35,
};

/** 連結器（緩衝器を含む）の仕様 */
export interface CouplerSpec {
  /** 遊間の全幅 [m]。この範囲では力を伝えない。 */
  readonly slack: Meters;
  /** 1 段目のばね定数 [N/m] */
  readonly stiffness1: number;
  /** 1 段目が受け持つ変位 [m]。これを超えると 2 段目の剛性になる。 */
  readonly travel1: Meters;
  /** 2 段目のばね定数 [N/m] */
  readonly stiffness2: number;
  /** 緩衝器の減衰係数 [N/(m/s)] */
  readonly damping: number;
  /** 伝達力の上限 [N]（省略時は無制限） */
  readonly maxForce?: Newtons;
}

/** 1 両の仕様 */
export interface VehicleSpec {
  readonly id: string;
  /** 自重 [kg] */
  readonly tareMass: Kilograms;
  /** 乗車率 100% における積載質量 [kg] */
  readonly fullLoadMass: Kilograms;
  /** 連結面間距離 [m] */
  readonly length: Meters;
  /** 台車中心間距離 [m] */
  readonly bogieSpacing: Meters;
  /** 固定軸距（台車内の軸間距離）[m] */
  readonly bogieWheelbase: Meters;
  /** 軸数（通常 4） */
  readonly axleCount: number;
  /** 動軸数（0 なら付随車） */
  readonly drivenAxleCount: number;
  /** 車輪径 [m] */
  readonly wheelDiameter: Meters;
  /**
   * 回転部慣性の等価質量係数 γ。等価質量 = m (1 + γ)。
   * 各軸の回転慣性 J は J = γ m r^2 / 軸数 として逆算される。
   */
  readonly rotatingMassFactor: number;
  /** 走行抵抗係数 */
  readonly runningResistance: DavisCoefficients;
  /** 重心高さ（レール面から）[m] */
  readonly centerOfGravityHeight: Meters;
  /** 牽引装置の高さ（レール面から）[m] */
  readonly tractionLinkHeight: Meters;
  /** 基礎ブレーキ装置 */
  readonly brake: VehicleBrakeSpec;
  /** 動力装置（付随車は null） */
  readonly traction: VehicleTractionSpec | null;
  /** 車体を支えるばねの動揺特性 */
  readonly suspension: SuspensionSpec;
  /** 乗客（吊り革）の振られ方 */
  readonly passenger: PassengerSpec;
}

/** 力行制御（編成としての取り扱い） */
export interface TractionControlSpec {
  /** 力行ノッチ数 */
  readonly notchCount: number;
  /** 各ノッチのトルク指令率（要素数 = notchCount、0 < r <= 1） */
  readonly notchTorqueRatio: readonly number[];
  /** トルク指令の立ち上がり速度 [1/s]（最大トルクに対する割合／秒） */
  readonly torqueRiseRate: number;
  /** トルク指令の立ち下がり速度 [1/s] */
  readonly torqueFallRate: number;
  /** 応荷重制御（乗車率に応じて引張力を補正し、加速度を一定に保つ） */
  readonly loadCompensation: boolean;
  /** 応荷重制御の基準乗車率（この乗車率で公称性能となる） */
  readonly referenceLoadFactor: number;
  /** 定加速度制御の目標加速度 [m/s^2]（0 以下で無効） */
  readonly targetAcceleration: MetersPerSecondSquared;
}

/** ブレーキ制御（編成としての取り扱い） */
export interface BrakeControlSpec {
  /** 常用ブレーキのノッチ数 */
  readonly notchCount: number;
  /** 常用最大ノッチの減速度 [m/s^2] */
  readonly maxServiceDeceleration: MetersPerSecondSquared;
  /** 非常ブレーキの減速度 [m/s^2] */
  readonly emergencyDeceleration: MetersPerSecondSquared;
  /** 各ノッチの減速度 [m/s^2]（省略時は最大減速度をノッチ数で等分） */
  readonly notchDeceleration?: readonly MetersPerSecondSquared[];
  /** 電空協調（回生優先で空気ブレーキが不足分を補う） */
  readonly blending: boolean;
  /** 応荷重制御 */
  readonly loadCompensation: boolean;
  /** 滑走防止装置 */
  readonly antiSkid: boolean;
  /** 非常ブレーキでも滑走防止を働かせるか */
  readonly antiSkidOnEmergency: boolean;
  /** 非常ブレーキで電気ブレーキを併用しない（純空気とする） */
  readonly emergencyIsAirOnly: boolean;
  /** 抑速ブレーキ（電気ブレーキによる勾配抑速）を持つか */
  readonly hasHoldingBrake: boolean;
}

/**
 * 客用扉の仕様（編成としての取り扱い）。
 *
 * 扉そのものの寸法や枚数は持たない。走りに効くのは**閉まり切るまでの時間**
 * （戸閉連動が成立するまで力行できない）だけで、あとは音と表示のための量である。
 */
export interface DoorSpec {
  /** 開指令から全開までの時間 [s] */
  readonly openTime: Seconds;
  /** 扉が動き出してから全閉・施錠までの時間 [s] */
  readonly closeTime: Seconds;
  /**
   * 閉扉予告の時間 [s]。閉指令からこの時間が経ってから扉が動き出す。
   * チャイムが鳴ってから閉まり始めるまでの間そのもの。
   */
  readonly closeWarningTime: Seconds;
  /** 開くときにドアチャイムを鳴らすか */
  readonly chimeOnOpen: boolean;
  /** 閉めるときにドアチャイムを鳴らすか */
  readonly chimeOnClose: boolean;
  /** チャイムが鳴っている時間 [s] */
  readonly chimeDuration: Seconds;
}

/** 空気式の両開き扉の代表的な動作時間 */
export const DEFAULT_DOOR: DoorSpec = {
  openTime: 2.2,
  closeTime: 2.4,
  closeWarningTime: 0.6,
  chimeOnOpen: true,
  chimeOnClose: true,
  chimeDuration: 1.6,
};

/** レール踏面の状態 */
export type RailCondition = 'dry' | 'wet' | 'leaves' | 'snow';

/** 編成全体の仕様 */
export interface ConsistSpec {
  readonly id: string;
  readonly name: string;
  readonly vehicles: readonly VehicleSpec[];
  readonly coupler: CouplerSpec;
  readonly adhesion: AdhesionSpec;
  readonly traction: TractionControlSpec;
  readonly brake: BrakeControlSpec;
  /** 客用扉 */
  readonly door: DoorSpec;
  /** 設計最高速度 [m/s] */
  readonly maxSpeed: MetersPerSecond;
  /**
   * 曲線抵抗係数 f [N/kg * m]。比抵抗 r_c = f / R。
   * 慣用式の 600/R（狭軌, kgf/t）などから `kgfPerTonToNPerKg` で変換した値を入れる。
   */
  readonly curveResistanceCoefficient: number;
  /** トンネル内で走行抵抗の速度 2 乗項に掛かる倍率 */
  readonly tunnelResistanceFactor: number;
}

/** 編成の総自重 [kg] */
export function tareMassOf(consist: ConsistSpec): Kilograms {
  return consist.vehicles.reduce((a, v) => a + v.tareMass, 0);
}

/** 乗車率 loadFactor における 1 両の質量 [kg] */
export function vehicleMass(v: VehicleSpec, loadFactor: number): Kilograms {
  return v.tareMass + v.fullLoadMass * loadFactor;
}

/** 乗車率 loadFactor における編成の総質量 [kg] */
export function consistMass(consist: ConsistSpec, loadFactor: number): Kilograms {
  return consist.vehicles.reduce((a, v) => a + vehicleMass(v, loadFactor), 0);
}

/** 編成長 [m] */
export function consistLength(consist: ConsistSpec): Meters {
  return consist.vehicles.reduce((a, v) => a + v.length, 0);
}

/**
 * 1 軸あたりの回転慣性 [kg*m^2]。
 *
 * 回転部（車輪・車軸・歯車・電動機回転子）の慣性は乗客の増減で変わらないため、
 * 等価質量係数 γ は**自重**に対して定義されているものとして J = γ m_tare r^2 / 軸数 とする。
 * これにより等価質量は m_total + γ m_tare となり、満車時に加速度が落ちる挙動が正しく出る。
 */
export function axleInertia(v: VehicleSpec): number {
  const r = v.wheelDiameter / 2;
  return (v.rotatingMassFactor * v.tareMass * r * r) / v.axleCount;
}
