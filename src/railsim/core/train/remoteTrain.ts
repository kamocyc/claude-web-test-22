import { AirCompressor } from '../brake/compressor.ts';
import { ElectroPneumaticBrakeSystem } from '../brake/electroPneumatic.ts';
import type { BrakeCommand } from '../brake/types.ts';
import { DoorSystem } from '../door/index.ts';
import { clamp, firstOrderLag } from '../math/scalar.ts';
import {
  gradeAcceleration,
  specificCurveResistance,
  specificRunningResistance,
} from '../physics/resistance.ts';
import type { Alignment } from '../track/alignment.ts';
import { createTractionSystem } from '../traction/factory.ts';
import { equivalentMass } from '../traction/common.ts';
import type { TractionSystem } from '../traction/types.ts';
import type { Meters, MetersPerSecond, Newtons, Seconds } from '../units.ts';
import type { ConsistSpec } from '../vehicle/spec.ts';
import { TrainDynamics } from './dynamics.ts';

/** 制御周期 [s]。自列車の装置と同じ刻みで回す。 */
const CONTROL_DT = 0.01;

/**
 * 力行ノッチの追従の時定数 [s]。
 *
 * 運転士がノッチを選び直す速さにあたる。短くすると要求どおりの引張力へ素早く
 * 寄るが、ノッチが小刻みに動いて音が落ち着かない。
 */
const NOTCH_TIME = 0.5;

/** 力行と制動を切り替えるときの不感帯 [m/s^2] */
const NOTCH_DEAD_BAND = 0.05;

/** これ以下の速度では停車扱いにする [m/s] */
const STOPPED_SPEED = 0.05;

/** 他列車に与える走行状態 */
export interface RemoteTrainCommand {
  /** 先頭端の距離程 [m] */
  readonly leadPosition: Meters;
  /** 進行の向き（+1 = 距離程が増える向き） */
  readonly direction: 1 | -1;
  /** 速度の大きさ [m/s] */
  readonly speed: MetersPerSecond;
  /** 進行方向の加速度 [m/s^2]（正 = 加速） */
  readonly acceleration: number;
  /** 戸閉指令（省略時は戸閉め） */
  readonly doorsClosed?: boolean;
  /** 警笛（省略時は鳴らさない） */
  readonly horn?: boolean;
}

/**
 * ダイヤ上の他列車を、自列車とまったく同じ装置で走らせる。
 *
 * ダイヤ列車が持っているのは時刻に対する位置の折れ線だけで、
 * 「いま何ノッチか」「インバータのゲートが開いているか」「ブレーキシリンダに
 * 何 Pa 入っているか」は書かれていない。しかし音はすべてそこから出る。
 *
 * そこでこのクラスは、**位置から装置の状態を逆に求める**。
 *
 *  1. ダイヤの位置と速度を `TrainDynamics` へ直接書き込む（積分はしない）
 *  2. その速度・勾配・曲線から、ダイヤどおりに走るために車輪周へ要る力を求める
 *  3. その力を出すノッチを選び、**実物と同じ** `TractionSystem` /
 *     `ElectroPneumaticBrakeSystem` / `DoorSystem` / `AirCompressor` を回す
 *
 * 結果として出てくる `driveState` は、自列車のそれと同じ実装が同じ手順で
 * 作ったものである。インバータの変調も、抵抗制御のカム軸の進段も、
 * チョッパの通流率も、音のために別に作った近似ではない。
 *
 * **なぜ積分しないのか。** ダイヤ列車の位置はダイヤが決めており、装置の出力で
 * 動かしてしまうとダイヤからずれる。実車の運転士も、ダイヤに合わせてノッチを
 * 選んでいるのであって、ノッチの結果としてダイヤが決まるのではない。
 *
 * **速度は大きさで渡す。** 装置が見ているのは輪軸の回転であって距離程ではない。
 * 対向列車は距離程の減る向きへ走るが、その車輪は前へ回っており、電動機も前へ
 * 回している。向きを持つのは位置だけで、装置はどちらへ走っていても同じに動く。
 */
export class RemoteTrain {
  readonly dynamics: TrainDynamics;
  readonly traction: TractionSystem;
  readonly brake: ElectroPneumaticBrakeSystem;
  readonly doors: DoorSystem;
  readonly compressor = new AirCompressor();

  /** ダイヤどおりに走るために車輪周へ要る力 [N]（正 = 力行） */
  requiredForce: Newtons = 0;
  /** いま選ばれている力行ノッチ */
  powerNotch = 0;
  /** いま選ばれている常用ブレーキノッチ */
  brakeNotch = 0;
  /** 警笛を鳴らしているか */
  horn = false;

