import { clamp, rateLimit } from '../math/scalar.ts';
import type { Amperes, MetersPerSecond, Newtons } from '../units.ts';
import { radPerSecToRpm } from '../units.ts';
import type { TrainDynamics } from '../train/dynamics.ts';
import type { ChopperTractionSpec, ConsistSpec } from '../vehicle/spec.ts';
import {
  ReAdhesionController,
  clearDriveTorques,
  createTractionState,
  electricBrakeSign,
  lineElectricPower,
  loadCompensationRatio,
  meanDrivenAxleOmega,
  regenerationFade,
  rimForceFromMotorTorque,
  type ReAdhesionOptions,
} from './common.ts';
import {
  backEmf,
  currentForTorque,
  currentRipple,
  fieldRatioForCurrent,
  motorTorque,
  stepArmatureCurrent,
  voltageForCurrent,
} from './dcMotor.ts';
import { createChopperDriveState, type ChopperDriveState } from './driveState.ts';
import type { TractionContext, TractionState, TractionSystem } from './types.ts';

export type ChopperOptions = ReAdhesionOptions;

/** 通流率がこの割合まで上がったら「全通流」と見なし、弱め界磁へ移る */
const FULL_DUTY_MARGIN = 0.995;

/**
 * 電機子チョッパ制御による動力装置。
 *
 * 電動機は抵抗制御車とまったく同じ直流直巻機で、違うのは**電圧の作り方だけ**である。
 * 起動抵抗で電圧を落として熱にする代わりに、サイリスタチョッパで架線電圧を刻む。
 * 通流率 δ を連続に変えられるので段が無く、引張力は滑らかに出る — 同じ電動機で
 * 「刻みがあるか無いか」だけが違うので、抵抗制御車と乗り比べると差がそのまま分かる。
 *
 * 制御は電流調節器である。限流値 I* を流すのに要る電圧を電機子回路の式から逆算し、
 * それを架線電圧で割ったものが通流率になる:
 *
 * ```
 * δ* = (m·E + I*·R_合計) / V_線          clamp[0, maxDuty]
 * V_a = δ · V_線
 * ```
 *
 * 速度が上がって δ が上限に貼り付いたら（＝もう電圧を上げられない）、そこから先は
 * 界磁を弱めて電流を保つ。「起動から一定加速度 → 全通流 → 弱め界磁」という 3 段が、
 * 抵抗を 1 本も使わずに出る。
 */
export class ChopperTractionSystem implements TractionSystem {
  readonly state: TractionState = createTractionState();
  readonly driveState: ChopperDriveState;

  private readonly consist: ConsistSpec;
  private readonly spec: ChopperTractionSpec | null;
  private readonly reAdhesion: ReAdhesionController;

  /** 電機子電流 [A]（1 台あたり・平均値） */
  private current: Amperes = 0;
  /** 通流率 0..1 */
  private duty = 0;
  /** 界磁率 */
  private fieldRatio = 1;
  private electricBrakeRequest = 0;
  private cutOffActive = false;

  constructor(consist: ConsistSpec, options: ChopperOptions = {}) {
    this.consist = consist;
    this.spec = firstChopperSpec(consist);
    this.reAdhesion = new ReAdhesionController(consist, options);
    this.driveState = createChopperDriveState(this.spec?.chopFrequency ?? 0);
  }

  setNotch(notch: number): void {
    this.state.notch = clamp(Math.round(notch), 0, this.consist.traction.notchCount);
  }

  requestElectricBrakeForce(force: Newtons): void {
    this.electricBrakeRequest = Math.max(0, force);
  }

  cutOff(): void {
    this.cutOffActive = true;
    this.state.notch = 0;
    this.electricBrakeRequest = 0;
  }

  /** 引き通し（非常ブレーキ復帰など）で出力を許可し直す */
  restore(): void {
    this.cutOffActive = false;
  }

