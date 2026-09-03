import { Vector3 } from 'three';
import { clamp } from '../core/units';
import { draw, smoothProfile, type Waypoint } from './sketch';
import { getClass, type NetworkClass } from '../network/classes';
import { anchorFromNode, anchorFromSegment, type Anchor } from '../network/editing';
import type { Network, SegmentId } from '../network/network';
import type { ZoneMap, ZoneType } from '../network/zoning';
import type { Heightfield } from '../terrain/heightfield';
import { DEFAULT_CITY_OPTIONS, planCities, type City } from '../world/cities';
import { planRoadLinks, type RoadLink } from '../world/roadNetwork';
import { RouteField, findRoute, smoothRoute, type XZ } from '../world/routing';

/**
 * 都市と、都市を結ぶ道路を自動で作る。
 *
 * 手順は現実の道路網ができる順と同じにしてある。
 *
 * 1. 地形から**都市の場所と規模**を決める (`world/cities.ts`)。
 * 2. 都市ごとに**街路**を敷き、沿道に用途を塗る。
 * 3. **どこを結ぶか**を人口と距離から決める (`world/roadNetwork.ts`)。
 * 4. 交通量の多い順に、**地形の通りやすい所を選んで**敷く
 *    (`world/routing.ts`)。既に道がある所は安く通れるので、あとから引く
 *    道は既設路に寄り、峠道や渡河点で束ねられる。
 *
 * 既設路と長く重なる区間は敷かず、その手前で**既設路に取り付ける**。
 * 同じ所に 2 本並べても仕方がないので、実際の道路網と同じように分岐に
 * なる。大都市には規格の太い道が何本も集まる。
 */

/** 水面とみなす高さ [m]。地形の生成が外周をこの下まで落としている。 */
const WATER_LEVEL = 0;

/** 既設路に取り付くときに探す半径 [m]。 */
const ATTACH_RADIUS = 90;

/**
 * 取り付き先を既存のノードにまとめる距離 [m]。
 *
 * 何本もの道が数十 m 違いで別々に取り付くと、交差点が重なって形が保てない
 * (交差点は取り付きの長さを食うので、区間がその倍は要る)。近くに辻が
 * あればそこへ集める。実際の村の辻と同じで、道は 1 つの辻に集まる。
 */
const ATTACH_SNAP = 60;

/** 都市の出入口の節を探す半径 [m]。交差点にまとめられて動いた分を見込む。 */
const GATE_SEARCH = 15;

/** 取り付いた点のすぐ先にある経由点を捨てる距離 [m]。短い区間を作らない。 */
const ATTACH_CLEARANCE = 60;

/** 既設路と「共用している」とみなす連続長 [m]。これ以上重なるなら敷かない。 */
const SHARE_MIN = 170;

/** 1 本として敷くのに要る最短の長さ [m]。これ未満の切れ端は捨てる。 */
const MIN_RUN = 130;

/** 都市間道路の経由点の間隔 [m]。 */
const WAYPOINT_SPACING = 130;

/** 区画を塗る筆の半径 [m] (道路の両側 2 列ぶんが入る)。 */
const ZONE_BRUSH = 26;

export interface AutoWorldOptions {
  seed?: number;
  /** 都市の数。省略するとマップの広さから決める。 */
  cityCount?: number;
  /** 沿道に用途を塗る先。渡すと都市に建物が建つ。 */
  zones?: ZoneMap | null;
}

export interface AutoWorldResult {
  cities: City[];
  links: RoadLink[];
  /** 実際に敷いた都市間道路の本数 (1 本の道が分かれると増える)。 */
  placed: number;
  /** 既設路と重なるので敷かなかった区間の本数。 */
  shared: number;
}

/**
 * 都市と都市間道路を丸ごと作り直す。既存の内容は消える。
 */
export function buildAutoWorld(
  network: Network,
  field: Heightfield,
  options: AutoWorldOptions = {},
): AutoWorldResult {
  network.clear();
  options.zones?.clear();

  const cities = planCities(field, {
    seed: options.seed ?? DEFAULT_CITY_OPTIONS.seed,
    waterLevel: WATER_LEVEL,
    count: options.cityCount,
  });
  const route = new RouteField(field, { waterLevel: WATER_LEVEL });

  // 市街地の縁の半径と、街路の節 (都市の出入口)。
  const edge: number[] = [];
  const gates: Vector3[][] = [];
  for (const city of cities) {
    const streets = layCityStreets(network, field, route, city, options.zones ?? null);
    edge[city.id] = streets.edge;
    gates[city.id] = streets.gates;
  }

  const links = planRoadLinks(cities);
  const plan: LayContext = { network, field, route, cities, edge, gates };
  let placed = 0;
  let shared = 0;
  for (const link of links) {
    const result = layLink(plan, link, true);
    placed += result.placed;
    shared += result.shared;
  }
  placed += connectStragglers(plan, links);
  return { cities, links, placed, shared };
}

