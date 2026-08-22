import { Vector3 } from 'three';
import { clamp } from '../core/units';
import type { RGB } from '../build/surface';
import type { LaneGraph, VehicleKind } from './lanegraph';
import { signalStateAt } from './signals';

/**
 * 車線グラフの上を走る車両。
 *
 * 車は前を走る車と信号・交差点の進路の競合だけを見る。厳密な交通流の
 * 再現ではなく、「敷いた道路網が実際に通り抜けられること」が目で分かる
 * ことを狙う。走れなくなった車両は消し、別の場所に湧かせる。
 */

/** 1 両の寸法 [m]。 */
export interface BodySize {
  length: number;
  width: number;
  height: number;
}

/** 車両 1 両の姿勢。 */
export interface BodyPose {
  pos: Vector3;
  dir: Vector3;
  /** 路面の横断勾配 (右へ 1 m あたりの上がり)。カントで車体が傾く。 */
  roll: number;
}

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  /** 通る車線の並び (過去 → 未来)。 */
  route: number[];
  /** `route[0]` の起点から測った先頭位置 [m]。 */
  head: number;
  speed: number;
  size: BodySize;
  /** 両数。 */
  cars: number;
  color: RGB;
  /** 両ごとの姿勢 (先頭から順)。 */
  bodies: BodyPose[];
  /**
   * 進入すると決めた交差点の進路。
   *
   * 停止線を越えてから信号や進路の取り合いで気が変わると、横断歩道の上や
   * 交差点の中で止まることになる。越える前に決め、越えたらそのまま渡る。
   */
  commit?: number;
}

/** 加速度・減速度 [m/s^2]。 */
const ACCEL = 1.9;
const DECEL = 3.4;
/** とっさのときの減速度 [m/s^2]。 */
const MAX_BRAKE = 6.5;
/** 前車に対して空ける車頭時間 [s]。 */
const HEADWAY = 1.1;
/** 前車との最小車間 [m]。 */
const MIN_GAP = 2.5;
/** 前方を見る距離 [m]。 */
const LOOKAHEAD = 90;
/** 交差点の進路に入る前に、競合の有無を確かめ始める距離 [m]。 */
const ENTRY_CHECK = 14;
/** 停止線の無い進路 (分岐器・転回) で、交差点の面の手前に取る余裕 [m]。 */
const STOP_MARGIN = 0.5;
/** 連結する車両どうしの間隔 [m]。 */
const COUPLING = 0.8;
/** 車両を湧かせるときに、まわりに空けておく距離 [m]。 */
const SPAWN_CLEARANCE = 15;

const CAR_COLORS: RGB[] = [
  [0.82, 0.84, 0.86],
  [0.18, 0.2, 0.24],
  [0.7, 0.22, 0.2],
  [0.2, 0.36, 0.62],
  [0.3, 0.5, 0.34],
  [0.85, 0.7, 0.25],
];
const TRAIN_COLORS: RGB[] = [
  [0.24, 0.42, 0.72],
  [0.72, 0.3, 0.26],
  [0.35, 0.6, 0.42],
];

const CAR_SIZE: BodySize = { length: 4.4, width: 1.8, height: 1.45 };
const TRUCK_SIZE: BodySize = { length: 8.2, width: 2.4, height: 3.1 };
const TRAIN_SIZE: BodySize = { length: 18, width: 2.9, height: 3.6 };

export interface TrafficOptions {
  /** 乱数の種。省略すると毎回同じ並びになる (テストのため)。 */
  seed?: number;
  /** 車の密度 (この距離 [m] に 1 台)。 */
  carSpacing?: number;
  /** 列車の密度 (この距離 [m] に 1 編成)。 */
  trainSpacing?: number;
  /** 車両数の上限。 */
  maxCars?: number;
  maxTrains?: number;
}

export class Traffic {
  readonly vehicles: Vehicle[] = [];
  /** 経過時間 [s]。信号の現示に使う。 */
  time = 0;
  private nextId = 1;
  private rng: () => number;
  private readonly options: Required<TrafficOptions>;

