import { Vector2, Vector3 } from 'three';
import { Alignment } from '../core/alignment';
import { curveFromTangents } from '../core/curve';
import { polygonHeightSampler } from '../core/meshbuilder';
import { STOP_LINE_OFFSET, SURFACE_LIFT, clamp } from '../core/units';
import { SPEED_FACTOR, type NetworkClass } from '../network/classes';
import type { Junction } from '../network/junction';
import { exitLaneFor, lanesOf, solveApproachLanes, type Lane } from '../network/lanes';
import type { Network, NodeId, SegmentId } from '../network/network';
import type { StationId } from '../network/station';

/**
 * 車線どうしの接続グラフ。
 *
 * 車や列車は「線形」ではなく「車線」の上を走る。セグメントの車線と、
 * 交差点の中を通る進路 (コネクタ) を頂点とし、走れる順に辺を張った有向
 * グラフをここで組み立てる。交通シミュレーションはこのグラフだけを見る。
 *
 * 線路に向きは無いので、1 本の軌道は向き違いの 2 車線になる。この 2 本は
 * `reverse` で互いを指し、止まってから折り返す先を表す (`next` ではない)。
 */

export type VehicleKind = 'car' | 'train';

/** 走行経路上の 1 点。位置・進行方向と、路面の横断勾配。 */
export interface LanePose {
  pos: Vector3;
  dir: Vector3;
  /**
   * 路面の横断勾配 (**車体から見て右**へ 1 m あたりの上がり)。カントや
   * 踏切の傾きがそのまま入る。
   *
   * 線形の `sample.right` (= `perp(t)` = (-z, x)) は、進行方向を向いた
   * ときの**左**を指す。線形・路面のデータはその向きで揃っているので、
   * 車体の姿勢へ渡すここで符号を返す。
   */
  roll: number;
}

/** 走行経路 1 本。弧長で位置と向きを引ける。 */
export interface LanePath {
  readonly length: number;
  poseAt(s: number): LanePose;
}

export interface GraphLane {
  id: number;
  /** セグメント本体か、交差点の中の進路か。 */
  kind: 'segment' | 'connector';
  vehicleKind: VehicleKind;
  path: LanePath;
  /** 設計速度から決めた走行速度 [m/s]。 */
  speedLimit: number;
  /** 続けて走れる車線。 */
  next: number[];
  /**
   * 同じ線路を逆向きに走る車線 (線路だけ)。
   *
   * 線路に向きは無いので、1 本の軌道は向き違いの 2 車線になる。**折り返しは
   * `next` には入れない**。続けて走れる先ではなく、いったん止まってから
   * 移る先なので、`next` に入れると車両がその場で向きを変えてしまう。
   */
  reverse?: number;
  segment?: SegmentId;
  /** Platform-centre stop measured from this lane path's start. */
  stationStop?: { station: StationId; s: number };
  /** コネクタが属する交差点。 */
  node?: NodeId;
  /** 信号のある交差点の進路なら、その位相 (同じ位相が同時に青)。 */
  phase?: number;
  /**
   * この進路に入る前に止まる位置 (進路の入口からの手前距離 [m])。
   *
   * 路面に描いた停止線と同じ値を使う。交差点の面の際まで出て止まると、
   * 横断歩道を塞いだ車が並ぶことになる。
   */
  stopLine?: number;
  /** 同時に進入してはいけない他の進路。 */
  conflicts: number[];
}

export interface LaneGraph {
  lanes: GraphLane[];
  /** セグメント本体の車線だけ (車両を湧かせる場所)。 */
  spawnable: number[];
}

/** 交差点の枝ごとの信号の位相。隣り合う枝が交互に青になる。 */
export function signalPhaseOf(index: number): number {
  return index % 2;
}

/** 車線の中心を走るときの走行速度 [m/s]。 */
function speedOf(cls: NetworkClass): number {
  return (cls.designSpeed / 3.6) * SPEED_FACTOR;
}

/**
 * 描画に使った路面の高さ。踏切のまわりでは路面が線路に合わせて上下・
 * 傾斜するので、線形をそのままたどると車が舗装の下に潜る。
 */
export type SurfaceQuery = (segment: SegmentId, s: number, y: number) => {
  dy: number;
  roll: number;
};

