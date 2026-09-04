import { AirCompressor, type CompressorState } from '../brake/compressor.ts';
import { ElectroPneumaticBrakeSystem } from '../brake/electroPneumatic.ts';
import { HoldingBrakeRegulator } from '../brake/holdingRegulator.ts';
import type { BrakeCommand } from '../brake/types.ts';
import { Rng } from '../math/rng.ts';
import { clamp, firstOrderLag } from '../math/scalar.ts';
import {
  AutoDriver,
  type AutoDriveParameters,
  type AutoDriveState,
} from '../operation/autoDrive.ts';
import { MetricsRecorder, type StopRecord } from '../operation/metrics.ts';
import { occupiedSpeedLimit } from '../route/types.ts';
import type { BeaconPayload, SafetySystemKind, Station } from '../route/types.ts';
import { AtcSystem } from '../safety/atc.ts';
import { AtsPSystem } from '../safety/atsP.ts';
import { AtsSnSystem } from '../safety/atsSn.ts';
import { CompositeSafetySystem } from '../safety/composite.ts';
import type { SafetyContext, SafetyOutput, SafetySystem } from '../safety/types.ts';
import { noOutput } from '../safety/types.ts';
import { VigilanceSystem } from '../safety/vigilance.ts';
import { SignallingSystem } from '../signalling/system.ts';
import { nearestPassingEncounter, type PassingEncounter } from '../signalling/passing.ts';
import {
  LevelCrossingSystem,
  type DirectedOccupancy,
  type LevelCrossingState,
} from '../crossing/system.ts';
import type { Bridge } from '../track/bridge.ts';
import type { Turnout } from '../track/turnout.ts';
import type { BodyMotionState } from '../train/bodyMotion.ts';
import { TrainDynamics, type DynamicsEnvironment } from '../train/dynamics.ts';
import { RemoteTrain, type RemoteTrainCommand } from '../train/remoteTrain.ts';
import { DoorSystem, type DoorState } from '../door/index.ts';
import type { DriveState } from '../traction/driveState.ts';
import { createTractionSystem } from '../traction/factory.ts';
import type { TractionSystem } from '../traction/types.ts';
import type { Meters, MetersPerSecond, Seconds } from '../units.ts';
import { NEUTRAL_INPUT, type ControlInput, type Scenario } from './types.ts';

/** 物理積分の刻み [s] */
export const PHYSICS_DT = 0.001;
/** 物理積分の刻み [マイクロ秒]（整数で時間を貯めるための単位） */
const PHYSICS_MICROS = 1000;
/** 装置制御の周期 [s] */
export const CONTROL_DT = 0.01;
/** 1 回の step() で進める最大の物理ステップ数（処理落ち時の暴走防止） */
const MAX_SUBSTEPS = 2000;

/**
 * ダイヤ列車の加速度を折れ線から均す時定数 [s]。
 * ノッチを動かしてから加速度が変わりきるまでの時間にあたる。
 */
const SCHEDULE_ACCELERATION_TIME = 2.0;

/** 駅での取り扱い状態 */
export interface StationProgress {
  readonly station: Station;
  arrived: boolean;
  departed: boolean;
  arrivalTime: Seconds | null;
  departureTime: Seconds | null;
  stopError: Meters | null;
  doorsOpen: boolean;
  /** 停車時分の経過 [s] */
  dwellElapsed: Seconds;
}

export interface SimulationOptions {
  /** 保安装置を差し替える（テスト用） */
  readonly safetyFactory?: (scenario: Scenario) => SafetySystem;
  /** 自動運転装置の調整値（`autoDrive` を有効にしたときに使われる） */
  readonly autoDrive?: Partial<AutoDriveParameters>;
}

/**
 * シミュレーション全体を束ねる。
 *
 * 時間の進め方は 3 階層に分かれている:
 *
 *  - 物理積分: 1 kHz（連結器とクリープ力の剛性に対して安定な刻み）
 *  - 装置制御: 100 Hz（ノッチ・保安装置・信号・滑走防止の判断）
 *  - 描画:     可変（`step()` を呼ぶ側の任意のタイミング）
 *
 * 外部からの入力は `input`（運転士の操作）だけであり、それ以外に時刻や乱数へ
 * 依存する箇所は無い。したがって「同じシナリオ + 同じ入力列」なら、
 * 実行環境やフレームレートに関係なく完全に同じ結果になる。
 */
