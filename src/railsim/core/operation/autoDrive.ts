import type { BrakeSystem } from '../brake/types.ts';
import { clamp, firstOrderLag, inverseLerp, lerp } from '../math/scalar.ts';
import { gradeAcceleration } from '../physics/resistance.ts';
import { occupiedSpeedLimit } from '../route/types.ts';
import type { CompiledRoute, Station } from '../route/types.ts';
import type { SignallingSystem } from '../signalling/system.ts';
import { NEUTRAL_INPUT, type ControlInput } from '../sim/types.ts';
import type { TrainDynamics } from '../train/dynamics.ts';
import type {
  Meters,
  MetersPerSecond,
  MetersPerSecondSquared,
  Pascals,
  Seconds,
} from '../units.ts';
import type { ConsistSpec } from '../vehicle/spec.ts';

/** 自動運転装置の動作モード */
export type AutoDriveMode =
  /** 停車中（開扉・停車時分・発車待ち） */
  | 'standby'
  /** 力行 */
  | 'power'
  /** 惰行 */
  | 'coast'
  /** 抑速（速度を保つための連続したブレーキ） */
  | 'regulate'
  /** 速度制限へ寄せる制動 */
  | 'brake'
  /** 停止位置制御 */
  | 'stopping';

/** 自動運転装置から見た駅の取り扱い状態（`StationProgress` をそのまま渡せる） */
export interface AutoDriveStation {
  readonly station: Station;
  readonly arrived: boolean;
  readonly departed: boolean;
  readonly dwellElapsed: Seconds;
}

/**
 * 自動運転装置が参照する情報。
 *
 * `Simulation` を直接受け取らないのは、装置がシミュレーションの内部構造へ
 * 依存しないようにするため（保安装置・ブレーキ装置と同じ扱い）。
 */
export interface AutoDriveContext {
  readonly time: Seconds;
  /** 列車先頭端の距離程 [m] */
  readonly position: Meters;
  readonly speed: MetersPerSecond;
  readonly route: CompiledRoute;
  readonly consist: ConsistSpec;
  readonly signalling: SignallingSystem;
  readonly dynamics: TrainDynamics;
  readonly brake: BrakeSystem;
  /** 次に扱う駅 */
  readonly nextStation: AutoDriveStation | undefined;
  /** 保安装置が非常ブレーキを動作させているか（停止後に復帰扱いをする） */
  readonly safetyEmergency: boolean;
  /** 保安装置が警報を出しているか（確認扱いを要する） */
  readonly safetyWarning: boolean;
  /** 保安装置の照査速度 [m/s]（照査していなければ null） */
  readonly patternSpeed: MetersPerSecond | null;
}

/**
 * 自動運転装置の調整値。
 *
 * 「どれだけ余裕を取るか」「どれだけノッチを動かすか」という運転の作法にあたる量なので、
 * 車両の物理諸元とは分けてここに持つ。
 */
export interface AutoDriveParameters {
  /** 目標速度を制限速度からどれだけ低く取るか [m/s] */
  readonly speedMargin: MetersPerSecond;
  /**
   * 制限速度へこれだけ迫ったら、間隔をおかずに力行を切る [m/s]。
   *
   * 目標速度の余裕（`speedMargin`）を薄く取るほど、ノッチを 1 段ずつ運ぶ間に
   * 制限へ届いてしまう余地が残る。制限を越えないことだけは操作の作法より
   * 優先されるので、ここだけは間隔を無視して即座に抜く。
   */
  readonly ceilingGuard: MetersPerSecond;
  /** 保安装置の照査速度からどれだけ低く抑えるか [m/s] */
  readonly patternMargin: MetersPerSecond;
  /** 目標速度からこれだけ落ちたら再力行する [m/s] */
  readonly powerResumeBand: MetersPerSecond;
  /** 目標速度のこれだけ手前から力行ノッチを戻し始める [m/s] */
  readonly powerEaseBand: MetersPerSecond;
  /**
   * 力行ノッチを 1 段動かす間隔 [s]。
   *
   * 目標速度から離れているとき（発進・再力行・制動へ向けての抜き取り）に使う。
   * 運転士がハンドルを運ぶのと同じで、行き先が決まっているならためらわずに運ぶ。
   */
  readonly powerStepTime: Seconds;
  /**
   * 目標速度の近くで力行ノッチを 1 段動かす間隔 [s]。
   *
   * 制限直下を保っている最中の微調整はこちらを使う。速く動かすと段が行き来する
   * （`cruise()` の注記を参照）ので、ここだけは間隔をおいて落ち着かせる。
   */
  readonly powerHoldTime: Seconds;
  /**
   * これ以下までブレーキシリンダ圧が抜けるまで力行を立ち上げない [Pa]。
   *
   * ブレーキを込めたまま引張力を立ち上げると、抜け切った瞬間に引張力がそのまま
   * 加速度として出る。BC 圧はむだ時間と緩め時定数のぶん遅れて抜けるので、
   * 発車のたびにこの食い違いが起きて、立っている乗客はたたらを踏む。
   * 運転士がブレーキの緩解を待ってから力行するのと同じ扱いにする。
   */
  readonly powerReleasePressure: Pascals;
  /** 速度制限へ寄せるときの設計減速度 [m/s^2] */
  readonly approachDeceleration: MetersPerSecondSquared;
  /** 制動を緩解する必要減速度（設計減速度に対する比） */
  readonly releaseRatio: number;
  /** ブレーキの応答時間（空走時間）[s] */
  readonly responseTime: Seconds;
  /**
   * 速度制限の始端手前に取る余裕距離 [m]。
   *
   * 「制限の始端で制限速度に落ちていればよい」わけではない。ATS-P は制限の 20m
   * 手前を目標に設計減速度 0.7m/s²・空走 2 秒のパターンを張っていて、こちらの
   * 設計減速度 0.4m/s² のほうが緩いぶん、**残り 100m を切ったあたりで両者の曲線が
   * 交差する**。目標を制限の始端ちょうどに置くと、そこから始端までのわずかな
   * 区間だけパターンの上へ出てしまい、110km/h から 65km/h へ落とすような大きな
   * 減速では実際に触る。始端の手前に信号と同じだけ（45m）余裕を取れば、
   * 最後まで曲線がパターンの下を通る。
   */
  readonly limitMargin: Meters;
  /** 停止現示信号の手前に取る余裕距離 [m] */
  readonly signalMargin: Meters;
  /** 線路終端の手前に取る余裕距離 [m] */
  readonly terminusMargin: Meters;
  /** 減速目標を探す前方距離 [m] */
  readonly lookahead: Meters;
  /** 停止制動の基準減速度 [m/s^2] */
  readonly stopDeceleration: MetersPerSecondSquared;
  /**
   * 止まる瞬間の減速度 [m/s^2]（衝撃緩和の到達点）。
   *
   * 停止制動中は最弱ノッチ（B1）より緩めないので、実際に到達できるのは
   * B1 の減速度までである。ここはその上限（ノッチの粗い編成で、B1 でも
   * なお強すぎるときに効く）で、実効値は `finalDeceleration()` が決める。
   */
  readonly finalDeceleration: MetersPerSecondSquared;
  /** 減速度の絞り込み（衝撃緩和）を始める速度 [m/s] */
  readonly easeSpeed: MetersPerSecond;
  /** 停止制動の指令減速度の上限（目標減速度に対する比） */
  readonly stopDemandCap: number;
  /** 停止制動に入るこれだけ手前で力行をやめる [m] */
  readonly coastLead: Meters;
  /** 制動開始までこれだけの時間しか無ければ力行しない [s] */
  readonly coastLeadTime: Seconds;
  /** 常用ブレーキノッチを動かす最短間隔 [s] */
  readonly notchHoldTime: Seconds;
  /** ノッチを 1 段動かすしきい値（ノッチ 1 段の減速度に対する比） */
  readonly notchHysteresis: number;
  /** 一度に動かせる最大のノッチ段数（込め始めの衝動を抑える） */
  readonly maxNotchStep: number;
  /** 込め切るまでの段階操作の間隔 [s] */
  readonly applyStepTime: Seconds;
  /** これ以上足りなければ緩解直後でも込め直す（1 段の減速度に対する比） */
  readonly urgentSteps: number;
  /** 緩解してから再びブレーキを入れるまでの最短時間 [s] */
  readonly reapplyDelay: Seconds;
  /** 制動が不要になったときにノッチを抜く間隔（`notchHoldTime` に対する比） */
  readonly releaseHoldRatio: number;
  /** 速度維持の不感帯 [m/s] */
  readonly regulationBand: MetersPerSecond;
  /** 速度超過に対する制動の比例ゲイン [1/s] */
  readonly regulationGain: number;
  /** 抑速（電気ブレーキのみ）で受け持つ減速度の上限 [m/s^2] */
  readonly holdingDeceleration: MetersPerSecondSquared;
  /** 抑速ブレーキを使う最低速度 [m/s]（これ以下では回生が失効する） */
  readonly holdingMinSpeed: MetersPerSecond;
  /** 停止保持に用いるブレーキノッチ */
  readonly holdNotch: number;
  /** ブレーキの効き具合を推定する時定数 [s] */
  readonly gainEstimateTime: Seconds;
  /** 効き具合を推定する最低速度 [m/s]（これ以下は誤差が大きい） */
  readonly gainMinSpeed: MetersPerSecond;
  /** 緩解しているあいだに効き具合の推定が 1 へ戻る時定数 [s] */
  readonly gainRelaxTime: Seconds;
  /**
   * 効き具合の補正を全量で効かせる下限速度 [m/s]。
   * ここから `easeSpeed` へ向けて補正を 1 へ戻す。
   */
  readonly gainTaperSpeed: MetersPerSecond;
  /**
   * ブレーキの効き具合の推定範囲（下限・上限）。
   *
   * 上限を 1 の近くに置くと「指令より強く効いている」ことを覚えられない。
   * 降雪では回生が失効して空気ブレーキが受け持ち、同じノッチで公称の倍近い
   * 減速度が出ることがある。そこを補正できないと、狙いより強く減速して
   * 停止位置の手前で速度を失い、残りを這って詰めることになる。
   */
  readonly minBrakeGain: number;
  readonly maxBrakeGain: number;
  /** 空転・滑走を検知してから砂を撒き続ける時間 [s] */
  readonly sandHoldTime: Seconds;
  /** 停止と判定する速度 [m/s] */
  readonly stopSpeed: MetersPerSecond;
  /** 停止してから開扉するまでの間 [s] */
  readonly doorOpenDelay: Seconds;
  /** 戸閉めから力行までの間 [s] */
  readonly departureDelay: Seconds;
}