  constructor(
    private graph: LaneGraph,
    options: TrafficOptions = {},
  ) {
    this.options = {
      seed: options.seed ?? 20260813,
      carSpacing: options.carSpacing ?? 260,
      trainSpacing: options.trainSpacing ?? 700,
      maxCars: options.maxCars ?? 56,
      maxTrains: options.maxTrains ?? 5,
    };
    this.rng = mulberry32(this.options.seed);
  }

  /** 車線グラフを差し替える (敷設し直したとき)。走っている車両は捨てる。 */
  reset(graph: LaneGraph): void {
    this.graph = graph;
    this.vehicles.length = 0;
    this.rng = mulberry32(this.options.seed);
  }

  /** その車両がいま乗っている車線。 */
  laneOf(vehicle: Vehicle): number {
    return vehicle.route[this.locate(vehicle.route, vehicle.head).index];
  }

  /** その種別で走らせたい台数。 */
  targetCount(kind: VehicleKind): number {
    let length = 0;
    for (const id of this.graph.spawnable) {
      const lane = this.graph.lanes[id];
      if (lane.vehicleKind === kind) length += lane.path.length;
    }
    const spacing = kind === 'train' ? this.options.trainSpacing : this.options.carSpacing;
    const limit = kind === 'train' ? this.options.maxTrains : this.options.maxCars;
    return Math.min(limit, Math.floor(length / spacing));
  }

  /**
   * 時間を `dt` [s] 進める。`time` を渡すと信号の時刻をそれに合わせる
   * (描画側と同じ現示を見るため)。
   */
  step(dt: number, time?: number): void {
    const step = clamp(dt, 0, 0.1);
    this.time = time ?? this.time + step;
    this.populate();

    // いま誰かが乗っている車線と、その車線での最後尾の位置。合流の判断に使う。
    const occupied = new Set<number>();
    const tailIn = new Map<number, number>();
    for (const vehicle of this.vehicles) {
      const from = this.locate(vehicle.route, this.tailOf(vehicle));
      const to = this.locate(vehicle.route, vehicle.head);
      for (let i = from.index; i <= to.index; i++) {
        const id = vehicle.route[i];
        occupied.add(id);
        const tail = i === from.index ? from.s : 0;
        tailIn.set(id, Math.min(tailIn.get(id) ?? Infinity, tail));
      }
    }

    // 「入ると決めた」進路は、誰が先に判断するかに関わらず押さえておく。
    // 決めた車が横取りされると、止まりきれない所で止まる羽目になる。
    for (const vehicle of this.vehicles) {
      if (vehicle.commit === undefined) continue;
      const lane = this.graph.lanes[vehicle.commit];
      if (!lane) continue;
      occupied.add(lane.id);
      const target = lane.next[0];
      if (target !== undefined) tailIn.set(target, 0);
    }

    const space: JunctionSpace = { occupied, tailIn };
    for (const vehicle of this.vehicles) {
      this.advance(vehicle, step, space);
    }
    this.vehicles.splice(
      0,
      this.vehicles.length,
      ...this.vehicles.filter((v) => this.alive(v)),
    );
    for (const vehicle of this.vehicles) this.updateBodies(vehicle);
  }

  // ------------------------------------------------------------ 走行

