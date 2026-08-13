import { Vector2, Vector3 } from 'three';
import { Alignment } from '../core/alignment';
import { curveFromTangents } from '../core/curve';
import { SURFACE_LIFT, clamp } from '../core/units';
import type { NetworkClass } from '../network/classes';
import type { Junction } from '../network/junction';
import { exitLaneFor, lanesOf, solveApproachLanes, type Lane } from '../network/lanes';
import type { Network, NodeId, SegmentId } from '../network/network';

/**
 * 車線どうしの接続グラフ。
 *
 * 車や列車は「線形」ではなく「車線」の上を走る。セグメントの車線と、
 * 交差点の中を通る進路 (コネクタ) を頂点とし、走れる順に辺を張った有向
 * グラフをここで組み立てる。交通シミュレーションはこのグラフだけを見る。
 */

export type VehicleKind = 'car' | 'train';

/** 走行経路 1 本。弧長で位置と向きを引ける。 */
export interface LanePath {
  readonly length: number;
  poseAt(s: number): { pos: Vector3; dir: Vector3 };
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
  segment?: SegmentId;
  /** コネクタが属する交差点。 */
  node?: NodeId;
  /** 信号のある交差点の進路なら、その位相 (同じ位相が同時に青)。 */
  phase?: number;
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
  return (cls.designSpeed / 3.6) * 0.85;
}

/** セグメント上の車線 (トリムした範囲だけ)。 */
class SegmentLanePath implements LanePath {
  readonly length: number;
  constructor(
    private readonly alignment: Alignment,
    private readonly offset: number,
    private readonly s0: number,
    private readonly s1: number,
    private readonly forward: boolean,
  ) {
    this.length = Math.max(0, s1 - s0);
  }

  poseAt(d: number): { pos: Vector3; dir: Vector3 } {
    const along = clamp(d, 0, this.length);
    const s = this.forward ? this.s0 + along : this.s1 - along;
    const sample = this.alignment.sampleAt(s);
    return {
      pos: new Vector3(
        sample.pos.x + sample.right.x * this.offset,
        sample.pos.y + SURFACE_LIFT,
        sample.pos.z + sample.right.z * this.offset,
      ),
      dir: this.forward ? sample.forward.clone() : sample.forward.clone().negate(),
    };
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
  ) {
    const a = new Vector2(from.pos.x, from.pos.z);
    const b = new Vector2(to.pos.x, to.pos.z);
    const ta = new Vector2(from.dir.x, from.dir.z);
    const tb = new Vector2(to.dir.x, to.dir.z);
    const horizontal = curveFromTangents(a, ta, b, tb, tension);
    this.alignment = Alignment.create(horizontal, from.pos.y, to.pos.y);
    this.length = Math.max(0.5, horizontal.length);
  }

  poseAt(d: number): { pos: Vector3; dir: Vector3 } {
    const sample = this.alignment.sampleAt(clamp(d, 0, this.alignment.length));
    return { pos: sample.pos.clone(), dir: sample.forward.clone() };
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
    const range = ranges.get(seg.id);
    if (!range || range.s1 - range.s0 < 1) continue;
    const alignment = network.alignmentOf(seg.id);
    for (const lane of lanesOf(cls, seg.id)) {
      const created = add({
        kind: 'segment',
        vehicleKind: cls.kind === 'rail' ? 'train' : 'car',
        path: new SegmentLanePath(alignment, lane.offset, range.s0, range.s1, lane.forward),
        speedLimit: speedOf(cls),
        segment: seg.id,
      });
      bySegment.set(`${seg.id}:${lane.index}`, created.id);
    }
  }

  const laneId = (lane: Lane): number | undefined =>
    bySegment.get(`${lane.segment}:${lane.index}`);

  /** 車線どうしを交差点の中で繋ぐ。 */
  const connect = (
    junction: Junction,
    entry: Lane,
    exit: Lane,
    phase: number | undefined,
    speed: number,
    tension?: number,
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
      path: new ConnectorPath(start, end, tension),
      speedLimit: speed,
      node: junction.node,
      phase,
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
    spawnable: lanes.filter((l) => l.kind === 'segment' && l.path.length > 15).map((l) => l.id),
  };
}

type Connect = (
  junction: Junction,
  entry: Lane,
  exit: Lane,
  phase: number | undefined,
  speed: number,
  tension?: number,
) => void;

/** 転回で膨らませる制御点の長さ [m]。 */
const UTURN_HANDLE = 7;

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
  const span = Math.max(1, Math.abs(entry.offset - exit.offset));
  connect(junction, entry, exit, undefined, 4, UTURN_HANDLE / span);
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
          connect(junction, entry.lane, target, phase, (limit / 3.6) * factor);
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
