import type { City } from './cities';

/**
 * どの都市とどの都市を、どの規格の道路で結ぶかを決める。
 *
 * 2 段構えにする。
 *
 * 1. **相対近傍グラフ (RNG)** で骨格を作る。「間に他の都市が割り込んでいない
 *    ペア」だけを結ぶので、隣どうしが素直に繋がり、長い辺が交差しない。
 *    最小全域木を含むので、これだけで全都市が繋がる。
 * 2. **重力モデル** (人口の積 ÷ 距離²) の大きい順に、幹線を足していく。
 *    足せる本数は都市の規模で決まるので、大都市ほど多くの方向へ道が出る。
 *
 * 規格も人口と交通量から決める。大都市どうしを結ぶ道は大通り、町へ入る道は
 * 生活道路。結果として**大都市には太い道が何本も集まる**。
 */

export interface RoadLink {
  from: number;
  to: number;
  classId: string;
  /** 重力モデルの交通量 (相対値)。敷く順の決め手にもなる。 */
  flow: number;
  /** 都市間の直線距離 [m]。 */
  distance: number;
}

export interface RoadPlanOptions {
  /** 骨格に足す幹線の本数の割合 (都市数に対する比)。 */
  extraRatio?: number;
}

/** 都市 1 つから出せる道路の本数。規模が大きいほど多い。 */
function maxDegree(city: City): number {
  return 3 + city.tier;
}

export function planRoadLinks(cities: City[], options: RoadPlanOptions = {}): RoadLink[] {
  if (cities.length < 2) return [];
  const extraRatio = options.extraRatio ?? 0.5;

  const distance = (a: City, b: City): number => Math.hypot(a.x - b.x, a.z - b.z);
  const pairs: { from: number; to: number; distance: number; flow: number }[] = [];
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      const d = distance(cities[i], cities[j]);
      // 重力モデル。距離の 2 乗で効かせるので、遠い都市どうしは繋がりにくい。
      const km = Math.max(d / 1000, 0.2);
      const flow = (cities[i].population * cities[j].population) / (km * km);
      pairs.push({ from: i, to: j, distance: d, flow });
    }
  }

  const key = (a: number, b: number): number => Math.min(a, b) * 4096 + Math.max(a, b);
  const taken = new Set<number>();
  const degree = new Array(cities.length).fill(0);
  const links: RoadLink[] = [];
  const add = (pair: { from: number; to: number; distance: number; flow: number }): void => {
    taken.add(key(pair.from, pair.to));
    degree[pair.from]++;
    degree[pair.to]++;
    links.push({ ...pair, classId: 'road_small' });
  };

  // 1. 骨格 (相対近傍グラフ)。
  for (const pair of pairs) {
    if (isRelativeNeighbour(cities, pair.from, pair.to, pair.distance, distance)) add(pair);
  }

  // 2. 交通量の大きい順に幹線を足す。本数は都市の規模で頭打ちになる。
  const longest = pairs.reduce((max, p) => Math.max(max, p.distance), 0);
  const extras = Math.round(cities.length * extraRatio);
  let added = 0;
  for (const pair of [...pairs].sort((a, b) => b.flow - a.flow)) {
    if (added >= extras) break;
    if (taken.has(key(pair.from, pair.to))) continue;
    // 地図を端から端まで貫く 1 本は、途中の都市を素通りするので入れない。
    if (pair.distance > longest * 0.6) continue;
    if (degree[pair.from] >= maxDegree(cities[pair.from])) continue;
    if (degree[pair.to] >= maxDegree(cities[pair.to])) continue;
    add(pair);
    added++;
  }

  assignClasses(cities, links);
  // 太い道から先に敷く。あとから敷く細い道が、既にある幹線に寄ってくる。
  links.sort((a, b) => b.flow - a.flow);
  return links;
}

/**
 * 相対近傍グラフの辺かどうか。
 *
 * 2 都市のどちらから見てもその距離より近い第三の都市が無ければ、間に
 * 割り込むものが無いということで、直接結ぶ。
 */
function isRelativeNeighbour(
  cities: City[],
  from: number,
  to: number,
  d: number,
  distance: (a: City, b: City) => number,
): boolean {
  for (let k = 0; k < cities.length; k++) {
    if (k === from || k === to) continue;
    if (distance(cities[from], cities[k]) < d && distance(cities[to], cities[k]) < d) return false;
  }
  return true;
}

/**
 * 規格を割り当てる。
 *
 * 基本は「細い側の都市」に合わせる (町へ入る道は生活道路)。そのうえで
 * 交通量が多い順の上位は 1 段太くして、大都市どうしを結ぶ道を通す。
 */
function assignClasses(cities: City[], links: RoadLink[]): void {
  const ladder = ['road_small', 'road_medium', 'road_large'];
  const byFlow = [...links].sort((a, b) => b.flow - a.flow);
  const promote = new Set(byFlow.slice(0, Math.ceil(links.length * 0.3)).map((l) => l));
  for (const link of links) {
    const tier = Math.min(cities[link.from].tier, cities[link.to].tier);
    const level = Math.min(tier + (promote.has(link) ? 1 : 0), ladder.length - 1);
    link.classId = ladder[level];
  }
}