  private advance(vehicle: Vehicle, dt: number, space: JunctionSpace): void {
    this.extendRoute(vehicle);
    const { occupied, tailIn } = space;
    // 合流先に自分が収まるだけの空きがあるか。前の車の最後尾までの距離で見る。
    const room = this.bodyLength(vehicle) + MIN_GAP;

    let stopIn = Infinity;
    let limit = Infinity;

    // 前方の車線を順に見て、速度制限・信号・競合・前車を拾う。
    const at = this.locate(vehicle.route, vehicle.head);
    // 進入すると決めた進路に乗ったら、そこから先は位置で押さえられる。
    if (vehicle.commit !== undefined && vehicle.route.indexOf(vehicle.commit) <= at.index) {
      vehicle.commit = undefined;
    }
    let ahead = -at.s;
    for (let i = at.index; i < vehicle.route.length; i++) {
      const lane = this.graph.lanes[vehicle.route[i]];
      if (!lane) break;
      if (ahead > LOOKAHEAD) break;
      // 25 m 先までの制限速度を守る (曲がる進路の手前で落とす)。
      if (ahead <= 25) limit = Math.min(limit, lane.speedLimit);

      if (i > at.index && lane.kind === 'connector') {
        // 止まる位置は停止線。停止線を引いていない進路 (分岐器・転回) は
        // 交差点の面の際で止める。
        const line = ahead - (lane.stopLine ?? STOP_MARGIN);
        const entry = ahead;
        // 合流先 (進路を抜けた先の車線) に空きがあるか。別の進路から
        // 合流してくる車は、互いの進路の上にいる間は見えないので、
        // 入る前にここで確かめないと重なってしまう。
        const target = lane.next[0];
        const free = target === undefined ? Infinity : tailIn.get(target) ?? Infinity;
        /** 進入すると決めたときの押さえ。 */
        const reserve = (): void => {
          // 同じ枠を 2 台が同時に取ってしまわないよう、判断した順に確定する。
          occupied.add(lane.id);
          if (target !== undefined) tailIn.set(target, 0);
          // もう止まりきれない所まで来たら、そこから先は引き返さない。
          // (引き返せば、横断歩道や交差点の中で止まることになる。)
          if (!this.canStopBefore(line, vehicle.speed)) vehicle.commit = lane.id;
        };

        // 停止線の手前で止まりきれるか。止まれない所で「やっぱり止まる」と
        // 決めると、横断歩道や交差点の中で止まることになる。
        const canStop = this.canStopBefore(line, vehicle.speed);
        // 進路の取り合いは、止まれる距離のうちに見ておく。ぎりぎりで
        // 気付いても間に合わない。
        const decideAt = ENTRY_CHECK + this.brakingDistance(vehicle.speed);
        const signal =
          lane.phase === undefined ? 0 : signalStateAt(this.time, lane.phase);

        // 進路の取り合い。合流先に空きが無い / 交わる進路に誰かいる。
        const busy = free < room || lane.conflicts.some((c) => occupied.has(c));

        if (vehicle.commit === lane.id) {
          // 決めたあとでも、まだ止まれるうちに赤や取り合いに気付いたら
          // 取り消す。止まれないなら、決めたとおり渡り切る。
          if (canStop && (signal !== 0 || busy)) {
            stopIn = Math.min(stopIn, line);
            vehicle.commit = undefined;
          } else {
            reserve();
          }
        } else if (signal !== 0) {
          // 黄で止まりきれず、進路も空いているなら渡り切る (ジレンマゾーン)。
          // 止まれるなら止まるし、進路が空いていなければ精一杯止まる。
          if (signal === 1 && !canStop && !busy) reserve();
          else stopIn = Math.min(stopIn, line);
        } else if (entry < decideAt && busy) {
          stopIn = Math.min(stopIn, line);
        } else if (entry < decideAt) {
          reserve();
        }
      }
      ahead += lane.path.length;
    }

    // 経路が尽きる所 (行き止まり) でも止まる。
    stopIn = Math.min(stopIn, this.remaining(vehicle));

    // 信号・進路の取り合い・行き止まりは「止まっている前車」とみなすと、
    // 前車追従と同じ式で扱える。
    const leader = this.leader(vehicle);
    let gap = leader.gap;
    let leadSpeed = leader.speed;
    if (stopIn + MIN_GAP < gap) {
      gap = Math.max(0.05, stopIn + MIN_GAP);
      leadSpeed = 0;
    }

    const v = vehicle.speed;
    const v0 = Number.isFinite(limit) ? limit : 12;
    // 追従は IDM (Intelligent Driver Model)。相対速度を見るので、前車に
    // 追いついたときに行き過ぎて重なることがない。
    const approach = (v * (v - leadSpeed)) / (2 * Math.sqrt(ACCEL * DECEL));
    const wanted = MIN_GAP + Math.max(0, v * HEADWAY + approach);
    const crowding = gap > 0.05 ? (wanted / gap) ** 2 : 400;
    const accel = ACCEL * (1 - (v / Math.max(0.5, v0)) ** 4 - crowding);
    vehicle.speed = Math.max(0, v + clamp(accel, -MAX_BRAKE, ACCEL) * dt);
    vehicle.head += vehicle.speed * dt;
    this.trimRoute(vehicle);
  }

