import type { Alignment } from '../track/alignment.ts';
import type { AdhesionConditions } from '../physics/adhesion.ts';
import { peakAdhesion, travelSign } from '../physics/adhesion.ts';
import { computeAxleLoads, solveAxle, type AxleSolveResult } from '../physics/axle.ts';
import { couplerForce } from '../physics/coupler.ts';
import { SMOOTH_TRACK, type TrackIrregularity } from '../physics/irregularity.ts';
import { NO_LEVEL_CROSSINGS, type LevelCrossingTrack } from '../track/levelCrossing.ts';
import { NO_TURNOUTS, type TurnoutTrack } from '../track/turnout.ts';
import { CarBodyMotion, type BodyMotionState } from './bodyMotion.ts';
import {
  gradeAcceleration,
  specificCurveResistance,
  specificRunningResistance,
} from '../physics/resistance.ts';
import { GRAVITY, type Meters, type MetersPerSecond, type Newtons } from '../units.ts';
import { axleInertia, vehicleMass, type ConsistSpec, type VehicleSpec } from '../vehicle/spec.ts';
import { clamp, sign } from '../math/scalar.ts';

/** 停止判定に用いる速度のしきい値 [m/s] */
const V_EPS = 1e-3;

/** 1 軸の実行時状態 */
export interface AxleRuntime {
  /** 車輪角速度 [rad/s] */
  omega: number;
  /** すべり率 */
  slip: number;
  /** レールに作用する長手力 [N] */
  creepForce: Newtons;
  /** 軸重 [N] */
  load: Newtons;
  /** 動軸か */
  readonly driven: boolean;
  /** 基礎ブレーキが作用する軸か */
  readonly braked: boolean;
  /** 指令された駆動トルク [N*m]（正 = 力行、負 = 電気ブレーキ） */
  driveTorque: number;
  /** 指令された機械ブレーキトルクの大きさ [N*m] */
  brakeTorque: number;
  /** そのステップで利用可能だった粘着力の上限 [N] */
  adhesionLimit: Newtons;
  /** 空転中か */
  slipping: boolean;
  /** 滑走中か */
  sliding: boolean;
}

/** 1 両の実行時状態 */
export interface VehicleRuntime {
  readonly spec: VehicleSpec;
  readonly index: number;
  /** 質量 [kg]（乗車率を含む） */
  mass: number;
  /** 車両中心の距離程 [m] */
  s: Meters;
  /** 速度 [m/s] */
  v: MetersPerSecond;
  /** 加速度 [m/s^2]（前ステップの結果） */
  a: number;
  /** 車体長にわたる平均勾配 [m/m] */
  grade: number;
  /** 車体長にわたる平均曲率 [1/m] */
  curvature: number;
  /** 曲線半径 [m] */
  radius: number;
  readonly axles: AxleRuntime[];
  /** 勾配による力 [N] */
  gradeForce: Newtons;
  /** 走行抵抗 [N]（進行方向に対して負） */
  runningResistanceForce: Newtons;
  /** 曲線抵抗 [N] */
  curveResistanceForce: Newtons;
  /** 前側連結器から受ける力 [N]（正 = 前へ引かれる） */
  frontCouplerForce: Newtons;
  /** 後側連結器から受ける力 [N]（正 = 前へ押される） */
  rearCouplerForce: Newtons;
  /** レール面の長手力（クリープ力の合計）[N] */
  railForce: Newtons;
  /** トンネル内か */
  inTunnel: boolean;
  /** 車体の動揺（ロール・ピッチ・ヨー・左右・上下）と体感加速度 */
  readonly body: BodyMotionState;
}

export interface DynamicsEnvironment {
  /** 粘着条件（砂撒きの入切などでステップごとに変わりうる） */
  adhesion: AdhesionConditions;
  /** 指定距離程がトンネル内かどうか */
  isTunnel(s: Meters): boolean;
}

