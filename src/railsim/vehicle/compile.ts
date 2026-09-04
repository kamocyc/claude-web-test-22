import {
  davisFromKgfPerTon,
  kgfPerTonToNPerKg,
  kmhToMps,
  kmhsToMps2,
  kpaToPa,
  mhToH,
  rpmToRadPerSec,
  tonsToKg,
  type CamStep,
  type ChopperTractionSpec,
  type ConsistSpec,
  type DcSeriesMotorSpec,
  type ResistorTractionSpec,
  type VehicleBrakeSpec,
  type VehicleSpec,
  type VehicleTractionSpec,
  type VvvfTractionSpec,
} from '../core/index.ts';
import { applyVehicleDefaults, type ParsedVehicle, type VehicleDefinition } from './schema.ts';

type ParsedCar = ParsedVehicle['cars'][number];
type ParsedTraction = NonNullable<ParsedCar['traction']>;
type ParsedMotor = Extract<ParsedTraction, { kind: 'resistor' }>['motor'];

function compileVvvf(spec: Extract<ParsedTraction, { kind: 'vvvf' }>): VvvfTractionSpec {
  return {
    kind: 'vvvf',
    motorCount: spec.motorCount,
    gearRatio: spec.gearRatio,
    driveEfficiency: spec.driveEfficiency,
    maxMotorTorque: spec.maxMotorTorque,
    constantTorqueSpeed: kmhToMps(spec.constantTorqueSpeed),
    constantPowerSpeed: kmhToMps(spec.constantPowerSpeed),
    maxBrakingMotorTorque: spec.maxBrakingMotorTorque,
    regenFadeStartSpeed: kmhToMps(spec.regenFadeStartSpeed),
    regenFadeEndSpeed: kmhToMps(spec.regenFadeEndSpeed),
    lineVoltage: spec.lineVoltage,
    converterEfficiency: spec.converterEfficiency,
    // 変調の諸元はもともと Hz と個数なので換算は要らない
    inverter: {
      polePairs: spec.inverter.polePairs,
      ratedSlipFrequency: spec.inverter.ratedSlipFrequency,
      baseFrequency: spec.inverter.baseFrequency,
      voltageBoost: spec.inverter.voltageBoost,
      asyncCarrier: spec.inverter.asyncCarrier.map(([f, c]) => [f, c] as [number, number]),
      pulseModes: spec.inverter.pulseModes,
      modeHysteresis: spec.inverter.modeHysteresis,
      rotorSlots: spec.inverter.rotorSlots,
      pinionTeeth: spec.inverter.pinionTeeth,
    },
  };
}

/**
 * 直流直巻電動機の諸元をコンパイルする。
 *
 * 銘板の 3 つ（定格電圧・定格電流・定格回転数）から磁束定数を逆算する:
 *
 * ```
 * E_定格     = V_定格 − I_定格 · R_a
 * ω_定格     = rpm · 2π / 60
 * kΦ(I_定格) = E_定格 / ω_定格
 * kΦ_max     = kΦ(I_定格) · (I_定格 + I_飽和) / I_定格      φ(I)=I/(I+I_飽和) の逆算
 * ```
 *
 * こうしておくと `T_定格 = kΦ(I_定格)·I_定格 = E_定格·I_定格 / ω_定格` が
 * 自動的に成り立つ。定格出力を別に書いて食い違う、ということが起こらない。
 */
function compileDcMotor(spec: ParsedMotor): DcSeriesMotorSpec {
  const ratedOmega = rpmToRadPerSec(spec.ratedRpm);
  const ratedEmf = spec.ratedVoltage - spec.ratedCurrent * spec.armatureResistance;
  if (ratedEmf <= 0) {
    throw new Error(
      `直流電動機の定格点が成立しません（電機子抵抗の降下が定格電圧を超えています）: ` +
        `${spec.ratedVoltage}V / ${spec.ratedCurrent}A / ${spec.armatureResistance}Ω`,
    );
  }
  const fluxAtRated = ratedEmf / ratedOmega;
  const fluxConstant =
    (fluxAtRated * (spec.ratedCurrent + spec.saturationCurrent)) / spec.ratedCurrent;

  return {
    armatureResistance: spec.armatureResistance,
    saturationCurrent: spec.saturationCurrent,
    fluxConstant,
    ratedCurrent: spec.ratedCurrent,
    armatureInductance: mhToH(spec.armatureInductance),
    armatureSlots: spec.armatureSlots,
    commutatorBars: spec.commutatorBars,
    fanBlades: spec.fanBlades,
    pinionTeeth: spec.pinionTeeth,
  };
}