/**
 * 縦断勾配を読むときに、前後を見る距離 [m]。
 *
 * 踏切のすり付けは十数 m で上下するので、点の勾配をそのまま使うと車体が
 * 折れ線をなぞる。前後 2 m ほど (車の軸距ぐらい) を見れば、路面の凹凸を
 * 車輪でまたぐのと同じように均される。
 */
const GRADE_STEP = 2;

/** セグメント上の車線 (トリムした範囲だけ)。 */
class SegmentLanePath implements LanePath {
  readonly length: number;
  constructor(
    private readonly alignment: Alignment,
    private readonly offset: number,
    private readonly s0: number,
    private readonly s1: number,
    private readonly forward: boolean,
    private readonly segment: SegmentId,
    private readonly surface?: SurfaceQuery,
  ) {
    this.length = Math.max(0, s1 - s0);
  }

  poseAt(d: number): LanePose {
    const along = clamp(d, 0, this.length);
    const s = this.forward ? this.s0 + along : this.s1 - along;
    const sample = this.alignment.sampleAt(s);
    // 路面と同じ補正を通す。踏切の前後で舗装は上下し、曲線ではカントで傾く。
    const blend = this.surface?.(this.segment, s, sample.pos.y) ?? { dy: 0, roll: 0 };
    const dir = this.forward ? sample.forward.clone() : sample.forward.clone().negate();
    return {
      pos: new Vector3(
        sample.pos.x + sample.right.x * this.offset,
        sample.pos.y + blend.dy + this.offset * blend.roll + SURFACE_LIFT,
        sample.pos.z + sample.right.z * this.offset,
      ),
      dir: this.surface ? this.pitch(dir, s) : dir,
      // 線形の「右」は車体から見た左なので、ここで符号を返す。弧長の向きが
      // 逆に走る車線では、車体の右がさらに逆になるのでもう一度返る。
      roll: this.forward ? -blend.roll : blend.roll,
    };
  }

  /**
   * 進行方向を、**補正後の路面**の縦断勾配に合わせて起こす。
   *
   * `sample.forward` は線形そのものの勾配なので、踏切のすり付けで舗装が
   * 上下している所では車体が路面と平行にならない。位置だけ持ち上げて姿勢を
   * そのままにすると、坂を水平のまま登る (踏切の山を鼻先で突っ切る) 形に
   * なるので、実際に走る線の勾配を測り直して向きを差し替える。
   */
  private pitch(dir: Vector3, s: number): Vector3 {
    const back = clamp(s - GRADE_STEP, 0, this.alignment.length);
    const ahead = clamp(s + GRADE_STEP, 0, this.alignment.length);
    const span = ahead - back;
    const flat = Math.hypot(dir.x, dir.z);
    if (span < 1e-6 || flat < 1e-9) return dir;
    // 弧長 (水平距離) あたりの上がり。線形自身の勾配も含んだ値になる。
    const rise = (this.heightAt(ahead) - this.heightAt(back)) / span;
    const grade = this.forward ? rise : -rise;
    const scale = 1 / Math.sqrt(1 + grade * grade);
    return dir.set((dir.x / flat) * scale, grade * scale, (dir.z / flat) * scale);
  }

  /** その弧長で、この車線が実際に通る高さ [m]。 */
  private heightAt(s: number): number {
    const sample = this.alignment.sampleAt(s);
    const blend = this.surface?.(this.segment, s, sample.pos.y) ?? { dy: 0, roll: 0 };
    return sample.pos.y + blend.dy + this.offset * blend.roll;
  }
}

/** 交差点の中を通る進路。両端の位置と向きから 3 次曲線で結ぶ。 */
class ConnectorPath implements LanePath {
  private readonly alignment: Alignment;
  readonly length: number;