export const DEFAULT_AUTO_DRIVE: AutoDriveParameters = {
  speedMargin: 0.4,
  ceilingGuard: 0.1,
  patternMargin: 1.0,
  powerResumeBand: 1.2,
  powerEaseBand: 0.2,
  powerStepTime: 0.35,
  powerHoldTime: 1.2,
  powerReleasePressure: 20_000,
  approachDeceleration: 0.4,
  releaseRatio: 0.45,
  responseTime: 1.2,
  limitMargin: 45,
  signalMargin: 45,
  terminusMargin: 40,
  lookahead: 2500,
  stopDeceleration: 0.62,
  finalDeceleration: 0.24,
  easeSpeed: 5.5,
  stopDemandCap: 1.5,
  coastLead: 40,
  coastLeadTime: 10,
  notchHoldTime: 1.4,
  notchHysteresis: 0.8,
  maxNotchStep: 2,
  applyStepTime: 0.4,
  urgentSteps: 2.5,
  reapplyDelay: 3,
  releaseHoldRatio: 0.5,
  regulationBand: 0.08,
  regulationGain: 0.45,
  holdingDeceleration: 0.5,
  holdingMinSpeed: 8,
  holdNotch: 4,
  gainEstimateTime: 2,
  gainMinSpeed: 3,
  gainRelaxTime: 30,
  gainTaperSpeed: 11.0,
  minBrakeGain: 0.7,
  maxBrakeGain: 2.2,
  sandHoldTime: 3.0,
  stopSpeed: 0.05,
  doorOpenDelay: 1.5,
  departureDelay: 2.0,
};

/** 自動運転装置の状態（表示・記録用） */
export interface AutoDriveState {
  mode: AutoDriveMode;
  /** いま出してよい速度 [m/s] */
  targetSpeed: MetersPerSecond;
  /** 必要減速度 [m/s^2]（勾配・抵抗を含む正味の値） */
  requiredDeceleration: MetersPerSecondSquared;
  /** ブレーキ装置へ出している指令減速度 [m/s^2] */
  commandedDeceleration: MetersPerSecondSquared;
  /** 勾配・走行抵抗による減速度 [m/s^2]（正 = 減速を助ける） */
  externalDeceleration: MetersPerSecondSquared;
  /** 制動を支配している対象（表示用） */
  governing: string | null;
  /** 停止目標までの距離 [m]（停止目標が無ければ null） */
  stopDistance: Meters | null;
  /** 発車できるようになるまでの時間 [s]（停車中のみ） */
  departureCountdown: Seconds | null;
  /** ブレーキの効き具合の推定値（1 = 指令どおり、雨・雪では下がる） */
  brakeGain: number;
  /** 常用ブレーキノッチを動かした回数 */
  notchChanges: number;
  /** ブレーキを入れた回数（緩解 → 込めの立ち上がり） */
  brakeApplications: number;
}

/**
 * 減速目標までの距離としてこれ以上は詰めない [m]。
 * 目標に達しかけているのに速度がわずかに高い、というだけで必要減速度が発散し、
 * 常用最大まで込めてしまうのを防ぐ（そこから先は速度維持の受け持ち）。
 */
const MIN_TARGET_GAP = 25;

/** 減速目標（この地点でこの速度以下にする） */
interface DecelTarget {
  readonly position: Meters;
  readonly speed: MetersPerSecond;
  readonly margin: Meters;
  readonly label: string;
}

/** 停止目標（この地点で速度 0 にする） */
interface StopPoint {
  readonly position: Meters;
  readonly label: string;
}