export class Simulation {
  readonly scenario: Scenario;
  readonly dynamics: TrainDynamics;
  readonly traction: TractionSystem;
  readonly brake: ElectroPneumaticBrakeSystem;
  readonly compressor = new AirCompressor();
  readonly doors: DoorSystem;
  readonly signalling: SignallingSystem;
  /**
   * ダイヤ列車の装置（列車 id → 装置一式）。
   *
   * ダイヤが持っているのは位置だけだが、音はノッチ・ゲート・BC 圧から出る。
   * `RemoteTrain` が自列車とまったく同じ装置を回してそれを埋めるので、
   * 対向列車も先行列車も自列車と同じ音源で鳴らせる。
   */
  readonly remoteTrains = new Map<string, RemoteTrain>();
  /** 踏切（鳴動と遮断桿。線路上のすべての列車を見て動く） */
  readonly levelCrossings: LevelCrossingSystem;
  readonly safety: SafetySystem;
  readonly metrics = new MetricsRecorder();
  readonly rng: Rng;

  /** 運転士の操作入力（外部から書き換える） */
  input: ControlInput = NEUTRAL_INPUT;

  /**
   * 自動運転装置。`autoDrive` が true のあいだは、これが組み立てた指令が
   * 運転士の操作の代わりに装置へ渡る。
   */
  readonly autoDriver: AutoDriver;
  /** 自動運転の入切 */
  autoDrive = false;

  /** シミュレーション内時刻 [s] */
  time: Seconds;
  /** 走行開始からの経過時間 [s] */
  elapsed: Seconds = 0;

  /**
   * 未消化の時間 [マイクロ秒]。
   * 浮動小数で貯めると呼び出し間隔によって刻み数が 1 ずれ、結果が再現しなくなるため、
   * 整数のマイクロ秒で保持する（物理刻み 1ms = 1000 マイクロ秒）。
   */
  private accumulatorMicros = 0;
  private controlAccumulator = 0;
  private previousFront: Meters;
  private lastControlFront: Meters;
  private safetyOutput: SafetyOutput = noOutput();
  private previousAcknowledge = false;
  private previousInput: ControlInput = NEUTRAL_INPUT;
  /** 実際に装置へ渡っている指令（自動運転中は装置が組み立てたもの） */
  private activeInput: ControlInput = NEUTRAL_INPUT;
  private lastCylinderPressure = 0;
  /**
   * 抑速ブレーキの調速器。
   *
   * 運転士の抑速位置は段を 1 つしか持たないので、実際に出す段はこれが選ぶ。
   * 自動運転装置のように段まで指定してくる指令（`holdingNotch`）はそのまま通す。
   */
  private readonly holdingRegulator = new HoldingBrakeRegulator();
  /** ダイヤ列車の前周期の速度と、均した加速度（列車 id で引く） */
  private readonly remoteSpeeds = new Map<string, number>();
  private readonly remoteAccelerations = new Map<string, number>();
  private readonly env: DynamicsEnvironment;

  readonly stations: StationProgress[];
  private nextStationIndex = 0;
  private slipLatched = false;
  private slideLatched = false;
  private emergencyLatched = false;
  private patternLatched = false;
  private warningLatched = false;

  constructor(scenario: Scenario, options: SimulationOptions = {}) {
    this.scenario = scenario;
    this.rng = new Rng(scenario.seed);
    this.time = scenario.startTime;
    this.dynamics = new TrainDynamics(scenario.consist, scenario.route.alignment, {
      loadFactor: scenario.loadFactor,
      initialFrontPosition: scenario.startPosition,
      initialSpeed: scenario.startSpeed,
      irregularity: scenario.route.irregularity,
      turnouts: scenario.route.turnouts,
      levelCrossings: scenario.route.levelCrossings,
      ...(scenario.rigidConsist === undefined ? {} : { rigidConsist: scenario.rigidConsist }),
    });
    this.traction = createTractionSystem(scenario.consist);
    this.doors = new DoorSystem(scenario.consist.door);
    this.brake = new ElectroPneumaticBrakeSystem(scenario.consist, {
      controlPeriod: CONTROL_DT,
    });
    this.signalling = new SignallingSystem(scenario.route, scenario.scheduledTrains);
    this.levelCrossings = new LevelCrossingSystem(scenario.route.levelCrossings);
    this.safety = options.safetyFactory
      ? options.safetyFactory(scenario)
      : buildSafetySystems(scenario);
    this.autoDriver = new AutoDriver(options.autoDrive);
    this.previousFront = this.dynamics.frontPosition;
    this.lastControlFront = this.previousFront;

    const tunnels = scenario.route.tunnels;
    this.env = {
      adhesion: { rail: scenario.railCondition, sanding: false },
      isTunnel: (s: Meters) => tunnels.at(s).length > 0,
    };

    this.stations = scenario.route.stations.map((station) => ({
      station,
      arrived: false,
      departed: false,
      arrivalTime: null,
      departureTime: null,
      stopError: null,
      doorsOpen: false,
      dwellElapsed: 0,
    }));

    this.signalling.update(this.occupancy(), this.time);
    this.runControl(CONTROL_DT);
  }