/**
 * 進段表を組み立てる。
 *
 * 各つなぎ（直列・直並列・並列）ごとに、起動時（逆起電力 0）で限流値を流す抵抗
 *
 * ```
 * R_合計,0 = V_線 / I_限流,    R_外部,0 = R_合計,0 − m·R_a
 * ```
 *
 * から始める。段が切り替わる瞬間は回転数が変わらない＝逆起電力が同じなので、
 * 「進段電流のときの電圧降下」と「限流値のときの電圧降下」が等しいことから
 *
 * ```
 * R_合計,j · I_進段 = R_合計,j+1 · I_限流
 *   →  R_合計,j+1 = R_合計,j · (I_進段 / I_限流)
 * ```
 *
 * という公比一定の幾何級数になる。外部抵抗が 0 以下になったところがそのつなぎの
 * 最終段（全短絡）で、そこで次のつなぎへ渡る。最後のつなぎの全短絡のあとに
 * 弱め界磁の段を積む。
 *
 * つまり段数は設計者が決める数ではなく、**限流値と進段電流の比から決まってしまう**。
 * 実車の段数（直列 10 段前後・並列 10 段前後）がどれも似ているのはこのためである。
 */
function buildCamSteps(
  spec: Extract<ParsedTraction, { kind: 'resistor' }>,
  armatureResistance: number,
): CamStep[] {
  const ratio = spec.stepCurrent / spec.currentLimit;
  if (!(ratio > 0 && ratio < 1)) {
    throw new Error(
      `進段電流は限流値より小さい正の値である必要があります: ` +
        `${spec.stepCurrent}A / ${spec.currentLimit}A`,
    );
  }

  const steps: CamStep[] = [];
  let motorsInSeries = spec.groupings[0] ?? 1;
  // 起動時は逆起電力が無い。組替えのたびに、その直前の逆起電力から始める。
  let emf = 0;
  for (const grouping of spec.groupings) {
    motorsInSeries = grouping;
    const internal = grouping * armatureResistance;
    // このつなぎの初段は「いまの逆起電力で限流値がちょうど流れる」抵抗から始める。
    // 組替えの瞬間は回転数が変わらないので、電圧の余りが電動機の数だけ増える。
    let total = (spec.lineVoltage - grouping * emf) / spec.currentLimit;
    for (;;) {
      const external = total - internal;
      if (external <= 0) break;
      steps.push({ motorsInSeries: grouping, resistance: external, fieldRatio: 1 });
      total *= ratio;
    }
    // 全短絡の段は必ず 1 つ入れる（外部抵抗が最初から要らない場合もここへ落ちる）
    steps.push({ motorsInSeries: grouping, resistance: 0, fieldRatio: 1 });
    // このつなぎを走り切った時点（全短絡・進段電流）の逆起電力
    emf = (spec.lineVoltage - spec.stepCurrent * internal) / grouping;
  }

  // 最終つなぎの全界磁・全短絡のあとに弱め界磁を積む
  for (const fieldRatio of spec.fieldSteps) {
    steps.push({ motorsInSeries, resistance: 0, fieldRatio });
  }
  return steps;
}

/**
 * 各ノッチで到達を許す最終段。
 * 省略時は全段をノッチ数で等分する（最終ノッチが最弱め界磁になる）。
 */
