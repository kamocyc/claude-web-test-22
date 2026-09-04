import { clamp } from '../math/scalar.ts';
import type { Amperes, MetersPerSecond, Newtons } from '../units.ts';
import { radPerSecToRpm } from '../units.ts';
import type { TrainDynamics } from '../train/dynamics.ts';
import type { CamStep, ConsistSpec, ResistorTractionSpec } from '../vehicle/spec.ts';
import {
  ReAdhesionController,
  clearDriveTorques,
  createTractionState,
  electricBrakeSign,
  loadCompensationRatio,
  meanDrivenAxleOmega,
  rimForceFromMotorTorque,
  type ReAdhesionOptions,
} from './common.ts';
import {
  backEmf,
  currentForTorque,
  motorTorque,
  selfExcitedCurrent,
  stepArmatureCurrent,
} from './dcMotor.ts';
import { createResistorDriveState, type ResistorDriveState } from './driveState.ts';
import type { TractionContext, TractionState, TractionSystem } from './types.ts';

export type ResistorOptions = ReAdhesionOptions;

/** 主接触器が開いているとき（惰行）に電流が消えていく時定数 [s] */
const OPEN_CIRCUIT_DECAY = 0.12;

/**
 * 抵抗制御（カム軸進段・直並列切替・弱め界磁）による動力装置。
 *
 * VVVF との決定的な違いは、**引張力を指令していない**ことである。運転士がノッチで
 * 決めるのは「どの段まで進めてよいか」だけで、そこへ至る道筋はカム軸が自動で刻む。
 * 出てくる引張力は電機子回路の解であって、指令値ではない。
 *
 * その結果として実車どおりの鋸歯が出る:
 *
 *  1. 段が進むと外部抵抗が落ちるので、定常電流が跳ね上がる
 *  2. 電機子回路の L/R 時定数で電流が立ち上がり、限流値付近に達する
 *  3. 加速して逆起電力が上がるにつれ電流が落ちていく
 *  4. 進段電流を下回ったところで次の段へ — 1 に戻る
 *
 * **`torqueRiseRate` / `torqueFallRate` / `targetAcceleration` は一切参照しない。**
 * それらを掛けてしまうと、この鋸歯がならされて VVVF と区別がつかなくなる。
 * レートリミッタの役目は電機子回路のインダクタンスとカム軸の回転速度が果たしている。
 *
 * 再粘着制御も持たない。直巻電動機は空転すると回転が上がって逆起電力が増え、電流が
 * 落ち、トルクが落ちる — **特性そのものが再粘着装置になっている**。空転の検知だけは
 * 表示のために行うが、引張力を絞る制御は入れていない。
 */
export class ResistorTractionSystem implements TractionSystem {
  readonly state: TractionState = createTractionState();
  readonly driveState: ResistorDriveState = createResistorDriveState();

  private readonly consist: ConsistSpec;
  private readonly spec: ResistorTractionSpec | null;
  private readonly reAdhesion: ReAdhesionController;

  /** 現在のカム軸の段（`camSteps` の添字）。-1 = 主接触器開放。 */
  private step = -1;
  /** 現在の段に入ってからの経過時間 [s] */
  private dwell = 0;
  /** 直並列の組替え（渡り）の残り時間 [s]。正のあいだ主回路は開いている。 */
  private transition = 0;
  /** 電機子電流 [A]（1 台あたり） */
  private current: Amperes = 0;
  /** ブレーキ装置から要求された電気ブレーキ力 [N]（正値） */
  private electricBrakeRequest = 0;
  private cutOffActive = false;