  /**
   * 自動運転の入切。
   * 入れ直したときに前回の走行の状態（制動のラッチ・停車の進行）が残らないよう、
   * 装置を初期化してから引き継ぐ。
   */
  setAutoDrive(enabled: boolean): void {
    if (enabled === this.autoDrive) return;
    if (enabled) this.autoDriver.reset();
    this.autoDrive = enabled;
  }

  /**
   * 実際に装置へ渡っている指令。
   * 自動運転中は `input`（運転士の操作）ではなく自動運転装置の出力になる。
   */
  get effectiveInput(): ControlInput {
    return this.activeInput;
  }

  /** 列車の在線範囲 */
  occupancy(): { front: Meters; rear: Meters } {
    return { front: this.dynamics.frontPosition, rear: this.dynamics.rearPosition };
  }

  /**
   * 線路上にいる列車の在線範囲と進行の向き（自列車 + ダイヤ列車）。
   *
   * 踏切はどの列車かを区別せず、線路上に列車がいることだけを検知して鳴る装置なので、
   * 自列車もダイヤ列車も同じ形で渡す。
   */
  private trainPresences(): DirectedOccupancy[] {
    // 自列車の向きは、逆転機の位置ではなく実際に動いている向きで見る
    const direction: 1 | -1 = this.dynamics.speed < -0.05 ? -1 : 1;
    const out: DirectedOccupancy[] = [{ ...this.occupancy(), direction }];
    for (const state of this.signalling.trainStates) {
      out.push({ ...state.occupancy, direction: state.direction });
    }
    return out;
  }

  /**
   * ダイヤ列車の装置を進める。
   *
   * ダイヤの折れ線は位置しか書いていないので、加速度は速度を微分して得る。
   * 折れ線の折れ点では速度が階段状に変わるため、そのまま微分するとありえない
   * 大きさの尖りになる。実際の列車の速度は連続なので、折れ線は粗い書き方だと
   * 見なして一次遅れで均す。この時定数が、ノッチを操作してから加速度が変わる
   * までの時間にあたる。
   */
  private updateRemoteTrains(dt: Seconds): void {
    const states = this.signalling.trainStates;
    if (states.length === 0 && this.remoteTrains.size === 0) return;
    const alive = new Set<string>();
    for (const state of states) {
      const id = state.train.id;
      alive.add(id);
      const previous = this.remoteSpeeds.get(id) ?? state.speed;
      this.remoteSpeeds.set(id, state.speed);
      const raw = dt > 0 ? (state.speed - previous) / dt : 0;
      const acceleration = firstOrderLag(
        this.remoteAccelerations.get(id) ?? 0,
        raw,
        SCHEDULE_ACCELERATION_TIME,
        dt,
      );
      this.remoteAccelerations.set(id, acceleration);
      const command: RemoteTrainCommand = {
        leadPosition: state.leadPosition,
        direction: state.direction,
        speed: state.speed,
        acceleration,
        // ダイヤが駅の中で列車を止めていれば、客扱いのために扉が開く
        doorsClosed: !this.stoppedInPlatform(state.occupancy, state.speed),
      };
      const existing = this.remoteTrains.get(id);
      if (existing) {
        existing.update(dt, command);
      } else {
        this.remoteTrains.set(
          id,
          new RemoteTrain(
            this.scenario.consist,
            this.scenario.route.alignment,
            command,
            this.scenario.loadFactor,
          ),
        );
      }
    }
    // 走り終えた列車は装置ごと消える
    for (const id of [...this.remoteTrains.keys()]) {
      if (alive.has(id)) continue;
      this.remoteTrains.delete(id);
      this.remoteSpeeds.delete(id);
      this.remoteAccelerations.delete(id);
    }
  }