/** 都市間道路を敷くのに要るもの一式。 */
interface LayContext {
  network: Network;
  field: Heightfield;
  route: RouteField;
  cities: City[];
  /** 都市ごとの市街地の縁の半径 [m]。 */
  edge: number[];
  /** 都市ごとの街路の節 (都市間道路を繋ぐ出入口)。 */
  gates: Vector3[][];
}

/**
 * 敷き終わったあと、繋がらずに残った都市を最寄りの都市へ結ぶ。
 *
 * 都市間道路は「既設路と重なる区間は敷かない」ので、経路がまるごと既設路に
 * 重なると 1 本も敷かれない。ふつうはそれで繋がっている (重なった先が既設路
 * なのだから) が、取り付き先が見つからないなどで繋がらないことがある。
 * 「都市が道路で結ばれている」ことは、この機能の約束なので必ず直す。
 *
 * 直すときは共用を諦めて、経路をまるごと 1 本として敷く。
 */
function connectStragglers(plan: LayContext, links: RoadLink[]): number {
  const tried = new Set<number>();
  let placed = 0;
  // 1 本敷ければ必ず繋がる (両端の繋ぎ先が決まらない区間は敷かれない) ので、
  // 組を変えながら都市の数の倍まで試す。
  for (let guard = 0; guard < plan.cities.length * 2; guard++) {
    const groups = cityGroups(plan);
    const main = mainGroup(groups);
    const stray = plan.cities.filter((c) => groups.get(c.id) !== main);
    if (stray.length === 0) break;

    // 繋がっていない都市と、繋がっている都市の、いちばん近い組を選ぶ。
    let best: { from: City; to: City; distance: number } | null = null;
    for (const from of stray) {
      for (const to of plan.cities) {
        if (groups.get(to.id) !== main) continue;
        const key = Math.min(from.id, to.id) * 4096 + Math.max(from.id, to.id);
        if (tried.has(key)) continue;
        const d = Math.hypot(from.x - to.x, from.z - to.z);
        if (!best || d < best.distance) best = { from, to, distance: d };
      }
    }
    if (!best) break;
    tried.add(Math.min(best.from.id, best.to.id) * 4096 + Math.max(best.from.id, best.to.id));

    const existing = links.find(
      (l) =>
        (l.from === best.from.id && l.to === best.to.id) ||
        (l.from === best.to.id && l.to === best.from.id),
    );
    const link: RoadLink = existing ?? {
      from: best.from.id,
      to: best.to.id,
      classId: 'road_small',
      flow: 0,
      distance: best.distance,
    };
    if (!existing) links.push(link);
    placed += layLink(plan, link, false).placed;
  }
  return placed;
}

/** 都市ごとの、繋がっている系統の番号。市街地の街路から引く。 */
function cityGroups(plan: LayContext): Map<number, number> {
  const parent = new Map<SegmentId, SegmentId>();
  const find = (a: SegmentId): SegmentId => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root) as SegmentId;
    return root;
  };
  for (const segment of plan.network.segments.values()) parent.set(segment.id, segment.id);
  for (const node of plan.network.nodes.values()) {
    for (let i = 1; i < node.segments.length; i++) {
      const a = find(node.segments[0]);
      const b = find(node.segments[i]);
      if (a !== b) parent.set(a, b);
    }
  }

  const groups = new Map<number, number>();
  for (const city of plan.cities) {
    // 都市の系統は**その街路**で見る。近くを通っているだけの道を拾うと、
    // 繋がっていないのに繋がっていることになる。
    let group = -1 - city.id;
    for (const gate of plan.gates[city.id] ?? []) {
      const node = plan.network.findNodeNear(gate, 3);
      if (node && node.segments.length > 0) {
        group = find(node.segments[0]);
        break;
      }
    }
    groups.set(city.id, group);
  }
  return groups;
}

