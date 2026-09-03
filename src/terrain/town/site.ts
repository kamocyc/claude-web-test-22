/**
 * 町の位置を決める。
 *
 * ctest105_city_terrain_generator の `chooseSettlements`
 * (`src/generator/civilization.ts`) の移植。要るのは適性の場と水のマスクと
 * 目標数とシードだけで、道路網・港・産業は要らない (あちらはそれらで
 * 集落を育てるが、ここでは点数から決める)。
 *
 * 肝は**間隔を数と土地の広さから決める**こと。固定の最小間隔にすると、
 * 少ない町がいちばん点数の良い盆地に固まり、残りの土地が空になる。
 */
import { TOWN_DENSITY, TOWN_MIN_SPACING } from '../../core/units';
import { clamp, hash2, type HydroGrid } from '../hydro/grid';

export type TownKind = 'city' | 'town' | 'village';

export interface Town {
  /** 中心のワールド座標 [m]。 */
  x: number;
  z: number;
  /** 水文格子の添字。 */
  cell: number;
  /** 適性の点数 (0..1)。 */
  score: number;
  kind: TownKind;
  /** 栄え具合 (0..1)。建物の高さに効く。 */
  development: number;
  name: string;
  /** 市街地の広がり [m]。 */
  radiusM: number;
  /** 街路の向き [rad]。 */
  angle: number;
}

/** 土地をこの割合まで使って間隔を決める。 */
const SPACING_FILL = 0.72;
/** 間隔の上限 [セル]。 */
const SPACING_MAX = 46;
/** 目標数に届かないときに間隔を縮める率。 */
const SPACING_RELAX = 0.82;
const SPACING_ATTEMPTS = 6;
/** 候補として認める適性の下限。 */
const MIN_SCORE = 0.4;

/** 上位から都市・町とする割合。残りは村。 */
const CITY_SHARE = 0.05;
const TOWN_SHARE = 0.25;

/** 市街地の広がり [m]。 */
const RADIUS: Record<TownKind, number> = { city: 500, town: 280, village: 140 };

const PREFIXES = ['青葉', '白波', '楓', '水鏡', '月見', '霞', '榛名', '朝凪', '石上', '遠野', '深緑', '千代'];
const SUFFIXES = ['市', '町', '郷', '浦', '川', '原', '丘', '宿'];

export interface TownInput {
  grid: HydroGrid;
  /** 集落の置きやすさ (0..1)。 */
  suitability: Float32Array;
  /** 1 = 水 (置けない)。 */
  water: Uint8Array;
  seed: number;
}

interface Candidate {
  cell: number;
  x: number;
  y: number;
  score: number;
}

export function chooseTowns(input: TownInput): Town[] {
  const { grid, suitability, water, seed } = input;
  const n = grid.n;
  const cell = grid.cell;
  const areaKm2 = ((n - 1) * cell) ** 2 / 1e6;
  const target = Math.max(1, Math.round(areaKm2 * TOWN_DENSITY));

  // 候補は「まわり 5x5 でいちばん適した所」。隣り合うセルが揃って候補に
  // なるのを防ぐので、このあとの間引きが素直に効く。
  const candidates: Candidate[] = [];
  for (let y = 3; y < n - 3; y++) {
    for (let x = 3; x < n - 3; x++) {
      const i = y * n + x;
      const score = suitability[i];
      if (water[i] || score < MIN_SCORE) continue;
      let peak = true;
      for (let oy = -2; oy <= 2 && peak; oy++) {
        for (let ox = -2; ox <= 2; ox++) {
          if ((ox || oy) && suitability[(y + oy) * n + (x + ox)] > score) {
            peak = false;
            break;
          }
        }
      }
      if (peak) candidates.push({ cell: i, x, y, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  let land = 0;
  for (let i = 0; i < grid.len; i++) if (!water[i]) land++;

  const floor = TOWN_MIN_SPACING / cell;
  const ideal = Math.max(floor, Math.min(SPACING_MAX, Math.sqrt(land / target) * SPACING_FILL));
  const select = (spacing: number): Candidate[] => {
    const chosen: Candidate[] = [];
    for (const candidate of candidates) {
      if (chosen.every((item) => Math.hypot(candidate.x - item.x, candidate.y - item.y) >= spacing)) {
        chosen.push(candidate);
      }
      if (chosen.length >= target) break;
    }
    return chosen;
  };

  let chosen = select(ideal);
  // 散らばりのために数を減らさない。目標に届くまで間隔を緩める。
  for (let attempt = 1; chosen.length < target && attempt <= SPACING_ATTEMPTS; attempt++) {
    const spacing = Math.max(floor, ideal * SPACING_RELAX ** attempt);
    const relaxed = select(spacing);
    if (relaxed.length > chosen.length) chosen = relaxed;
    if (spacing <= floor) break;
  }

  // 格は点数の絶対値ではなく順位で決める。移植元は 0.82 / 0.69 という
  // 敷居値を使っているが、あれはあちらの適性の分布に合わせたもので、
  // こちらの地形に当てると 8 割が都市になった。
  const cities = Math.max(1, Math.round(chosen.length * CITY_SHARE));
  const towns = cities + Math.round(chosen.length * TOWN_SHARE);
  return chosen.map((candidate, rank) => {
    const kind: TownKind = rank < cities ? 'city' : rank < towns ? 'town' : 'village';
    return {
      x: grid.worldAt(candidate.x),
      z: grid.worldAt(candidate.y),
      cell: candidate.cell,
      score: candidate.score,
      kind,
      // 移植元は道路網の次数・港・産業から育てるが、ここには無い。
      // 点数からそれらしい幅に散らす。
      development: clamp(candidate.score * 0.6 + 0.15),
      name: townName(candidate.x, candidate.y, seed),
      radiusM: RADIUS[kind],
      // 街路の向き。移植元は幹線道路の主軸から採るが、ここには道路が
      // 無いので、あちらの代替と同じく位置ハッシュで決める。
      angle: hash2(candidate.x, candidate.y, seed + 6607) * (Math.PI / 2),
    };
  });
}

/** 地名。位置ハッシュで接頭辞と接尾辞を引く (x と y を入れ替えて相関を切る)。 */
export function townName(x: number, y: number, seed: number): string {
  const prefix = PREFIXES[Math.floor(hash2(x, y, seed + 901) * PREFIXES.length)];
  const suffix = SUFFIXES[Math.floor(hash2(y, x, seed + 919) * SUFFIXES.length)];
  return `${prefix}${suffix}`;
}
