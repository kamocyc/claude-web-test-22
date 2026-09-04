import {
  buildAlignment,
  kmhToMps,
  type AdhesionSpec,
  type Alignment,
  type BrakeControlSpec,
  DEFAULT_PASSENGER,
  DEFAULT_SUSPENSION,
  type ConsistSpec,
  type CouplerSpec,
  type DavisCoefficients,
  DEFAULT_DOOR,
  DEFAULT_INVERTER,
  type ChopperTractionSpec,
  type DcSeriesMotorSpec,
  type ResistorTractionSpec,
  type TractionControlSpec,
  type VehicleBrakeSpec,
  type VehicleSpec,
  type VehicleTractionSpec,
  type VvvfTractionSpec,
} from '../../src/railsim/core/index.ts';

/** 抵抗ゼロの係数（解析解との突き合わせ用） */
export const NO_RESISTANCE: DavisCoefficients = { a: 0, b: 0, c: 0 };

export const TEST_TRACTION: VvvfTractionSpec = {
  kind: 'vvvf',
  motorCount: 4,
  gearRatio: 7.07,
  driveEfficiency: 0.97,
  maxMotorTorque: 1200,
  constantTorqueSpeed: kmhToMps(35),
  constantPowerSpeed: kmhToMps(70),
  maxBrakingMotorTorque: 1200,
  regenFadeStartSpeed: kmhToMps(10),
  regenFadeEndSpeed: kmhToMps(3),
  lineVoltage: 1500,
  converterEfficiency: 0.97,
  inverter: DEFAULT_INVERTER,
};

/**
 * 試験用の直流直巻電動機（375V・350A・1630rpm 級）。
 * 磁束定数は銘板から逆算した値そのもの:
 *   kΦ(350A) = (375 − 350·0.10) / (1630·2π/60) = 1.9918
 *   kΦ_max   = 1.9918 · (350 + 190) / 350      = 3.0731
 */
export const TEST_DC_MOTOR: DcSeriesMotorSpec = {
  armatureResistance: 0.1,
  saturationCurrent: 190,
  fluxConstant: 3.0731,
  ratedCurrent: 350,
  armatureInductance: 0.022,
  armatureSlots: 31,
  commutatorBars: 93,
  fanBlades: 34,
  pinionTeeth: 15,
};

/**
 * 試験用の抵抗制御。
 *
 * 進段表はコンパイラ（`packages/data/src/compile/vehicle.ts`）が作るものと同じ
 * 幾何級数で、限流値 480A・進段電流 380A（公比 0.7917）から決まる
 * 8 台直列 7 段 → 4 台直列 8 段 → 弱め界磁 2 段。手で丸めた値を置くと段の境目で
 * 電流が跳ねてしまい、鋸歯の検定にならない。
 */
export const TEST_RESISTOR_TRACTION: ResistorTractionSpec = {
  kind: 'resistor',
  motorCount: 4,
  gearRatio: 5.6,
  driveEfficiency: 0.95,
  lineVoltage: 1500,
  converterEfficiency: 1,
  motor: TEST_DC_MOTOR,
  camSteps: [
    { motorsInSeries: 8, resistance: 2.325, fieldRatio: 1 },
    { motorsInSeries: 8, resistance: 1.674, fieldRatio: 1 },
    { motorsInSeries: 8, resistance: 1.159, fieldRatio: 1 },
    { motorsInSeries: 8, resistance: 0.751, fieldRatio: 1 },
    { motorsInSeries: 8, resistance: 0.427, fieldRatio: 1 },
    { motorsInSeries: 8, resistance: 0.172, fieldRatio: 1 },
    { motorsInSeries: 8, resistance: 0, fieldRatio: 1 },
    { motorsInSeries: 4, resistance: 1.479, fieldRatio: 1 },
    { motorsInSeries: 4, resistance: 1.088, fieldRatio: 1 },
    { motorsInSeries: 4, resistance: 0.778, fieldRatio: 1 },
    { motorsInSeries: 4, resistance: 0.532, fieldRatio: 1 },
    { motorsInSeries: 4, resistance: 0.338, fieldRatio: 1 },
    { motorsInSeries: 4, resistance: 0.184, fieldRatio: 1 },
    { motorsInSeries: 4, resistance: 0.063, fieldRatio: 1 },
    { motorsInSeries: 4, resistance: 0, fieldRatio: 1 },
    { motorsInSeries: 4, resistance: 0, fieldRatio: 0.65 },
    { motorsInSeries: 4, resistance: 0, fieldRatio: 0.45 },
  ],
  currentLimit: 480,
  stepCurrent: 380,
  stepDwell: 0.25,
  transitionTime: 0.5,
  notchFinalStep: [6, 14, 15, 16],
  hasDynamicBrake: true,
  brakeResistance: 6.2,
  brakeCurrentLimit: 500,
  brakeMotorsInSeries: 4,
  brakeFieldRatio: 1,
};

/** 試験用の電機子チョッパ（抵抗制御と同じ電動機を段なしで回す） */
export const TEST_CHOPPER_TRACTION: ChopperTractionSpec = {
  kind: 'chopper',
  motorCount: 4,
  gearRatio: 6.07,
  driveEfficiency: 0.95,
  lineVoltage: 1500,
  converterEfficiency: 0.96,
  motor: TEST_DC_MOTOR,
  motorsInSeries: 4,
  chopFrequency: 400,
  maxDuty: 0.97,
  dutyRate: 3.0,
  minFieldRatio: 0.45,
  fieldRate: 0.6,
  currentLimit: 500,
  brakeCurrentLimit: 460,
  regenFadeStartSpeed: kmhToMps(12),
  regenFadeEndSpeed: kmhToMps(5),
};