export interface DynamicsOptions {
  /** 乗車率（0 = 空車、1 = 定員相当） */
  readonly loadFactor?: number;
  /** 列車を単一剛体として扱う（BVE 相当の単一質点モード） */
  readonly rigidConsist?: boolean;
  /** 先頭車の初期位置（先頭端の距離程）[m] */
  readonly initialFrontPosition?: Meters;
  /** 初速 [m/s] */
  readonly initialSpeed?: MetersPerSecond;
  /** 軌道狂い（省略時は狂いなし） */
  readonly irregularity?: TrackIrregularity;
  /** 分岐器（省略時は分岐器なし）。局所的な軌道狂いとして軌道狂いに重なる。 */
  readonly turnouts?: TurnoutTrack;
  /** 踏切（省略時は踏切なし）。踏切板と舗装の段差が同じく局所的な狂いになる。 */
  readonly levelCrossings?: LevelCrossingTrack;
}

const scratchResult: AxleSolveResult = { omega: 0, creepForce: 0, slip: 0 };

/** 停止保持に使えるレール面の長手力の範囲 [N] */
interface StickRange {
  min: Newtons;
  max: Newtons;
}

/**
 * 外力 `external` を打ち消してその場に留まれるかを判定する。
 *
 * 静止摩擦の範囲（レール面の `range` と静止時の転がり抵抗 `staticResistance`）に
 * 必要な力が収まっていれば、レール面が受け持つ力 [N] を返す。収まらなければ
 * `null`（動き出す）。
 */
function holdForce(
  range: StickRange,
  external: Newtons,
  staticResistance: Newtons,
): Newtons | null {
  const needed = -external;
  if (needed < range.min - staticResistance || needed > range.max + staticResistance) return null;
  return clamp(needed, range.min, range.max);
}

/**
 * 列車の縦方向運動を解く多質点ダイナミクス。
 *
 * 各車両は自分の距離程で勾配・曲率を参照し、連結器を介して力をやり取りする。
 * これにより、長編成が勾配変化点を通過するときの前後衝動や、
 * 力行・惰行の切り替え時に遊間を詰める衝撃が自然に現れる。
 *
 * 各輪軸は独立した回転自由度を持ち、クリープ力を介して車体と結合する。
 * 粘着限界は「力の頭打ち」ではなくクリープ曲線の形状から自然に生じるため、
 * 空転・滑走とその収束（再粘着）が現象として再現される。
 */
export class TrainDynamics {
  readonly consist: ConsistSpec;
  readonly alignment: Alignment;
  readonly vehicles: VehicleRuntime[] = [];
  /** 連結器 i は車両 i と i+1 のあいだ。正 = 引張。 */
  readonly couplerForces: Float64Array;
  readonly rigid: boolean;
  readonly loadFactor: number;
  /** 車両中心間の設計距離 [m] */
  private readonly nominalGap: Float64Array;
  private readonly axleLoadScratch: Float64Array;
  private readonly bodyMotions: CarBodyMotion[] = [];
  /** 軌道狂い（距離程の関数。同じ場所では常に同じ揺れになる） */
  readonly irregularity: TrackIrregularity;
  /** 分岐器（同じく距離程の関数。トングレールと欠線が局所的な狂いになる） */
  readonly turnouts: TurnoutTrack;
  /** 踏切（同じく距離程の関数。踏切板の段差が局所的な狂いになる） */
  readonly levelCrossings: LevelCrossingTrack;
  /** 編成の総質量 [kg] */
  readonly totalMass: number;