  /**
   * その速度から停止線までに止まりきるのに要る距離 [m]。
   *
   * 減速度 `DECEL` で止まる距離に、判断と車間の余裕を足したもの。
   * これより手前で「止まる」と決めても間に合わないので、進路の取り合いは
   * この距離のうちに決める。速いほど長くなるが、上限を切って、交差点を
   * 何十秒も押さえたままにしない。
   */
  private brakingDistance(speed: number): number {
    return Math.min(60, (speed * speed) / (2 * DECEL) + MIN_GAP);
  }

  /**
   * その速度で、`distance` [m] 先の停止線までに止まりきれるか。
   *
   * ほとんど止まっている車はいつでも止まれる (停止線の上で待っている車が
   * 「もう止まれない」と判断して動き出さないように)。
   */
  private canStopBefore(distance: number, speed: number): boolean {
    if (speed < 1.5) return distance > -0.5;
    return distance >= this.brakingDistance(speed);
  }

  /** 前を走る車両との車間 [m] と、その速度。いなければ無限大。 */
  private leader(vehicle: Vehicle): { gap: number; speed: number } {
    const at = this.locate(vehicle.route, vehicle.head);
    let best = { gap: Infinity, speed: 0 };
    const offsets = new Map<number, number>();
    let ahead = -at.s;
    for (let i = at.index; i < vehicle.route.length && ahead <= LOOKAHEAD; i++) {
      const id = vehicle.route[i];
      if (!offsets.has(id)) offsets.set(id, ahead);
      ahead += this.graph.lanes[id]?.path.length ?? 0;
    }

    for (const other of this.vehicles) {
      if (other === vehicle) continue;
      const tail = this.locate(other.route, this.tailOf(other));
      const laneOffset = offsets.get(other.route[tail.index]);
      if (laneOffset === undefined) continue;
      const gap = laneOffset + tail.s;
      if (gap > 0 && gap < best.gap) best = { gap, speed: other.speed };
    }
    return best;
  }

  /** 経路の終わりまでの距離 [m]。延長できるならまだ余裕がある。 */
  private remaining(vehicle: Vehicle): number {
    let total = 0;
    for (const id of vehicle.route) total += this.graph.lanes[id]?.path.length ?? 0;
    return total - vehicle.head;
  }

  private alive(vehicle: Vehicle): boolean {
    // 転回できない行き止まり (一方通行の末端) に着いたら消す。
    if (this.successors(vehicle).length > 0) return true;
    return this.remaining(vehicle) > 3;
  }

  private successors(vehicle: Vehicle): number[] {
    const last = this.graph.lanes[vehicle.route[vehicle.route.length - 1]];
    return last ? last.next : [];
  }

  private extendRoute(vehicle: Vehicle): void {
    for (let guard = 0; guard < 8; guard++) {
      if (this.remaining(vehicle) > LOOKAHEAD) return;
      const options = this.successors(vehicle);
      if (options.length === 0) return;
      const pick = options[Math.floor(this.rng() * options.length) % options.length];
      vehicle.route.push(pick);
    }
  }

  /** 通り過ぎた車線を落とす。最後尾がまだ乗っている車線は残す。 */
  private trimRoute(vehicle: Vehicle): void {
    while (vehicle.route.length > 1) {
      const first = this.graph.lanes[vehicle.route[0]]?.path.length ?? 0;
      if (this.tailOf(vehicle) < first) return;
      vehicle.route.shift();
      vehicle.head -= first;
    }
  }

  /** 最後尾の位置 (`route[0]` の起点から測った距離)。 */
  private tailOf(vehicle: Vehicle): number {
    return vehicle.head - this.bodyLength(vehicle);
  }