  private readonly consist: ConsistSpec;
  private readonly alignment: Alignment;
  private readonly loadFactor: number;
  private readonly massEquivalent: number;
  /** 連続量としてのトルク指令率 0..1（ノッチへ丸める前）。運転士の手にあたる。 */
  private torqueDemand = 0;
  private accumulator = 0;
  private lastCylinderPressure = 0;
  private command: RemoteTrainCommand;

  constructor(
    consist: ConsistSpec,
    alignment: Alignment,
    initial: RemoteTrainCommand,
    loadFactor = 0,
  ) {
    this.consist = consist;
    this.alignment = alignment;
    this.loadFactor = loadFactor;
    this.dynamics = new TrainDynamics(consist, alignment, {
      loadFactor,
      initialFrontPosition: initial.leadPosition,
      initialSpeed: initial.speed,
    });
    this.traction = createTractionSystem(consist);
    this.brake = new ElectroPneumaticBrakeSystem(consist, { controlPeriod: CONTROL_DT });
    this.doors = new DoorSystem(consist.door);
    this.massEquivalent = equivalentMass(consist, loadFactor);
    this.command = initial;
    this.place(initial);
    this.runControl(CONTROL_DT);
  }

  /** 先頭端の距離程 [m]（進行方向の先の端） */
  get leadPosition(): Meters {
    return this.command.leadPosition;
  }

  get direction(): 1 | -1 {
    return this.command.direction;
  }

  /** 速度の大きさ [m/s] */
  get speed(): MetersPerSecond {
    return this.command.speed;
  }

