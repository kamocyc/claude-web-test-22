import type { VehicleDefinition } from '../schema.ts';

/** VVVF 主回路の共通仕様（M 車 2 両とも同じ） */
const motorSpec = {
  kind: 'vvvf' as const,
  motorCount: 4,
  gearRatio: 7.07,
  driveEfficiency: 0.97,
  /**
   * 電動機 1 台あたりの最大トルク [N*m]。
   * 乗車率 50% の編成（等価質量 140.3t）で起動加速度 3.3km/h/s になるよう設定している。
   *   必要引張力 = 140.3t * 0.917m/s^2 = 128.6kN
   *   1 両あたりの車輪周引張力 = T * 4 * 7.07 * 0.97 / 0.43 = T * 63.8
   *   M 車 2 両で T * 127.6 = 128.6kN → T ≒ 1010
   */
  maxMotorTorque: 1010,
  constantTorqueSpeed: 35,
  constantPowerSpeed: 70,
  /** 電気ブレーキは常用最大（3.5km/h/s）を単独で賄える容量を持たせる */
  maxBrakingMotorTorque: 1100,
  regenFadeStartSpeed: 10,
  regenFadeEndSpeed: 3,
  lineVoltage: 1500,
  converterEfficiency: 0.97,
  /**
   * 変調は GTO サイリスタ素子の既定値（`inverterSchema`）をそのまま使う。
   * 4 極・歯車比 7.07・車輪径 0.86m なので、定トルク域の上限 35km/h が
   * 電動機 1526rpm・出力周波数 53Hz にあたり、そこで変調率が飽和して一パルスへ入る。
   * それまでに非同期 → 15 → 9 → 5 → 3 パルスと段階的に落ちる。
   */
  inverter: {},
} as const;

/** 先頭車の走行抵抗係数 [kgf/t]（前面の空気抵抗が大きいぶん速度 2 乗項が大きい） */
const leadResistance = { a: 1.65, b: 0.0247, c: 0.00078 };
/** 中間車の走行抵抗係数 [kgf/t] */
const middleResistance = { a: 1.65, b: 0.0247, c: 0.00028 };

/**
 * 通勤形電車 4 両編成（Tc - M - M - Tc）。
 *
 * VVVF インバータ制御・電気指令式ブレーキ（電空協調・応荷重）・ATS-P 対応。
 * 公称性能は起動加速度 3.3km/h/s、常用最大減速度 3.5km/h/s、非常減速度 4.5km/h/s。
 *
 * 数値は日本の在来線通勤形電車の代表値であり、実在形式の諸元ではない。
 */
export const commuter4Vehicle: VehicleDefinition = {
  id: 'commuter-4',
  name: '通勤形 4 両編成 (2M2T)',
  maxSpeed: 120,

  cars: [
    {
      id: 'Tc1',
      type: 'Tc',
      tareMass: 25,
      fullLoadMass: 9,
      drivenAxleCount: 0,
      rotatingMassFactor: 0.05,
      resistance: leadResistance,
      traction: null,
    },
    {
      id: 'M1',
      type: 'M',
      tareMass: 32,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.09,
      resistance: middleResistance,
      traction: motorSpec,
    },
    {
      id: 'M2',
      type: 'M',
      tareMass: 32,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.09,
      resistance: middleResistance,
      traction: motorSpec,
    },
    {
      id: 'Tc2',
      type: 'Tc',
      tareMass: 25,
      fullLoadMass: 9,
      drivenAxleCount: 0,
      rotatingMassFactor: 0.05,
      resistance: leadResistance,
      traction: null,
    },
  ],

  coupler: {
    // 密着連結器 + ゴム緩衝器。遊間 10mm、2 段剛性。
    slack: 0.01,
    stiffness1: 2.0e6,
    travel1: 0.02,
    stiffness2: 2.0e7,
    damping: 2.0e5,
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
    notchCount: 4,
    notchTorqueRatio: [0.25, 0.5, 0.75, 1.0],
    torqueRiseRate: 2.5,
    torqueFallRate: 4.0,
    loadCompensation: true,
    referenceLoadFactor: 0.5,
    targetAcceleration: 0,
  },

  brake: {
    notchCount: 8,
    maxServiceDeceleration: 3.5,
    emergencyDeceleration: 4.5,
    blending: true,
    loadCompensation: true,
    antiSkid: true,
    antiSkidOnEmergency: true,
    emergencyIsAirOnly: true,
    hasHoldingBrake: true,
  },

  curveResistanceCoefficient: 600,
  tunnelResistanceFactor: 1.6,
};
