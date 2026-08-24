import type { RGB } from '../build/surface';
import type { LineId, TransitLine } from '../network/line';
import type { Station, StationId } from '../network/station';
import type { GraphLane, LaneGraph } from './lanegraph';

/**
 * 路線の経路を引く。
 *
 * 停車駅の並び (`TransitLine.stops`) を、車線グラフの上の**続けて走れる
 * 区間 (run)** に変える。線路には向きがあるので、終端駅では同じ駅の反対側の
 * ホームへ移らないと戻れない。そこが run の切れ目で、列車はそこで折り返す。
 *
 *   停車駅 → 区間ごとの最短経路 → 続けて走れるところは繋ぐ → run
 *
 * 環状線のように最後から最初へそのまま続けられる路線は run が 1 本になり、
 * 折り返さずに走り続ける (`seamless`)。
 */

/** 続けて走れるひと繋がりの区間。 */
export interface LineRun {
  /** 通る車線の並び。隣り合う車線は必ず繋がっている。 */
  lanes: number[];
  /** 先頭の駅。折り返してきた列車はこの駅のホームに現れる。 */
  startStation: StationId;
  /** 先頭の車線でのホームの位置 [m]。 */
  startStop: number;
  /** 最後に停まる駅。ここで折り返す。 */
  endStation: StationId;
  /** 区間の長さ [m]。 */
  length: number;
}

/** 路線 1 本の運転計画。 */
export interface LinePlan {
  id: LineId;
  name: string;
  color: RGB;
  /** 停まる駅 (選んだ順)。表示に使う。 */
  stops: { id: StationId; name: string }[];
  /** 実際に走る駅の並び (往復なら折り返しを含む)。 */
  itinerary: StationId[];
  runs: LineRun[];
  /** run が 1 本で、終わりから先頭へそのまま続けられる (環状・折り返し無し)。 */
  seamless: boolean;
  /** 経路長 [m]。往復なら往復の合計。 */
  length: number;
  /** 線路が繋がっておらず、列車が飛ぶ区間。 */
  gaps: { from: string; to: string }[];
  /** 列車を走らせられるか。 */
  runnable: boolean;
}

/** 路線ごとの経路を引き直す。 */
export function planLines(
  graph: LaneGraph,
  lines: Iterable<TransitLine>,
  stations: ReadonlyMap<StationId, Station>,
): LinePlan[] {
  const byStation = new Map<StationId, number[]>();
  for (const lane of graph.lanes) {
    const stop = lane.stationStop;
    if (!stop) continue;
    const list = byStation.get(stop.station);
    if (list) list.push(lane.id);
    else byStation.set(stop.station, [lane.id]);
  }

  const plans: LinePlan[] = [];
  for (const line of lines) {
    plans.push(planLine(graph, byStation, line, stations));
  }
  return plans;
}

function planLine(
  graph: LaneGraph,
  byStation: Map<StationId, number[]>,
  line: TransitLine,
  stations: ReadonlyMap<StationId, Station>,
): LinePlan {
  const nameOf = (id: StationId): string => stations.get(id)?.name ?? `駅 #${id}`;
  const stops = line.stops
    .filter((id) => stations.has(id))
    .filter((id, i, all) => id !== all[i - 1]);
  const plan: LinePlan = {
    id: line.id,
    name: line.name,
    color: line.color,
    stops: stops.map((id) => ({ id, name: nameOf(id) })),
    itinerary: [],
    runs: [],
    seamless: false,
    length: 0,
    gaps: [],
    runnable: false,
  };
  if (stops.length < 2) return plan;

  plan.itinerary = itineraryOf(stops);
  const order = plan.itinerary;

  // 区間ごとに最短経路を引く。前の区間の終わりからそのまま走り続けられる
  // なら、そちらを優先する (終端で折り返さずに済むなら折り返さない)。
  let previousEnd: number | null = null;
  const legs: (number[] | null)[] = [];
  for (let i = 0; i < order.length; i++) {
    const to = order[(i + 1) % order.length];
    const goals = new Set(byStation.get(to) ?? []);
    let lanes: number[] | null =
      previousEnd === null ? null : findPath(graph, [previousEnd], goals);
    if (!lanes) lanes = findPath(graph, byStation.get(order[i]) ?? [], goals);
    legs.push(lanes);
    if (lanes) previousEnd = lanes[lanes.length - 1];
    else {
      previousEnd = null;
      plan.gaps.push({ from: nameOf(order[i]), to: nameOf(to) });
    }
  }

  // 続けて走れる区間どうしを繋ぎ、繋がらない所で run を切る。
  const chains: number[][] = [];
  let current: number[] = [];
  for (const lanes of legs) {
    if (!lanes) {
      if (current.length > 0) chains.push(current);
      current = [];
      continue;
    }
    if (current.length > 0 && current[current.length - 1] === lanes[0]) {
      current.push(...lanes.slice(1));
    } else {
      if (current.length > 0) chains.push(current);
      current = [...lanes];
    }
  }
  if (current.length > 0) chains.push(current);

  // 一周して戻ってくる路線では、最後の run と最初の run が同じ車線で
  // 出会う。そこも繋いでひと続きにする。
  if (chains.length > 1) {
    const last = chains[chains.length - 1];
    if (last[last.length - 1] === chains[0][0]) {
      chains[0] = [...last, ...chains[0].slice(1)];
      chains.pop();
    }
  }
  let seamless = false;
  if (chains.length === 1) {
    const only = chains[0];
    if (only.length > 1 && only[0] === only[only.length - 1]) {
      only.pop();
      seamless = true;
    }
  }

  plan.runs = chains.map((lanes) => toRun(graph, lanes));
  plan.seamless = seamless;
  plan.length = plan.runs.reduce((sum, run) => sum + run.length, 0);
  plan.runnable = plan.runs.length > 0;
  return plan;
}