  constructor(
    from: { pos: Vector3; dir: Vector3 },
    to: { pos: Vector3; dir: Vector3 },
    /** 制御点を伸ばす割合。転回のように両端が向かい合う進路では大きくする。 */
    tension = 1 / 3,
    /**
     * 交差点面の高さ。進路は両端を結んだだけの縦断なので、面が反って
     * いる交差点 (勾配の違う枝が集まる所) では途中が面の下に潜る。
     */
    private readonly floor?: (x: number, z: number) => number | null,
  ) {
    const a = new Vector2(from.pos.x, from.pos.z);
    const b = new Vector2(to.pos.x, to.pos.z);
    const ta = new Vector2(from.dir.x, from.dir.z);
    const tb = new Vector2(to.dir.x, to.dir.z);
    const horizontal = curveFromTangents(a, ta, b, tb, tension);
    this.alignment = Alignment.create(horizontal, from.pos.y, to.pos.y);
    this.length = Math.max(0.5, horizontal.length);
  }

  poseAt(d: number): LanePose {
    const sample = this.alignment.sampleAt(clamp(d, 0, this.alignment.length));
    const pos = sample.pos.clone();
    const floor = this.floor?.(pos.x, pos.z);
    if (floor !== null && floor !== undefined && floor > pos.y) pos.y = floor;
    // 交差点の面は水平断面で組む (カントは面の手前で 0 に戻してある)。
    return { pos, dir: sample.forward.clone(), roll: 0 };
  }
}

/** 交差点に入る車線か (`atStart` はノードがセグメントの a 側かどうか)。 */
function isEntry(lane: Lane, atStart: boolean): boolean {
  return lane.forward !== atStart;
}

/** 外向き方向から見た車線の横距。 */
function outwardOffset(lane: Lane, atStart: boolean): number {
  return atStart ? lane.offset : -lane.offset;
}

/**
 * ネットワークから車線グラフを組み立てる。
 *
 * `ranges` は交差点でトリムしたあとの描画範囲。車線もそこで切っておくと、
 * 交差点の中はコネクタだけが担当することになり、二重に走らせずに済む。
 */
