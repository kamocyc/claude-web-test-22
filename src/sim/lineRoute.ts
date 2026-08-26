import type { RGB } from '../build/surface';
import type { LineId, TransitLine } from '../network/line';
import type { Station, StationId } from '../network/station';
import type { GraphLane, LaneGraph } from './lanegraph';

/**
 * 路線の経路を引く。
 *
 * 停車駅の並び (`TransitLine.stops`) を、車線グラフの上の**続けて走れる
 * 区間 (run)** に変える。
 *
 *   停車駅 → 区間ごとの最短経路 → 続けて走れるところは繋ぐ → run
 *
 * 線路に向きは無いので、終端駅では入ってきた線路をそのまま折り返せる。
 * 折り返しは経路の一部 (`GraphLane.reverse` を渡る) で、区間は切れない。
 * ただし止まって向きを変えるぶん時間がかかるので、通り抜けられる経路が
 * あればそちらを選ぶ (`REVERSE_PENALTY`)。
 *
 * 区間が切れるのは、停車駅の間の線路がそもそも繋がっていないときだけ。
 * そこは列車が飛ぶ (回送)。一巡してそのまま先頭へ続けられる路線は run が
 * 1 本になり、走り続ける (`seamless`)。
 */

/** 続けて走れるひと繋がりの区間。 */
export interface LineRun {
  /** 通る車線の並び。隣り合う車線は必ず繋がっている。 */
  lanes: number[];
  /** 先頭の駅。回送されてきた列車はこの駅のホームに現れる。 */
  startStation: StationId;
  /** 先頭の車線でのホームの位置 [m]。 */
  startStop: number;
  /** 最後に停まる駅。ここから先は繋がっていない。 */
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
  /** run が 1 本で、終わりから先頭へそのまま続けられる (環状・折り返し)。 */
  seamless: boolean;
  /**
   * 同じ線路を両方向に使う (行き違いができない)。
   *
   * 折り返して戻ってくる路線がこれにあたる。1 本しか走らせられない。
   */
  singleTrack: boolean;
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
    singleTrack: false,
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
  // 出会う。終点で折り返す路線では、最後の車線の折り返し先が最初の車線に
  // なる。どちらもそのまま続けられるので、繋いでひと続きにする。
  if (chains.length > 1) {
    const last = chains[chains.length - 1];
    const end = last[last.length - 1];
    if (end === chains[0][0]) {
      chains[0] = [...last, ...chains[0].slice(1)];
      chains.pop();
    } else if (reverseOf(graph, end) === chains[0][0]) {
      chains[0] = [...last, ...chains[0]];
      chains.pop();
    }
  }
  let seamless = false;
  if (chains.length === 1) {
    const only = chains[0];
    const end = only[only.length - 1];
    if (only.length > 1 && only[0] === end) {
      // 一周して同じ車線に戻る。先頭は次の周で通るので落とす。
      only.pop();
      seamless = true;
    } else if (only.length > 1 && reverseOf(graph, end) === only[0]) {
      // 終点で折り返すと先頭の車線に戻る。走り続けられる。
      seamless = true;
    }
  }

  plan.runs = chains.map((lanes) => toRun(graph, lanes));
  plan.seamless = seamless;
  plan.singleTrack = plan.runs.some((run) => usesBothDirections(graph, run.lanes));
  plan.length = plan.runs.reduce((sum, run) => sum + run.length, 0);
  plan.runnable = plan.runs.length > 0;
  return plan;
}

/** その車線の、同じ線路を逆向きに走る車線。 */
function reverseOf(graph: LaneGraph, id: number): number | undefined {
  return graph.lanes[id]?.reverse;
}

/**
 * 折り返せる車線か。
 *
 * 列車が止まる所でしか折り返せない。ホーム (旅客扱いのついでに向きを
 * 変える) と、行き止まり (車止めの手前) の 2 つ。
 */
function canReverse(lane: GraphLane): boolean {
  return lane.reverse !== undefined && (lane.stationStop !== undefined || lane.next.length === 0);
}

/** 同じ線路を両方向に使っているか (行き違いができない区間)。 */
function usesBothDirections(graph: LaneGraph, lanes: number[]): boolean {
  const used = new Set(lanes);
  return lanes.some((id) => {
    const back = reverseOf(graph, id);
    return back !== undefined && used.has(back);
  });
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
 * 折り返し 1 回を、遠回りに直したときの重み [m]。
 *
 * 折り返しには止まって向きを変える時間がかかるので、少しの遠回りなら
 * 通り抜ける経路の方が速い。渡り線や引き上げ線を敷いたときに、そちらを
 * 選ばせるための重み。この町の広さ (1 km 四方) に対して決めている。
 */
const REVERSE_PENALTY = 400;

/**
 * 車線グラフの最短経路 (ダイクストラ)。車線を頂点、車線の長さを重みにする。
 * 見つかった経路は始点の車線から終点の車線まで、続けて走れる並びになる。
 *
 * 折り返し (`GraphLane.reverse`) も 1 本の辺として通す。重みを足してあるので、
 * 折り返さずに行ける経路があればそちらが選ばれる。
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
    const steps: [number, number][] = lane.next.map((to) => [to, next]);
    if (canReverse(lane)) steps.push([lane.reverse!, next + REVERSE_PENALTY]);
    for (const [to, weight] of steps) {
      if (weight >= (dist.get(to) ?? Infinity)) continue;
      dist.set(to, weight);
      from.set(to, id);
      heap.push(to, weight);
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