  constructor(consist: ConsistSpec, alignment: Alignment, options: DynamicsOptions = {}) {
    this.consist = consist;
    this.alignment = alignment;
    this.rigid = options.rigidConsist ?? false;
    this.loadFactor = options.loadFactor ?? 0;
    this.irregularity = options.irregularity ?? SMOOTH_TRACK;
    this.turnouts = options.turnouts ?? NO_TURNOUTS;
    this.levelCrossings = options.levelCrossings ?? NO_LEVEL_CROSSINGS;

    const n = consist.vehicles.length;
    this.couplerForces = new Float64Array(Math.max(0, n - 1));
    this.nominalGap = new Float64Array(Math.max(0, n - 1));
    let maxAxles = 0;

    const front = options.initialFrontPosition ?? 0;
    const v0 = options.initialSpeed ?? 0;
    let cursor = front;
    for (let i = 0; i < n; i++) {
      const spec = consist.vehicles[i]!;
      maxAxles = Math.max(maxAxles, spec.axleCount);
      const mass = vehicleMass(spec, this.loadFactor);
      const center = cursor - spec.length / 2;
      const axles: AxleRuntime[] = [];
      const r = spec.wheelDiameter / 2;
      for (let k = 0; k < spec.axleCount; k++) {
        axles.push({
          omega: v0 / r,
          slip: 0,
          creepForce: 0,
          load: (mass * GRAVITY) / spec.axleCount,
          driven: k < spec.drivenAxleCount,
          braked: k < Math.round(spec.axleCount * spec.brake.brakedAxleRatio),
          driveTorque: 0,
          brakeTorque: 0,
          adhesionLimit: 0,
          slipping: false,
          sliding: false,
        });
      }
      this.bodyMotions.push(new CarBodyMotion(spec.suspension, spec.passenger));
      this.vehicles.push({
        spec,
        index: i,
        mass,
        s: center,
        v: v0,
        a: 0,
        grade: 0,
        curvature: 0,
        radius: Infinity,
        axles,
        gradeForce: 0,
        runningResistanceForce: 0,
        curveResistanceForce: 0,
        frontCouplerForce: 0,
        rearCouplerForce: 0,
        railForce: 0,
        inTunnel: false,
        body: this.bodyMotions[i]!.state,
      });
      if (i > 0) {
        this.nominalGap[i - 1] = (consist.vehicles[i - 1]!.length + spec.length) / 2;
      }
      cursor -= spec.length;
    }
    this.axleLoadScratch = new Float64Array(Math.max(1, maxAxles));
    this.totalMass = this.vehicles.reduce((a, v) => a + v.mass, 0);
    this.updateGeometry();
  }

  /** 先頭端の距離程 [m] */
  get frontPosition(): Meters {
    const v0 = this.vehicles[0]!;
    return v0.s + v0.spec.length / 2;
  }

  /** 最後尾端の距離程 [m] */
  get rearPosition(): Meters {
    const last = this.vehicles[this.vehicles.length - 1]!;
    return last.s - last.spec.length / 2;
  }

  /** 代表速度（先頭車の速度）[m/s] */
  get speed(): MetersPerSecond {
    return this.vehicles[0]!.v;
  }

  /** 編成の平均加速度 [m/s^2] */
  get acceleration(): number {
    let sum = 0;
    for (const v of this.vehicles) sum += v.a * v.mass;
    return sum / this.totalMass;
  }

  /** 全車両を同じ速度に揃える（初期化・リセット用） */
  setSpeed(v: MetersPerSecond): void {
    for (const veh of this.vehicles) {
      veh.v = v;
      const r = veh.spec.wheelDiameter / 2;
      for (const ax of veh.axles) ax.omega = v / r;
    }
  }

  /** 先頭端の距離程を指定して編成全体を配置し直す */
  setFrontPosition(front: Meters): void {
    let cursor = front;
    for (const veh of this.vehicles) {
      veh.s = cursor - veh.spec.length / 2;
      cursor -= veh.spec.length;
    }
    this.updateGeometry();
  }

  private updateGeometry(): void {
    for (const veh of this.vehicles) {
      const half = veh.spec.length / 2;
      veh.grade = this.alignment.averageGrade(veh.s - half, veh.s + half);
      veh.curvature = this.alignment.averageCurvature(veh.s - half, veh.s + half);
      veh.radius = Math.abs(veh.curvature) < 1e-9 ? Infinity : 1 / Math.abs(veh.curvature);
    }
  }