  /** 停止していて、かつホームに掛かっているか */
  private stoppedInPlatform(occupancy: { front: Meters; rear: Meters }, speed: number): boolean {
    if (speed > 0.05) return false;
    for (const station of this.scenario.route.stations) {
      if (station.isPass) continue;
      if (occupancy.front >= station.platformStart && occupancy.rear <= station.platformEnd) {
        return true;
      }
    }
    return false;
  }

  get speed(): MetersPerSecond {
    return this.dynamics.speed;
  }

  get position(): Meters {
    return this.dynamics.frontPosition;
  }

  /**
   * いまかかっている速度制限 [m/s]。
   *
   * 在線範囲で引くので、先頭が制限区間へ入った時点で効きはじめ、最後部が抜けるまで
   * 解けない（`occupiedSpeedLimit`）。ここ 1 か所で決まった値が保安装置の照査速度の
   * 上限・HUD・グラフへ配られる。
   */
  get currentSpeedLimit(): MetersPerSecond {
    return occupiedSpeedLimit(this.scenario.route.speedLimits, this.occupancy());
  }

  /** 次に停車すべき駅 */
  get nextStation(): StationProgress | undefined {
    for (let i = this.nextStationIndex; i < this.stations.length; i++) {
      const st = this.stations[i]!;
      if (!st.departed) return st;
    }
    return undefined;
  }

  /**
   * 実時間 `elapsedSeconds` ぶんシミュレーションを進める。
   * 固定刻みのアキュムレータ方式で、呼び出し間隔に依らず同じ結果になる。
   */
  step(elapsedSeconds: Seconds): void {
    this.accumulatorMicros += Math.round(elapsedSeconds * 1e6);
    let steps = 0;
    while (this.accumulatorMicros >= PHYSICS_MICROS && steps < MAX_SUBSTEPS) {
      this.substep(PHYSICS_DT);
      this.accumulatorMicros -= PHYSICS_MICROS;
      steps++;
    }
    if (steps >= MAX_SUBSTEPS) {
      // 処理が追いつかない場合は残りを捨てる（時間を飛ばして破綻させない）
      this.accumulatorMicros = 0;
    }
  }

  /** 物理 1 ステップぶん進める */
  private substep(dt: Seconds): void {
    this.controlAccumulator += dt;
    if (this.controlAccumulator >= CONTROL_DT - 1e-9) {
      this.runControl(this.controlAccumulator);
      this.controlAccumulator = 0;
    }

    this.previousFront = this.dynamics.frontPosition;
    this.env.adhesion = {
      rail: this.scenario.railCondition,
      sanding: this.activeInput.sanding,
    };
    this.dynamics.step(dt, this.env);
    this.time += dt;
    this.elapsed += dt;

    this.sampleMetrics(dt);
    this.updateStations(dt);
  }