/**
 * 自動運転装置（ATO）。停止位置制御（TASC）を含む。
 *
 * 運転士の代わりに `ControlInput` を組み立てるだけの装置であり、物理にも保安装置にも
 * 手を入れない。したがって自動運転で走らせても、出てくる挙動は手動運転とまったく同じ
 * 物理モデルの上の結果になる。
 *
 * 設計の要点は 3 つ。
 *
 * **1. 必要減速度で考える（ノッチの入切を最小にする）**
 *
 * 「目標速度を超えたらブレーキ、下回ったら緩解」という制御は、目標速度の周りで
 * 必ずブレーキを入切する。そこで前方の減速目標（速度制限・停止現示・停止位置）に対して
 *
 *     a_req = (v² − v_t²) / 2(d − margin − v·t_r)
 *
 * という**その目標に届くのに必要な減速度**を求め、それがそのまま出るノッチを選ぶ。
 * 必要減速度どおりに減速しているかぎり a_req は一定に保たれるので、ノッチを
 * 動かす必要がない。制動中にノッチが動くのは、勾配が変わったときと、
 * 次の 3 の絞り込みのときだけになる。
 *
 * **2. 勾配と走行抵抗を打ち消してから指令する**
 *
 * ブレーキ装置の指令減速度は「ブレーキが受け持つぶん」であり、実際の減速度には
 * 勾配と走行抵抗が加わる。指令値から勾配ぶんを差し引いておくと、下り勾配でも
 * ノッチを入れっぱなしのまま速度が保たれる（＝抑速）。差し引かないと、
 * 勾配で速度が戻るたびにブレーキを入切することになる。
 *
 * **3. 止まる直前は減速度そのものを絞る（衝撃緩和）**
 *
 * 停止の衝撃は「止まった瞬間の減速度」がそのまま前後衝動になる。そこで速度に対する
 * 目標減速度を
 *
 *     a(v) = a_final + (a_stop − a_final)·min(v / v_ease, 1)
 *
 * と定め、その形のまま止まったときの制動距離 D(v) を解析的に求めておく。残距離 d に
 * 対する指令は a(v)·D(v)/d でよい。ちょうど良い位置（d = D(v)）ならそのまま a(v) が出て、
 * ずれていれば比例して補正される。これは一定減速度の必要減速度 a = v²/2d の自然な
 * 拡張であり、**停止位置の精度を落とさずに**止まる瞬間の減速度だけを a_final まで
 * 落とせる。ノッチは B5 → B4 → B3 → B2 → B1 と自然に緩んでいく。
 *
 * 到達点 a_final は最弱ノッチ B1 の減速度に採る（`finalDeceleration()`）。
 */
export class AutoDriver {
  readonly params: AutoDriveParameters;
  readonly state: AutoDriveState = {
    mode: 'standby',
    targetSpeed: 0,
    requiredDeceleration: 0,
    commandedDeceleration: 0,
    externalDeceleration: 0,
    governing: null,
    stopDistance: null,
    departureCountdown: null,
    brakeGain: 1,
    notchChanges: 0,
    brakeApplications: 0,
  };

  private powerNotch = 0;
  private brakeNotch = 0;
  private holdingNotch = 0;
  private doorsClosed = true;

  /** 常用ブレーキノッチを動かしてからの時間 [s] */
  private notchTimer = 0;
  /** 力行ノッチを動かしてからの時間 [s] */
  private powerTimer = 0;
  /** ブレーキを緩解してからの時間 [s] */
  private releaseTimer = Number.POSITIVE_INFINITY;
  /** 込めたブレーキが立ち上がるまでの残り時間 [s] */
  private applyLag = 0;
  /** 指令減速度に対して実際に出ている減速度の比（雨・雪で下がる） */
  private brakeGain = 1;
  /** 確認扱いの出力と、その前の警報の有無（押しっぱなしにしないためのラッチ） */
  private acknowledge = false;
  private acknowledged = false;
  /** 抑速ノッチを動かしてからの時間 [s] */
  private holdingTimer = 0;
  /** 砂を撒き続ける残り時間 [s] */
  private sandTimer = 0;
  /** 制動を継続中か（必要減速度がわずかに下がっても緩解しないためのラッチ） */
  private braking = false;
  /** 停止位置制御に入っているか、その目標地点 [m] */
  private stopping = false;
  private stoppingTarget: Meters | null = null;
  /** 停止した時刻 [s] */
  private stoppedAt: Seconds | null = null;
  /** 発車準備（戸閉め）が整った時刻 [s] */
  private readyAt: Seconds | null = null;
  /** 発車済みの駅（同じ駅へ再びブレーキをかけないため） */
  private departedStationId: string | null = null;
  /** 直近に通過した信号機が示していた許容速度 [m/s] */
  private signalCeiling: MetersPerSecond = Number.POSITIVE_INFINITY;
  /** 前回の制御周期の先頭端位置 [m]（信号機の通過判定に使う） */
  private lastPosition: Meters | null = null;

  constructor(options: Partial<AutoDriveParameters> = {}) {
    this.params = { ...DEFAULT_AUTO_DRIVE, ...options };
  }

  /** 制御周期ごとに呼び、運転士の代わりとなる操作入力を返す */
  update(dt: Seconds, ctx: AutoDriveContext): ControlInput {
    this.notchTimer += dt;
    this.powerTimer += dt;
    this.releaseTimer += dt;
    this.holdingTimer += dt;
    this.applyLag = Math.max(0, this.applyLag - dt);
    // 空転・滑走を検知したら、収まってからもしばらく撒き続ける。砂が踏面へ届いて
    // 粘着が戻るまでには間があるので、検知した瞬間だけ撒いても効かない。
    this.sandTimer =
      ctx.dynamics.anySlipping || ctx.dynamics.anySliding
        ? this.params.sandHoldTime
        : Math.max(0, this.sandTimer - dt);
    this.updateSignalCeiling(ctx);
    this.updateBrakeGain(dt, ctx);

    // 保安装置の警報には確認扱いをする（押しっぱなしにはしない）
    this.acknowledge = ctx.safetyWarning && !this.acknowledged;
    this.acknowledged = ctx.safetyWarning;

    const station = this.stationTarget(ctx);
    if (station && station.arrived && Math.abs(ctx.speed) < this.params.stopSpeed) {
      return this.dwell(ctx, station);
    }
    return this.drive(ctx, station);
  }

  /** 走行を初期状態へ戻す */
  reset(): void {
    this.powerNotch = 0;
    this.brakeNotch = 0;
    this.holdingNotch = 0;
    this.doorsClosed = true;
    this.notchTimer = 0;
    this.powerTimer = 0;
    this.releaseTimer = Number.POSITIVE_INFINITY;
    this.applyLag = 0;
    this.brakeGain = 1;
    this.acknowledge = false;
    this.acknowledged = false;
    this.holdingTimer = 0;
    this.sandTimer = 0;
    this.braking = false;
    this.stopping = false;
    this.stoppingTarget = null;
    this.stoppedAt = null;
    this.readyAt = null;
    this.departedStationId = null;
    this.signalCeiling = Number.POSITIVE_INFINITY;
    this.lastPosition = null;
    this.state.notchChanges = 0;
    this.state.brakeApplications = 0;
    this.state.brakeGain = 1;
  }

  // ------------------------------------------------------------------
  // 停車中
  // ------------------------------------------------------------------

  /**
   * 停車中（開扉 → 停車時分 → 戸閉め → 発車）。
   *
   * 停車時分と発時刻の両方を満たしてから戸閉めし、戸閉め確認の間をおいて発車する。
   * 終着駅（発時刻を持たない最終駅）では発車しない。
   */
  private dwell(ctx: AutoDriveContext, progress: AutoDriveStation): ControlInput {
    const p = this.params;
    const station = progress.station;
    if (this.stoppedAt === null) this.stoppedAt = ctx.time;

    // 勾配で転動しないようブレーキを込めたまま保持する。
    // すでに止まっているので、ここでノッチを変えても衝動にはならない。
    this.setBrake(p.holdNotch);
    this.powerNotch = 0;
    this.holdingNotch = 0;
    this.stopping = false;
    this.stoppingTarget = null;
    this.braking = true;
    this.state.mode = 'standby';
    this.state.stopDistance = station.stopPosition - ctx.position;
    this.state.commandedDeceleration = ctx.brake.decelerationForNotch(this.brakeNotch);

    const stoodFor = ctx.time - this.stoppedAt;
    if (this.isTerminal(ctx, station)) {
      // 終着。扉を開けたまま留置する。
      if (stoodFor >= p.doorOpenDelay) this.doorsClosed = false;
      this.state.departureCountdown = null;
      return this.input(ctx);
    }

    if (stoodFor >= p.doorOpenDelay && this.readyAt === null) this.doorsClosed = false;

    const dwellLeft = station.dwellTime - progress.dwellElapsed;
    const timeLeft =
      station.departureTime === undefined ? 0 : station.departureTime - ctx.time - p.departureDelay;
    this.state.departureCountdown = Math.max(0, dwellLeft, timeLeft);

    if (dwellLeft <= 0 && timeLeft <= 0) {
      this.doorsClosed = true;
      if (this.readyAt === null) this.readyAt = ctx.time;
      if (ctx.time - this.readyAt >= p.departureDelay) {
        // 発車。以後この駅は停止目標にしない。
        this.departedStationId = station.id;
        this.stoppedAt = null;
        this.readyAt = null;
        this.braking = false;
        this.setBrake(0);
        this.state.departureCountdown = null;
      }
    }
    return this.input(ctx);
  }