  /**
   * 1 サブステップ（既定 1 ms）進める。
   * 駆動トルク・ブレーキトルクは呼び出し側（動力系・ブレーキ系）が
   * 各輪軸の `driveTorque` / `brakeTorque` に設定しておく。
   */
  step(dt: number, env: DynamicsEnvironment): void {
    this.updateGeometry();
    const n = this.vehicles.length;

    // --- 連結器力 ---
    if (!this.rigid) {
      for (let i = 0; i < n - 1; i++) {
        const a = this.vehicles[i]!;
        const b = this.vehicles[i + 1]!;
        const delta = a.s - b.s - this.nominalGap[i]!;
        const rate = a.v - b.v;
        this.couplerForces[i] = couplerForce(this.consist.coupler, delta, rate);
      }
    } else {
      this.couplerForces.fill(0);
    }

    // --- 各車両の力を積み上げる ---
    let rigidDriving = 0;
    let rigidResistive = 0;
    let rigidStaticResistive = 0;
    let rigidExternal = 0;
    let rigidStick: StickRange | null = { min: 0, max: 0 };
    let rigidStandstill = true;
    const vRef = this.rigid ? this.vehicles[0]!.v : 0;

    for (let i = 0; i < n; i++) {
      const veh = this.vehicles[i]!;
      const spec = veh.spec;
      veh.inTunnel = env.isTunnel(veh.s);

      // 軸重（前ステップのレール力による荷重移動を含む）
      computeAxleLoads(spec, veh.mass, veh.railForce, this.axleLoadScratch);

      // 輪軸の回転を解き、クリープ力を求める
      const r = spec.wheelDiameter / 2;
      const J = axleInertia(spec);
      const mu = peakAdhesion(this.consist.adhesion, veh.v, env.adhesion);
      let railForce = 0;
      for (let k = 0; k < veh.axles.length; k++) {
        const ax = veh.axles[k]!;
        ax.load = this.axleLoadScratch[k]!;
        const res = solveAxle(
          {
            inertia: J,
            radius: r,
            driveTorque: ax.driveTorque,
            brakeTorque: ax.brakeTorque,
            load: ax.load,
            vehicleSpeed: veh.v,
            omega: ax.omega,
            peakAdhesion: mu,
            peakCreep: this.consist.adhesion.peakCreep,
            kineticRatio: this.consist.adhesion.kineticRatio,
            creepReferenceSpeed: this.consist.adhesion.creepReferenceSpeed,
            dt,
          },
          scratchResult,
        );
        ax.omega = res.omega;
        ax.slip = res.slip;
        ax.creepForce = res.creepForce;
        ax.adhesionLimit = mu * ax.load;
        const slipMag = Math.abs(res.slip) / this.consist.adhesion.peakCreep;
        // 空転（車輪が速い）と滑走（車輪が遅い）は進行方向に対して見る。
        // 後退中はすべり率の符号が裏返るので、進行方向の符号を掛けてそろえる。
        const signedSlip = res.slip * travelSign(veh.v);
        ax.slipping = signedSlip > 0 && slipMag > 1;
        ax.sliding = signedSlip < 0 && slipMag > 1;
        railForce += res.creepForce;
      }
      veh.railForce = railForce;

      // 勾配・曲線・走行抵抗
      veh.gradeForce = veh.mass * gradeAcceleration(veh.grade);
      const tunnelFactor = veh.inTunnel ? this.consist.tunnelResistanceFactor : 1;
      const v = this.rigid ? vRef : veh.v;
      const rRun = specificRunningResistance(spec.runningResistance, v, tunnelFactor);
      const rCurve = specificCurveResistance(this.consist.curveResistanceCoefficient, veh.radius);
      const resistiveMagnitude = veh.mass * (rRun + rCurve);
      const staticMagnitude = veh.mass * (spec.runningResistance.a + rCurve);

      const frontCoupler = i > 0 ? this.couplerForces[i - 1]! : 0;
      const rearCoupler = i < n - 1 ? this.couplerForces[i]! : 0;
      // 前側連結器が引張なら前へ引かれる、後側連結器が引張なら後ろへ引かれる
      veh.frontCouplerForce = frontCoupler;
      veh.rearCouplerForce = -rearCoupler;

      // レール面以外の外力。停止保持ではこれをレール面の摩擦が打ち消す。
      const external = veh.gradeForce + veh.frontCouplerForce + veh.rearCouplerForce;
      const driving = railForce + external;
      // 停止していれば、静止摩擦でその場に留まれるかを判定する
      const standstill = Math.abs(veh.v) < V_EPS;
      const stick = standstill ? this.stickRange(veh, mu) : null;

      if (this.rigid) {
        rigidDriving += driving;
        rigidResistive += resistiveMagnitude;
        rigidStaticResistive += staticMagnitude;
        rigidExternal += external;
        if (!standstill || stick === null) rigidStandstill = false;
        if (rigidStick !== null && stick !== null) {
          rigidStick.min += stick.min;
          rigidStick.max += stick.max;
        } else {
          rigidStick = null;
        }
        // 個々の抵抗力は編成全体で解いた後に配分する
        veh.runningResistanceForce = 0;
        veh.curveResistanceForce = 0;
      } else {
        const hold = stick === null ? null : holdForce(stick, external, staticMagnitude);
        if (hold !== null) {
          this.holdAtStandstill(veh, hold, external);
        } else {
          const applied = this.applyResistance(veh.v, driving, resistiveMagnitude, staticMagnitude);
          // 走行抵抗と曲線抵抗の内訳（診断用に比で分ける）
          const total = rRun + rCurve;
          const ratio = total > 0 ? rRun / total : 1;
          veh.runningResistanceForce = applied.resistance * ratio;
          veh.curveResistanceForce = applied.resistance * (1 - ratio);
          veh.a = applied.locked ? 0 : (driving + applied.resistance) / veh.mass;
          veh.v = applied.locked ? 0 : veh.v + veh.a * dt;
        }
      }
    }

    if (this.rigid) {
      const hold =
        rigidStandstill && rigidStick !== null
          ? holdForce(rigidStick, rigidExternal, rigidStaticResistive)
          : null;
      if (hold !== null) {
        // 保持力は各車が自重ぶんを受け持つものとして配分する
        for (const veh of this.vehicles) {
          const share = veh.mass / this.totalMass;
          this.holdAtStandstill(veh, hold * share, rigidExternal * share);
        }
      } else {
        const applied = this.applyResistance(
          vRef,
          rigidDriving,
          rigidResistive,
          rigidStaticResistive,
        );
        const a = applied.locked ? 0 : (rigidDriving + applied.resistance) / this.totalMass;
        const newV = applied.locked ? 0 : vRef + a * dt;
        for (const veh of this.vehicles) {
          veh.a = a;
          veh.v = newV;
          // 剛体モードでは抵抗を編成でまとめて解くため、内訳は均等配分して表示する
          veh.runningResistanceForce = applied.resistance / n;
          veh.curveResistanceForce = 0;
        }
      }
    }

    // --- 位置の更新（半陰的オイラー: 速度を更新してから位置を進める） ---
    for (const veh of this.vehicles) {
      veh.s += veh.v * dt;
    }

    // --- 車体の動揺 ---
    this.updateBodyMotion(dt);
  }