  /** 装置制御（100 Hz） */
  private runControl(dt: Seconds): void {
    const front = this.dynamics.frontPosition;

    // 1. 閉塞・信号現示の更新
    this.signalling.update(this.occupancy(), this.time);

    // 1b. ダイヤ列車の装置。ダイヤは位置しか持たないので、そこから逆に
    //     ノッチ・ゲート・BC 圧を求めて自列車と同じ装置を回す。
    this.updateRemoteTrains(dt);

    // 1c. 踏切。線路上の列車を検知して鳴り、少し遅れて遮断桿が下りる。自列車だけ
    //     でなくダイヤ列車も検知するので、対向列車が来れば自分が止まっていても鳴る。
    this.levelCrossings.update(dt, this.trainPresences());

    // 2. 地上子の通過処理（区間交差で判定するため取りこぼしがない）。
    //    後退しているあいだは踏まない。地上子は列車が進む向きに読ませる前提で
    //    並んでいるので、逆戻りで踏むと ATS のパターンが後ろ向きに立ってしまう。
    //    後退は入換相当の扱いで、保安装置の対象外とする。
    const ctx = this.safetyContext(front, this.lastControlFront);
    if (front > this.lastControlFront) {
      const crossed = this.scenario.route.beacons.crossing(this.lastControlFront, front);
      for (const entry of crossed) {
        this.safety.onBeacon(entry.value as BeaconPayload, entry.s, ctx);
      }
    }

    // 3. 保安装置
    this.safetyOutput = this.safety.update(dt, ctx);
    this.lastControlFront = front;
    // 保安装置の判定に使った指令を、次の周期の比較対象として控える。
    // 自動運転装置はこのあとで今周期の指令を作るので、ここで控えておかないと
    // 「前回の指令」と「今回の指令」が同じものになり、確認扱いの立ち上がりを
    // 検出できなくなる。
    this.previousInput = this.activeInput;
    this.previousAcknowledge = this.activeInput.acknowledge;

    // 4. 自動運転装置。運転士の操作の代わりに指令を組み立てる。
    //    制御周期の中で回すので、描画のフレームレートに依らず結果は同じになる。
    this.activeInput = this.autoDrive
      ? this.autoDriver.update(dt, {
          time: this.time,
          position: front,
          speed: this.dynamics.speed,
          route: this.scenario.route,
          consist: this.scenario.consist,
          signalling: this.signalling,
          dynamics: this.dynamics,
          brake: this.brake,
          nextStation: this.nextStation,
          safetyEmergency: this.safetyOutput.emergencyBrake,
          safetyWarning: this.safetyOutput.indication.bell,
          patternSpeed: this.safetyOutput.indication.patternSpeed,
        })
      : this.input;

    // 扉は指令に対して有限の時間をかけて動く。閉扉予告のチャイムもここで進む。
    this.doors.setCommand(this.activeInput.doorsClosed);
    this.doors.update(dt);

    if (this.activeInput.safetyReset && Math.abs(this.dynamics.speed) < 0.05) {
      this.safety.reset();
    }

    // 5. 指令と保安装置の出力を合成する
    const emergency = this.activeInput.emergency || this.safetyOutput.emergencyBrake;
    let brakeNotch = this.activeInput.brakeNotch;
    if (this.safetyOutput.serviceBrakeNotch !== null) {
      brakeNotch = Math.max(
        brakeNotch,
        Math.min(this.safetyOutput.serviceBrakeNotch, this.scenario.consist.brake.notchCount),
      );
    }
    const cutOff = this.safetyOutput.cutOffTraction || emergency || brakeNotch > 0;
    // 戸閉連動は**指令ではなく扉の実際の状態**で判定する。実車の力行回路も、
    // 全部の扉が閉じて施錠されたことを確かめる接点を通っている。閉指令を出しても
    // 閉まり切るまでは力行できない。
    const powerNotch =
      cutOff || this.activeInput.reverser === 0 || !this.doors.interlocked
        ? 0
        : this.activeInput.powerNotch;

    // 抑速位置は段を持たないので、装置が速度を見て段を選ぶ。常用ブレーキを込めたら
    // 抑速は外れる（ブレーキ装置は常用が切のときだけ抑速を見る）ので、そこも渡す
    // 条件に含める。切れた時点で調速器は目標速度を忘れ、入れ直しで取り直す。
    const notchCount = this.scenario.consist.brake.notchCount;
    const serviceNotch = clamp(brakeNotch, 0, notchCount);
    const holdingEngaged =
      this.activeInput.holding &&
      this.scenario.consist.brake.hasHoldingBrake &&
      powerNotch === 0 &&
      serviceNotch === 0 &&
      !emergency;
    const regulated = this.holdingRegulator.update(
      dt,
      holdingEngaged,
      Math.abs(this.dynamics.speed),
      notchCount,
    );

    const brakeCommand: BrakeCommand = {
      notch: serviceNotch,
      emergency,
      holdingNotch:
        powerNotch > 0 ? 0 : this.activeInput.holding ? regulated : this.activeInput.holdingNotch,
      backup: this.activeInput.backupBrake,
      snowproof: this.activeInput.snowproofBrake,
    };

    // 6. ブレーキ → 動力の順に更新する（電空協調で電気ブレーキ量が決まるため）
    const brakeCtx = {
      dynamics: this.dynamics,
      traction: this.traction,
      loadFactor: this.scenario.loadFactor,
      regenerationReceptivity: this.scenario.regenerationReceptivity,
      lineVoltage: 1500,
      railCondition: this.scenario.railCondition,
    };
    this.brake.setCommand(brakeCommand);
    this.brake.update(dt, brakeCtx);

    this.traction.setNotch(powerNotch);
    this.traction.update(dt, {
      dynamics: this.dynamics,
      loadFactor: this.scenario.loadFactor,
      regenerationReceptivity: this.scenario.regenerationReceptivity,
      lineVoltage: 1500,
      // 逆転機が後位なら牽引力の向きを反転する（入換程度の低速後退を想定）
      direction: this.activeInput.reverser === -1 ? -1 : 1,
    });

    // 7. 補機（空気圧縮機）。ブレーキの物理には影響しないが、BC へ込めたぶん
    //    元空気溜めが減るので、ブレーキを使うほど早く回り出す。
    const cylinderPressure = this.brake.averageCylinderPressure();
    const fillRate = dt > 0 ? Math.max(0, cylinderPressure - this.lastCylinderPressure) / dt : 0;
    this.lastCylinderPressure = cylinderPressure;
    this.compressor.step(dt, fillRate * this.scenario.consist.vehicles.length);

    this.updateSafetyMetrics();
  }

