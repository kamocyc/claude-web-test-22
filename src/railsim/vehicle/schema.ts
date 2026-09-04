/**
 * 車両データの型と既定値。
 *
 * 移植元 (`packages/data/src/schema/vehicle.ts`) は zod で書かれていて、
 * 型・既定値・実行時検証の 3 つを 1 つの宣言から作っていた。こちらへは
 * **zod を持ち込まない**ので、同じものを素の TypeScript で書き直してある:
 *
 * - 型 → `interface`
 * - 既定値 → `DEFAULT_*` の定数と `applyVehicleDefaults`
 * - 実行時検証 → **落とした**。車両データはこのリポジトリの中に書かれた
 *   定数だけで、外から来る JSON を読む口が無い。値の範囲を守る仕事は
 *   型検査と、諸元が成立しないときに投げる `compileVehicle` が担う。
 *
 * 単位は移植元のまま「現場の単位」で書く (質量 t・速度 km/h・減速度 km/h/s・
 * 圧力 kPa・走行抵抗 kgf/t・インダクタンス mH)。SI への換算は
 * `compileVehicle` が一手に引き受ける。
 */

import {
  DEFAULT_DOOR,
  DEFAULT_INVERTER,
  DEFAULT_PASSENGER,
  DEFAULT_SUSPENSION,
  type DoorSpec,
  type InverterSpec,
  type PassengerSpec,
  type SuspensionSpec,
} from '../core/vehicle/spec.ts';

/** 書く側が省いてよい項目を落とした入力型。`R` に挙げた鍵だけは必須のまま。 */
type Input<T, R extends keyof T = never> = Partial<Omit<T, R>> & Pick<T, R>;

/** 走行抵抗 (ダビスの式) の係数 [kgf/t]。SI ではないことに注意。 */
export interface DavisData {
  /** 速度に依らない項 [kgf/t] */
  readonly a: number;
  /** 速度比例項 [kgf/t / (km/h)] */
  readonly b: number;
  /** 速度 2 乗項 [kgf/t / (km/h)^2] */
  readonly c: number;
}

export const DEFAULT_DAVIS: DavisData = { a: 1.65, b: 0.0247, c: 0.00028 };

/** VVVF の諸元。速度は km/h。 */
export interface VvvfData {
  readonly kind: 'vvvf';
  /** 1 両あたりの主電動機数 */
  readonly motorCount: number;
  /** 歯車比 */
  readonly gearRatio: number;
  /** 駆動効率 */
  readonly driveEfficiency: number;
  /** 電動機 1 台あたりの最大トルク [N*m] */
  readonly maxMotorTorque: number;
  /** 定トルク域の上限速度 [km/h] */
  readonly constantTorqueSpeed: number;
  /** 定出力域の上限速度 [km/h] */
  readonly constantPowerSpeed: number;
  /** 電気ブレーキ時の電動機 1 台あたり最大トルク [N*m] */
  readonly maxBrakingMotorTorque: number;
  /** 回生の絞り込みが始まる速度 [km/h] */
  readonly regenFadeStartSpeed: number;
  /** 回生が完全に失効する速度 [km/h] */
  readonly regenFadeEndSpeed: number;
  /** 公称架線電圧 [V] */
  readonly lineVoltage: number;
  /** 主変換装置の効率 */
  readonly converterEfficiency: number;
  /** 変調方式と音に関わる諸元。走りには一切効かない。 */
  readonly inverter: InverterSpec;
}

const VVVF_DEFAULTS = {
  motorCount: 4,
  gearRatio: 7.07,
  driveEfficiency: 0.97,
  constantTorqueSpeed: 35,
  constantPowerSpeed: 70,
  regenFadeStartSpeed: 10,
  regenFadeEndSpeed: 3,
  lineVoltage: 1500,
  converterEfficiency: 0.97,
} as const;

/**
 * 直流直巻電動機の諸元。銘板に載っている量で書く。
 * 磁束定数はここから `compileDcMotor` が逆算する。
 */
export interface DcMotorData {
  /** 電機子 + 直巻界磁 + ブラシの抵抗 [Ω] (1 台あたり) */
  readonly armatureResistance: number;
  /** 磁化曲線の飽和電流 [A] */
  readonly saturationCurrent: number;
  /** 定格電圧 [V] (1 台あたりの端子電圧) */
  readonly ratedVoltage: number;
  /** 定格電流 [A] */
  readonly ratedCurrent: number;
  /** 定格回転数 [rpm] */
  readonly ratedRpm: number;
  /** 電機子回路のインダクタンス [mH] (1 台あたり) */
  readonly armatureInductance: number;
  /** 電機子スロット数 (電磁音の主役) */
  readonly armatureSlots: number;
  /** 整流子片数 */
  readonly commutatorBars: number;
  /** 通風ファンの翼数 */
  readonly fanBlades: number;
  /** 小歯車の歯数 */
  readonly pinionTeeth: number;
}