/** いちばん多くの都市が乗っている系統。 */
function mainGroup(groups: Map<number, number>): number {
  const counts = new Map<number, number>();
  for (const group of groups.values()) counts.set(group, (counts.get(group) ?? 0) + 1);
  let best = -1;
  let bestCount = -1;
  for (const [group, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = group;
    }
  }
  return best;
}

// ------------------------------------------------------------------ 街路

/** 街路の縦断で許す勾配。市街地は平らな所を選んでいるので、緩く抑える。 */
const STREET_GRADE = 0.06;

/** 街路を持ち上げる量 [m]。都市間道路と同じにして、繋いだ所に段差を作らない。 */
const ROAD_LIFT = 0.8;

/**
 * 都市の街路を敷く。規模に応じた碁盤の目で、真ん中の通りだけ規格を上げる。
 *
 * 交差点は**先に節を決めてから**両方向の街路で共有する。線形どうしの交差を
 * あとから拾う手 (`resolveAutoJunctions`) だと、2 本の縦断が交点で 40 cm
 * 以上ずれただけで交差点にならず、碁盤の目が繋がらない。節を共有すれば
 * 高さは必ず一致する。
 *
 * 返り値は市街地の縁の半径と、街路の節の位置 (都市の出入口)。都市間道路は
 * 縁の外側だけを敷き、**必ずこの節のどれかに繋ぐ**。
 */
function layCityStreets(
  network: Network,
  field: Heightfield,
  route: RouteField,
  city: City,
  zones: ZoneMap | null,
): { edge: number; gates: Vector3[] } {
  // 町は十字路 1 つ、市は 2 本ずつ、大都市は 3 本ずつ。
  const lines = city.tier + 1;
  const spacing = Math.min(160, city.radius * 0.8);
  const half = ((lines - 1) * spacing) / 2 + Math.min(150, city.radius * 0.85);
  const mainClass =
    city.tier === 2 ? 'road_large' : city.tier === 1 ? 'road_medium' : 'road_small';
  const centre = Math.floor((lines - 1) / 2);

  const cos = Math.cos(city.heading);
  const sin = Math.sin(city.heading);
  // 局所座標 (u, v) をワールドへ。都市ごとに向きを変えて碁盤が揃いすぎないように。
  const world = (u: number, v: number): XZ => ({
    x: city.x + cos * u - sin * v,
    z: city.z + sin * u + cos * v,
  });

  const offsets: number[] = [];
  for (let i = 0; i < lines; i++) offsets.push((i - (lines - 1) / 2) * spacing);
  // 節の位置。両端と、直交する通りと交わる所。
  const stations = [-half, ...offsets, half];
  const heights = streetHeights(field, world, stations, offsets);

  const gates: Vector3[] = [];
  // u 方向の通り (v = offsets[j]) と、v 方向の通り (u = offsets[i])。
  for (const alongU of [true, false]) {
    for (let i = 0; i < lines; i++) {
      const offset = offsets[i];
      const classId = i === centre ? mainClass : 'road_small';
      const points: Waypoint[] = stations.map((t, k) => {
        const p = alongU ? world(t, offset) : world(offset, t);
        const a = alongU ? k : i + 1;
        const b = alongU ? i + 1 : k;
        return { x: p.x, z: p.z, y: heights[a][b] + ROAD_LIFT };
      });
      route.markCorridor(points, 1);
      layStreet(network, field, classId, points);
      for (const point of points) {
        const y = point.y ?? field.baseHeightAt(point.x, point.z);
        if (!gates.some((g) => Math.hypot(g.x - point.x, g.z - point.z) < 1)) {
          gates.push(new Vector3(point.x, y, point.z));
        }
      }
      if (zones) paintZones(zones, city, points, half);
    }
  }
  return { edge: half + 40, gates };
}

/**
 * 節ごとの高さを決める。
 *
 * 自然地形の高さをそのまま使い、隣の節との勾配だけ抑える。市街地は平らな
 * 所を選んでいるので、これで切土・盛土はほとんど出ない。**同じ節は
 * どちらの通りから見ても同じ高さ**になるので、交差点で段差ができない。
 */