  private bodyLength(vehicle: Vehicle): number {
    return vehicle.cars * vehicle.size.length + (vehicle.cars - 1) * COUPLING;
  }

  private locate(route: number[], distance: number): { index: number; s: number } {
    let rest = distance;
    for (let i = 0; i < route.length; i++) {
      const length = this.graph.lanes[route[i]]?.path.length ?? 0;
      if (rest <= length || i === route.length - 1) {
        return { index: i, s: clamp(rest, 0, length) };
      }
      rest -= length;
    }
    return { index: 0, s: 0 };
  }

  private poseAt(vehicle: Vehicle, distance: number): BodyPose {
    const at = this.locate(vehicle.route, distance);
    const lane = this.graph.lanes[vehicle.route[at.index]];
    return lane.path.poseAt(at.s);
  }

  private updateBodies(vehicle: Vehicle): void {
    const pitch = vehicle.size.length + COUPLING;
    for (let k = 0; k < vehicle.cars; k++) {
      const centre = vehicle.head - vehicle.size.length / 2 - k * pitch;
      vehicle.bodies[k] = this.poseAt(vehicle, Math.max(0, centre));
    }
  }

  // ------------------------------------------------------------ 湧き出し

  private populate(): void {
    for (const kind of ['car', 'train'] as const) {
      const want = this.targetCount(kind);
      const have = this.vehicles.filter((v) => v.kind === kind).length;
      // 1 フレームに 1 台ずつ。まとめて湧かせると団子になる。
      if (have < want) this.spawn(kind);
      else if (have > want + 1) {
        const index = this.vehicles.findIndex((v) => v.kind === kind);
        if (index >= 0) this.vehicles.splice(index, 1);
      }
    }
  }

  private spawn(kind: VehicleKind): void {
    const candidates = this.graph.spawnable.filter(
      (id) => this.graph.lanes[id].vehicleKind === kind,
    );
    if (candidates.length === 0) return;

    const size = kind === 'train' ? TRAIN_SIZE : this.rng() < 0.18 ? TRUCK_SIZE : CAR_SIZE;
    const cars = kind === 'train' ? 3 : 1;
    const length = cars * size.length + (cars - 1) * COUPLING;

    for (let attempt = 0; attempt < 12; attempt++) {
      const id = candidates[Math.floor(this.rng() * candidates.length) % candidates.length];
      const lane = this.graph.lanes[id];
      if (lane.path.length < length + 12) continue;
      if (!this.isClear(id, 0, length + 1)) continue;
      const palette = kind === 'train' ? TRAIN_COLORS : CAR_COLORS;
      const vehicle: Vehicle = {
        id: this.nextId++,
        kind,
        route: [id],
        head: length + 1,
        speed: lane.speedLimit * 0.6,
        size,
        cars,
        color: palette[Math.floor(this.rng() * palette.length) % palette.length],
        bodies: [],
      };
      this.updateBodies(vehicle);
      this.vehicles.push(vehicle);
      return;
    }
  }

  /**
   * その車線の入口側に車両を置けるか。
   *
   * 車線の上だけを見ると、手前の車線を走ってきた車の目の前に湧いてしまう
   * (相手からは車線が変わるまで見えない)。実際の位置で周りを空けておく。
   */
  private isClear(id: number, from: number, to: number): boolean {
    const lane = this.graph.lanes[id];
    const ends = [lane.path.poseAt(from).pos, lane.path.poseAt(to).pos];
    for (const vehicle of this.vehicles) {
      for (const body of vehicle.bodies) {
        for (const end of ends) {
          if (body.pos.distanceTo(end) < SPAWN_CLEARANCE) return false;
        }
      }
    }
    return true;
  }
}

/** 交差点まわりの空き状況。1 フレームのあいだ使い回す。 */
interface JunctionSpace {
  /** 誰かが乗っている車線。 */
  occupied: Set<number>;
  /** その車線に乗っている車両の、最後尾の位置 [m] (小さいほど入口に近い)。 */
  tailIn: Map<number, number>;
}

/** 決定的な擬似乱数 (mulberry32)。テストで同じ並びを再現できる。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