  /**
   * 各車の車体動揺を進める。
   *
   * 励振源は「曲線通過による非平衡横加速度」「前後加速度」「軌道狂い」「分岐器」
   * 「踏切」の 5 つ。軌道狂いは前後の台車位置で別々に読み取るので、前後台車の
   * 高低差がピッチングを、通り狂いの差がヨーイングを生む。分岐器のトングレールと
   * 欠線、踏切板と舗装の段差も、その場所にだけある軌道狂いとして同じ経路で効く。
   */
  private updateBodyMotion(dt: number): void {
    const gauge = this.alignment.gauge;
    for (let i = 0; i < this.vehicles.length; i++) {
      const veh = this.vehicles[i]!;
      const half = veh.spec.bogieSpacing / 2;
      const front = veh.s + half;
      const rear = veh.s - half;
      const irr = this.irregularity;
      const to = this.turnouts;
      const xg = this.levelCrossings;
      this.bodyMotions[i]!.step(dt, {
        unbalancedLateral: this.alignment.lateralAcceleration(veh.s, veh.v),
        cantAngle: this.alignment.cantAngleAt(veh.s),
        // 車体長にわたって平均した勾配（先頭が勾配へ入りかけている状態も表せる）
        gradeAngle: Math.atan(veh.grade),
        longitudinalAcceleration: veh.a,
        frontVertical: irr.verticalAt(front) + to.verticalAt(front) + xg.verticalAt(front),
        rearVertical: irr.verticalAt(rear) + to.verticalAt(rear) + xg.verticalAt(rear),
        frontLateral: irr.lateralAt(front) + to.lateralAt(front),
        rearLateral: irr.lateralAt(rear) + to.lateralAt(rear),
        crossLevel: irr.crossLevelAt(veh.s) + to.crossLevelAt(veh.s),
        bogieSpacing: veh.spec.bogieSpacing,
        gauge,
      });
    }
  }