  /** 終着駅（発時刻を持たない最終駅）か */
  private isTerminal(ctx: AutoDriveContext, station: Station): boolean {
    const stations = ctx.route.stations;
    const last = stations[stations.length - 1];
    return station.departureTime === undefined && last !== undefined && last.id === station.id;
  }

  // ------------------------------------------------------------------
  // 走行中
  // ------------------------------------------------------------------

  private drive(ctx: AutoDriveContext, station: AutoDriveStation | undefined): ControlInput {
    const p = this.params;
    const v = Math.abs(ctx.speed);
    const external = this.externalDeceleration(ctx.dynamics);
    this.state.externalDeceleration = external;

    // --- 1. いま出してよい速度 ---
    // 保安装置の照査速度も上限に入れる。自動運転装置が保安装置に叱られてブレーキを
    // 掛けられる、というのは運転としても保安としても最悪で、そこだけ突然の
    // 常用最大が入ってしまう。常に照査速度の内側を走れば、保安装置は動作しない。
    // 制限は在線範囲で引く。先頭が制限区間を抜けても最後部が残っているうちは
    // まだ制限の中なので、そこで力行を始めてはいけない。
    const permitted = Math.min(
      ctx.route.maxSpeed,
      ctx.consist.maxSpeed,
      occupiedSpeedLimit(ctx.route.speedLimits, {
        front: ctx.dynamics.frontPosition,
        rear: ctx.dynamics.rearPosition,
      }),
      this.signalCeiling,
    );
    // 保安装置の照査速度に取る余裕は、パターンが**降りてきているとき**のためのもので
    // ある。近づくほど下がってくる相手の内側へ入るには、その動くぶんの余裕が要る。
    // 一方、照査速度が在線の制限と並んでいるあいだ、それは制限そのものを写している
    // だけで、制限の内側を走っていれば保安装置は動作しない。そこへ余裕を二重に積むと、
    // 制限より照査余裕ぶん低い速度でしか走れなくなる（制限 80km/h の区間を
    // 76km/h で走ることになる）。降りてきているときだけ内側へ入る。
    const ceiling =
      ctx.patternSpeed !== null && ctx.patternSpeed < permitted
        ? Math.min(permitted, ctx.patternSpeed - p.patternMargin)
        : permitted;
    const vTarget = Math.max(0, ceiling - p.speedMargin);
    this.state.targetSpeed = vTarget;
    // 力行の判断だけは少し先の制限も見る。すぐ先で制限に入るのに、そこまでの
    // 数百メートルのためだけに力行して即ノッチオフ、という運転をしないため。
    const lead = p.coastLead + v * p.coastLeadTime;
    const vPower = Math.max(
      0,
      Math.min(ceiling, this.lowestLimitWithin(ctx, lead)) - p.speedMargin,
    );

    // --- 2. 前方の速度制限・信号に対する必要減速度 ---
    // `demand` は正味（勾配・抵抗を含む）、`brakeDemand` はブレーキが受け持つぶん。
    // 制動に入るかどうかは**正味**で判断し、ノッチは**ブレーキ側**で決める。
    // 前者は「本当に減速が要るのか」という軌跡の話、後者は「その減速度を出すのに
    // どの段が要るか」という装置の話で、別のものである。下り勾配ではブレーキ側が
    // 大きく出るので、ここを取り違えると勾配で必ず常用ブレーキが入ってしまい、
    // 抑速で保つという運転にならない。
    const ahead = this.approachDemand(ctx, v);
    let demand = ahead.demand;
    let brakeDemand = ahead.brakeDemand;
    let governing = ahead.label;

    // --- 3. 停止目標（駅の停止位置・停止現示・線路終端）に対する停止制動 ---
    const point = this.stopPointAhead(ctx, station);
    if (point === null) {
      this.stopping = false;
      this.stoppingTarget = null;
      this.state.stopDistance = null;
    } else {
      const distance = point.position - ctx.position;
      this.state.stopDistance = distance;
      const stopDemand = this.stopDemand(ctx, distance - v * this.brakingLag(), v);
      // 一度入った停止制動は、その目標が消える（信号が現示アップして次の目標へ移る）まで
      // 続ける。必要減速度が一時的に下がっただけで解除してしまうと、勾配や粘着の
      // ばらつきのたびに「停止制動 → 緩解 → また停止制動」を繰り返すことになる。
      if (this.stoppingTarget !== null && Math.abs(point.position - this.stoppingTarget) > 1) {
        this.stopping = false;
        this.stoppingTarget = null;
      }
      if (stopDemand >= this.shapeDeceleration(ctx, v)) {
        this.stopping = true;
        this.stoppingTarget = point.position;
      }
      if (this.stopping && stopDemand > demand) {
        demand = stopDemand;
        // 停止位置制御だけは形どおりの正味の減速度で走らせるので、足元の勾配を
        // そのまま打ち消す。勾配の変わり目でノッチは動くが、狙った位置で止まる。
        brakeDemand = stopDemand - external;
        governing = point.label;
      }
    }

    // --- 4. 制動を続けるかどうか（ラッチ付き） ---
    if (demand >= p.approachDeceleration) this.braking = true;
    else if (demand < p.approachDeceleration * p.releaseRatio && !this.stopping) {
      this.braking = false;
    }
    this.state.requiredDeceleration = demand;
    this.state.governing = governing;

    if (this.braking || this.stopping) {
      return this.applyBrake(ctx, brakeDemand);
    }

    // --- 5. 速度維持（抑速）と、制動から惰行へ戻す途中の緩解 ---
    const regulation = p.regulationGain * (v - vTarget) - external;
    if (
      this.holdingNotch > 0 ||
      this.brakeNotch > 0 ||
      (v > vTarget + p.regulationBand && regulation > 0)
    ) {
      return this.regulate(ctx, regulation, v, vTarget);
    }

    // --- 6. 力行と惰行 ---
    return this.cruise(ctx, v, vPower, ceiling, demand, point);
  }

