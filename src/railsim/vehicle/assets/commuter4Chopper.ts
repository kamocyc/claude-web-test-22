import type { VehicleDefinition } from '../schema.ts';

/**
 * 電機子チョッパ 主回路の共通仕様（M 車 2 両とも同じ）。
 *
 * **電動機は抵抗制御車（`commuter4Resistor.ts`）とまったく同じ直流直巻機**である。
 * 違うのは電圧の作り方だけで、起動抵抗で落として熱にする代わりにサイリスタ
 * チョッパで刻む。同じ電動機を積んでいるので、乗り比べると「刻みがあるか無いか」
 * の差だけが浮き上がる。
 *
 * 4 台直列で 1500V を受けるので、全通流のとき 1 台あたり 375V ＝ 定格電圧になる。
 * 抵抗制御車のように組み替えないのは、通流率を連続に変えられるから組み替える
 * 必要が無いためである。
 *
 * 限流値 500A では φ = 500/690 = 0.725 なので
 *
 *   T = 3.073 · 0.725 · 500 = 1113 N·m/台
 *   1 両あたりの車輪周引張力 = 1113 · 4 · 6.07 · 0.95 / 0.43 = 59.7kN
 *   M 車 2 両で 119.4kN
 *   乗車率 50% の等価質量 153.0t に対して 0.78m/s² = 2.81km/h/s
 *
 * 全通流に達するのは、1 台あたりの端子電圧が 0.97 · 1500 / 4 = 363.75V に届く速度:
 *
 *   E = 363.75 − 500 · 0.10 = 313.75V
 *   ω = 313.75 / (3.073 · 0.725) = 140.9 rad/s → 車速 36km/h
 *
 * そこから先は界磁を 0.45 まで弱めて回転を伸ばす。「起動から一定加速度 →
 * 全通流 → 弱め界磁」という 3 段が、抵抗を 1 本も使わずに出る。
 */
const motorSpec = {
  kind: 'chopper' as const,
  motorCount: 4,
  gearRatio: 6.07,
  driveEfficiency: 0.95,
  lineVoltage: 1500,
  converterEfficiency: 0.96,
  motor: {
    armatureResistance: 0.1,
    saturationCurrent: 190,
    ratedVoltage: 375,
    ratedCurrent: 350,
    ratedRpm: 1630,
    armatureInductance: 22,
    // 抵抗制御車と同じ電動機（31 スロット × コイル辺 3 = 整流子 93 片）。
    armatureSlots: 31,
    commutatorBars: 93,
    fanBlades: 34,
    pinionTeeth: 15,
  },
  motorsInSeries: 4,
  /**
   * チョッピング周波数 [Hz]。サイリスタの転流に要る時間で上限が決まるので、
   * この世代の車は数百 Hz に落ち着く。**速度によらず一定**なので、加速しても
   * 音程が変わらない — チョッパ車の音がすぐそれと分かるのはこのためである。
   */
  chopFrequency: 400,
  maxDuty: 0.97,
  dutyRate: 3.0,
  minFieldRatio: 0.45,
  fieldRate: 0.6,
  currentLimit: 500,
  brakeCurrentLimit: 460,
  /**
   * 回生の絞り込み。チョッパの昇圧比には `1/(1 − maxDuty)` の上限があるので、
   * 電動機側の電圧が架線電圧の `1 − maxDuty` 倍を割ると架線へ押し返せない。
   * 実際には制御側の下限のほうが先に効くので、その速度を入れている。
   */
  regenFadeStartSpeed: 12,
  regenFadeEndSpeed: 5,
};

/** 先頭車の走行抵抗係数 [kgf/t] */
const leadResistance = { a: 1.75, b: 0.026, c: 0.00092 };
/** 中間車の走行抵抗係数 [kgf/t] */
const middleResistance = { a: 1.75, b: 0.026, c: 0.00032 };

/**
 * 電機子チョッパ 通勤形電車 4 両編成（Tc - M - M - Tc）。
 *
 * 通流率制御・弱め界磁・回生ブレーキ・電気指令式ブレーキ（電空協調）。
 * 公称性能は起動加速度 2.81km/h/s、常用最大減速度 3.5km/h/s、非常 4.5km/h/s、
 * 最高 110km/h。
 *
 * 3 方式を乗り比べると、それぞれの違いがそのまま体感になる:
 *
 *  - 抵抗制御車と**同じ電動機**なのに、段が無いので引張力が滑らかに出る
 *  - 抵抗器で熱にしないので、同じ加速でも架線から取る電力が小さい
 *  - 発電ブレーキと違って回生なので、**架線の受け入れ率で効きが変わる**
 *    （降雪シナリオでは VVVF 車と同じように失効する）
 *
 * 数値は日本の在来線通勤形電車の代表値であり、実在形式の諸元ではない。
 */
export const commuter4ChopperVehicle: VehicleDefinition = {
  id: 'commuter-4-chopper',
  name: '通勤形 4 両編成 電機子チョッパ (2M2T)',
  maxSpeed: 110,

  cars: [
    {
      id: 'Tc1',
      type: 'Tc',
      tareMass: 26,
      fullLoadMass: 9,
      drivenAxleCount: 0,
      rotatingMassFactor: 0.06,
      resistance: leadResistance,
      traction: null,
    },
    {
      id: 'M1',
      type: 'M',
      tareMass: 36,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.11,
      resistance: middleResistance,
      traction: motorSpec,
    },
    {
      id: 'M2',
      type: 'M',
      tareMass: 36,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.11,
      resistance: middleResistance,
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
      traction: null,
    },
  ],

  coupler: {
    slack: 0.012,
    stiffness1: 1.9e6,
    travel1: 0.02,
    stiffness2: 1.9e7,
    damping: 1.9e5,
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
    // 段が無いので、ノッチはそのまま限流値の割合になる。
    notchCount: 4,
    notchTorqueRatio: [0.4, 0.6, 0.8, 1.0],
    torqueRiseRate: 2.5,
    torqueFallRate: 4.0,
    loadCompensation: true,
    referenceLoadFactor: 0.5,
    targetAcceleration: 0,
  },

  brake: {
    notchCount: 7,
    maxServiceDeceleration: 3.5,
    emergencyDeceleration: 4.5,
    blending: true,
    loadCompensation: true,
    antiSkid: true,
    antiSkidOnEmergency: false,
    emergencyIsAirOnly: true,
    hasHoldingBrake: true,
  },

  curveResistanceCoefficient: 600,
  tunnelResistanceFactor: 1.6,
};