  constructor(consist: ConsistSpec, options: ResistorOptions = {}) {
    this.consist = consist;
    this.spec = firstResistorSpec(consist);
    this.reAdhesion = new ReAdhesionController(consist, options);
    this.driveState.stepCount = this.spec?.camSteps.length ?? 0;
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
   * 発電ブレーキで出せる制動力 [N]（編成合計・正値）。
   *
   * **`ctx.regenerationReceptivity` を掛けていない。** 発電ブレーキは電力を制動抵抗器で
   * 熱にして捨てるので、架線に負荷があろうと無かろうと関係なく効く。回生失効という
   * 現象がそもそも起きないのが、この方式の（数少ない）長所である。
   *
   * 低速で落ちるのは自励の閾値によるもので、フェード曲線は引いていない。
   */
  availableElectricBrakeForce(v: MetersPerSecond, _ctx: TractionContext): Newtons {
    const spec = this.spec;
    if (!spec || !spec.hasDynamicBrake || this.cutOffActive) return 0;
    let total = 0;
    for (const veh of this.consist.vehicles) {
      const s = veh.traction;
      if (s?.kind !== 'resistor' || veh.drivenAxleCount === 0) continue;
      const omega = motorOmegaFromSpeed(v, veh.wheelDiameter, s.gearRatio);
      const i = clamp(
        selfExcitedCurrent(
          s.motor,
          s.brakeFieldRatio,
          omega,
          s.brakeMotorsInSeries,
          s.brakeResistance,
        ),
        0,
        s.brakeCurrentLimit,
      );
      total += rimForceFromMotorTorque(s, veh, motorTorque(s.motor, i, s.brakeFieldRatio));
    }
    return total;
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
    // 直巻機の特性が再粘着装置を兼ねるので、指令を絞る制御は持たない
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

    const braking = this.electricBrakeRequest > 0 && this.state.notch === 0;
    this.state.electricBraking = braking && spec.hasDynamicBrake;

    if (braking && spec.hasDynamicBrake) {
      this.updateDynamicBrake(dt, spec, dyn, ctx);
    } else {
      this.updateTraction(dt, spec, dyn, ctx, omega);
    }
  }

  /** 力行: カム軸の進段と電機子電流の時間発展 */
  private updateTraction(
    dt: number,
    spec: ResistorTractionSpec,
    dyn: TrainDynamics,
    ctx: TractionContext,
    omega: number,
  ): void {
    const st = this.driveState;
    const notch = this.cutOffActive ? 0 : this.state.notch;
    const target = notch > 0 ? (spec.notchFinalStep[notch - 1] ?? spec.camSteps.length - 1) : -1;

    // --- カム軸を動かす ---
    if (this.transition > 0) {
      // 渡りの最中。組替えが終わるまでカム軸は次へ進まないし、滞留時間も数えない
      // （数えてしまうと、渡りが明けた瞬間に次の段へ跳んでしまう）。
      this.transition -= dt;
      this.dwell = 0;
    } else {
      this.dwell += dt;
      if (this.step > target) {
        // ノッチを戻したときは 1 制御周期で目標段まで落とす（電動カム軸の戻りは速い）。
        this.advanceTo(spec, target);
      } else if (this.step < target) {
        // 起動の 1 段目は電流条件を待たずに入る（主接触器が閉じる瞬間）。
        //
        // 2 つの条件のどちらが律速になるかは場面で入れ替わる。起動から加速していく
        // あいだは電流条件（限流継電器）が律速で、電流が限流値から進段電流まで落ちる
        // のに 1.5〜2 秒かかる。いっぽう高速からの再力行では逆起電力が大きく、全抵抗が
        // 入った 1 段目でも電流が進段電流を大きく下回るので、電流条件は最初から真に
        // なっている。そこではカム軸の回転速度（`stepDwell`）だけが律速になり、
        // 段が連打されながら速度に見合った段まで駆け上がる。
        const limit = spec.stepCurrent * loadCompensationRatio(this.consist, ctx.loadFactor);
        const mayAdvance = this.step < 0 || (this.current < limit && this.dwell >= spec.stepDwell);
        if (mayAdvance) this.advanceTo(spec, this.step + 1);
      }
    }

    const transitioning = this.transition > 0;
    const cam = this.step >= 0 && !transitioning ? spec.camSteps[this.step] : undefined;
    st.gate = cam !== undefined;
    st.transitioning = transitioning;
    st.step = Math.max(0, this.step);
    st.dynamicBraking = false;

    if (!cam) {
      // 主接触器が開いている（惰行、または渡りの最中）。
      // 電流は還流ダイオードを通って自身の時定数で消える。
      this.current = this.current * Math.exp(-dt / OPEN_CIRCUIT_DECAY);
      this.applyOpenCircuit(spec, dyn);
      return;
    }

    // --- 電機子電流を進める ---
    this.current = stepArmatureCurrent({
      spec: spec.motor,
      current: this.current,
      appliedVoltage: ctx.lineVoltage,
      motorsInSeries: cam.motorsInSeries,
      externalResistance: cam.resistance,
      fieldRatio: cam.fieldRatio,
      motorOmega: omega,
      dt,
    });
    // 限流値は保護継電器の役目。定常解が超えることは無いが、段が進んだ直後の
    // 過渡で行き過ぎないよう頭を押さえる。
    this.current = Math.min(this.current, spec.motor.ratedCurrent * 3);

    const torque = motorTorque(spec.motor, this.current, cam.fieldRatio);
    const totalRimForce = this.distribute(dyn, torque, false);

    this.state.tractiveEffort = totalRimForce;
    // 「指令」に相当するものが無いので、進段の進捗を入れておく（記録・表示用）。
    this.state.torqueCommand =
      spec.camSteps.length > 1 ? st.step / (spec.camSteps.length - 1) : st.gate ? 1 : 0;
    this.updateElectrical(spec, cam, ctx);
  }

  /**
   * カム軸を `next` 段へ動かす。
   *
   * つなぎ方が変わる段（直並列の組替え）へ渡るときは、いったん主回路を切って
   * 接触器を組み替える時間を取る。抵抗を短絡するだけの進段と違って回路の形が
   * 変わるので、切らずに繋ぎ替えることができないためである。
   */
  private advanceTo(spec: ResistorTractionSpec, next: number): void {
    const previous = this.step >= 0 ? spec.camSteps[this.step] : undefined;
    this.step = Math.min(next, spec.camSteps.length - 1);
    this.dwell = 0;
    this.driveState.stepEvents++;
    const entered = this.step >= 0 ? spec.camSteps[this.step] : undefined;
    if (previous && entered && previous.motorsInSeries !== entered.motorsInSeries) {
      this.driveState.groupEvents++;
      this.transition = spec.transitionTime;
    }
  }

  /** 発電ブレーキ: 電機子を制動抵抗へつなぎ、自励で電流を作る */
  private updateDynamicBrake(
    dt: number,
    spec: ResistorTractionSpec,
    dyn: TrainDynamics,
    ctx: TractionContext,
  ): void {
    const st = this.driveState;
    this.step = -1;
    this.dwell = 0;
    this.transition = 0;
    st.gate = false;
    st.transitioning = false;
    st.dynamicBraking = true;

    const available = this.availableElectricBrakeForce(dyn.speed, ctx);
    const requested = Math.min(this.electricBrakeRequest, available);
    if (requested <= 0 || available <= 0) {
      this.current = this.current * Math.exp(-dt / OPEN_CIRCUIT_DECAY);
      this.applyOpenCircuit(spec, dyn);
      return;
    }

    const omega = st.motorAngularVelocity;
    const full = clamp(
      selfExcitedCurrent(
        spec.motor,
        spec.brakeFieldRatio,
        omega,
        spec.brakeMotorsInSeries,
        spec.brakeResistance,
      ),
      0,
      spec.brakeCurrentLimit,
    );
    // 要求された制動力の割合はそのまま**トルク**の割合である。トルクは電流に
    // 比例していないので、電流を同じ割合に絞ると力が足りなくなる。
    // 制動抵抗を段階的に短絡して電流を作る実機に倣い、必要な電流を逆算する。
    const ratio = requested / available;
    const torque = motorTorque(spec.motor, full, spec.brakeFieldRatio) * ratio;
    this.current = currentForTorque(spec.motor, torque, spec.brakeFieldRatio);
    const totalRimForce = this.distribute(dyn, torque, true);

    this.state.tractiveEffort = -totalRimForce;
    this.state.torqueCommand = 0;

    // 発電機として働いているので、端子電圧は逆起電力から電機子抵抗の降下を引いたもの。
    const emf = backEmf(spec.motor, this.current, spec.brakeFieldRatio, omega);
    st.fieldRatio = spec.brakeFieldRatio;
    st.motorsInSeries = spec.brakeMotorsInSeries;
    st.branches = this.branchCount(spec.brakeMotorsInSeries);
    st.resistance = spec.brakeResistance;
    st.armatureCurrent = this.current;
    st.backEmf = emf;
    st.armatureVoltage = emf - this.current * spec.motor.armatureResistance;
    st.torqueRatio = -this.current / spec.motor.ratedCurrent;
    // 制動抵抗で捨てている電力（編成合計）。架線へは何も返さない。
    st.resistorPower =
      this.branchCount(spec.brakeMotorsInSeries) *
      this.current *
      this.current *
      spec.brakeResistance;

    // 架線からは何も取らず、架線へも何も返さない。回生失効という現象が起きない所以。
    this.state.motorCurrent = 0;
    this.state.power = 0;
  }

  /** 主回路が開いているときの後始末（惰行） */
  private applyOpenCircuit(spec: ResistorTractionSpec, dyn: TrainDynamics): void {
    const st = this.driveState;
    clearDriveTorques(dyn);
    this.state.tractiveEffort = 0;
    this.state.torqueCommand = 0;
    this.state.motorCurrent = 0;
    this.state.power = 0;
    st.armatureCurrent = this.current;
    st.armatureVoltage = 0;
    st.backEmf = 0;
    st.resistance = 0;
    st.resistorPower = 0;
    st.fieldRatio = 1;
    st.torqueRatio = this.current / spec.motor.ratedCurrent;
  }

  /**
   * 電動機トルクを各動軸へ配分する。戻り値は車輪周の力の合計 [N]（正値）。
   * `braking` のときは車輪の実回転から向きを決める（滑走軸を逆転させないため）。
   */
  private distribute(dyn: TrainDynamics, torque: number, braking: boolean): Newtons {
    let total = 0;
    for (const veh of dyn.vehicles) {
      const s = veh.spec.traction;
      if (s?.kind !== 'resistor' || veh.spec.drivenAxleCount === 0) {
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
  private updateElectrical(spec: ResistorTractionSpec, cam: CamStep, ctx: TractionContext): void {
    const st = this.driveState;
    const branches = this.branchCount(cam.motorsInSeries);

    // 分岐の電圧配分: 起動抵抗で I·R_ext を落とし、残りを m 台の電動機で分け合う。
    const motorVoltage = (ctx.lineVoltage - this.current * cam.resistance) / cam.motorsInSeries;

    st.motorsInSeries = cam.motorsInSeries;
    st.branches = branches;
    st.resistance = cam.resistance;
    st.fieldRatio = cam.fieldRatio;
    st.armatureCurrent = this.current;
    st.armatureVoltage = motorVoltage;
    st.backEmf = motorVoltage - this.current * spec.motor.armatureResistance;
    st.torqueRatio = this.current / spec.motor.ratedCurrent;
    // 起動抵抗で熱にしている電力。全短絡した段では 0 になる — 音もそこで消える。
    st.resistorPower = branches * this.current * this.current * cam.resistance;

    // 抵抗制御には変換器が無いので、架線電流は分岐の数だけ電機子電流が並んだものそのもの。
    this.state.motorCurrent = branches * this.current;
    this.state.power = ctx.lineVoltage * this.state.motorCurrent;
  }

  /** 編成全体で並列に並んでいる主回路の分岐数 */
  private branchCount(motorsInSeries: number): number {
    const m = Math.max(1, motorsInSeries);
    let motors = 0;
    for (const veh of this.consist.vehicles) {
      if (veh.traction?.kind === 'resistor') motors += veh.traction.motorCount;
    }
    return motors / m;
  }
}

/** 編成のなかで最初に見つかる抵抗制御の仕様 */
function firstResistorSpec(consist: ConsistSpec): ResistorTractionSpec | null {
  for (const veh of consist.vehicles) {
    if (veh.traction?.kind === 'resistor') return veh.traction;
  }
  return null;
}

/** 車速から電動機の角速度 [rad/s] を求める（表示・見積り用） */
function motorOmegaFromSpeed(v: MetersPerSecond, wheelDiameter: number, gearRatio: number): number {
  return (Math.abs(v) / (wheelDiameter / 2)) * gearRatio;
}