function streetHeights(
  field: Heightfield,
  world: (u: number, v: number) => XZ,
  stations: readonly number[],
  offsets: readonly number[],
): number[][] {
  const m = stations.length;
  const heights: number[][] = [];
  for (let a = 0; a < m; a++) {
    heights.push([]);
    for (let b = 0; b < m; b++) {
      const p = world(stations[a], stations[b]);
      heights[a].push(field.baseHeightAt(p.x, p.z));
    }
  }

  // 通りに沿って、前後から勾配を抑える。節を共有しているので、両方向を
  // 何度か往復すれば全体で辻褄が合う。
  const inner = offsets.map((_, i) => i + 1);
  const clampLine = (get: (k: number) => number, set: (k: number, y: number) => void): void => {
    for (let k = 1; k < m; k++) {
      const limit = STREET_GRADE * Math.abs(stations[k] - stations[k - 1]);
      set(k, clamp(get(k), get(k - 1) - limit, get(k - 1) + limit));
    }
    for (let k = m - 2; k >= 0; k--) {
      const limit = STREET_GRADE * Math.abs(stations[k + 1] - stations[k]);
      set(k, clamp(get(k), get(k + 1) - limit, get(k + 1) + limit));
    }
  };
  for (let pass = 0; pass < 3; pass++) {
    for (const b of inner) {
      clampLine(
        (k) => heights[k][b],
        (k, y) => {
          heights[k][b] = y;
        },
      );
    }
    for (const a of inner) {
      clampLine(
        (k) => heights[a][k],
        (k, y) => {
          heights[a][k] = y;
        },
      );
    }
  }
  return heights;
}

/**
 * 1 本の通りを、節ごとに区切って敷く。
 *
 * 節に既にノードがあればそこへ繋ぐ (交差点になる)。無ければ作る。区間は
 * どれも直線で同じ向きなので、繋ぎ目で折れない。
 */
function layStreet(
  network: Network,
  field: Heightfield,
  classId: string,
  points: readonly Waypoint[],
): void {
  const cls = getClass(classId);
  for (let i = 1; i < points.length; i++) {
    const a = nodeAnchor(network, field, points[i - 1], cls);
    const b = nodeAnchor(network, field, points[i], cls);
    draw(network, field, classId, [points[i - 1], points[i]], {
      straight: true,
      start: a ?? undefined,
      end: b ?? undefined,
    });
  }
}

/** その節に既にあるノードへの接続。無ければ null (新しい端点になる)。 */
function nodeAnchor(
  network: Network,
  field: Heightfield,
  point: Waypoint,
  cls: NetworkClass,
): Anchor | null {
  const y = point.y ?? field.baseHeightAt(point.x, point.z);
  const node = network.findNodeNear(new Vector3(point.x, y, point.z), 2);
  if (!node) return null;
  const anchor = anchorFromNode(network, node, cls);
  // 直交する通りの勾配を引き継ぐと、交差点から先の縦断がそちらへ引っ張られる。
  // 位置だけ借りて、勾配はこの通りの節の高さから解かせる。
  return { pos: anchor.pos.clone(), node: anchor.node };
}

/**
 * 街路沿いに用途を塗る。中心は商業、周りは住宅、外れは工業。
 *
 * 塗るのは地面なので、道路を引き直しても残る (`ZoneMap`)。実際に建物が
 * 建つのは道路に接したマスだけなので、はみ出した塗りは効かない。
 */
function paintZones(zones: ZoneMap, city: City, points: readonly XZ[], half: number): void {
  const spacing = 16;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.round(length / spacing));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      zones.paint(x, z, ZONE_BRUSH, zoneFor(city, Math.hypot(x - city.x, z - city.z) / half));
    }
  }
}

function zoneFor(city: City, ratio: number): ZoneType {
  if (city.tier === 0) return ratio < 0.3 ? 'commercial' : 'residential';
  if (ratio < 0.4) return 'commercial';
  if (ratio < 0.85) return 'residential';
  return 'industrial';
}

// -------------------------------------------------------------- 都市間道路

/**
 * 1 本の都市間道路を敷く。
 *
 * `reuse` を立てると、既設路と長く重なる区間は敷かずに取り付ける
 * (道が束ねられる)。落とすと、経路をまるごと 1 本として敷く。
 */