const DC_MOTOR_DEFAULTS = {
  armatureResistance: 0.1,
  armatureInductance: 20,
  armatureSlots: 31,
  commutatorBars: 93,
  fanBlades: 34,
  pinionTeeth: 15,
} as const;

export type DcMotorInput = Input<
  DcMotorData,
  'saturationCurrent' | 'ratedVoltage' | 'ratedCurrent' | 'ratedRpm'
>;

/** 抵抗制御の諸元。進段表は書かない (限流値と進段電流の比から決まる)。 */
export interface ResistorData {
  readonly kind: 'resistor';
  readonly motorCount: number;
  readonly gearRatio: number;
  readonly driveEfficiency: number;
  /** 公称架線電圧 [V] */
  readonly lineVoltage: number;
  /** 主回路の効率。抵抗制御には変換器が無いので既定は 1。 */
  readonly converterEfficiency: number;
  readonly motor: DcMotorData;
  /** 限流値 [A] (1 台あたり) */
  readonly currentLimit: number;
  /** 進段電流 [A]。限流値より小さいこと。 */
  readonly stepCurrent: number;
  /** 1 段あたりの最短滞留時間 [s] */
  readonly stepDwell: number;
  /** 直並列の組替え (渡り) に要する時間 [s] */
  readonly transitionTime: number;
  /** 1 分岐に直列に入る電動機数を、進む順に。 */
  readonly groupings: readonly number[];
  /** 弱め界磁の段 (降順) */
  readonly fieldSteps: readonly number[];
  /** 各力行ノッチで到達を許す最終段 (省略時は全段をノッチ数で等分) */
  readonly notchFinalStep?: readonly number[];
  readonly hasDynamicBrake: boolean;
  /** 発電ブレーキの制動抵抗 [Ω] (1 分岐) */
  readonly brakeResistance: number;
  /** 発電ブレーキの限流値 [A] (省略時は力行の限流値) */
  readonly brakeCurrentLimit?: number;
  /** 発電ブレーキ時に 1 分岐へ直列に入る電動機数 */
  readonly brakeMotorsInSeries: number;
  readonly brakeFieldRatio: number;
}

const RESISTOR_DEFAULTS = {
  motorCount: 4,
  gearRatio: 5.6,
  driveEfficiency: 0.95,
  lineVoltage: 1500,
  converterEfficiency: 1,
  stepDwell: 0.25,
  transitionTime: 0.5,
  groupings: [4, 2] as readonly number[],
  fieldSteps: [0.75, 0.6, 0.5, 0.4] as readonly number[],
  hasDynamicBrake: true,
  brakeResistance: 1.6,
  brakeMotorsInSeries: 2,
  brakeFieldRatio: 1,
} as const;

/** 電機子チョッパ制御の諸元 */
export interface ChopperData {
  readonly kind: 'chopper';
  readonly motorCount: number;
  readonly gearRatio: number;
  readonly driveEfficiency: number;
  readonly lineVoltage: number;
  readonly converterEfficiency: number;
  readonly motor: DcMotorData;
  /** 1 分岐に直列に入る主電動機の数 */
  readonly motorsInSeries: number;
  /** チョッピング周波数 [Hz] */
  readonly chopFrequency: number;
  /** 通流率の上限 */
  readonly maxDuty: number;
  /** 通流率の変化速度 [1/s] */
  readonly dutyRate: number;
  /** 弱め界磁の下限界磁率 */
  readonly minFieldRatio: number;
  /** 界磁率の変化速度 [1/s] */
  readonly fieldRate: number;
  /** 力行の限流値 [A] */
  readonly currentLimit: number;
  /** 回生の限流値 [A] */
  readonly brakeCurrentLimit: number;
  /** 回生の絞り込みが始まる速度 [km/h] */
  readonly regenFadeStartSpeed: number;
  /** 回生が完全に失効する速度 [km/h] */
  readonly regenFadeEndSpeed: number;
}

