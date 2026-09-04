import type { VehicleDefinition } from '../schema.ts';

/**
 * 抵抗制御 主回路の共通仕様（MM' ユニットの M 車 2 両とも同じ）。
 *
 * 電動機は国鉄形の直流直巻機（375V・350A・1630rpm・約 120kW）を模した値。
 * コンパイラが銘板の 3 つから磁束定数を逆算する:
 *
 *   ω_定格   = 1630 · 2π/60 = 170.7 rad/s
 *   E_定格   = 375 − 350 · 0.10 = 340 V
 *   kΦ(350A) = 340 / 170.7 = 1.992 V·s/rad
 *   kΦ_max   = 1.992 · (350 + 190) / 350 = 3.073
 *   → T_定格 = 1.992 · 350 = 697 N·m（= 119kW / 170.7、銘板と一致する）
 *
 * 限流値 480A では φ = 480/670 = 0.716 なので
 *
 *   T = 3.073 · 0.716 · 480 = 1056 N·m/台
 *   1 両あたりの車輪周引張力 = 1056 · 4 · 5.6 · 0.95 / 0.43 = 52.3kN
 *   M 車 2 両で 104.5kN
 *   乗車率 50% の等価質量 158.2t に対して 0.66m/s² = 2.38km/h/s
 *
 * VVVF 車（3.3km/h/s）より鈍いのは、電動機の出力そのものが小さいうえに、
 * 起動抵抗で捨てているぶん架線から取った電力の半分近くが熱になっているためである。
 *
 * つなぎは MM' ユニット 8 台で組む。全直列（8 台直列）では 1 台 187.5V、
 * 並列（4 台直列 × 2 群）で 1 台 375V となり、**最終段でちょうど定格電圧**になる。
 * 国鉄形が MM' ユニットを組むのはこのためで、1 両 4 台では直並列にすると
 * 750V が掛かってしまい定格の倍になる。
 *
 * 進段表はここには書かない。限流値 480A と進段電流 380A の比 0.792 が公比の
 * 幾何級数として決まるので、コンパイラが組み立てる（直列 7 段 + 並列 8 段 +
 * 弱め界磁 4 段）。
 */
const motorSpec = {
  kind: 'resistor' as const,
  motorCount: 4,
  gearRatio: 5.6,
  driveEfficiency: 0.95,
  lineVoltage: 1500,
  motor: {
    armatureResistance: 0.1,
    saturationCurrent: 190,
    ratedVoltage: 375,
    ratedCurrent: 350,
    ratedRpm: 1630,
    armatureInductance: 22,
    // 電機子は 31 スロット、1 スロットにコイル辺が 3 個なので整流子片は 31 × 3 = 93。
    // 音の主役は片数（93 次）ではなくスロット（31 次）のほうで、40km/h で 714Hz。
    // 歯車のかみ合い（15 次・345Hz）のほぼ 1 オクターブ上に来る。
    armatureSlots: 31,
    commutatorBars: 93,
    fanBlades: 34,
    pinionTeeth: 15,
  },
  currentLimit: 480,
  stepCurrent: 380,
  /**
   * カム軸の機械的な回転速度。起動時は電流条件のほうが律速なので効かないが、
   * 高速からの再力行では逆起電力が大きくて 1 段目から進段電流を下回っているため、
   * カム軸が電流を待たずにこの速度で回りきる。70km/h からなら 17 段で約 5 秒。
   */
  stepDwell: 0.25,
  /**
   * ノッチの止まり位置。抵抗が回路に残る段では連続して走れない（抵抗器が焼ける）ので、
   * 運転士が保持できるのは**全短絡の段だけ**である。
   * 1 = 直列最終、2 = 並列最終、3 = 弱め界磁 0.65、4 = 最弱め界磁 0.45。
   */
  notchFinalStep: [6, 14, 16, 18],
  /** MM' ユニット 8 台を 全直列 → 並列（4 台直列 × 2 群）と組み替える */
  groupings: [8, 4],
  fieldSteps: [0.8, 0.65, 0.55, 0.45],
  /**
   * 発電ブレーキ。4 台直列 1 群を 6.2Ω の制動抵抗へつなぐ。
   * 自励が始まるのは `I = m·kΦ_max·ω/R − I_飽和` が正になる速度、すなわち
   *   ω_電動機 > 190 · 6.6 / (4 · 3.073) = 102 rad/s → 車速 28km/h
   * より上である。それ以下では電空協調が空気ブレーキへ渡していく。
   */
  hasDynamicBrake: true,
  brakeResistance: 6.2,
  brakeCurrentLimit: 500,
  brakeMotorsInSeries: 4,
  brakeFieldRatio: 1,
};