function layLink(
  plan: LayContext,
  link: RoadLink,
  reuse: boolean,
): { placed: number; shared: number } {
  const { route, cities, edge } = plan;
  const from = cities[link.from];
  const to = cities[link.to];
  const cls = getClass(link.classId);
  // 規格いっぱいの勾配で通せる所を「通りやすい」と見ると、山を直登する道に
  // なる。規格の 7 割で追える所を選ばせる。
  const raw = findRoute(route, from, to, { maxGrade: cls.maxGrade * 0.7 });
  if (!raw) return { placed: 0, shared: 0 };

  const path = smoothRoute(raw, {
    passes: 3,
    tolerance: 10,
    minSpacing: WAYPOINT_SPACING,
    maxSpacing: WAYPOINT_SPACING * 1.6,
  });

  // 市街地の中は既にある街路を通る。両端を縁で切る。
  let head = 0;
  while (head + 1 < path.length && distance(path[head + 1], from) <= edge[from.id]) head++;
  let tail = path.length - 1;
  while (tail - 1 > head && distance(path[tail - 1], to) <= edge[to.id]) tail--;
  if (tail - head < 1) {
    // 市街地が近すぎて外を通る所が残らない。街路どうしを直に繋ぐ。
    head = 0;
    tail = path.length - 1;
    if (tail < 1) return { placed: 0, shared: 1 };
  }
  const trimmed = path.slice(head, tail + 1);

  // 既設路と重なっている区間を抜き、残った所だけを敷く。
  let placed = 0;
  let shared = 0;
  const runs = reuse
    ? splitRuns(route, trimmed)
    : [{ start: 0, end: trimmed.length - 1, shared: false }];
  const last = trimmed.length - 1;
  for (const range of runs) {
    if (range.shared) {
      shared++;
      continue;
    }
    // 両端が市街地に接するなら、街路の節へ直に繋ぐ。近くの線形を探して
    // 取り付ける手は、探し当てられなかったときに端点が浮いてしまう。
    const ends = {
      start: range.start === 0 ? gateAnchor(plan, from, trimmed[0]) : null,
      end: range.end === last ? gateAnchor(plan, to, trimmed[last]) : null,
    };
    if (layRun(plan, trimmed, range, link.classId, ends)) placed++;
  }
  return { placed, shared };
}

interface Run {
  start: number;
  end: number;
  shared: boolean;
}

/**
 * 折れ線を「既設路と重なっている所」と「新しく敷く所」に分ける。
 *
 * 重なりが短ければ、ただ交差しただけなので分けない。分けた切れ端が短すぎる
 * ときも、その手前の重なりに含めてしまう (数十 m の道を継ぎ足しても、
 * 交差点ばかりになって形にならない)。
 */
function splitRuns(route: RouteField, points: readonly XZ[]): Run[] {
  const last = points.length - 1;
  const flags = points.map((p, i) =>
    i === 0 || i === last ? false : route.corridorAt(p.x, p.z) >= 0.5,
  );

  const runs: Run[] = [];
  let start = 0;
  for (let i = 1; i <= last; i++) {
    if (flags[i] === flags[start]) continue;
    runs.push({ start, end: i, shared: flags[start] });
    start = i;
  }
  runs.push({ start, end: last, shared: flags[start] });

  // 短い重なりは「交差しただけ」。短い切れ端は「継ぎ足す意味が無い」。
  for (const run of runs) {
    const length = runLength(points, run);
    if (run.shared && length < SHARE_MIN) run.shared = false;
    else if (!run.shared && length < MIN_RUN && runs.length > 1) run.shared = true;
  }
  return merge(runs);
}

/** 同じ扱いになった隣どうしを繋げる。 */
function merge(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    const previous = out[out.length - 1];
    if (previous && previous.shared === run.shared) previous.end = run.end;
    else out.push({ ...run });
  }
  return out;
}

function runLength(points: readonly XZ[], run: Run): number {
  let length = 0;
  for (let i = run.start + 1; i <= run.end; i++) length += distance(points[i - 1], points[i]);
  return length;
}

/**
 * 折れ線の一区間を実際に敷く。
 *
 * 両端は、そこに既設路があれば取り付ける (途中なら分岐、端点なら接続)。
 * 市街地から出る所も、既設路から分かれる所も同じ扱いになる。
 */