  /**
   * 停止中にレール面が受け持てる長手力の範囲 [N]。
   *
   * 車輪が固着している（ブレーキの静止摩擦が車輪を保持している）とき、レール面の
   * 力は輪軸のトルクと釣り合う**拘束力**になる。輪軸のつり合い
   * `0 = T_drive + T_friction - r F` と `|T_friction| <= T_brake` から、1 軸あたり
   *
   *   F ∈ [(T_drive - T_brake)/r, (T_drive + T_brake)/r] ∩ [-μW, +μW]
   *
   * の範囲で任意の値を取れる。両端の意味はそのまま実車の挙動になる:
   *
   * - ブレーキが緩んでいれば範囲は `T_drive/r` の 1 点に潰れる。車輪が転がるので
   *   勾配上では必ず動き出す（駆動力が勾配とちょうど釣り合うときだけ止まる）。
   * - 非常ブレーキなら ±μW いっぱいまで使えるので、粘着が足りるかぎり停車を保つ。
   * - 粘着を超える駆動トルクが掛かっている軸があれば範囲が空になり（`null`）、
   *   空転として動き出す。
   */
  private stickRange(veh: VehicleRuntime, mu: number): StickRange | null {
    const r = veh.spec.wheelDiameter / 2;
    let min = 0;
    let max = 0;
    for (const ax of veh.axles) {
      const center = ax.driveTorque / r;
      const half = ax.brakeTorque / r;
      const limit = mu * ax.load;
      const lo = Math.max(-limit, center - half);
      const hi = Math.min(limit, center + half);
      if (lo > hi) return null;
      min += lo;
      max += hi;
    }
    return { min, max };
  }

  /**
   * 静止摩擦で停止を保持する。速度と加速度を 0 に固定し、
   * レール面の拘束力を軸重に比例して各軸へ配分する。
   */
  private holdAtStandstill(veh: VehicleRuntime, railForce: Newtons, external: Newtons): void {
    veh.v = 0;
    veh.a = 0;
    veh.railForce = railForce;

    let totalLoad = 0;
    for (const ax of veh.axles) totalLoad += ax.load;
    for (const ax of veh.axles) {
      const share = totalLoad > 0 ? ax.load / totalLoad : 1 / veh.axles.length;
      // 停止中は車輪も止まっている。すべりが無いので空転・滑走の表示も落とす。
      ax.omega = 0;
      ax.slip = 0;
      ax.slipping = false;
      ax.sliding = false;
      ax.creepForce = railForce * share;
    }
    // 残差は静止している車両の転がり抵抗が受け持つ（大きさは静止抵抗以下）
    veh.runningResistanceForce = -(external + railForce);
    veh.curveResistanceForce = 0;
  }

  /**
   * 走行抵抗・曲線抵抗を適用する。
   *
   * 抵抗は常に運動を妨げる向きに働くため、単純に -sign(v)*R とすると
   * 停止直前に速度が振動する。停止付近で駆動力が静止抵抗を下回るときは
   * 抵抗が駆動力を完全に打ち消して静止を保つ（静摩擦的な扱い）。
   */
  private applyResistance(
    v: number,
    driving: number,
    resistiveMagnitude: number,
    staticMagnitude: number,
  ): { resistance: number; locked: boolean } {
    if (Math.abs(v) < V_EPS) {
      if (Math.abs(driving) <= staticMagnitude) {
        return { resistance: -driving, locked: true };
      }
      return { resistance: -sign(driving) * resistiveMagnitude, locked: false };
    }
    return { resistance: -sign(v) * resistiveMagnitude, locked: false };
  }

  /** 全輪軸の駆動トルクを 0 にする */
  clearTorques(): void {
    for (const veh of this.vehicles) {
      for (const ax of veh.axles) {
        ax.driveTorque = 0;
        ax.brakeTorque = 0;
      }
    }
  }

  /** 空転中の軸があるか */
  get anySlipping(): boolean {
    return this.vehicles.some((v) => v.axles.some((a) => a.slipping));
  }

  /** 滑走中の軸があるか */
  get anySliding(): boolean {
    return this.vehicles.some((v) => v.axles.some((a) => a.sliding));
  }

  /** 連結器力の最大絶対値 [N] */
  get maxCouplerForce(): Newtons {
    let m = 0;
    for (const f of this.couplerForces) m = Math.max(m, Math.abs(f));
    return m;
  }
}