export function buildLaneGraph(
  network: Network,
  junctions: Map<NodeId, Junction>,
  ranges: Map<SegmentId, { s0: number; s1: number }>,
  options: { surface?: SurfaceQuery } = {},
): LaneGraph {
  const lanes: GraphLane[] = [];
  /** セグメントの車線 ID。`segment:index` で引く。 */
  const bySegment = new Map<string, number>();

  const add = (lane: Omit<GraphLane, 'id' | 'next' | 'conflicts'>): GraphLane => {
    const created: GraphLane = { ...lane, id: lanes.length, next: [], conflicts: [] };
    lanes.push(created);
    return created;
  };

  for (const seg of network.segments.values()) {
    const cls = network.classOf(seg);
    const drawn = ranges.get(seg.id);
    if (!drawn || drawn.s1 - drawn.s0 < 1) continue;
    // 行き止まりでは、転回できるぶんだけ車線を手前で終える。舗装の端まで
    // 車線を延ばすと、転回の弧が路面からはみ出して草の上を回ることになる。
    const inset = deadEndInset(cls);
    const room = (drawn.s1 - drawn.s0) * 0.25;
    const back = (node: NodeId): number =>
      junctions.get(node)?.kind === 'end' ? Math.min(inset, room) : 0;
    const range = { s0: drawn.s0 + back(seg.a), s1: drawn.s1 - back(seg.b) };
    const alignment = network.alignmentOf(seg.id);
    for (const lane of lanesOf(cls, seg.id)) {
      const station = seg.stationTrack ? network.stations.get(seg.stationTrack.station) : undefined;
      const stationCenter = alignment.length / 2;
      const stationStop = station
        ? {
            station: station.id,
            s: clamp(
              lane.forward ? stationCenter - range.s0 : range.s1 - stationCenter,
              0,
              range.s1 - range.s0,
            ),
          }
        : undefined;
      const created = add({
        kind: 'segment',
        vehicleKind: cls.kind === 'rail' ? 'train' : 'car',
        path: new SegmentLanePath(
          alignment,
          lane.offset,
          range.s0,
          range.s1,
          lane.forward,
          seg.id,
          options.surface,
        ),
        speedLimit: speedOf(cls),
        segment: seg.id,
        stationStop,
      });
      bySegment.set(`${seg.id}:${lane.index}`, created.id);
    }
    // 同じ軌道の向き違いの車線どうしを結ぶ (線路の折り返し)。
    linkReverse(lanes, cls, seg.id, bySegment);
  }

  const laneId = (lane: Lane): number | undefined =>
    bySegment.get(`${lane.segment}:${lane.index}`);

  /**
   * 進路が潜ってはいけない床の高さを引く関数。
   *
   * 交差点では面 (いちばん内側のリング = 車道面)、行き止まりでは転回する
   * 相手の路面そのもの。勾配のある道路の行き止まりでは、転回の弧が
   * 前へ膨らむぶんだけ路面が上がるので、これがないと車が舗装に潜る。
   */
  const floors = new Map<NodeId, (x: number, z: number) => number | null>();
  const floorOf = (junction: Junction): ((x: number, z: number) => number | null) => {
    const found = floors.get(junction.node);
    if (found) return found;
    const ring = junction.rings[junction.rings.length - 1] ?? [];
    const sampler = ring.length >= 3 ? polygonHeightSampler(ring) : deadEndFloor(junction);
    const lifted = (x: number, z: number): number | null => {
      const y = sampler(x, z);
      return y === null ? null : y + SURFACE_LIFT;
    };
    floors.set(junction.node, lifted);
    return lifted;
  };

  /** 行き止まりの路面 (端から手前 8 m ぶん) を引く関数。 */
  const deadEndFloor = (junction: Junction): ((x: number, z: number) => number | null) => {
    const approach = junction.approaches[0];
    const drawn = approach ? ranges.get(approach.branch.segment) : undefined;
    if (!approach || !drawn) return () => null;
    const alignment = network.alignmentOf(approach.branch.segment);
    const from = approach.branch.atStart ? drawn.s0 : Math.max(drawn.s0, drawn.s1 - 8);
    const to = approach.branch.atStart ? Math.min(drawn.s1, drawn.s0 + 8) : drawn.s1;
    const points: { x: number; z: number; y: number; rx: number; rz: number; roll: number }[] = [];
    for (let s = from; s <= to; s += 0.5) {
      const sample = alignment.sampleAt(s);
      const blend = options.surface?.(approach.branch.segment, s, sample.pos.y);
      points.push({
        x: sample.pos.x,
        z: sample.pos.z,
        y: sample.pos.y + (blend?.dy ?? 0),
        rx: sample.right.x,
        rz: sample.right.z,
        roll: blend?.roll ?? 0,
      });
    }
    return (x: number, z: number): number | null => {
      let best: (typeof points)[number] | null = null;
      let bestDistance = 36;
      for (const p of points) {
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = p;
        }
      }
      if (!best) return null;
      const lateral = (x - best.x) * best.rx + (z - best.z) * best.rz;
      return best.y + lateral * best.roll;
    };
  };

  /** 車線どうしを交差点の中で繋ぐ。 */
  const connect = (
    junction: Junction,
    entry: Lane,
    exit: Lane,
    phase: number | undefined,
    speed: number,
    tension?: number,
    stopLine?: number,
  ): void => {
    const from = laneId(entry);
    const to = laneId(exit);
    if (from === undefined || to === undefined || from === to) return;
    const fromLane = lanes[from];
    const toLane = lanes[to];
    const start = fromLane.path.poseAt(fromLane.path.length);
    const end = toLane.path.poseAt(0);
    if (start.pos.distanceTo(end.pos) < 0.05) {
      // 継ぎ目のように、ほぼ同じ点で繋がる車線は直接繋ぐ。
      fromLane.next.push(to);
      return;
    }
    const connector = add({
      kind: 'connector',
      vehicleKind: fromLane.vehicleKind,
      path: new ConnectorPath(start, end, tension, floorOf(junction)),
      speedLimit: speed,
      node: junction.node,
      phase,
      stopLine,
    });
    fromLane.next.push(connector.id);
    connector.next.push(to);
  };

  for (const junction of junctions.values()) {
    const isRail = junction.approaches[0]?.branch.cls.kind === 'rail';
    const first = lanes.length;

    if (junction.kind === 'end') connectDeadEnd(junction, connect);
    else if (isRail) connectTracks(junction, connect);
    else connectRoads(junction, connect);
    markConflicts(lanes, first);
  }

  return {
    lanes,
    spawnable: lanes
      .filter((l) => l.kind === 'segment' && l.path.length > 15 && !l.stationStop)
      // 線路は向き違いの 2 車線で 1 本の軌道なので、湧かせる場所としては
      // 片方だけ数える (両方数えると線路の本数を倍に見積もってしまう)。
      .filter((l) => l.reverse === undefined || l.reverse > l.id)
      .map((l) => l.id),
  };
}