const CHOPPER_DEFAULTS = {
  motorCount: 4,
  gearRatio: 5.6,
  driveEfficiency: 0.95,
  lineVoltage: 1500,
  converterEfficiency: 0.96,
  motorsInSeries: 2,
  chopFrequency: 400,
  maxDuty: 0.97,
  dutyRate: 3.0,
  minFieldRatio: 0.4,
  fieldRate: 0.6,
  regenFadeStartSpeed: 12,
  regenFadeEndSpeed: 5,
} as const;

/**
 * 制御方式 (`kind` による判別可能ユニオン)。
 *
 * `kind` は省略できない。既定値を埋めてから振り分けることもできるが、そうすると
 * 入力の型が潰れて、車両データを書いた時点での型検査が効かなくなる。
 */
export type TractionData = VvvfData | ResistorData | ChopperData;

export type TractionInput =
  | (Input<Omit<VvvfData, 'inverter'>, 'kind' | 'maxMotorTorque' | 'maxBrakingMotorTorque'> & {
      /** 変調の諸元。書かなかった項目は `DEFAULT_INVERTER` で埋まる。 */
      readonly inverter?: Partial<InverterSpec>;
    })
  | (Input<Omit<ResistorData, 'motor'>, 'kind' | 'currentLimit' | 'stepCurrent'> & {
      readonly motor: DcMotorInput;
    })
  | (Input<Omit<ChopperData, 'motor'>, 'kind' | 'currentLimit' | 'brakeCurrentLimit'> & {
      readonly motor: DcMotorInput;
    });

/** 基礎ブレーキ装置。圧力は kPa、速度は km/h。 */
export interface VehicleBrakeData {
  readonly kind: 'tread' | 'disc';
  /** BC 圧 1 Pa あたりに車輪周で発生する制動力 [N/Pa] 相当の係数 */
  readonly forcePerPressure: number;
  /** 最大 BC 圧 [kPa] */
  readonly maxCylinderPressure: number;
  /** むだ時間 [s] */
  readonly deadTime: number;
  /** BC 圧の込め時定数 [s] */
  readonly fillTimeConstant: number;
  /** BC 圧の緩め時定数 [s] */
  readonly releaseTimeConstant: number;
  /** 摩擦材の μ の速度依存。[速度 km/h, 基準 μ に対する比] の折れ線。 */
  readonly frictionSpeedCurve: ReadonlyArray<readonly [number, number]>;
  /** ブレーキが作用する軸の割合 */
  readonly brakedAxleRatio: number;
}

export const DEFAULT_VEHICLE_BRAKE: VehicleBrakeData = {
  kind: 'disc',
  forcePerPressure: 0.15,
  maxCylinderPressure: 400,
  deadTime: 0.3,
  fillTimeConstant: 0.6,
  releaseTimeConstant: 0.5,
  frictionSpeedCurve: [
    [0, 1.05],
    [30, 1.0],
    [80, 0.95],
    [120, 0.9],
  ],
  brakedAxleRatio: 1,
};

/** 車 1 両。質量は t。 */
export interface CarData {
  readonly id: string;
  /** 車種 (表示用)。Mc/Tc は先頭車。 */
  readonly type: 'M' | 'T' | 'Mc' | 'Tc';
  /** 自重 [t] */
  readonly tareMass: number;
  /** 乗車率 100% における積載質量 [t] */
  readonly fullLoadMass: number;
  /** 連結面間距離 [m] */
  readonly length: number;
  /** 台車中心間距離 [m] */
  readonly bogieSpacing: number;
  /** 固定軸距 [m] */
  readonly bogieWheelbase: number;
  readonly axleCount: number;
  readonly drivenAxleCount: number;
  /** 車輪径 [m] */
  readonly wheelDiameter: number;
  /** 回転部慣性の等価質量係数 γ */
  readonly rotatingMassFactor: number;
  /** 走行抵抗 [kgf/t] */
  readonly resistance: DavisData;
  /** 重心高さ [m] */
  readonly centerOfGravityHeight: number;
  /** 牽引装置高さ [m] */
  readonly tractionLinkHeight: number;
  readonly brake: VehicleBrakeData;
  readonly traction: TractionData | null;
  readonly suspension: SuspensionSpec;
  readonly passenger: PassengerSpec;
}

const CAR_DEFAULTS = {
  type: 'T',
  fullLoadMass: 9,
  length: 20,
  bogieSpacing: 13.8,
  bogieWheelbase: 2.1,
  axleCount: 4,
  drivenAxleCount: 0,
  wheelDiameter: 0.86,
  rotatingMassFactor: 0.05,
  centerOfGravityHeight: 1.8,
  tractionLinkHeight: 0.6,
} as const;