/**
 * 実際に走る駅の並び。
 *
 * 最後にもう一度最初の駅を選んだら環状運転、そうでなければ終点で折り返す
 * 往復運転にする。並びは循環で、末尾の次は先頭に戻る。
 */
function itineraryOf(stops: StationId[]): StationId[] {
  if (stops.length > 2 && stops[0] === stops[stops.length - 1]) return stops.slice(0, -1);
  return [...stops, ...[...stops].reverse().slice(1, -1)];
}

function toRun(graph: LaneGraph, lanes: number[]): LineRun {
  const first = graph.lanes[lanes[0]];
  const last = graph.lanes[lanes[lanes.length - 1]];
  return {
    lanes,
    startStation: first.stationStop?.station ?? -1,
    startStop: first.stationStop?.s ?? 0,
    endStation: last.stationStop?.station ?? -1,
    length: lanes.reduce((sum, id) => sum + (graph.lanes[id]?.path.length ?? 0), 0),
  };
}

/**
 * 車線グラフの最短経路 (ダイクストラ)。車線を頂点、車線の長さを重みにする。
 * 見つかった経路は始点の車線から終点の車線まで、続けて走れる並びになる。
 */
function findPath(graph: LaneGraph, starts: number[], goals: Set<number>): number[] | null {
  if (starts.length === 0 || goals.size === 0) return null;
  const dist = new Map<number, number>();
  const from = new Map<number, number>();
  const heap = new MinHeap();
  for (const id of starts) {
    if (dist.has(id)) continue;
    dist.set(id, 0);
    heap.push(id, 0);
  }

  while (heap.size > 0) {
    const { id, cost } = heap.pop();
    if (cost > (dist.get(id) ?? Infinity)) continue;
    if (goals.has(id)) return trace(from, id);
    const lane: GraphLane | undefined = graph.lanes[id];
    if (!lane) continue;
    const next = cost + lane.path.length;
    for (const to of lane.next) {
      if (next >= (dist.get(to) ?? Infinity)) continue;
      dist.set(to, next);
      from.set(to, id);
      heap.push(to, next);
    }
  }
  return null;
}

function trace(from: Map<number, number>, end: number): number[] {
  const out = [end];
  let at = end;
  // 車線の数を超えて遡ることはないが、万一の輪を作らないよう上限を置く。
  for (let guard = 0; guard < 100000; guard++) {
    const previous = from.get(at);
    if (previous === undefined) break;
    out.push(previous);
    at = previous;
  }
  return out.reverse();
}

/** 経路探索用の二分ヒープ。 */
class MinHeap {
  private readonly ids: number[] = [];
  private readonly costs: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, cost: number): void {
    this.ids.push(id);
    this.costs.push(cost);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent] <= this.costs[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): { id: number; cost: number } {
    const id = this.ids[0];
    const cost = this.costs[0];
    const lastId = this.ids.pop()!;
    const lastCost = this.costs.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.costs[0] = lastCost;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let small = i;
        if (left < this.ids.length && this.costs[left] < this.costs[small]) small = left;
        if (right < this.ids.length && this.costs[right] < this.costs[small]) small = right;
        if (small === i) break;
        this.swap(small, i);
        i = small;
      }
    }
    return { id, cost };
  }

  private swap(a: number, b: number): void {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.costs[a], this.costs[b]] = [this.costs[b], this.costs[a]];
  }
}