function layRun(
  plan: LayContext,
  points: readonly XZ[],
  run: Run,
  classId: string,
  ends: { start: Anchor | null; end: Anchor | null } = { start: null, end: null },
): boolean {
  const { network, field, route } = plan;
  // 取り付き先は「1 つ外側の点」で探す。そこは既設路の上なので必ず当たる。
  const startAnchor =
    ends.start ?? attachAt(network, field, points[Math.max(run.start - 1, 0)], classId);
  const endAnchor =
    ends.end ??
    attachAt(network, field, points[Math.min(run.end + 1, points.length - 1)], classId);
  // 両端とも繋ぎ先が決まらないと、どこにも繋がらない道が 1 本できるだけ。
  // そういう区間は敷かない (繋がらなかった都市はあとで結び直す)。
  if (!startAnchor || !endAnchor) return false;

  const middle = points.slice(run.start, run.end + 1);
  const waypoints: XZ[] = [];
  if (startAnchor) waypoints.push({ x: startAnchor.pos.x, z: startAnchor.pos.z });
  for (const point of middle) {
    const previous = waypoints[waypoints.length - 1];
    // 取り付いた点のすぐ先に経由点があると、極端に短い区間ができる。
    if (previous && distance(previous, point) < ATTACH_CLEARANCE) continue;
    waypoints.push(point);
  }
  if (endAnchor) {
    const end = { x: endAnchor.pos.x, z: endAnchor.pos.z };
    while (waypoints.length > 1 && distance(waypoints[waypoints.length - 1], end) < ATTACH_CLEARANCE)
      waypoints.pop();
    waypoints.push(end);
  }
  if (waypoints.length < 2) return false;

  const fixed = endAnchor
    ? [{ index: waypoints.length - 1, y: endAnchor.pos.y }]
    : undefined;
  const profiled = smoothProfile(field, waypoints, classId, {
    passes: 2,
    lift: 0.8,
    startY: startAnchor?.pos.y,
    fixed,
  });
  draw(network, field, classId, profiled, {
    straight: false,
    matchCrossings: true,
    start: startAnchor ?? undefined,
    end: endAnchor ?? undefined,
  });
  route.markCorridor(waypoints, 1);
  return true;
}

/**
 * 都市の出入口 (街路の節) への接続。
 *
 * 都市に入る道は、近くの線形を探すのではなく**街路の節そのもの**へ繋ぐ。
 * 探して取り付ける手だと、見つからなかったときに端点が浮いて、その都市が
 * 道路網から切れてしまう。節は分割・統合で番号が変わりうるので、位置から
 * 引き直す。
 */
function gateAnchor(plan: LayContext, city: City, toward: XZ): Anchor | null {
  let best: Vector3 | null = null;
  let bestDistance = Infinity;
  for (const gate of plan.gates[city.id] ?? []) {
    const d = Math.hypot(gate.x - toward.x, gate.z - toward.z);
    if (d < bestDistance) {
      bestDistance = d;
      best = gate;
    }
  }
  if (!best) return null;
  // 交差点にまとめられた節は、平均で少し動いている (`Network.mergeNodes`)。
  // 街路の間隔は 100 m 以上あるので、この程度広く探しても取り違えない。
  const node = plan.network.findNodeNear(best, GATE_SEARCH);
  if (node) {
    // 位置だけ借りる。接線を引き継ぐと、通りの延長としてしか出ていけない。
    return { pos: node.pos.clone(), node: node.id };
  }
  return attachAt(plan.network, plan.field, best, 'road_small');
}

/**
 * その地点にある道路への取り付き。
 *
 * 道路の途中なら分岐 (敷くときに分割してノードにする)、無ければ null。
 * 高さで絞って、橋の下を通る道に取り付いてしまうのを防ぐ。
 */
function attachAt(
  network: Network,
  field: Heightfield,
  at: XZ,
  classId: string,
): Anchor | null {
  const y = field.baseHeightAt(at.x, at.z);
  const hit = network.findSegmentNear(new Vector3(at.x, y, at.z), ATTACH_RADIUS, {
    y,
    tolerance: 12,
  });
  if (!hit) return null;
  if (network.classOf(network.getSegment(hit.segment)).kind !== 'road') return null;

  // 近くに辻があればそこへ集める。無ければ、区間の途中で分ける。
  const node = network.findNodeNear(hit.pos, ATTACH_SNAP, { y: hit.pos.y, tolerance: 8 });
  if (node) return anchorFromNode(network, node, getClass(classId));
  // 端に寄りすぎた分割は、極端に短い区間を残す。そのときも端の辻へ寄せる。
  const length = network.alignmentOf(hit.segment).length;
  if (hit.s < ATTACH_SNAP || hit.s > length - ATTACH_SNAP) {
    const segment = network.getSegment(hit.segment);
    const end = network.getNode(hit.s < length / 2 ? segment.a : segment.b);
    return anchorFromNode(network, end, getClass(classId));
  }
  return anchorFromSegment(network, hit.segment, hit.s);
}

function distance(a: XZ, b: XZ): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