export type CarInput = Input<Omit<CarData, 'resistance' | 'brake' | 'traction'>, 'id' | 'tareMass'> & {
  readonly resistance?: Partial<DavisData>;
  readonly brake?: Partial<VehicleBrakeData>;
  readonly traction?: TractionInput | null;
};

export interface CouplerData {
  /** 遊間の全幅 [m] */
  readonly slack: number;
  /** 1 段目のばね定数 [N/m] */
  readonly stiffness1: number;
  /** 1 段目が受け持つ変位 [m] */
  readonly travel1: number;
  /** 2 段目のばね定数 [N/m] */
  readonly stiffness2: number;
  /** 緩衝器の減衰係数 [N/(m/s)] */
  readonly damping: number;
  /** 伝達力の上限 [kN] */
  readonly maxForce?: number;
}

export const DEFAULT_COUPLER: CouplerData = {
  slack: 0.01,
  stiffness1: 2.0e6,
  travel1: 0.02,
  stiffness2: 2.0e7,
  damping: 2.0e5,
};

/** 粘着。すべり角は mrad、速度は km/h。 */
export interface AdhesionData {
  /** 停止時のピーク粘着係数 (乾燥レール) */
  readonly mu0: number;
  /** 速度依存係数 [1/(km/h)] */
  readonly speedCoefficient: number;
  /** ピーク粘着を与えるすべり率 */
  readonly peakCreep: number;
  /** 横クリープ力が飽和するすべり角 [mrad] */
  readonly lateralCreepSaturation: number;
  /** 滑走摩擦係数比 */
  readonly kineticRatio: number;
  /** 砂撒き時の倍率 */
  readonly sandingFactor: number;
  /** すべり率の基準速度 [km/h] */
  readonly creepReferenceSpeed: number;
}

export const DEFAULT_ADHESION: AdhesionData = {
  mu0: 0.33,
  speedCoefficient: 0.008,
  peakCreep: 0.012,
  lateralCreepSaturation: 3.0,
  kineticRatio: 0.6,
  sandingFactor: 1.25,
  creepReferenceSpeed: 1.8,
};

/** 力行の制御。目標加速度は km/h/s。 */
export interface TractionControlData {
  readonly notchCount: number;
  readonly notchTorqueRatio: readonly number[];
  /** トルク指令の立ち上がり速度 [1/s] */
  readonly torqueRiseRate: number;
  /** トルク指令の立ち下がり速度 [1/s] */
  readonly torqueFallRate: number;
  readonly loadCompensation: boolean;
  readonly referenceLoadFactor: number;
  /** 定加速度制御の目標加速度 [km/h/s] (0 で無効) */
  readonly targetAcceleration: number;
}

export const DEFAULT_TRACTION_CONTROL: TractionControlData = {
  notchCount: 4,
  notchTorqueRatio: [0.25, 0.5, 0.75, 1.0],
  torqueRiseRate: 2.5,
  torqueFallRate: 4.0,
  loadCompensation: true,
  referenceLoadFactor: 0.5,
  targetAcceleration: 0,
};

/** ブレーキの制御。減速度は km/h/s。 */
export interface BrakeControlData {
  readonly notchCount: number;
  /** 常用最大の減速度 [km/h/s] */
  readonly maxServiceDeceleration: number;
  /** 非常ブレーキの減速度 [km/h/s] */
  readonly emergencyDeceleration: number;
  /** ノッチごとの減速度 [km/h/s] (省略時は等分) */
  readonly notchDeceleration?: readonly number[];
  readonly blending: boolean;
  readonly loadCompensation: boolean;
  readonly antiSkid: boolean;
  readonly antiSkidOnEmergency: boolean;
  /** 非常ブレーキで電気ブレーキを併用しない */
  readonly emergencyIsAirOnly: boolean;
  readonly hasHoldingBrake: boolean;
}

export const DEFAULT_BRAKE_CONTROL: BrakeControlData = {
  notchCount: 8,
  maxServiceDeceleration: 3.5,
  emergencyDeceleration: 4.5,
  blending: true,
  loadCompensation: true,
  antiSkid: true,
  antiSkidOnEmergency: true,
  emergencyIsAirOnly: true,
  hasHoldingBrake: true,
};