  /**
   * 回生ブレーキで出せる制動力 [N]（編成合計・正値）。
   *
   * 抵抗制御の発電ブレーキと違い、こちらは電力を**架線へ返す**ので、
   * 架線に受け取り手がいなければ効かない（`regenerationReceptivity`）。
   *
   * 低速で失効するのも物理的な理由がある。チョッパの昇圧比には上限
   * `1/(1 − maxDuty)` があるので、`m·E` が架線電圧の `(1 − maxDuty)` 倍を下回ると
   * どうやっても架線へ押し返せない。`regenFade*Speed` はその速度から決めている。
   */
  availableElectricBrakeForce(v: MetersPerSecond, ctx: TractionContext): Newtons {
    const spec = this.spec;
    if (!spec || this.cutOffActive) return 0;
    let total = 0;
    for (const veh of this.consist.vehicles) {
      const s = veh.traction;
      if (s?.kind !== 'chopper' || veh.drivenAxleCount === 0) continue;
      const torque = motorTorque(s.motor, s.brakeCurrentLimit, this.fieldRatio);
      total += rimForceFromMotorTorque(s, veh, torque) * regenerationFade(s, v);
    }
    return total * clamp(ctx.regenerationReceptivity, 0, 1);
  }

  /** 逆転機の向き（1 = 前、-1 = 後）。力行トルクの向きにだけ効く。 */
  private direction: 1 | -1 = 1;

  update(dt: number, ctx: TractionContext): void {
    const dyn = ctx.dynamics;
    const spec = this.spec;
    const st = this.driveState;
    this.direction = ctx.direction ?? 1;

    this.reAdhesion.update(dt, dyn);
    this.state.slipDetected = this.reAdhesion.slipDetected;
    // 直巻機は空転すると逆起電力が上がって電流が落ちるので、特性そのものが
    // 再粘着装置を兼ねる。電子的な絞り込みは持たない。
    this.state.reAdhesionFactor = 1;

    if (!spec) {
      clearDriveTorques(dyn);
      this.state.tractiveEffort = 0;
      this.state.power = 0;
      this.state.motorCurrent = 0;
      return;
    }

    const omega = Math.abs(meanDrivenAxleOmega(dyn)) * spec.gearRatio;
    st.motorAngularVelocity = omega;
    st.motorRpm = radPerSecToRpm(omega);
    const rps = omega / (2 * Math.PI);
    st.gearMeshFrequency = rps * spec.motor.pinionTeeth;
    st.commutatorFrequency = rps * spec.motor.commutatorBars;
    st.slotFrequency = rps * spec.motor.armatureSlots;
    st.ventilationFrequency = rps * spec.motor.fanBlades;

    const notch = this.cutOffActive ? 0 : this.state.notch;
    const braking = this.electricBrakeRequest > 0 && notch === 0;
    this.state.electricBraking = braking;

    if (braking) {
      this.updateRegeneration(dt, spec, dyn, ctx, omega);
    } else if (notch > 0) {
      this.updateTraction(dt, spec, dyn, ctx, omega, notch);
    } else {
      this.updateCoasting(dt, spec, dyn);
    }
  }