  /**
   * ブレーキの効き具合を推定する。
   *
   * 指令した減速度に対して実際に出ている減速度の比を、ゆっくり追従する 1 次遅れで
   * 覚えておく。雨・雪・落葉で粘着が落ちると滑走防止装置が BC 圧を抜くため、
   * 同じノッチでも減速度は出ない。この比で指令を割り増しておくと、悪条件でも
   * ノッチを深くして同じ減速度を保てる（＝停止位置が狂わない）。
   *
   * 立ち上がり中と低速域は誤差が大きいので推定しない。
   *
   * **滑走防止装置が動作している間も推定しない。** BC 圧を抜いている最中の減速度は
   * 「ブレーキの効きの悪さ」ではなく過渡であり、滑走はごく短い山として現れるので、
   * これを平均へ入れると推定は必ず過小へ偏る。過小な推定はそのまま指令の割り増しに
   * なり、停止目標のはるか手前で速度を落としきってしまう。雪の日に停止直前をだらだら
   * 這って詰めることになるのは、突き詰めればこの偏りが原因である。
   *
   * 緩解しているあいだは、覚えた効きの悪さをゆっくり 1 へ戻す。粘着は区間ごとにも
   * 速度によっても変わるので（μ = μ₀/(1 + kV)）、1 回の制動で測った値を次の制動まで
   * そのまま持ち越す理由が無い。
   */
  private updateBrakeGain(dt: Seconds, ctx: AutoDriveContext): void {
    const p = this.params;
    const target = ctx.brake.state.targetDeceleration;
    const v = Math.abs(ctx.speed);
    if (this.brakeNotch === 0) {
      this.brakeGain = firstOrderLag(this.brakeGain, 1, p.gainRelaxTime, dt);
      this.state.brakeGain = this.brakeGain;
      return;
    }
    if (this.applyLag > 0 || v < p.gainMinSpeed || target < 0.15) {
      this.state.brakeGain = this.brakeGain;
      return;
    }
    const achieved = -ctx.dynamics.acceleration - this.externalDeceleration(ctx.dynamics);
    const ratio = clamp(achieved / target, p.minBrakeGain, p.maxBrakeGain);
    this.brakeGain = firstOrderLag(this.brakeGain, ratio, p.gainEstimateTime, dt);
    this.state.brakeGain = this.brakeGain;
  }

  /**
   * 指令に掛ける効き補正（指令をこれで割る）。
   *
   * 効きが落ちているぶんの割り増しは高速側だけで効かせ、絞り込み域（止まる直前）へ
   * 向かって滑らかに 1 へ戻す。割り増しを残したまま粘着が戻ると、過大な減速度が
   * そのまま停止直前の衝撃になるからで、そもそも粘着は低速ほど良くなるので
   * （μ = μ₀/(1 + kV)）、高速で測った効きの悪さを低速へ持ち込む理由も無い。
   *
   * 速度で切り替えるのではなく渡すのが要点である。段で切り替えると、その速度を
   * 跨いだ瞬間に減速度が跳ね、停止制動の途中で目標がずれる。
   *
   * 効きすぎているとき（gain > 1）は全速度域で補正する。緩めるほうは衝撃にならない。
   */
  private correctionGain(v: MetersPerSecond): number {
    const p = this.params;
    if (this.brakeGain >= 1) return this.brakeGain;
    const t = clamp(inverseLerp(p.easeSpeed, p.gainTaperSpeed, v), 0, 1);
    return lerp(1, this.brakeGain, t);
  }

  /**
   * ブレーキが立ち上がるまでに走ってしまう時間 [s]。
   *
   * 込める前は応答時間そのもの（その距離を使えないものとして必要減速度を求める）。
   * 込めたあとは経過とともに 0 へ減らす。**込めたあとも応答時間を引き続けると**、
   * 目標へ近づくほど必要減速度が実際より大きく出て、ノッチを際限なく深くしてしまう。
   * 逆に最初から引かないと込め始めが遅れる。空走ぶんを 1 回だけ使い切る、
   * というこの扱いにすると、必要減速度は制動中ほぼ一定に保たれる。
   */
  private brakingLag(): Seconds {
    return this.brakeNotch === 0 ? this.params.responseTime : this.applyLag;
  }

  /**
   * 前方の速度制限・信号に対して**ブレーキが受け持つべき**減速度。
   *
   * 目標ごとに正味の必要減速度 `a = (v² − v_t²) / 2(d − margin − v·t_lag)` を求め、
   * そこから目標までの平均勾配・抵抗が受け持つぶん（`externalAhead`）を差し引く。
   * 差し引きを目標地点ではなく**目標までの平均**で行うのが要点で、下り勾配の先の
   * 制限へは早く込め、上り勾配の先の制限へは遅らせる、という運転になる。
   */
  private approachDemand(
    ctx: AutoDriveContext,
    v: MetersPerSecond,
  ): {
    demand: MetersPerSecondSquared;
    brakeDemand: MetersPerSecondSquared;
    label: string | null;
  } {
    const cap = ctx.consist.brake.maxServiceDeceleration;
    const lag = this.brakingLag();
    let demand = 0;
    let brakeDemand = 0;
    let label: string | null = null;
    for (const target of this.targetsAhead(ctx)) {
      if (v <= target.speed) continue;
      const at = target.position - target.margin;
      const gap = at - ctx.position - v * lag;
      const total = Math.min(
        cap,
        (v * v - target.speed * target.speed) / (2 * Math.max(gap, MIN_TARGET_GAP)),
      );
      const brake = Math.min(cap, total - this.externalAhead(ctx, at));
      if (brake > brakeDemand) {
        brakeDemand = brake;
        label = target.label;
      }
      if (total > demand) demand = total;
    }
    return { demand, brakeDemand, label };
  }

  /** 前方 `lead` [m] のあいだに現れる最も低い制限速度（無ければ +∞） */
  private lowestLimitWithin(ctx: AutoDriveContext, lead: Meters): MetersPerSecond {
    const end = ctx.position + lead;
    let lowest = Number.POSITIVE_INFINITY;
    for (const entry of ctx.route.speedLimitEntries) {
      if (entry.start <= ctx.position) continue;
      if (entry.start > end) break;
      if (entry.speed < lowest) lowest = entry.speed;
    }
    for (const sig of ctx.signalling.signals) {
      if (sig.position <= ctx.position) continue;
      if (sig.position > end) break;
      const st = ctx.signalling.state(sig.id);
      if (st && st.speed < lowest) lowest = st.speed;
    }
    return lowest;
  }

  /** 前方の減速目標（速度が 0 でないもの）を集める */
  private *targetsAhead(ctx: AutoDriveContext): Generator<DecelTarget> {
    const p = this.params;
    const pos = ctx.position;
    const limit = pos + p.lookahead;

    for (const entry of ctx.route.speedLimitEntries) {
      if (entry.start <= pos) continue;
      if (entry.start > limit) break;
      yield {
        position: entry.start,
        speed: Math.max(0, entry.speed - p.speedMargin),
        margin: p.limitMargin,
        label: `制限 ${entry.id}`,
      };
    }

    for (const sig of ctx.signalling.signals) {
      if (sig.position <= pos) continue;
      if (sig.position > limit) break;
      const st = ctx.signalling.state(sig.id);
      if (!st) continue;
      // 停止現示は停止目標として別に扱う（そこで止まるので、先の信号は見ない）
      if (st.aspect === 'R') break;
      yield {
        position: sig.position,
        speed: Math.max(0, st.speed - p.speedMargin),
        margin: p.limitMargin,
        label: `信号 ${sig.id}`,
      };
    }
  }

  // ------------------------------------------------------------------
  // 停止制動
  // ------------------------------------------------------------------

