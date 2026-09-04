import type { Station, StationId } from '../network/station';
import type { StructureRun } from '../network/structure';
import type { SegmentId } from '../network/network';
import { buildDrivingRoute, type DrivingRoute } from '../railsim/adapter/route';
import { buildDrivingScenario } from '../railsim/adapter/scenario';
import { Simulation } from '../railsim/core/sim/simulation.ts';
import { mpsToKmh } from '../railsim/core/units.ts';
import type { ConsistSpec } from '../railsim/core/vehicle/spec.ts';
import { commuter4Vehicle, compileVehicle } from '../railsim/vehicle/index.ts';
import type { LaneGraph } from '../sim/lanegraph';
import type { Traffic, Vehicle } from '../sim/traffic';
import { DriverState, type DriverCommand, type HeldCommand } from './driverState';

/**
 * 運転モード。
 *
 * 敷いた線路の上に 1 本だけ「運転する列車」を置き、その速さを追従モデルでは
 * なく**運転士**が決める。運転する列車もふつうの `Vehicle` のままなので、
 * カメラ (乗車モード)・描画・他の車両から見た先行車の扱いは今までのまま働く。
 * 違うのは中身の決め方だけである。
 *
 * 時間の進め方は移植元のまま 3 階層になっている。物理は 1 kHz、装置の制御は
 * 100 Hz、描画は任意。`Simulation.step` が整数マイクロ秒の積算器で刻むので、
 * こちらが渡す `dt` がフレームごとに揺れても結果は変わらない。**1 kHz は
 * 緩めない** —— 連結器とクリープ力の剛性から決まっている刻みで、60 Hz にすると
 * 輪軸の解が発散する。
 */

/** 運転する列車の 1 両の寸法 [m]。 */
const CAR_SIZE = { length: 20, width: 2.9, height: 3.6 };

/** 運転する列車の色。走っている他の列車と見分けが付くように。 */
const DRIVEN_COLOR: [number, number, number] = [0.92, 0.86, 0.3];

/**
 * 経路を伸ばす上限 [両]。
 *
 * 分岐のたびに 1 本を選んで前へ辿る。行き止まりに当たるか、同じ車線へ戻って
 * きたら止める。運転中に分岐を選び直す (経路を作り直す) のはまだできない
 * —— `Simulation` は路線データを持ったまま作られるので、作り直すと走行中の
 * 状態が失われる。分岐は敷設のときに決まっているものとして扱う。
 */
const MAX_LANES = 512;

export interface DrivingOptions {
  /** 駅の諸元 (名前とホーム長)。 */
  readonly stations?: ReadonlyMap<StationId, Station>;
  /** 区間ごとの構造形式。トンネルの走行抵抗に効く。 */
  readonly structures?: ReadonlyMap<SegmentId, StructureRun[]>;
  /** 走らせる車両。省略すると通勤形 4 両編成。 */
  readonly consist?: ConsistSpec;
  /** 起点 (先頭端の距離程 [m])。省略すると編成が丸ごと載る位置。 */
  readonly startPosition?: number;
}

/** HUD に出す運転の状態。 */
export interface DrivingStatus {
  /** 速度 [km/h] */
  readonly speed: number;
  /** 制限速度 [km/h] */
  readonly limit: number;
  /** 力行ノッチ (0 = 切) */
  readonly powerNotch: number;
  /** ブレーキノッチ (0 = 緩解) */
  readonly brakeNotch: number;
  readonly holding: boolean;
  readonly emergency: boolean;
  /** 逆転機 (1 = 前、0 = 中立、-1 = 後) */
  readonly reverser: 1 | 0 | -1;
  /** ブレーキシリンダ圧 [kPa] */
  readonly cylinderPressure: number;
  /** 引張力 [kN]。負は制動。 */
  readonly tractiveEffort: number;
  /** 勾配 [‰] */
  readonly gradePermil: number;
  /** 次の停車駅。 */
  readonly nextStation: { name: string; distance: number; stopped: boolean } | null;
  /** 距離程 [m] と全長 [m]。 */
  readonly position: number;
  readonly routeLength: number;
  /** 走った時間 [s]。 */
  readonly elapsed: number;
}

export class Driving {
  readonly route: DrivingRoute;
  readonly sim: Simulation;
  readonly driver: DriverState;
  private readonly vehicle: Vehicle;
  private readonly consist: ConsistSpec;

  private constructor(
    route: DrivingRoute,
    sim: Simulation,
    driver: DriverState,
    vehicle: Vehicle,
    consist: ConsistSpec,
    private readonly traffic: Traffic,
  ) {
    this.route = route;
    this.sim = sim;
    this.driver = driver;
    this.vehicle = vehicle;
    this.consist = consist;
  }