/**
 * 鋳鉄制輪子の踏面ブレーキ。
 *
 * レジンやディスクと違い、**μ が速度で大きく落ちる**のが鋳鉄の特徴で、
 * 高速から込めても最初は効かず、速度が落ちるにつれて効きが増していく。
 * 停止直前に効きすぎて前につんのめるのはこの曲線そのものである。
 */
const treadBrake = {
  kind: 'tread' as const,
  forcePerPressure: 0.17,
  frictionSpeedCurve: [
    [0, 1.45],
    [20, 1.2],
    [40, 1.0],
    [70, 0.82],
    [100, 0.72],
  ] as [number, number][],
};

/** 先頭車の走行抵抗係数 [kgf/t]（前面が平妻なので速度 2 乗項が大きい） */
const leadResistance = { a: 1.85, b: 0.0276, c: 0.00105 };
/** 中間車の走行抵抗係数 [kgf/t] */
const middleResistance = { a: 1.85, b: 0.0276, c: 0.00035 };

/**
 * 抵抗制御 通勤形電車 4 両編成（Tc - M - M' - Tc）。
 *
 * カム軸進段・直並列切替・弱め界磁・発電ブレーキ。公称性能は起動加速度
 * 2.38km/h/s、常用最大減速度 3.5km/h/s、非常減速度 4.5km/h/s、最高 100km/h。
 *
 * VVVF 車（`commuter4Vehicle`）と乗り比べると、同じ路線でも走りがはっきり違う:
 *
 *  - 進段のたびに引張力が鋸歯状に上下し、直並列の渡りでは一瞬トルクが抜ける
 *  - 発電ブレーキは抵抗器へ捨てるので、**架線の回生受け入れ率に左右されない**
 *    （降雪シナリオで VVVF 車と挙動が分かれる）
 *  - そのかわり低速で自励しなくなるので、28km/h あたりで空気ブレーキへ渡る
 *
 * 応荷重制御を持たないのも旧型らしいところで、混んでいるほど加速が鈍る。
 *
 * 数値は日本の在来線通勤形電車の代表値であり、実在形式の諸元ではない。
 */
export const commuter4ResistorVehicle: VehicleDefinition = {
  id: 'commuter-4-resistor',
  name: '通勤形 4 両編成 抵抗制御 (2M2T)',
  maxSpeed: 100,

  cars: [
    {
      id: 'Tc1',
      type: 'Tc',
      tareMass: 26,
      fullLoadMass: 9,
      drivenAxleCount: 0,
      rotatingMassFactor: 0.06,
      resistance: leadResistance,
      brake: treadBrake,
      traction: null,
    },
    {
      id: 'M1',
      type: 'M',
      tareMass: 38,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.12,
      resistance: middleResistance,
      brake: treadBrake,
      traction: motorSpec,
    },
    {
      id: "M'1",
      type: 'M',
      tareMass: 38,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.12,
      resistance: middleResistance,
      brake: treadBrake,
      traction: motorSpec,
    },
    {
      id: 'Tc2',
      type: 'Tc',
      tareMass: 26,
      fullLoadMass: 9,
      drivenAxleCount: 0,
      rotatingMassFactor: 0.06,
      resistance: leadResistance,
      brake: treadBrake,
      traction: null,
    },
  ],

  coupler: {
    // 密着連結器 + ゴム緩衝器。旧型なので遊間がやや大きい。
    slack: 0.015,
    stiffness1: 1.8e6,
    travel1: 0.02,
    stiffness2: 1.8e7,
    damping: 1.8e5,
  },

  adhesion: {
    mu0: 0.33,
    speedCoefficient: 0.008,
    peakCreep: 0.012,
    kineticRatio: 0.6,
    sandingFactor: 1.25,
    creepReferenceSpeed: 1.8,
  },

  traction: {
    // ノッチは「どの段まで進めてよいか」を選ぶだけで、そこへ至る道筋はカム軸が刻む。
    // 1 = 直列最終、2 = 並列の途中、3 = 並列最終、4 = 最弱め界磁。
    notchCount: 4,
    notchTorqueRatio: [1.0, 1.0, 1.0, 1.0],
    torqueRiseRate: 2.5,
    torqueFallRate: 4.0,
    // 応荷重制御を持たない旧型。混んでいるほど加速が鈍る。
    loadCompensation: false,
    referenceLoadFactor: 0.5,
    targetAcceleration: 0,
  },

  brake: {
    notchCount: 7,
    maxServiceDeceleration: 3.5,
    emergencyDeceleration: 4.5,
    blending: true,
    // 応荷重を持たないので、空いていると効きすぎ、混んでいると効きが落ちる。
    loadCompensation: false,
    antiSkid: false,
    antiSkidOnEmergency: false,
    emergencyIsAirOnly: true,
    hasHoldingBrake: true,
  },

  curveResistanceCoefficient: 600,
  tunnelResistanceFactor: 1.6,
};