function resolveNotchFinalStep(
  spec: Extract<ParsedTraction, { kind: 'resistor' }>,
  stepCount: number,
  notchCount: number,
): number[] {
  const last = stepCount - 1;
  if (spec.notchFinalStep) {
    return spec.notchFinalStep.map((s) => Math.min(Math.max(0, Math.round(s)), last));
  }
  return Array.from({ length: notchCount }, (_, i) => Math.round(((i + 1) / notchCount) * last));
}

function compileResistor(
  spec: Extract<ParsedTraction, { kind: 'resistor' }>,
  notchCount: number,
): ResistorTractionSpec {
  const motor = compileDcMotor(spec.motor);
  const camSteps = buildCamSteps(spec, motor.armatureResistance);
  return {
    kind: 'resistor',
    motorCount: spec.motorCount,
    gearRatio: spec.gearRatio,
    driveEfficiency: spec.driveEfficiency,
    lineVoltage: spec.lineVoltage,
    converterEfficiency: spec.converterEfficiency,
    motor,
    camSteps,
    currentLimit: spec.currentLimit,
    stepCurrent: spec.stepCurrent,
    stepDwell: spec.stepDwell,
    transitionTime: spec.transitionTime,
    notchFinalStep: resolveNotchFinalStep(spec, camSteps.length, notchCount),
    hasDynamicBrake: spec.hasDynamicBrake,
    brakeResistance: spec.brakeResistance,
    brakeCurrentLimit: spec.brakeCurrentLimit ?? spec.currentLimit,
    brakeMotorsInSeries: spec.brakeMotorsInSeries,
    brakeFieldRatio: spec.brakeFieldRatio,
  };
}

function compileChopper(spec: Extract<ParsedTraction, { kind: 'chopper' }>): ChopperTractionSpec {
  return {
    kind: 'chopper',
    motorCount: spec.motorCount,
    gearRatio: spec.gearRatio,
    driveEfficiency: spec.driveEfficiency,
    lineVoltage: spec.lineVoltage,
    converterEfficiency: spec.converterEfficiency,
    motor: compileDcMotor(spec.motor),
    motorsInSeries: spec.motorsInSeries,
    chopFrequency: spec.chopFrequency,
    maxDuty: spec.maxDuty,
    dutyRate: spec.dutyRate,
    minFieldRatio: spec.minFieldRatio,
    fieldRate: spec.fieldRate,
    currentLimit: spec.currentLimit,
    brakeCurrentLimit: spec.brakeCurrentLimit,
    regenFadeStartSpeed: kmhToMps(spec.regenFadeStartSpeed),
    regenFadeEndSpeed: kmhToMps(spec.regenFadeEndSpeed),
  };
}

function compileTraction(
  spec: ParsedCar['traction'],
  notchCount: number,
): VehicleTractionSpec | null {
  if (!spec) return null;
  switch (spec.kind) {
    case 'vvvf':
      return compileVvvf(spec);
    case 'resistor':
      return compileResistor(spec, notchCount);
    case 'chopper':
      return compileChopper(spec);
  }
}

function compileBrake(spec: ParsedCar['brake']): VehicleBrakeSpec {
  return {
    kind: spec.kind,
    forcePerPressure: spec.forcePerPressure,
    maxCylinderPressure: kpaToPa(spec.maxCylinderPressure),
    deadTime: spec.deadTime,
    fillTimeConstant: spec.fillTimeConstant,
    releaseTimeConstant: spec.releaseTimeConstant,
    frictionSpeedCurve: spec.frictionSpeedCurve.map(
      ([v, f]) => [kmhToMps(v), f] as [number, number],
    ),
    brakedAxleRatio: spec.brakedAxleRatio,
  };
}

/**
 * 車両定義をコンパイルして編成仕様にする。
 * 現場の単位（t・km/h・km/h/s・kPa・kgf/t・mH）をすべて SI へ変換する。
 */