  /**
   * 保安装置へ渡す文脈。
   *
   * 操作の有無（EB 装置の判定に使う）は、前の制御周期で実際に装置へ渡った指令から見る。
   * 自動運転中は装置が連続して指令を出しているので、無操作の監視は成立しない。
   */
  private safetyContext(front: Meters, previousFront: Meters): SafetyContext {
    const current = this.autoDrive ? this.activeInput : this.input;
    const anyOperation =
      this.autoDrive ||
      current.powerNotch !== this.previousInput.powerNotch ||
      current.brakeNotch !== this.previousInput.brakeNotch ||
      current.horn ||
      current.acknowledge ||
      current.emergency !== this.previousInput.emergency;
    return {
      time: this.time,
      position: front,
      previousPosition: previousFront,
      speed: this.dynamics.speed,
      signalling: this.signalling,
      driver: {
        acknowledge: current.acknowledge && !this.previousAcknowledge,
        anyOperation,
      },
      lineSpeedLimit: this.scenario.route.maxSpeed,
      currentSpeedLimit: this.currentSpeedLimit,
    };
  }

  private sampleMetrics(dt: Seconds): void {
    const dyn = this.dynamics;
    const lateral = this.scenario.route.alignment.lateralAcceleration(dyn.frontPosition, dyn.speed);
    let resistancePower = 0;
    let brakePower = 0;
    for (const veh of dyn.vehicles) {
      resistancePower +=
        Math.abs(veh.runningResistanceForce + veh.curveResistanceForce) * Math.abs(veh.v);
      for (const ax of veh.axles) {
        brakePower += Math.abs(ax.brakeTorque * ax.omega);
      }
    }
    const stance = dyn.vehicles[0]!.body.passenger.stance;
    this.metrics.sample({
      dt,
      acceleration: dyn.acceleration,
      lateralAcceleration: lateral,
      couplerForce: dyn.maxCouplerForce,
      electricPower: this.traction.state.power,
      resistancePower,
      brakePower,
      stagger: stance.stagger,
      passengerSteps: stance.steps,
    });
  }

  private updateSafetyMetrics(): void {
    const m = this.metrics.safety;
    if (this.safetyOutput.emergencyBrake) {
      if (!this.emergencyLatched) m.emergencyBrakeCount++;
      this.emergencyLatched = true;
    } else {
      this.emergencyLatched = false;
    }
    if (this.safetyOutput.serviceBrakeNotch !== null) {
      if (!this.patternLatched) m.patternBrakeCount++;
      this.patternLatched = true;
    } else {
      this.patternLatched = false;
    }
    if (this.safetyOutput.indication.bell) {
      if (!this.warningLatched) m.atsWarningCount++;
      this.warningLatched = true;
    } else {
      this.warningLatched = false;
    }
    if (this.dynamics.anySlipping) {
      if (!this.slipLatched) m.slipEvents++;
      this.slipLatched = true;
    } else {
      this.slipLatched = false;
    }
    if (this.dynamics.anySliding) {
      if (!this.slideLatched) m.slideEvents++;
      this.slideLatched = true;
    } else {
      this.slideLatched = false;
    }
  }