  /**
   * 止まる瞬間に狙う減速度 [m/s^2]。
   *
   * 停止制動中はブレーキを抜かない（`applyBrake` の `min`）ので、止まる瞬間に
   * 残っているのは最も浅いノッチ B1 である。したがって**停止の衝撃の下限は
   * B1 の減速度**であり、それより小さい値を狙っても届かない。逆に B1 より
   * 大きい値を狙うと、B2 以上を込めたまま止まることになり、その段のぶんが
   * そのまま前後衝動として出る。到達できる中でいちばん小さい値、すなわち
   * B1 の減速度を狙う。
   *
   * 空気ブレーキは指令を追うのに 1 秒ほど掛かるので、B1 相当まで指令を
   * 落とすのが早いほど、止まるまでに BC 圧が抜けきる。
   */
  private finalDeceleration(ctx: AutoDriveContext): MetersPerSecondSquared {
    // 公称値ではなく**実際に出る**減速度で考える。効きが指令より強く出る条件
    // （降雪で回生が失効し、空気ブレーキが受け持つときなど）では、B1 でも公称の
    // 倍近い減速度が出る。それを公称値のまま形へ入れると、狙いより強く減速して
    // 停止位置のかなり手前で速度を失い、残りを這って詰めることになる。しかも
    // 目標の形は B1 が出せる値より小さいので、ノッチは入切を繰り返すしかない。
    // 効き推定を掛けておけば、形そのものが「いま出せるいちばん静かな減速度」に
    // 揃うので、B1 を入れたまま一息に停止位置まで詰められる。
    return Math.min(
      this.params.finalDeceleration,
      ctx.brake.decelerationForNotch(1) * this.brakeGain,
    );
  }

  /** 速度 v に対する目標減速度（止まる直前は絞り込む） */
  private shapeDeceleration(ctx: AutoDriveContext, v: MetersPerSecond): MetersPerSecondSquared {
    const p = this.params;
    if (v >= p.easeSpeed) return p.stopDeceleration;
    const aFinal = this.finalDeceleration(ctx);
    return aFinal + (p.stopDeceleration - aFinal) * (v / p.easeSpeed);
  }

  /**
   * 目標減速度の形どおりに減速したときの制動距離 [m]。
   *
   * 絞り込み域では a(v) = a_f + c·v（c = (a_stop − a_f)/v_ease）なので
   *
   *     D = ∫₀^v u/(a_f + c·u) du = v/c − (a_f/c²)·ln(1 + c·v/a_f)
   *
   * と解析的に求まる。v_ease を超えるぶんは一定減速度として足す。
   *
   * ここでの a(v) は**正味の減速度**（勾配・抵抗を含む）である。停止位置は速度ではなく
   * 位置の精度が要る話（許容 1m）なので、勾配ぶんはブレーキで打ち消してこの形どおりに
   * 走らせる。したがって勾配の先読みはここには入らない。下り勾配の駅で制動距離が
   * 伸びるのは、ノッチが深くなることで吸収される（`applyBrake` が足元の勾配を
   * 打ち消す）。速度制限へ寄せるときだけ区間平均で先読みするのは、あちらが
   * 「その地点で何 km/h か」という速度の話で、ノッチを動かさないほうが得だからである。
   */
  private shapeDistance(ctx: AutoDriveContext, v: MetersPerSecond): Meters {
    const p = this.params;
    const aFinal = this.finalDeceleration(ctx);
    const ve = Math.min(v, p.easeSpeed);
    const c = (p.stopDeceleration - aFinal) / p.easeSpeed;
    const low =
      c <= 1e-9
        ? (ve * ve) / (2 * aFinal)
        : ve / c - (aFinal / (c * c)) * Math.log(1 + (c * ve) / aFinal);
    if (v <= p.easeSpeed) return low;
    return low + (v * v - p.easeSpeed * p.easeSpeed) / (2 * p.stopDeceleration);
  }

  /**
   * 残距離 `distance` で停止するのに、**ブレーキが受け持つべき**減速度。
   *
   * 目標減速度の形どおりなら `d = D(v)` なので a(v) がそのまま出る。手前に寄れば
   * その比で強まるが、`stopDemandCap` で頭打ちにする。頭打ちが無いと、残り数十 cm で
   * 速度がわずかに残っているだけで指令が発散し、止まる寸前に深いノッチを
   * 掴むことになる（＝いちばん目立つ衝撃）。数十 cm の誤差はここで捨てる。
   *
   * 返すのは**正味の**必要減速度である（`approachDemand` はブレーキ側を返すので、
   * ここだけ約束が違う）。停止は位置の精度が要るので、勾配は区間平均で先読みせず、
   * 足元の勾配を `applyBrake` でそのまま打ち消して形どおりに走らせる。
   */
  private stopDemand(
    ctx: AutoDriveContext,
    distance: Meters,
    v: MetersPerSecond,
  ): MetersPerSecondSquared {
    const p = this.params;
    if (distance <= 0.02) {
      // 目標に達している。這うような速度なら停止保持のノッチで静かに止め、
      // 明らかに行き過ぎているときだけ常用最大まで込める。
      return v >= p.easeSpeed
        ? ctx.consist.brake.maxServiceDeceleration
        : ctx.brake.decelerationForNotch(p.holdNotch);
    }
    const shape = this.shapeDeceleration(ctx, v);
    return Math.min((shape * this.shapeDistance(ctx, v)) / distance, shape * p.stopDemandCap);
  }

  /** もっとも近い停止目標 */
  private stopPointAhead(
    ctx: AutoDriveContext,
    station: AutoDriveStation | undefined,
  ): StopPoint | null {
    const p = this.params;
    let best: StopPoint | null = null;
    const consider = (position: Meters, label: string): void => {
      if (position - ctx.position > p.lookahead) return;
      if (best === null || position < best.position) best = { position, label };
    };

    if (station) consider(station.station.stopPosition, `停止位置 ${station.station.name}`);
    for (const sig of ctx.signalling.signals) {
      if (sig.position <= ctx.position) continue;
      if (ctx.signalling.aspectOf(sig.id) !== 'R') continue;
      // 停止現示の手前で止まるので、それより先の信号は見なくてよい
      consider(sig.position - p.signalMargin, `停止信号 ${sig.id}`);
      break;
    }
    consider(ctx.route.length - p.terminusMargin, '線路終端');
    return best;
  }

  /** 停止目標にすべき駅（通過駅・発車済みの駅は対象外） */
  private stationTarget(ctx: AutoDriveContext): AutoDriveStation | undefined {
    const st = ctx.nextStation;
    if (!st || st.departed || st.station.isPass) return undefined;
    if (st.station.id === this.departedStationId) return undefined;
    return st;
  }

  // ------------------------------------------------------------------
  // ノッチの選び方
  // ------------------------------------------------------------------

  /**
   * 必要減速度から常用ブレーキノッチを決める。
   *
   * 指令するのは「ブレーキが受け持つぶん」なので、勾配と走行抵抗による減速度を
   * 差し引いてからノッチへ写す。ノッチは 1 段ずつ・最短間隔つきでしか動かさないので、
   * 細かい誤差でノッチが行き来することはない。
   */
  private applyBrake(ctx: AutoDriveContext, demand: MetersPerSecondSquared): ControlInput {
    const commanded = Math.max(0, demand) / this.correctionGain(Math.abs(ctx.speed));
    this.state.commandedDeceleration = commanded;
    this.state.mode = this.stopping ? 'stopping' : 'brake';
    this.powerNotch = 0;
    this.holdingNotch = 0;
    // 停止位置制御中は緩解しない。止める途中でブレーキを抜くと、込め直すときに
    // 必ず衝動が出る。ただし最小ノッチでも効きすぎるとき（勾配が下りから上りへ
    // 変わった、粘着が戻った）は緩解を許す。そこで踏み続けるほうが不自然になる。
    const lightest = ctx.brake.decelerationForNotch(1);
    const min = this.stopping && commanded > lightest * 0.5 ? 1 : 0;
    this.trimBrake(ctx, commanded, min);
    return this.input(ctx);
  }

