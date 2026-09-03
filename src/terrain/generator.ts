import {
  HYDRO_CELL,
  NOISE_SPAN,
  SEA_FLOOR_Y,
  SEA_LEVEL_Y,
  TERRAIN_RELIEF,
  clamp,
} from '../core/units';
import type { Heightfield } from './heightfield';
import { generateHydroWorld } from './hydro/world';
import type { HydroWorld } from './hydro/types';
import { buildRiverNetwork } from './river/network';
import { carveRivers, upsampleTerrain } from './upsample';
import { TerrainWater } from './water';

/**
 * 地形生成。
 *
 * 実体は `hydro/` の水文エンジン (ctest105_city_terrain_generator の master・
 * 有限マップからの移植) で、大陸ノイズ → 山地の急峻化 → 海面の決定 →
 * 埋め立てと排水木 → 流量集積 → 盆地の開削 → 蛇行河道 → 侵食と氾濫原 →
 * 湖、の順に解く。ここはそれを TrackBuilder の高さ場に載せる係で、
 *
 *   1. 高さ場の広さから水文格子 (40 m) を決めて回す
 *   2. 無次元の高さをメートルに直す (海面が Y 0)
 *   3. 40 m から高さ場の格子へ Catmull-Rom で細分する
 *   4. 河道の曲線から断面を刻む
 *
 * の 4 段を踏む。川・湖・海は `TerrainWater` として返し、描画と敷設の
 * 両方が同じものを見る。
 */

export interface TerrainOptions {
  seed: number;
  /** 海になる面積の割合。 */
  sea: number;
  /** 険しさ。 */
  rugged: number;
  /** 平地の割合。 */
  flat: number;
  /** 盆地の量。 */
  basin: number;
  /** 河川の密度。0 で川を作らない。 */
  river: number;
  /** 蛇行の強さ。 */
  meander: number;
  /** 侵食の強さ。 */
  erosion: number;
  /** 無次元の高さをメートルに直す倍率。 */
  relief: number;
}

export const DEFAULT_TERRAIN: TerrainOptions = {
  seed: 20260812,
  sea: 0.24,
  rugged: 0.65,
  flat: 0.36,
  basin: 0.45,
  river: 0.55,
  meander: 0.68,
  erosion: 0.55,
  relief: TERRAIN_RELIEF,
};

/** 生成した地形と、その水系。 */
export interface TerrainWorld {
  hydro: HydroWorld;
  water: TerrainWater;
}

/** 湖の最大水深 [m]。これ以上は掘らない。 */
const LAKE_MAX_DEPTH = 32;
/** 湖の最小水深 [m]。 */
const LAKE_MIN_DEPTH = 2;
/** 汀線のすぐ内側の陸地の高さ [m]。海面と地面が同じ高さになるのを避ける。 */
const SHORE_Y = 1.8;
/** 海の水深の下限 [m]。汀線のすぐ外はここまで下がる。 */
const SHALLOW_Y = -3;

export function generateTerrain(field: Heightfield, options: TerrainOptions = DEFAULT_TERRAIN): TerrainWorld {
  // 広さは高さ場から採る。テスト用の小さな格子でも同じ手順で作れる。
  const extent = field.cells * field.cell;
  const hydroCells = Math.max(24, Math.round(extent / HYDRO_CELL));
  const hydroCell = extent / hydroCells;

  const hydro = generateHydroWorld(
    hydroCells,
    {
      seed: options.seed,
      sea: options.sea,
      rugged: options.rugged,
      flat: options.flat,
      basin: options.basin,
      river: options.river,
      meander: options.meander,
      erosion: options.erosion,
      span: extent / NOISE_SPAN,
    },
    hydroCell,
    field.origin,
  );

  const { groundY, lakeY } = toMetres(hydro, options.relief);

  upsampleTerrain(field, { grid: hydro.grid, groundY, sea: hydro.sea, lake: hydro.lake });

  const network = buildRiverNetwork(hydro, options.relief, SEA_LEVEL_Y);
  const water = new TerrainWater(field, hydro.grid, hydro.sea, hydro.lake, lakeY, groundY, network);
  carveRivers(field, network, water.field);

  field.resetWork();
  return { hydro, water };
}

/**
 * 無次元の高さをメートルに直す。海面が Y 0 になる。
 *
 * 海底・湖底・陸で扱いが違う。海と湖は「水面」と「その下の地面」が別なので、
 * 地面の方を水面より確実に下げておかないと、水面板の下から地面が突き出る。
 */
function toMetres(hydro: HydroWorld, relief: number): { groundY: Float32Array; lakeY: Float32Array } {
  const len = hydro.grid.len;
  const groundY = new Float32Array(len);
  const lakeY = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const raw = (hydro.terrain[i] - hydro.seaLevel) * relief;
    // `filled` は窪地を埋めた面なので、湖のセルではそれが水面になる。
    const surface = Math.max(SHORE_Y, (hydro.filled[i] - hydro.seaLevel) * relief);
    lakeY[i] = surface;
    if (hydro.sea[i]) {
      groundY[i] = clamp(raw, SEA_FLOOR_Y, SHALLOW_Y);
    } else if (hydro.lake[i]) {
      groundY[i] = clamp(raw, surface - LAKE_MAX_DEPTH, surface - LAKE_MIN_DEPTH);
    } else {
      groundY[i] = Math.max(SHORE_Y, raw);
    }
  }
  return { groundY, lakeY };
}