  /** 力行: 限流値制御 → 全通流 → 弱め界磁 */
  private updateTraction(
    dt: number,
    spec: ChopperTractionSpec,
    dyn: TrainDynamics,
    ctx: TractionContext,
    omega: number,
    notch: number,
  ): void {
    const st = this.driveState;
    const ctrl = this.consist.traction;
    const m = spec.motorsInSeries;
    const notchRatio = ctrl.notchTorqueRatio[notch - 1] ?? 1;
    const target =
      spec.currentLimit * notchRatio * loadCompensationRatio(this.consist, ctx.loadFactor);

    // --- 通流率: 目標電流を流すのに要る電圧を逆算する ---
    const needed = voltageForCurrent(spec.motor, target, this.fieldRatio, omega, m);
    const dutyTarget = clamp(ctx.lineVoltage > 0 ? needed / ctx.lineVoltage : 0, 0, spec.maxDuty);
    this.duty = rateLimit(this.duty, dutyTarget, spec.dutyRate, dt);

    // --- 弱め界磁: 電圧を使い切ってから初めて界磁を弱める ---
    const saturated = this.duty >= spec.maxDuty * FULL_DUTY_MARGIN;
    let fieldTarget = 1;
    if (saturated) {
      fieldTarget = clamp(
        fieldRatioForCurrent(spec.motor, target, ctx.lineVoltage * spec.maxDuty, omega, m),
        spec.minFieldRatio,
        1,
      );
    }
    this.fieldRatio = rateLimit(this.fieldRatio, fieldTarget, spec.fieldRate, dt);

    // --- 電機子電流 ---
    this.current = stepArmatureCurrent({
      spec: spec.motor,
      current: this.current,
      appliedVoltage: this.duty * ctx.lineVoltage,
      motorsInSeries: m,
      externalResistance: 0,
      fieldRatio: this.fieldRatio,
      motorOmega: omega,
      dt,
    });
    this.current = Math.min(this.current, spec.currentLimit * 1.2);

    const torque = motorTorque(spec.motor, this.current, this.fieldRatio);
    const totalRimForce = this.distribute(dyn, torque, false);
    this.state.tractiveEffort = totalRimForce;
    this.state.torqueCommand = this.duty;

    st.gate = true;
    st.regenerating = false;
    // 速度の大きさで見る（後退中に力行が回生に見えないように）
    this.updateElectrical(spec, ctx, omega, totalRimForce * Math.abs(dyn.speed));
  }

  /** 回生: チョッパを昇圧動作させ、電力を架線へ返す */
  private updateRegeneration(
    dt: number,
    spec: ChopperTractionSpec,
    dyn: TrainDynamics,
    ctx: TractionContext,
    omega: number,
  ): void {
    const st = this.driveState;
    const v = dyn.speed;
    const available = this.availableElectricBrakeForce(v, ctx);
    const requested = Math.min(this.electricBrakeRequest, available);

    if (requested <= 0 || available <= 0) {
      this.updateCoasting(dt, spec, dyn);
      return;
    }

    // 制動力の割合はトルクの割合そのものだが、トルクは電流に比例していないので、
    // 電流を同じ割合に絞ると力が足りない。必要な電流を逆算する。
    const ratio = requested / available;
    const fullTorque =
      motorTorque(spec.motor, spec.brakeCurrentLimit, this.fieldRatio) * regenerationFade(spec, v);
    const target = currentForTorque(spec.motor, fullTorque * ratio, this.fieldRatio);
    // 制動側でも電流の立ち上がりは電機子回路の時定数に従う。
    this.current = stepArmatureCurrent({
      spec: spec.motor,
      current: this.current,
      appliedVoltage: voltageForCurrent(
        spec.motor,
        target,
        this.fieldRatio,
        omega,
        spec.motorsInSeries,
      ),
      motorsInSeries: spec.motorsInSeries,
      externalResistance: 0,
      fieldRatio: this.fieldRatio,
      motorOmega: omega,
      dt,
    });
    this.fieldRatio = rateLimit(this.fieldRatio, 1, spec.fieldRate, dt);

    const torque = motorTorque(spec.motor, this.current, this.fieldRatio);
    const totalRimForce = this.distribute(dyn, torque, true);
    this.state.tractiveEffort = -totalRimForce;
    this.state.torqueCommand = 0;

    // 回生時の通流率は昇圧比の逆数。電動機側の電圧が架線電圧より低いほど深く刻む。
    const emf = backEmf(spec.motor, this.current, this.fieldRatio, omega);
    this.duty =
      ctx.lineVoltage > 0
        ? clamp(1 - (spec.motorsInSeries * emf) / ctx.lineVoltage, 0, spec.maxDuty)
        : 0;
    st.gate = true;
    st.regenerating = true;
    this.updateElectrical(spec, ctx, omega, -totalRimForce * Math.abs(v));
  }

