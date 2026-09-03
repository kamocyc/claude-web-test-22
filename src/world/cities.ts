import { clamp } from '../core/units';
import { mulberry32 } from '../terrain/generator';
import type { Heightfield } from '../terrain/heightfield';

/**
 * 都市の配置を決める。
 *
 * 都市は「地形が選ぶ」。人が住み着くのは、まとまった平地があって、
 * 低く、水の近い所。ここでは地形からその 3 つを点数にして、点の高い所から
 * 順に、互いに離して置いていく。点が高いほど大きな都市になるので、
 * **広い平野の真ん中に大都市ができ、山あいには町が点在する**。
 *
 * 道路網 (`roadNetwork.ts`) はここで決めた人口と位置だけを見るので、
 * 地形の良し悪しは道路の集まり方にもそのまま効く。
 */

/** 都市の規模。0 = 町、1 = 市、2 = 大都市。 */
export type CityTier = 0 | 1 | 2;

export interface City {
  id: number;
  name: string;
  tier: CityTier;
  /** 中心のワールド座標 [m]。 */
  x: number;
  z: number;
  /** 中心の自然地形高さ [m]。 */
  y: number;
  /** 人口の目安 [人]。道路網の重み付けに使う。 */
  population: number;
  /** 市街地の半径 [m]。街路はこの内側に収まる。 */
  radius: number;
  /** 街路の向き [rad]。都市ごとに変えて、碁盤の目が揃いすぎないようにする。 */
  heading: number;
}

export interface CityOptions {
  seed: number;
  /** 水面の高さ [m]。これより低い所は水域として扱う。 */
  waterLevel: number;
  /** 置く都市の数。省略するとマップの広さから決める。 */
  count?: number;
}

export const DEFAULT_CITY_OPTIONS: CityOptions = {
  seed: 20260903,
  waterLevel: 0,
};

/** 候補地を刻む間隔 [m]。都市の間隔よりずっと細かければよい。 */
const PROBE_STEP = 64;

/** 平地かどうかを見る半径 [m] (市街地が乗るくらい)。 */
const FLAT_RADIUS = 120;

/** 周りが開けているかを見る半径 [m] (山あいか平野か)。 */
const OPEN_RADIUS = 320;

/** 都市名の候補。規模に応じて「市」「町」を付ける。 */
const CITY_NAMES = [
  '青葉',
  '白河',
  '東山',
  '港北',
  '緑野',
  '桜川',
  '峰岡',
  '南浜',
  '八重原',
  '深沢',
  '鶴岡',
  '花咲',
  '高瀬',
  '若松',
  '小田原',
  '大槻',
  '海老名',
  '藤代',
  '樫野',
  '宮下',
];

interface Probe {
  x: number;
  z: number;
  y: number;
  score: number;
}

/**
 * 地形から都市の配置を決める。
 *
 * 同じ地形 (同じシード) なら必ず同じ結果になる。
 */