  /**
   * ダイヤの状態を反映して装置を進める。
   *
   * 制御周期は自列車と揃えてある。呼ぶ側のフレーム間隔に依らず同じ結果になるよう、
   * 端数は次の呼び出しへ持ち越す。
   */
  update(dt: Seconds, command: RemoteTrainCommand): void {
    this.command = command;
    this.place(command);
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= CONTROL_DT - 1e-9 && steps < 200) {
      this.runControl(CONTROL_DT);
      this.accumulator -= CONTROL_DT;
      steps++;
    }
    if (steps >= 200) this.accumulator = 0;
  }

  /**
   * ダイヤの位置と速度を各車へ書き込む。
   *
   * 編成は先頭端から**進行方向の後ろへ**伸びる。対向列車では距離程の大きい側が
   * 後ろになるので、向きを掛けて並べる。
   *
   * 勾配も向きで符号が変わる。同じ坂でも、登る向きに走っていれば上り勾配であり、
   * 反対から来る列車にとっては下り勾配である。
   */
  private place(cmd: RemoteTrainCommand): void {
    const vehicles = this.dynamics.vehicles;
    let cursor = cmd.leadPosition;
    for (const veh of vehicles) {
      const half = veh.spec.length / 2;
      const centre = cursor - cmd.direction * half;
      veh.s = centre;
      veh.v = cmd.speed;
      veh.a = cmd.acceleration;
      veh.grade = cmd.direction * this.alignment.averageGrade(centre - half, centre + half);
      veh.curvature = this.alignment.averageCurvature(centre - half, centre + half);
      veh.radius = Math.abs(veh.curvature) < 1e-9 ? Infinity : 1 / Math.abs(veh.curvature);
      // 装置が見ているのは車輪の回転。空転・滑走は積分していないので、
      // 車輪は車速どおりに回っている。
      const omega = cmd.speed / (veh.spec.wheelDiameter / 2);
      for (const ax of veh.axles) {
        ax.omega = omega;
        ax.slip = 0;
      }
      cursor -= cmd.direction * veh.spec.length;
    }
  }

  /**
   * ダイヤどおりに走るために車輪周へ要る力 [N]。
   *
   *   F = M_等価 a + R_走行 + R_曲線 - F_勾配
   *
   * 自列車が解いているつり合いをそのまま逆に読んだだけである。正なら力行、
   * 負なら制動が要る。下り勾配で惰行すれば負になり、そのまま抑速の判断になる。
   */
  private computeRequiredForce(): Newtons {
    const v = this.command.speed;
    let resistance = 0;
    let gradeForce = 0;
    for (const veh of this.dynamics.vehicles) {
      const spec = veh.spec;
      resistance +=
        veh.mass *
        (specificRunningResistance(spec.runningResistance, v) +
          specificCurveResistance(this.consist.curveResistanceCoefficient, veh.radius));
      gradeForce += veh.mass * gradeAcceleration(veh.grade);
    }
    return this.massEquivalent * this.command.acceleration + resistance - gradeForce;
  }

  /** 装置制御（100 Hz）。自列車の `Simulation.runControl` と同じ順序で回す。 */
  private runControl(dt: Seconds): void {
    const required = this.computeRequiredForce();
    this.requiredForce = required;
    this.chooseNotches(dt, required);

    // 扉。停車していなければ閉、停車していれば指令どおり。
    const doorsClosed = this.command.doorsClosed ?? true;
    this.doors.setCommand(this.command.speed > STOPPED_SPEED ? true : doorsClosed);
    this.doors.update(dt);
    this.horn = this.command.horn ?? false;

    const powerNotch = this.brakeNotch > 0 || !this.doors.interlocked ? 0 : this.powerNotch;
    const brakeCommand: BrakeCommand = {
      notch: this.brakeNotch,
      emergency: false,
      holdingNotch: 0,
      backup: false,
      snowproof: false,
    };

    // ブレーキ → 動力の順（電空協調で電気ブレーキの分担が決まるため）
    const ctx = {
      dynamics: this.dynamics,
      traction: this.traction,
      loadFactor: this.loadFactor,
      regenerationReceptivity: 1,
      lineVoltage: 1500,
    };
    this.brake.setCommand(brakeCommand);
    this.brake.update(dt, ctx);
    this.traction.setNotch(powerNotch);
    this.traction.update(dt, ctx);

    const cylinderPressure = this.brake.averageCylinderPressure();
    const fillRate = dt > 0 ? Math.max(0, cylinderPressure - this.lastCylinderPressure) / dt : 0;
    this.lastCylinderPressure = cylinderPressure;
    this.compressor.step(dt, fillRate * this.consist.vehicles.length);
  }

  /**
   * 要る力からノッチを選ぶ（運転士の代わり）。
   *
   * **制動側**はノッチと減速度が 1 対 1 に決まっているので、要る減速度を出せる
   * いちばん軽いノッチをそのまま選べる。実車の運転士の選び方と同じである。
   *
   * **力行側**にはそういう対応表が無い。ノッチが作る引張力は速度で変わる
   * （定トルク・定出力・特性の 3 領域）ので、装置に入れてみるまで分からない。
   * そこで**いま出ている引張力からトルク指令率あたりの引張力を測り**、それで
   * 要る力を割って必要な指令率を出す。
   *
   *   引張力 / トルク指令率 = そのときの全ノッチ相当の引張力
   *   必要な指令率 = 要る力 / それ
   *
   * 力行していないあいだはこの測定ができないので、設計減速度と同じ桁の加速度を
   * 出す力を全ノッチ相当と見なして呼び水にする。1 周期でも力行すれば実測へ
   * 置き換わるので、この初期値は結果に残らない。
   *
   * 最後に、指令率をいちばん近いノッチへ丸める。手はゆっくりしか動かないので
   * 一次遅れを噛ませてあり、これが無いと 1 ノッチ跨ぎで行ったり来たりする。
   */
  private chooseNotches(dt: Seconds, required: Newtons): void {
    const deadBand = NOTCH_DEAD_BAND * this.massEquivalent;
    if (required < -deadBand) {
      // 制動側。要る減速度を出せるいちばん軽いノッチを選ぶ。
      const target = -required / this.dynamics.totalMass;
      let notch = 0;
      for (let n = 1; n <= this.consist.brake.notchCount; n++) {
        notch = n;
        if (this.brake.decelerationForNotch(n) >= target) break;
      }
      this.brakeNotch = notch;
      this.torqueDemand = firstOrderLag(this.torqueDemand, 0, NOTCH_TIME, dt);
      this.powerNotch = 0;
      return;
    }

    this.brakeNotch = 0;
    const state = this.traction.state;
    const fullEffort =
      state.torqueCommand > 0.02 && state.tractiveEffort > 1
        ? state.tractiveEffort / state.torqueCommand
        : this.massEquivalent * this.consist.brake.maxServiceDeceleration;
    const wanted = required <= deadBand ? 0 : clamp(required / fullEffort, 0, 1);
    this.torqueDemand = firstOrderLag(this.torqueDemand, wanted, NOTCH_TIME, dt);
    this.powerNotch = wanted <= 0 ? 0 : this.nearestNotch(this.torqueDemand);
  }

  /** 指令率にいちばん近い力行ノッチ（1 以上） */
  private nearestNotch(ratio: number): number {
    const ratios = this.consist.traction.notchTorqueRatio;
    let best = 1;
    let bestError = Infinity;
    for (let n = 1; n <= this.consist.traction.notchCount; n++) {
      const error = Math.abs((ratios[n - 1] ?? n / this.consist.traction.notchCount) - ratio);
      if (error < bestError) {
        bestError = error;
        best = n;
      }
    }
    return best;
  }
}