  /** 惰行: チョッパを止め、電流を自然に落とす */
  private updateCoasting(dt: number, spec: ChopperTractionSpec, dyn: TrainDynamics): void {
    const st = this.driveState;
    this.duty = rateLimit(this.duty, 0, spec.dutyRate, dt);
    this.fieldRatio = rateLimit(this.fieldRatio, 1, spec.fieldRate, dt);
    this.current = stepArmatureCurrent({
      spec: spec.motor,
      current: this.current,
      appliedVoltage: 0,
      motorsInSeries: spec.motorsInSeries,
      externalResistance: 0,
      fieldRatio: this.fieldRatio,
      motorOmega: 0,
      dt,
    });
    clearDriveTorques(dyn);
    this.state.tractiveEffort = 0;
    this.state.torqueCommand = 0;
    this.state.motorCurrent = 0;
    this.state.power = 0;
    st.gate = false;
    st.regenerating = false;
    st.duty = this.duty;
    st.fieldRatio = this.fieldRatio;
    st.armatureCurrent = this.current;
    st.currentRipple = 0;
    st.armatureVoltage = 0;
    st.backEmf = 0;
    st.torqueRatio = 0;
  }

  /**
   * 電動機トルクを各動軸へ配分する。戻り値は車輪周の力の合計 [N]（正値）。
   * `braking` のときは車輪の実回転から向きを決める（滑走軸を逆転させないため）。
   */
  private distribute(dyn: TrainDynamics, torque: number, braking: boolean): Newtons {
    let total = 0;
    for (const veh of dyn.vehicles) {
      const s = veh.spec.traction;
      if (s?.kind !== 'chopper' || veh.spec.drivenAxleCount === 0) {
        for (const ax of veh.axles) ax.driveTorque = 0;
        continue;
      }
      const axleTorqueTotal = torque * s.motorCount * s.gearRatio * s.driveEfficiency;
      const perAxle = axleTorqueTotal / veh.spec.drivenAxleCount;
      for (const ax of veh.axles) {
        if (!ax.driven) {
          ax.driveTorque = 0;
        } else {
          ax.driveTorque = braking
            ? -electricBrakeSign(ax.omega) * perAxle
            : this.direction * perAxle;
        }
      }
      total += rimForceFromMotorTorque(s, veh.spec, torque);
    }
    return total;
  }

  /** 主回路の電気量（表示・音響・電力量記録用）を更新する */
  private updateElectrical(
    spec: ChopperTractionSpec,
    ctx: TractionContext,
    omega: number,
    mechanicalPower: number,
  ): void {
    const st = this.driveState;
    const m = spec.motorsInSeries;
    const emf = backEmf(spec.motor, this.current, this.fieldRatio, omega);

    st.duty = this.duty;
    st.fieldRatio = this.fieldRatio;
    st.armatureCurrent = this.current;
    st.armatureVoltage = emf + this.current * spec.motor.armatureResistance;
    st.backEmf = emf;
    st.currentRipple = currentRipple(spec.motor, ctx.lineVoltage, this.duty, spec.chopFrequency, m);
    st.torqueRatio = (st.regenerating ? -1 : 1) * (this.current / spec.motor.ratedCurrent);

    const elecPower = lineElectricPower(mechanicalPower, spec.converterEfficiency);
    this.state.power = elecPower;
    this.state.motorCurrent = ctx.lineVoltage > 0 ? elecPower / ctx.lineVoltage : 0;
  }
}

/** 編成のなかで最初に見つかるチョッパ制御の仕様 */
function firstChopperSpec(consist: ConsistSpec): ChopperTractionSpec | null {
  for (const veh of consist.vehicles) {
    if (veh.traction?.kind === 'chopper') return veh.traction;
  }
  return null;
}