export function planCities(field: Heightfield, options: CityOptions = DEFAULT_CITY_OPTIONS): City[] {
  const rand = mulberry32(options.seed ^ 0x5bf03635);
  const span = field.worldMax - field.worldMin;
  // 端に寄った都市は、道路が地図の外へ回り込めず不自然になる。内側に寄せる。
  const margin = span * 0.12;
  const lo = field.worldMin + margin;
  const hi = field.worldMax - margin;

  const probes = collectProbes(field, options, lo, hi, rand);
  probes.sort((a, b) => b.score - a.score);

  const total = options.count ?? clamp(Math.round(span / 560), 4, 12);
  const bigCount = clamp(Math.round(total * 0.22), 1, 3);
  const midCount = clamp(Math.round(total * 0.34), 1, 4);

  // 規模の大きい都市ほど広い縄張りを取る。大都市どうしが隣り合わないので、
  // それぞれの周りに町が付き従う形になる。
  const chosen: Probe[] = [];
  const tiers: CityTier[] = [];
  // 上限は積み上げ (大都市を置いたあと、その続きに市・町を足していく)。
  const separation: [CityTier, number, number][] = [
    [2, span * 0.3, bigCount],
    [1, span * 0.17, bigCount + midCount],
    [0, span * 0.11, total],
  ];
  for (const [tier, gap, limit] of separation) {
    for (const probe of probes) {
      if (chosen.length >= limit) break;
      if (chosen.some((c) => Math.hypot(c.x - probe.x, c.z - probe.z) < gap)) continue;
      chosen.push(probe);
      tiers.push(tier);
    }
  }

  const names = pickNames(chosen.length, rand);
  return chosen.map((probe, i) => {
    const tier = tiers[i];
    const population = populationFor(tier, rand);
    // 市街地が縄張りからはみ出すと、隣の都市の街路と噛み合ってしまう。
    const radius = Math.min(radiusFor(tier, population), span * 0.055);
    return {
      id: i,
      name: `${names[i]}${tier === 0 ? '町' : '市'}`,
      tier,
      x: probe.x,
      z: probe.z,
      y: probe.y,
      population,
      radius,
      heading: rand() * Math.PI,
    };
  });
}

/** 格子状に刻んだ候補地に、住みやすさの点数を付ける。 */
function collectProbes(
  field: Heightfield,
  options: CityOptions,
  lo: number,
  hi: number,
  rand: () => number,
): Probe[] {
  const probes: Probe[] = [];
  for (let z = lo; z <= hi; z += PROBE_STEP) {
    for (let x = lo; x <= hi; x += PROBE_STEP) {
      const y = field.baseHeightAt(x, z);
      // 水面下と、波打ち際すれすれには置かない。
      if (y < options.waterLevel + 2) continue;

      const near = ringStats(field, x, z, FLAT_RADIUS);
      const wide = ringStats(field, x, z, OPEN_RADIUS);

      // 市街地が乗る範囲の起伏。ここが平らでないと町割りができない。
      let score = -near.relief * 1.0;
      // その外側が開けているか。谷底の狭い平地より、広い平野を選ぶ。
      score -= wide.relief * 0.3;
      // 同じ平らさなら低い所。人は水の得やすい低地に集まる。
      score -= (y - options.waterLevel) * 0.12;
      // 川や海が近ければ港・渡しができる。ただし自分は水没していない所。
      if (wide.min <= options.waterLevel + 2) score += 7;
      // 同点の並びをほぐす。地形の僅差で毎回同じ模様にならないように。
      score += (rand() - 0.5) * 5;

      probes.push({ x, z, y, score });
    }
  }
  return probes;
}

/** 半径 `radius` の円周と中心を拾って、起伏と最低標高を見る。 */
function ringStats(
  field: Heightfield,
  x: number,
  z: number,
  radius: number,
): { relief: number; min: number } {
  let min = field.baseHeightAt(x, z);
  let max = min;
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    for (const r of [radius * 0.55, radius]) {
      const h = field.baseHeightAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { relief: max - min, min };
}

function populationFor(tier: CityTier, rand: () => number): number {
  const base = tier === 2 ? 420_000 : tier === 1 ? 130_000 : 24_000;
  const spread = tier === 2 ? 380_000 : tier === 1 ? 150_000 : 46_000;
  return Math.round(base + rand() * spread);
}

function radiusFor(tier: CityTier, population: number): number {
  // 人口の平方根に比例させる (面積が人口に比例する)。
  const scale = Math.sqrt(population / 100_000);
  return clamp(Math.round(110 * scale), tier === 0 ? 130 : 170, 300);
}

/** 名前を重複なく選ぶ。 */
function pickNames(count: number, rand: () => number): string[] {
  const pool = CITY_NAMES.slice();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (pool.length === 0) {
      out.push(`第${i + 1}`);
      continue;
    }
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}