/** 既定値がすべて埋まった車両定義。`compileVehicle` が読むのはこちら。 */
export interface ParsedVehicle {
  readonly id: string;
  readonly name: string;
  /** 設計最高速度 [km/h] */
  readonly maxSpeed: number;
  readonly cars: readonly CarData[];
  readonly coupler: CouplerData;
  readonly adhesion: AdhesionData;
  readonly traction: TractionControlData;
  readonly brake: BrakeControlData;
  readonly door: DoorSpec;
  /** 曲線抵抗係数 f [kgf/t·m] (比抵抗 = f / R)。狭軌 600、標準軌 800 が目安。 */
  readonly curveResistanceCoefficient: number;
  /** トンネル内で走行抵抗の速度 2 乗項に掛かる倍率 */
  readonly tunnelResistanceFactor: number;
}

/** 車両データを書くときの型。既定値のある項目は省ける。 */
export interface VehicleDefinition {
  readonly id: string;
  readonly name: string;
  readonly maxSpeed: number;
  readonly cars: readonly CarInput[];
  readonly coupler?: Partial<CouplerData>;
  readonly adhesion?: Partial<AdhesionData>;
  readonly traction?: Partial<TractionControlData>;
  readonly brake?: Partial<BrakeControlData>;
  readonly door?: Partial<DoorSpec>;
  readonly curveResistanceCoefficient?: number;
  readonly tunnelResistanceFactor?: number;
}

/** `undefined` の項目だけ既定値で埋める。zod の `.default()` にあたる。 */
function fill<T extends object>(defaults: T, given: Partial<T> | undefined): T {
  if (!given) return defaults;
  const out = { ...defaults };
  for (const key of Object.keys(given) as (keyof T)[]) {
    const value = given[key];
    if (value !== undefined) out[key] = value as T[keyof T];
  }
  return out;
}

function fillMotor(given: DcMotorInput): DcMotorData {
  return { ...DC_MOTOR_DEFAULTS, ...stripUndefined(given) } as DcMotorData;
}

/** `{ a: undefined }` が既定値を上書きしてしまわないように落とす。 */
function stripUndefined<T extends object>(given: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(given) as (keyof T)[]) {
    if (given[key] !== undefined) out[key] = given[key];
  }
  return out;
}

function fillTraction(given: TractionInput | null | undefined): TractionData | null {
  if (!given) return null;
  switch (given.kind) {
    case 'vvvf':
      return {
        ...VVVF_DEFAULTS,
        ...stripUndefined(given),
        kind: 'vvvf',
        inverter: fill(DEFAULT_INVERTER, given.inverter),
      } as VvvfData;
    case 'resistor':
      return {
        ...RESISTOR_DEFAULTS,
        ...stripUndefined(given),
        kind: 'resistor',
        motor: fillMotor(given.motor),
      } as ResistorData;
    case 'chopper':
      return {
        ...CHOPPER_DEFAULTS,
        ...stripUndefined(given),
        kind: 'chopper',
        motor: fillMotor(given.motor),
      } as ChopperData;
  }
}

function fillCar(given: CarInput): CarData {
  return {
    ...CAR_DEFAULTS,
    ...stripUndefined(given),
    resistance: fill(DEFAULT_DAVIS, given.resistance),
    brake: fill(DEFAULT_VEHICLE_BRAKE, given.brake),
    traction: fillTraction(given.traction),
    suspension: fill(DEFAULT_SUSPENSION, given.suspension),
    passenger: fill(DEFAULT_PASSENGER, given.passenger),
  } as CarData;
}

/**
 * 省略された項目に既定値を埋める。移植元の `vehicleSchema.parse` にあたる。
 *
 * 検証はしない (このファイルの冒頭を参照)。諸元として成立しない組み合わせ
 * — 電機子抵抗の降下が定格電圧を超える、進段電流が限流値以上 — は
 * `compileVehicle` が投げる。
 */
export function applyVehicleDefaults(definition: VehicleDefinition): ParsedVehicle {
  if (definition.cars.length < 1) {
    throw new Error(`車両定義に車両が 1 両もありません: ${definition.id}`);
  }
  return {
    id: definition.id,
    name: definition.name,
    maxSpeed: definition.maxSpeed,
    cars: definition.cars.map(fillCar),
    coupler: fill(DEFAULT_COUPLER, definition.coupler),
    adhesion: fill(DEFAULT_ADHESION, definition.adhesion),
    traction: fill(DEFAULT_TRACTION_CONTROL, definition.traction),
    brake: fill(DEFAULT_BRAKE_CONTROL, definition.brake),
    door: fill(DEFAULT_DOOR, definition.door),
    curveResistanceCoefficient: definition.curveResistanceCoefficient ?? 600,
    tunnelResistanceFactor: definition.tunnelResistanceFactor ?? 1.6,
  };
}