/**
 * 同じ軌道を逆向きに走る車線どうしを結ぶ。
 *
 * 断面の同じ位置にある、向きが逆の車線の組を探す。線路では 1 組だけだが、
 * 種別の定義から引くので、軌道を増やしてもそのまま通る。
 */
function linkReverse(
  lanes: GraphLane[],
  cls: NetworkClass,
  segment: SegmentId,
  bySegment: Map<string, number>,
): void {
  if (cls.kind !== 'rail') return;
  const specs = lanesOf(cls, segment);
  for (const lane of specs) {
    if (!lane.forward) continue;
    const back = specs.find(
      (other) => !other.forward && Math.abs(other.offset - lane.offset) < 1e-6,
    );
    if (!back) continue;
    const a = bySegment.get(`${segment}:${lane.index}`);
    const b = bySegment.get(`${segment}:${back.index}`);
    if (a === undefined || b === undefined) continue;
    lanes[a].reverse = b;
    lanes[b].reverse = a;
  }
}

type Connect = (
  junction: Junction,
  entry: Lane,
  exit: Lane,
  phase: number | undefined,
  speed: number,
  tension?: number,
  stopLine?: number,
) => void;

/**
 * 転回の制御点の長さ (両端の間隔に対する比)。
 *
 * 3 次ベジエで半円を近似する値 (4/3 × 半径 = 2/3 × 直径)。これより
 * 長くすると弧が前へ膨らみ、行き止まりの舗装から飛び出してしまう。
 */
const UTURN_TENSION = 2 / 3;

/**
 * 行き止まりで転回するために、車線を手前で終える長さ [m]。
 *
 * 転回の弧は、内側どうしの車線の間隔を直径とする半円になるので、
 * 車線の端から半径のぶんだけ前に膨らむ。そのぶんを引いておく。
 */
function deadEndInset(cls: NetworkClass): number {
  if (cls.kind !== 'road' || cls.oneWay || cls.lanes.length < 2) return 0;
  const span = Math.min(
    ...cls.lanes
      .filter((l) => l.direction > 0)
      .map((l) =>
        Math.min(
          ...cls.lanes.filter((o) => o.direction < 0).map((o) => Math.abs(l.offset - o.offset)),
        ),
      ),
  );
  if (!Number.isFinite(span)) return 0;
  return span / 2 + 0.6;
}

/**
 * 行き止まりでの転回。
 *
 * 対向車線のある道路なら、行き止まりで向きを変えて戻れる。繋いでおかないと
 * 車がそこで消えてしまい、袋小路のある町で車が湧いては消えるだけになる。
 */
function connectDeadEnd(junction: Junction, connect: Connect): void {
  const approach = junction.approaches[0];
  if (!approach || approach.branch.cls.kind !== 'road') return;
  const atStart = approach.branch.atStart;
  const lanes = lanesOf(approach.branch.cls, approach.branch.segment);
  // いちばん中央寄りの車線どうしを繋ぐ (転回の半径がいちばん小さい)。
  const entry = lanes
    .filter((l) => isEntry(l, atStart))
    .sort((a, b) => outwardOffset(a, atStart) - outwardOffset(b, atStart))[0];
  const exit = lanes
    .filter((l) => !isEntry(l, atStart))
    .sort((a, b) => outwardOffset(b, atStart) - outwardOffset(a, atStart))[0];
  if (!entry || !exit) return;
  connect(junction, entry, exit, undefined, 4, UTURN_TENSION);
}