  /**
   * 速度維持（抑速）。
   *
   * 下り勾配では、勾配ぶんを打ち消す制動を**入れっぱなし**にするのが自然な運転であり、
   * ブレーキの入切が起きない唯一のやり方でもある。受け持てるうちは電気ブレーキ
   * （抑速ブレーキ）だけで賄い、足りないときだけ常用ブレーキへ移る。
   */
  private regulate(
    ctx: AutoDriveContext,
    demand: MetersPerSecondSquared,
    v: MetersPerSecond,
    vTarget: MetersPerSecond,
  ): ControlInput {
    const p = this.params;
    this.state.mode = 'regulate';
    this.state.commandedDeceleration = Math.max(0, demand);
    this.powerNotch = 0;

    const useHolding =
      ctx.consist.brake.hasHoldingBrake &&
      v > p.holdingMinSpeed &&
      demand <= p.holdingDeceleration &&
      this.brakeNotch === 0;

    if (!useHolding) {
      this.holdingNotch = 0;
      this.trimBrake(ctx, demand, 0);
      return this.input(ctx);
    }

    const count = ctx.consist.brake.notchCount;
    if (this.holdingNotch === 0) {
      this.holdingNotch = clamp(Math.ceil((count * demand) / p.holdingDeceleration), 1, count);
      this.holdingTimer = 0;
    } else if (this.holdingTimer >= p.notchHoldTime) {
      if (v > vTarget + p.regulationBand && this.holdingNotch < count) {
        this.holdingNotch++;
        this.holdingTimer = 0;
      } else if (v < vTarget - p.regulationBand) {
        this.holdingNotch = Math.max(0, this.holdingNotch - 1);
        this.holdingTimer = 0;
      }
    }
    return this.input(ctx);
  }

  /**
   * 力行・惰行・定速。
   *
   * 目標速度に届いたらノッチを 0 まで戻す、という運転はしない。それをやると惰行で
   * `powerResumeBand` ぶん落ちてから込め直すことになり、制限のはるか下を鋸歯状に
   * 走ることになる。実際の運転士がやるのと同じく、**走行抵抗と釣り合う段で手を止めて
   * 制限直下を保つ**。段が動かないので、力行の操作回数はむしろ減る。
   *
   * 戻すかどうかは、いまの速度ではなく**ノッチを抜き終えたときの速度**で決める。
   * 加速している最中にいまの速度だけ見て判断すると、抜き終えるまでに伸びるぶんで
   * 必ず目標を越える。ここが「先を読んで操作する」の中身である。
   */
  private cruise(
    ctx: AutoDriveContext,
    v: MetersPerSecond,
    vTarget: MetersPerSecond,
    ceiling: MetersPerSecond,
    demand: MetersPerSecondSquared,
    point: StopPoint | null,
  ): ControlInput {
    const p = this.params;
    this.trimBrake(ctx, 0, 0);
    this.holdingNotch = 0;
    this.state.commandedDeceleration = 0;

    // 停止制動に入る手前と、制限へ寄せる制動が近いときは力行しない。
    // 残りを時間で見るのが要点で、「あと十数秒で込めるのに一度だけ力行する」という
    // いちばん不自然な操作を防ぐ（＝そのまま惰行で待つ）。
    const gap =
      point === null
        ? Number.POSITIVE_INFINITY
        : point.position - ctx.position - this.shapeDistance(ctx, v) - v * p.responseTime;
    const nearStop = gap <= p.coastLead + v * p.coastLeadTime;
    const nearBrake = demand >= p.approachDeceleration * p.releaseRatio;

    // 制限へ迫ったら間隔をおかずに抜く。制限を越えないことは操作の作法より優先する。
    if (v >= ceiling - p.ceilingGuard) {
      if (this.powerNotch > 0) {
        this.powerNotch = 0;
        this.powerTimer = 0;
      }
      this.state.mode = 'coast';
      return this.input(ctx);
    }

    // 目標から離れているうちはためらわずに運び、目標の近くでだけ間隔をおく。
    //
    // 戻すかどうかの判断（下の `vAhead`）は、抜き切るのに掛かる時間を通じて
    // **ノッチ段数そのものに依存する**。段を戻せば `unwind` が縮んで `vAhead` が
    // 下がり、その場でまた込めてよい条件に戻る——という閉じたループになっている。
    // 間隔が長ければループが遅くて表に出ないが、速いまま目標の近くで回すと
    // P1 と N を毎秒何度も行き来することになる。落ち着かせたいのはそこだけなので、
    // 「目標の内側で釣り合っている」ときだけ間隔を空ける。
    const settled = !nearStop && !nearBrake && v <= vTarget && v >= vTarget - p.powerResumeBand;
    const stepTime = settled ? p.powerHoldTime : p.powerStepTime;

    if (nearStop || nearBrake) {
      // ノッチを 1 段ずつ戻して惰行へ
      if (this.powerNotch > 0 && this.powerTimer >= stepTime) {
        this.powerNotch--;
        this.powerTimer = 0;
      }
      this.state.mode = this.powerNotch > 0 ? 'power' : 'coast';
      return this.input(ctx);
    }

    // ノッチを 0 まで戻し切るのに掛かる時間と、そのあいだに伸びるぶん。加速度は
    // 段を抜くにつれ 0 へ向かうので、平均として半分を見込む。この先の勾配ぶんは
    // 平均で引いておく（下り勾配へ入る**前に**ノッチが抜けることになる）。
    //
    // ここは操作の間隔ではなく「実際に抜き切るのに掛かる時間」なので、目標付近で
    // 間隔を空けていても速い側（`powerStepTime`）で見積もる。抜くのは速くできる。
    const unwind = this.powerNotch * p.powerStepTime;
    const lead = unwind + p.responseTime;
    const aTraction = ctx.dynamics.acceleration + this.externalDeceleration(ctx.dynamics);
    const aExtLead = this.externalAhead(ctx, ctx.position + v * lead);
    const vAhead = v + 0.5 * Math.max(0, aTraction) * unwind - aExtLead * lead;

    if (vAhead > vTarget) {
      if (this.powerNotch > 0 && this.powerTimer >= stepTime) {
        this.powerNotch--;
        this.powerTimer = 0;
      }
      this.state.mode = this.powerNotch > 0 ? 'power' : 'coast';
      return this.input(ctx);
    }

    // 込めるのは目標から十分に落ちてから。惰行から立ち上げるときだけ広く取るのは、
    // 力行の入切そのものを減らすため。保っている最中の微調整は狭くてよい。
    const band = this.powerNotch > 0 ? p.powerEaseBand : p.powerResumeBand;
    if (v > vTarget - band) {
      // 釣り合っている。段を動かさない（＝定速）。
      this.state.mode = this.powerNotch > 0 ? 'power' : 'coast';
      return this.input(ctx);
    }

    // ブレーキが抜け切るまでは立ち上げない。込めたまま引張力を育てると、
    // 抜けた瞬間にそのぶんが加速度として出て、発車のたびに前後衝動になる。
    if (ctx.brake.averageCylinderPressure() > p.powerReleasePressure) {
      this.state.mode = this.powerNotch > 0 ? 'power' : 'coast';
      return this.input(ctx);
    }

    if (this.powerTimer >= stepTime) {
      this.powerNotch = Math.min(ctx.consist.traction.notchCount, this.powerNotch + 1);
      this.powerTimer = 0;
    }
    this.state.mode = this.powerNotch > 0 ? 'power' : 'coast';
    return this.input(ctx);
  }