  /** 駅の到着・停車・出発を管理する */
  private updateStations(dt: Seconds): void {
    const progress = this.nextStation;
    if (!progress) return;
    const station = progress.station;
    const front = this.dynamics.frontPosition;
    const stopped = Math.abs(this.dynamics.speed) < 0.05;

    if (station.isPass) {
      if (front > station.platformEnd) {
        progress.departed = true;
        progress.arrived = true;
        this.advanceStation();
      }
      return;
    }

    if (!progress.arrived) {
      const withinPlatform = front >= station.platformStart && front <= station.platformEnd + 50;
      if (stopped && withinPlatform) {
        progress.arrived = true;
        progress.arrivalTime = this.time;
        progress.stopError = front - station.stopPosition;
        this.metrics.recordStop({
          stationId: station.id,
          stationName: station.name,
          stopError: progress.stopError,
          arrivalTime: this.time,
          delay: station.arrivalTime === undefined ? null : this.time - station.arrivalTime,
          departureTime: null,
          departureDelay: null,
        } satisfies StopRecord);
      } else if (front > station.platformEnd + 50) {
        // 停止位置を大きく行き過ぎた場合は通過扱いとして次へ進む
        progress.arrived = true;
        progress.departed = true;
        this.advanceStation();
      }
      return;
    }

    if (!progress.departed) {
      progress.doorsOpen = this.doors.state.position > 0 && stopped;
      if (progress.doorsOpen || progress.dwellElapsed > 0) {
        progress.dwellElapsed += dt;
      }
      if (!stopped && front > station.stopPosition - 1) {
        progress.departed = true;
        progress.departureTime = this.time;
        const record = this.metrics.stops[this.metrics.stops.length - 1];
        if (record && record.stationId === station.id) {
          record.departureTime = this.time;
          record.departureDelay =
            station.departureTime === undefined ? null : this.time - station.departureTime;
        }
        this.advanceStation();
      }
    }
  }

  private advanceStation(): void {
    while (
      this.nextStationIndex < this.stations.length &&
      this.stations[this.nextStationIndex]!.departed
    ) {
      this.nextStationIndex++;
    }
  }

  /** 描画・記録用のスナップショット */
  snapshot(): SimSnapshot {
    const dyn = this.dynamics;
    const alignment = this.scenario.route.alignment;
    const nextStation = this.nextStation;
    const turnout = this.scenario.route.turnouts.next(dyn.frontPosition);
    const ringing = this.levelCrossings.nearestRinging(dyn.frontPosition);
    return {
      time: this.time,
      elapsed: this.elapsed,
      speed: dyn.speed,
      acceleration: dyn.acceleration,
      front: dyn.frontPosition,
      rear: dyn.rearPosition,
      grade: dyn.vehicles[0]!.grade,
      curvature: dyn.vehicles[0]!.curvature,
      cant: alignment.cantAt(dyn.frontPosition),
      cantDeficiency: alignment.cantDeficiencyAmount(dyn.frontPosition, dyn.speed),
      lateralAcceleration: alignment.lateralAcceleration(dyn.frontPosition, dyn.speed),
      body: dyn.vehicles[0]!.body,
      speedLimit: this.currentSpeedLimit,
      tractiveEffort: this.traction.state.tractiveEffort,
      motorCurrent: this.traction.state.motorCurrent,
      power: this.traction.state.power,
      powerNotch: this.traction.state.notch,
      brakeNotch: this.brake.state.command.notch,
      holdingNotch: this.brake.state.command.holdingNotch,
      emergency: this.brake.state.command.emergency,
      cylinderPressure: this.brake.averageCylinderPressure(),
      electricBrakeForce: this.brake.state.electricForce,
      airBrakeForce: this.brake.state.airForceActual,
      regenerationLost: this.brake.state.regenerationLost,
      antiSkidActive: this.brake.state.antiSkidActive,
      snowLoss: this.brake.state.snowLoss,
      reAdhesionFactor: this.traction.state.reAdhesionFactor,
      drive: this.traction.driveState,
      doors: this.doors.state,
      compressor: this.compressor.state,
      maxSlip: dyn.vehicles.reduce(
        (m, v) => v.axles.reduce((mm, a) => (Math.abs(a.slip) > Math.abs(mm) ? a.slip : mm), m),
        0,
      ),
      maxCouplerForce: dyn.maxCouplerForce,
      safety: this.safetyOutput,
      nextSignal: this.signalling.signalAhead(dyn.frontPosition) ?? null,
      nextStationName: nextStation?.station.name ?? null,
      distanceToStop: nextStation ? nextStation.station.stopPosition - dyn.frontPosition : null,
      nextTurnout: turnout ? { turnout, distance: turnout.position - dyn.frontPosition } : null,
      bridge: this.scenario.route.bridges.at(dyn.frontPosition) ?? null,
      crossing: ringing
        ? { state: ringing, distance: ringing.crossing.position - dyn.frontPosition }
        : null,
      passing: nearestPassingEncounter(
        dyn.frontPosition,
        dyn.speed,
        this.signalling.trainStates,
        this.scenario.route.adjacentTrack,
      ),
      autoDrive: this.autoDrive ? this.autoDriver.state : null,
    };
  }
}