export function compileVehicle(definition: VehicleDefinition): ConsistSpec {
  // 移植時の差分: zod の `.parse` は既定値を埋める `applyVehicleDefaults` に置き換えた。
  const def = applyVehicleDefaults(definition);

  const vehicles: VehicleSpec[] = def.cars.map((car) => ({
    id: car.id,
    tareMass: tonsToKg(car.tareMass),
    fullLoadMass: tonsToKg(car.fullLoadMass),
    length: car.length,
    bogieSpacing: car.bogieSpacing,
    bogieWheelbase: car.bogieWheelbase,
    axleCount: car.axleCount,
    drivenAxleCount: car.drivenAxleCount,
    wheelDiameter: car.wheelDiameter,
    rotatingMassFactor: car.rotatingMassFactor,
    runningResistance: davisFromKgfPerTon(car.resistance),
    centerOfGravityHeight: car.centerOfGravityHeight,
    tractionLinkHeight: car.tractionLinkHeight,
    brake: compileBrake(car.brake),
    traction: compileTraction(car.traction, def.traction.notchCount),
    suspension: car.suspension,
    passenger: car.passenger,
  }));

  // 主回路は編成で 1 本に引き通されるので、制御方式の混在は組成の誤りである
  const kinds = new Set(vehicles.map((v) => v.traction?.kind).filter((k) => k !== undefined));
  if (kinds.size > 1) {
    throw new Error(`編成内で制御方式が混在しています: ${[...kinds].join(', ')}`);
  }

  const notchDeceleration = def.brake.notchDeceleration?.map(kmhsToMps2);

  return {
    id: def.id,
    name: def.name,
    vehicles,
    coupler: {
      slack: def.coupler.slack,
      stiffness1: def.coupler.stiffness1,
      travel1: def.coupler.travel1,
      stiffness2: def.coupler.stiffness2,
      damping: def.coupler.damping,
      ...(def.coupler.maxForce === undefined ? {} : { maxForce: def.coupler.maxForce * 1000 }),
    },
    adhesion: {
      mu0: def.adhesion.mu0,
      speedCoefficient: def.adhesion.speedCoefficient,
      peakCreep: def.adhesion.peakCreep,
      // データは現場の単位（mrad）で書き、ここで rad へ直す
      lateralCreepSaturation: def.adhesion.lateralCreepSaturation / 1000,
      kineticRatio: def.adhesion.kineticRatio,
      sandingFactor: def.adhesion.sandingFactor,
      creepReferenceSpeed: kmhToMps(def.adhesion.creepReferenceSpeed),
    },
    traction: {
      notchCount: def.traction.notchCount,
      notchTorqueRatio: def.traction.notchTorqueRatio,
      torqueRiseRate: def.traction.torqueRiseRate,
      torqueFallRate: def.traction.torqueFallRate,
      loadCompensation: def.traction.loadCompensation,
      referenceLoadFactor: def.traction.referenceLoadFactor,
      targetAcceleration: kmhsToMps2(def.traction.targetAcceleration),
    },
    brake: {
      notchCount: def.brake.notchCount,
      maxServiceDeceleration: kmhsToMps2(def.brake.maxServiceDeceleration),
      emergencyDeceleration: kmhsToMps2(def.brake.emergencyDeceleration),
      ...(notchDeceleration === undefined ? {} : { notchDeceleration }),
      blending: def.brake.blending,
      loadCompensation: def.brake.loadCompensation,
      antiSkid: def.brake.antiSkid,
      antiSkidOnEmergency: def.brake.antiSkidOnEmergency,
      emergencyIsAirOnly: def.brake.emergencyIsAirOnly,
      hasHoldingBrake: def.brake.hasHoldingBrake,
    },
    door: {
      openTime: def.door.openTime,
      closeTime: def.door.closeTime,
      closeWarningTime: def.door.closeWarningTime,
      chimeOnOpen: def.door.chimeOnOpen,
      chimeOnClose: def.door.chimeOnClose,
      chimeDuration: def.door.chimeDuration,
    },
    maxSpeed: kmhToMps(def.maxSpeed),
    curveResistanceCoefficient: kgfPerTonToNPerKg(def.curveResistanceCoefficient),
    tunnelResistanceFactor: def.tunnelResistanceFactor,
  };
}