  /**
   * 指令減速度に合うよう常用ブレーキノッチを詰める。
   *
   * 1 段ぶんの減速度に対して `notchHysteresis` の不感帯を持たせ、さらに
   * `notchHoldTime` のあいだは動かさない。これにより「必要減速度がノッチの
   * ちょうど中間にある」ときでもノッチが振動しない。
   *
   * 込めるときは一度に `maxNotchStep` 段までしか動かさず、足りなければ
   * `applyStepTime` をおいて続ける。電気ブレーキは指令に即座に応じるので、
   * 深いノッチを一息に入れると同じだけの段差が減速度に出てしまう。
   * ハンドルを段階的に運ぶのと同じ扱いにして、その段差を小さくしている。
   */
  private trimBrake(
    ctx: AutoDriveContext,
    desired: MetersPerSecondSquared,
    minNotch: number,
  ): void {
    const p = this.params;
    const count = ctx.consist.brake.notchCount;
    const current = this.brakeNotch;
    const step = this.notchStep(ctx, current);
    const error = desired - ctx.brake.decelerationForNotch(current);
    const band = p.notchHysteresis * step;

    let want = current;
    if (error > band) want = Math.min(this.notchFor(ctx, desired), current + p.maxNotchStep);
    else if (error < -p.urgentSteps * step) {
      // 思ったより効いている（粘着の回復・摩擦係数の上昇）。手早く緩める。
      want = Math.max(this.notchFor(ctx, desired), current - p.maxNotchStep);
    } else if (error < -band) want = current - 1;

    want = clamp(want, minNotch, count);
    if (want === current) return;

    if (current === 0) {
      // 緩解した直後の込め直しは待つ（込め・緩めを繰り返さないため）。
      // ただし大きく足りないときは待たない。
      if (this.releaseTimer < p.reapplyDelay && error <= p.urgentSteps * step) return;
    } else {
      // 込め切るまでの段階操作と効きすぎたときの緩めは短い間隔で、要らなくなった
      // ブレーキの抜き取りはやや速く、それ以外（微調整）は通常の間隔で運ぶ。
      const hold =
        Math.abs(want - current) > 1
          ? p.applyStepTime
          : desired <= 0 && want < current
            ? p.notchHoldTime * p.releaseHoldRatio
            : p.notchHoldTime;
      if (this.notchTimer < hold) return;
    }
    this.setBrake(want);
  }

  private setBrake(notch: number): void {
    if (notch === this.brakeNotch) return;
    if (this.brakeNotch === 0) {
      this.state.brakeApplications++;
      this.applyLag = this.params.responseTime;
    }
    if (notch === 0) this.releaseTimer = 0;
    this.state.notchChanges++;
    this.brakeNotch = notch;
    this.notchTimer = 0;
  }

  /** ノッチ 1 段あたりの減速度 [m/s^2] */
  private notchStep(ctx: AutoDriveContext, notch: number): MetersPerSecondSquared {
    const count = ctx.consist.brake.notchCount;
    const dec = (n: number): number => ctx.brake.decelerationForNotch(n);
    const n = clamp(notch, 0, count);
    const step = n < count ? dec(n + 1) - dec(n) : dec(n) - dec(n - 1);
    return step > 1e-6 ? step : dec(count) / Math.max(1, count);
  }

  /** 指定の減速度を出せる最小のノッチ */
  private notchFor(ctx: AutoDriveContext, deceleration: MetersPerSecondSquared): number {
    const count = ctx.consist.brake.notchCount;
    if (deceleration <= 0) return 0;
    for (let n = 1; n <= count; n++) {
      if (ctx.brake.decelerationForNotch(n) >= deceleration) return n;
    }
    return count;
  }

  // ------------------------------------------------------------------
  // 補助
  // ------------------------------------------------------------------

  /**
   * 走行抵抗・曲線抵抗による減速度 [m/s^2]（正 = 減速を助ける）。勾配は含まない。
   * 回転部慣性を含む等価質量で割る（ブレーキ装置の指令減速度と基準を揃えるため）。
   */
  private resistanceDeceleration(dyn: TrainDynamics): MetersPerSecondSquared {
    let force = 0;
    let mass = 0;
    for (const veh of dyn.vehicles) {
      force += veh.runningResistanceForce + veh.curveResistanceForce;
      mass += veh.mass + veh.spec.rotatingMassFactor * veh.spec.tareMass;
    }
    if (mass <= 0) return 0;
    return clamp(-force / mass, -1, 1);
  }

  /**
   * いまの位置の勾配・走行抵抗・曲線抵抗による減速度 [m/s^2]（正 = 減速を助ける）。
   * 「いまこの瞬間どれだけ助けられているか」なので、速度維持と効きの推定に使う。
   */
  private externalDeceleration(dyn: TrainDynamics): MetersPerSecondSquared {
    let force = 0;
    let mass = 0;
    for (const veh of dyn.vehicles) {
      force += veh.runningResistanceForce + veh.curveResistanceForce + veh.gradeForce;
      mass += veh.mass + veh.spec.rotatingMassFactor * veh.spec.tareMass;
    }
    if (mass <= 0) return 0;
    return clamp(-force / mass, -1, 1);
  }

  /**
   * 在線範囲の後端から `to` までの平均的な「減速を助ける加速度」[m/s^2]。
   *
   * 運転士は路線の勾配を頭に入れていて、いまの勾配ではなく**制動しているあいだの
   * 勾配**で手を決める。下り勾配の先にある駅は、いま平坦を走っていても平坦ぶんの
   * 制動距離では止まれないし、上り勾配の先の制限へは早く込めるだけ無駄になる。
   * 目標までの平均勾配で必要制動力を求めれば、その両方が自然に出る。
   *
   * 「いまここ」の勾配で引くのに比べて、ノッチの入切はむしろ**減る**。勾配境界を
   * 跨ぐたびに階段状に動く量ではなく、位置に対して滑らかに動く量になるからである。
   *
   * 走行抵抗・曲線抵抗はいまの値をそのまま使う。速度の関数なので制動中に減るが、
   * 勾配に比べれば小さく、先読みしても得るものが無い。
   */
  private externalAhead(ctx: AutoDriveContext, to: Meters): MetersPerSecondSquared {
    const from = ctx.dynamics.rearPosition;
    const end = Math.max(to, from + 1);
    const grade = ctx.route.alignment.averageGrade(from, end);
    return clamp(-gradeAcceleration(grade) + this.resistanceDeceleration(ctx.dynamics), -1, 1);
  }

  /**
   * 通過した信号機の現示を覚えておく。
   *
   * 自列車が閉塞へ入ると、その閉塞を防護する信号機は停止現示へ変わる。したがって
   * 「いま走っている閉塞の許容速度」は、その信号機を**通過した時点**の現示から
   * 取らなければならない（運転士が信号を見て走るのと同じ）。
   */
  private updateSignalCeiling(ctx: AutoDriveContext): void {
    const previous = this.lastPosition;
    this.lastPosition = ctx.position;
    if (previous === null) return;
    for (const sig of ctx.signalling.signals) {
      if (sig.position > previous && sig.position <= ctx.position) {
        this.signalCeiling = ctx.signalling.speedForAspect(
          sig,
          ctx.signalling.aspectBefore(sig.id),
        );
      }
    }
  }

  /** 現在の内部状態から操作入力を組み立てる */
  private input(ctx: AutoDriveContext): ControlInput {
    return {
      ...NEUTRAL_INPUT,
      powerNotch: this.powerNotch,
      brakeNotch: this.brakeNotch,
      holdingNotch: this.holdingNotch,
      doorsClosed: this.doorsClosed,
      acknowledge: this.acknowledge,
      // 保安装置が動作したまま停止したら復帰扱いをする（自動運転を続けられるように）
      safetyReset: ctx.safetyEmergency && Math.abs(ctx.speed) < this.params.stopSpeed,
      // 空転・滑走を検知したら砂を撒く（粘着が落ちているのは踏面の状態のせいなので、
      // ノッチを緩めるより先にこちらで粘着そのものを回復させる）
      sanding: this.sandTimer > 0,
    };
  }
}