/** 道路の交差点。進行方向別通行区分に従って進路を張る。 */
function connectRoads(junction: Junction, connect: Connect): void {
  const assignment = solveApproachLanes(junction);
  junction.approaches.forEach((approach, index) => {
    const lanes = assignment.get(approach.branch.segment);
    if (!lanes) return;
    const phase = junction.signalized ? signalPhaseOf(index) : undefined;
    lanes.entry.forEach((entry, i) => {
      for (const movement of entry.movements) {
        for (const exit of lanes.exits) {
          if (exit.movement !== movement) continue;
          const target = exitLaneFor(exit, i, lanes.entry.length);
          // 交差点の中は曲がる分だけ遅い。直進でもいくらか落とす。
          const limit = Math.min(
            approach.branch.cls.designSpeed,
            exit.approach.branch.cls.designSpeed,
          );
          const factor = movement === 'through' ? 0.7 : 0.4;
          // 止まる位置は路面に描いた停止線。交差点の面の際まで出ない。
          const stopLine = junction.kind === 'intersection' ? STOP_LINE_OFFSET : undefined;
          connect(junction, entry.lane, target, phase, (limit / 3.6) * factor, undefined, stopLine);
        }
      }
    });
  });
}

/** 線路の分岐器・クロッシング。進路は `Junction.connections` が決めている。 */
function connectTracks(junction: Junction, connect: Connect): void {
  for (const connection of junction.connections) {
    for (const [fromId, toId] of [
      [connection.from, connection.to],
      [connection.to, connection.from],
    ]) {
      const from = junction.approaches.find((a) => a.branch.segment === fromId);
      const to = junction.approaches.find((a) => a.branch.segment === toId);
      if (!from || !to) continue;
      const fromLanes = lanesOf(from.branch.cls, fromId).filter((l) =>
        isEntry(l, from.branch.atStart),
      );
      const toLanes = lanesOf(to.branch.cls, toId).filter(
        (l) => !isEntry(l, to.branch.atStart),
      );
      if (toLanes.length === 0) continue;
      for (const lane of fromLanes) {
        // 相手側では左右が反転するので、横距が符号違いで一致する軌道を選ぶ。
        const wanted = -outwardOffset(lane, from.branch.atStart);
        let best = toLanes[0];
        let bestDelta = Infinity;
        for (const candidate of toLanes) {
          const delta = Math.abs(outwardOffset(candidate, to.branch.atStart) - wanted);
          if (delta < bestDelta) {
            bestDelta = delta;
            best = candidate;
          }
        }
        const limit = Math.min(from.branch.cls.designSpeed, to.branch.cls.designSpeed);
        connect(junction, lane, best, undefined, (limit / 3.6) * (connection.through ? 0.8 : 0.4));
      }
    }
  }
}

/** 交差点の中で経路が交わる進路の組を記録する。 */
const CONFLICT_DISTANCE = 3.5;

/**
 * 同時に進入できない進路の組を求める。
 *
 * 同じ車線から分かれる進路どうしは競合しない (分岐するだけ)。それ以外で
 * 経路が近づく組は、交差するか合流するかのどちらかなので競合とみなす。
 */
function markConflicts(lanes: GraphLane[], from: number): void {
  const connectors = lanes.slice(from).filter((l) => l.kind === 'connector');
  const samples = new Map<number, Vector3[]>();
  for (const lane of connectors) {
    const steps = Math.max(2, Math.ceil(lane.path.length / 2));
    const points: Vector3[] = [];
    for (let i = 0; i <= steps; i++) points.push(lane.path.poseAt((i / steps) * lane.path.length).pos);
    samples.set(lane.id, points);
  }

  const entryOf = new Map<number, number>();
  for (const lane of lanes) {
    for (const next of lane.next) {
      if (lanes[next]?.kind === 'connector') entryOf.set(next, lane.id);
    }
  }

  for (let i = 0; i < connectors.length; i++) {
    for (let j = i + 1; j < connectors.length; j++) {
      const a = connectors[i];
      const b = connectors[j];
      if (entryOf.get(a.id) !== undefined && entryOf.get(a.id) === entryOf.get(b.id)) continue;
      if (!pathsMeet(samples.get(a.id)!, samples.get(b.id)!)) continue;
      a.conflicts.push(b.id);
      b.conflicts.push(a.id);
    }
  }
}

function pathsMeet(a: Vector3[], b: Vector3[]): boolean {
  for (const p of a) {
    for (const q of b) {
      const dx = p.x - q.x;
      const dz = p.z - q.z;
      if (dx * dx + dz * dz < CONFLICT_DISTANCE * CONFLICT_DISTANCE) return true;
    }
  }
  return false;
}