  /**
   * その車線から前へ辿れるかぎりの経路を作り、列車を置く。
   *
   * `null` を返すのは、線路の車線が無いか、経路が編成より短いとき。
   */
  static start(
    graph: LaneGraph,
    traffic: Traffic,
    startLane: number,
    options: DrivingOptions = {},
  ): Driving | null {
    const lanes = walkForward(graph, startLane);
    if (lanes.length === 0) return null;

    const consist = options.consist ?? compileVehicle(commuter4Vehicle);
    const consistLength = consist.vehicles.reduce((a, v) => a + v.length, 0);

    let route: DrivingRoute;
    try {
      route = buildDrivingRoute(graph, lanes, {
        consistLength,
        ...(options.stations === undefined ? {} : { stations: options.stations }),
        ...(options.structures === undefined ? {} : { structures: options.structures }),
      });
    } catch {
      return null;
    }
    // 編成が丸ごと載らない線路では運転にならない。
    if (route.length < consistLength + 10) return null;

    const scenario = buildDrivingScenario(route, consist, {
      ...(options.startPosition === undefined ? {} : { startPosition: options.startPosition }),
    });
    const sim = new Simulation(scenario);
    const driver = new DriverState({
      powerNotchCount: () => consist.traction.notchCount,
      brakeNotchCount: () => consist.brake.notchCount,
      hasHoldingBrake: () => consist.brake.hasHoldingBrake,
      // 逆転ハンドルは止まっているときだけ動く (実車では主幹制御器と鎖錠されている)。
      canMoveReverser: () => Math.abs(sim.speed) < 0.05,
    });

    // 運転台を引き継ぐときは、ブレーキが込められている。実車で「ハンドルを
    // 渡す」というのはそういう状態のことで、緩解したまま渡せば勾配のある所で
    // 列車が転動する (デモ路線の始発は 25‰ の下り勾配にあり、緩解のまま置くと
    // 何もしていないのに 15 km/h まで出た)。
    driver.setBrake(consist.brake.notchCount);

    const vehicle = traffic.addDriven({
      route: [...route.lanes],
      head: sim.position,
      cars: consist.vehicles.length,
      size: { ...CAR_SIZE, length: consist.vehicles[0]?.length ?? CAR_SIZE.length },
      color: DRIVEN_COLOR,
    });

    const driving = new Driving(route, sim, driver, vehicle, consist, traffic);
    driving.sync();
    return driving;
  }

  /** 運転を終える。列車を線路から降ろす。 */
  stop(): void {
    this.traffic.removeDriven();
  }

  /** 運転している列車。乗車モードのカメラが乗る先。 */
  get train(): Vehicle {
    return this.vehicle;
  }

  apply(command: DriverCommand): void {
    this.driver.apply(command);
  }

  hold(command: HeldCommand): void {
    this.driver.hold(command);
  }

  release(command: HeldCommand): void {
    this.driver.release(command);
  }

  releaseAll(): void {
    this.driver.releaseAll();
  }

  /**
   * 1 フレーム進める。
   *
   * `Traffic.step` より**前**に呼ぶ。他の車両はこのフレームの列車の位置を
   * 見て車間を測るので、先に動かしておかないと 1 フレーム古い位置で判断する
   * ことになる。
   */
  update(dt: number): void {
    this.sim.input = this.driver.input;
    this.sim.step(dt);
    this.sync();
  }

  /** 物理の結果を、走っている車両へ移す。 */
  private sync(): void {
    const centres = this.sim.dynamics.vehicles.map((v) => v.s);
    this.traffic.moveDriven(this.vehicle, this.sim.position, this.sim.speed, centres);
  }

  status(): DrivingStatus {
    const snapshot = this.sim.snapshot();
    const next = this.sim.nextStation;
    return {
      speed: mpsToKmh(snapshot.speed),
      limit: mpsToKmh(snapshot.speedLimit),
      powerNotch: snapshot.powerNotch,
      brakeNotch: snapshot.brakeNotch,
      holding: this.driver.handles.holding,
      emergency: snapshot.emergency,
      reverser: this.driver.handles.reverser,
      cylinderPressure: snapshot.cylinderPressure / 1000,
      tractiveEffort: snapshot.tractiveEffort / 1000,
      gradePermil: snapshot.grade * 1000,
      nextStation: next
        ? {
            name: next.station.name,
            distance: next.station.stopPosition - snapshot.front,
            stopped: next.arrived && !next.departed,
          }
        : null,
      position: snapshot.front,
      routeLength: this.route.length,
      elapsed: snapshot.elapsed,
    };
  }

  /** 編成長 [m]。 */
  get consistLength(): number {
    return this.consist.vehicles.reduce((a, v) => a + v.length, 0);
  }
}

/**
 * 車線を前へ辿って 1 本の経路にする。
 *
 * 分岐では最初の枝を採る。折り返し (`reverse`) には入らない —— 止まらずに
 * 向きが変わることになるので、経路としては別物である。
 */
export function walkForward(graph: LaneGraph, startLane: number): number[] {
  const first = graph.lanes[startLane];
  if (!first || first.vehicleKind !== 'train') return [];
  const chain = [startLane];
  const seen = new Set(chain);
  for (let guard = 0; guard < MAX_LANES; guard++) {
    const last = graph.lanes[chain[chain.length - 1]!]!;
    const next = last.next.find((id) => !seen.has(id) && graph.lanes[id]?.vehicleKind === 'train');
    if (next === undefined) break;
    seen.add(next);
    chain.push(next);
  }
  return chain;
}

/** いちばん長く走れる線路の車線を探す (運転モードに入るときの既定の起点)。 */
export function longestRailStart(graph: LaneGraph): number | null {
  let best: { lane: number; length: number } | null = null;
  for (const lane of graph.lanes) {
    if (lane.vehicleKind !== 'train' || lane.kind !== 'segment') continue;
    let length = 0;
    for (const id of walkForward(graph, lane.id)) length += graph.lanes[id]?.path.length ?? 0;
    if (!best || length > best.length) best = { lane: lane.id, length };
  }
  return best?.lane ?? null;
}