export const TEST_VEHICLE_BRAKE: VehicleBrakeSpec = {
  kind: 'disc',
  forcePerPressure: 0.15,
  maxCylinderPressure: 400_000,
  deadTime: 0.3,
  fillTimeConstant: 0.6,
  releaseTimeConstant: 0.5,
  frictionSpeedCurve: [
    [0, 1.05],
    [kmhToMps(30), 1.0],
    [kmhToMps(80), 0.95],
    [kmhToMps(120), 0.9],
  ],
  brakedAxleRatio: 1,
};

export const TEST_ADHESION: AdhesionSpec = {
  mu0: 0.33,
  speedCoefficient: 0.008,
  peakCreep: 0.012,
  lateralCreepSaturation: 0.003,
  kineticRatio: 0.6,
  sandingFactor: 1.25,
  creepReferenceSpeed: 0.5,
};

export const TEST_COUPLER: CouplerSpec = {
  slack: 0.01,
  stiffness1: 2.0e6,
  travel1: 0.02,
  stiffness2: 2.0e7,
  damping: 2.0e5,
};

export const TEST_TRACTION_CONTROL: TractionControlSpec = {
  notchCount: 4,
  notchTorqueRatio: [0.25, 0.5, 0.75, 1.0],
  torqueRiseRate: 2.5,
  torqueFallRate: 4.0,
  loadCompensation: true,
  referenceLoadFactor: 0.5,
  targetAcceleration: 0,
};

export const TEST_BRAKE_CONTROL: BrakeControlSpec = {
  notchCount: 8,
  maxServiceDeceleration: 1.0,
  emergencyDeceleration: 1.25,
  blending: true,
  loadCompensation: true,
  antiSkid: true,
  antiSkidOnEmergency: true,
  emergencyIsAirOnly: true,
  hasHoldingBrake: true,
};

export interface TestVehicleOptions {
  readonly id?: string;
  readonly tareMass?: number;
  readonly fullLoadMass?: number;
  readonly length?: number;
  readonly drivenAxleCount?: number;
  readonly rotatingMassFactor?: number;
  readonly runningResistance?: DavisCoefficients;
  readonly traction?: VehicleTractionSpec | null;
}

export function testVehicle(options: TestVehicleOptions = {}): VehicleSpec {
  return {
    id: options.id ?? 'test-car',
    tareMass: options.tareMass ?? 32_000,
    fullLoadMass: options.fullLoadMass ?? 9_000,
    length: options.length ?? 20,
    bogieSpacing: 13.8,
    bogieWheelbase: 2.1,
    axleCount: 4,
    drivenAxleCount: options.drivenAxleCount ?? 4,
    wheelDiameter: 0.86,
    rotatingMassFactor: options.rotatingMassFactor ?? 0.09,
    runningResistance: options.runningResistance ?? NO_RESISTANCE,
    centerOfGravityHeight: 1.8,
    tractionLinkHeight: 0.6,
    brake: TEST_VEHICLE_BRAKE,
    traction: options.traction === undefined ? TEST_TRACTION : options.traction,
    suspension: DEFAULT_SUSPENSION,
    passenger: DEFAULT_PASSENGER,
  };
}

export interface TestConsistOptions extends TestVehicleOptions {
  readonly cars?: number;
  readonly coupler?: CouplerSpec;
  readonly adhesion?: Partial<AdhesionSpec>;
  readonly curveResistanceCoefficient?: number;
}

export function testConsist(options: TestConsistOptions = {}): ConsistSpec {
  const cars = options.cars ?? 1;
  const vehicles: VehicleSpec[] = [];
  for (let i = 0; i < cars; i++) {
    vehicles.push(testVehicle({ ...options, id: `${options.id ?? 'car'}-${i + 1}` }));
  }
  return {
    id: 'test-consist',
    name: 'テスト編成',
    vehicles,
    coupler: options.coupler ?? TEST_COUPLER,
    adhesion: { ...TEST_ADHESION, ...options.adhesion },
    traction: TEST_TRACTION_CONTROL,
    brake: TEST_BRAKE_CONTROL,
    door: DEFAULT_DOOR,
    maxSpeed: kmhToMps(120),
    curveResistanceCoefficient: options.curveResistanceCoefficient ?? 0,
    tunnelResistanceFactor: 1.6,
  };
}

/** 平坦・直線の試験線 */
export function flatTrack(length = 20_000): Alignment {
  return buildAlignment({
    gauge: 1.067,
    horizontal: [{ length }],
    vertical: [{ length, gradePermil: 0 }],
    sampleStep: 5,
  });
}

/** 一定勾配の試験線 */
export function gradeTrack(permil: number, length = 20_000): Alignment {
  return buildAlignment({
    gauge: 1.067,
    horizontal: [{ length }],
    vertical: [{ length, gradePermil: permil }],
    sampleStep: 5,
  });
}

/** トンネルなしの環境 */
export const NO_TUNNEL = { isTunnel: () => false };