/** 描画・グラフ用の 1 時点のスナップショット */
export interface SimSnapshot {
  time: Seconds;
  elapsed: Seconds;
  speed: MetersPerSecond;
  acceleration: number;
  front: Meters;
  rear: Meters;
  grade: number;
  curvature: number;
  /** カント [m] */
  cant: number;
  /** カント過不足量 [m]（正 = 不足、負 = 超過。曲線の左右によらない） */
  cantDeficiency: number;
  lateralAcceleration: number;
  /** 先頭車の車体動揺と体感加速度 */
  body: BodyMotionState;
  speedLimit: MetersPerSecond;
  tractiveEffort: number;
  motorCurrent: number;
  power: number;
  powerNotch: number;
  brakeNotch: number;
  /**
   * 抑速ブレーキのノッチ（0 = 切）。
   *
   * 常用ブレーキとは別系統で、電気ブレーキだけで下り勾配の速度を保つときに使う。
   * 常用ノッチが 0 のままでも制動力は出ているので、これを出さないと
   * 「ブレーキが掛かっているのに表示は切」という食い違いになる。
   */
  holdingNotch: number;
  emergency: boolean;
  cylinderPressure: number;
  electricBrakeForce: number;
  airBrakeForce: number;
  regenerationLost: boolean;
  antiSkidActive: boolean;
  /** 雪の噛み込みで落ちている制動力の割合 0..1 */
  snowLoss: number;
  reAdhesionFactor: number;
  /** 制御方式ごとの駆動装置の状態（変調 / 進段 / 通流率） */
  drive: DriveState;
  /** 客用扉（開閉の途中も含む） */
  doors: DoorState;
  /** 元空気溜めと空気圧縮機 */
  compressor: CompressorState;
  maxSlip: number;
  maxCouplerForce: number;
  safety: SafetyOutput;
  nextSignal: { state: { aspect: string; speed: number }; distance: number } | null;
  nextStationName: string | null;
  distanceToStop: number | null;
  /**
   * 次の分岐器（通過中ならその分岐器。距離は負になる）。
   * 開通方向と分岐側の制限速度が入っているので、手前で速度を落とす判断に使える。
   */
  nextTurnout: { turnout: Turnout; distance: Meters } | null;
  /** いま桁の上にいる橋りょう（明かり区間なら null） */
  bridge: Bridge | null;
  /**
   * いちばん近い鳴動中の踏切と、そこまでの距離 [m]（負 = 通過済み）。
   * 警報音は踏切のスピーカから鳴っているので、これが音源の位置になる。
   */
  crossing: { state: LevelCrossingState; distance: Meters } | null;
  /** 隣の線路の対向列車とのすれ違い（誰も来ていなければ null） */
  passing: PassingEncounter | null;
  /** 自動運転装置の状態（手動運転なら null） */
  autoDrive: AutoDriveState | null;
}

/** シナリオの指定に従って保安装置を組み立てる */
export function buildSafetySystems(scenario: Scenario): SafetySystem {
  const systems: SafetySystem[] = [];
  for (const kind of scenario.safetySystems) {
    systems.push(createSafetySystem(kind));
  }
  if (scenario.hasVigilance) systems.push(new VigilanceSystem());
  return new CompositeSafetySystem(systems);
}

export function createSafetySystem(kind: SafetySystemKind): SafetySystem {
  switch (kind) {
    case 'ats-sn':
      return new AtsSnSystem();
    case 'ats-p':
      return new AtsPSystem();
    case 'atc':
      return new AtcSystem();
    default:
      throw new Error(`未知の保安装置: ${String(kind)}`);
  }
}
