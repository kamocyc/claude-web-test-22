import type { Heightfield } from './heightfield';
import { clamp, fbm, hash2, type HydroGrid } from './hydro/grid';
import type { HydroWorld } from './hydro/types';
import type { Town } from './town/site';

/**
 * 森の濃さと、木の散らばり。
 *
 * 濃さは水文モデルの結果 (流量・川からの距離・河川地形・集落の適性) から
 * 40 m 格子で決める。**どこに何が生えるかは位置ハッシュだけで決まる**ので、
 * メッシュを何度組み直しても木は動かない (`buildBuilding` と同じ考え方)。
 *
 * 描画に依らない純粋な計算にしてある。ここが決めた木を
 * `src/render/vegetationView.ts` がカメラのまわりだけメッシュにする。
 */

/** 木の格子の間隔 [m]。濃さ 1 のときこの間隔で 1 本立つ。 */
export const TREE_SPACING = 12;

/** 格子点をずらす量 [m]。方眼紙に見えないように。 */
export const TREE_JITTER = 5;

/** これより急な斜面には生えない [rad] (32°)。岩肌になる。 */
export const TREE_MAX_SLOPE = (32 * Math.PI) / 180;

/** 森林限界 [m]。ここから `TREE_LINE_FADE` かけて 0 になる。 */
export const TREE_LINE = 340;
const TREE_LINE_FADE = 60;

/** 波打ち際には生えない。この高さから下は空ける [m]。 */
export const TREE_MIN_Y = 2.2;

/** 濃さの斑の波長 [m]。滑らかな勾配のままだと森の輪郭が出ない。 */
const PATCH_SPAN = 700;
/**
 * 斑を 0..1 に写す下限と幅 (`fbm` は -1..1)。
 *
 * 実測した分布 (下位 1 割 -0.37 / 中央 -0.07 / 上位 1 割 0.16) に合わせてある。
 * 下限を上げると空き地が増え、幅を狭めると森と空き地の境がはっきりする。
 */
const PATCH_FLOOR = 0.4;
const PATCH_RANGE = 0.6;

/**
 * 濃さの下駄。
 *
 * 0 から積み上げると、水も川も遠い高台がすべて裸地になる。日本の里山の
 * ように「基本は森、開けている所が例外」にしたいので下駄を履かせる。
 */
const BASE_DENSITY = 0.42;

/** 川に近いほど濃くする範囲 (格子セル数)。 */
const RIVER_REACH = 6;
/** 海際で塩害として引く範囲 (格子セル数)。 */
const COAST_REACH = 3;

/** 河川地形ごとの加減。自然堤防は木が育ち、後背湿地は水はけが悪い。 */
const LANDFORM_BONUS = [0, 0.12, 0.22, 0.04, 0.1];

/** 樹種。0 = 針葉樹 / 1 = 広葉樹 / 2 = 低木。 */
export type Species = 0 | 1 | 2;

export interface Tree {
  x: number;
  z: number;
  /** 根元の地面の高さ [m]。 */
  y: number;
  /** 樹高 [m]。 */
  height: number;
  /** 樹冠の半径 [m]。 */
  radius: number;
  species: Species;
  /** 向き [rad]。同じ形が並んで見えないように振る。 */
  angle: number;
}

/** 木を数える 1 区画。 */
export interface VegetationTile {
  minX: number;
  minZ: number;
  size: number;
}

export class VegetationField {
  private grid: HydroGrid | null = null;
  private density: Float32Array | null = null;
  private seed = 0;

  /** 地形を作り直したら呼ぶ。 */
  build(hydro: HydroWorld, seed: number): void {
    const grid = hydro.grid;
    const density = new Float32Array(grid.len);
    // 流量は上流のセル数なので、対数で潰してから使う。
    let maxAcc = 1;
    for (let i = 0; i < grid.len; i++) maxAcc = Math.max(maxAcc, hydro.accumulation[i]);
    const accScale = 1 / Math.log(1 + maxAcc);

    for (let iz = 0; iz < grid.n; iz++) {
      for (let ix = 0; ix < grid.n; ix++) {
        const i = iz * grid.n + ix;
        // 海面と川面には生えない。
        if (hydro.sea[i] || hydro.rivers[i]) continue;

        let d = BASE_DENSITY;
        // 水分。流域の下流ほど濃い。
        d += 0.3 * accScale * Math.log(1 + hydro.accumulation[i]);
        // 川沿いは水が近い。
        d += 0.24 * clamp(1 - hydro.riverDistance[i] / RIVER_REACH);
        d += LANDFORM_BONUS[hydro.landform[i]] ?? 0;
        // 海際は塩害で育たない。
        d -= 0.3 * clamp(1 - hydro.coastDistance[i] / COAST_REACH);
        // 集落を置きやすい所は、人が使っている土地 (農地・集落) と見て空ける。
        // これで森が山腹と川沿いに寄り、町のまわりが開ける。
        d -= 0.45 * hydro.suitability[i];

        // 斑にする。掛けることで、濃い所の中にも空き地ができる。
        // `fbm` は -1..1 なので、下側を切って 0..1 に写す。
        const x = grid.worldAt(ix);
        const z = grid.worldAt(iz);
        const patch = fbm(x / PATCH_SPAN, z / PATCH_SPAN, seed + 4177, 3);
        density[i] = clamp(d) * clamp((patch + PATCH_FLOOR) / PATCH_RANGE);
      }
    }

    this.grid = grid;
    this.density = density;
    this.seed = seed;
  }

  get ready(): boolean {
    return this.density !== null;
  }

  /** その地点の森の濃さ 0..1 (双一次補間)。 */
  densityAt(x: number, z: number): number {
    const grid = this.grid;
    const density = this.density;
    if (!grid || !density) return 0;
    const gx = clamp(grid.cellAt(x), 0, grid.n - 1);
    const gz = clamp(grid.cellAt(z), 0, grid.n - 1);
    const ix = Math.min(grid.n - 2, Math.floor(gx));
    const iz = Math.min(grid.n - 2, Math.floor(gz));
    const tx = gx - ix;
    const tz = gz - iz;
    const a = density[iz * grid.n + ix];
    const b = density[iz * grid.n + ix + 1];
    const c = density[(iz + 1) * grid.n + ix];
    const d = density[(iz + 1) * grid.n + ix + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  /**
   * その区画に生える木。
   *
   * `keep` は 0..1 で、遠くの区画を間引くのに使う (1 で全部)。位置ハッシュで
   * 間引くので、同じ `keep` なら同じ木が残る。
   */
  treesIn(
    tile: VegetationTile,
    field: Heightfield,
    towns: readonly Town[],
    keep = 1,
  ): Tree[] {
    if (!this.density || keep <= 0) return [];
    const seed = this.seed;
    const out: Tree[] = [];
    // 格子は**マップ全体で 1 つ**。区画の境で二重に置いたり抜けたりしない。
    const i0 = Math.ceil(tile.minX / TREE_SPACING);
    const i1 = Math.ceil((tile.minX + tile.size) / TREE_SPACING) - 1;
    const k0 = Math.ceil(tile.minZ / TREE_SPACING);
    const k1 = Math.ceil((tile.minZ + tile.size) / TREE_SPACING) - 1;

    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        if (keep < 1 && hash2(i, k, seed + 9311) >= keep) continue;
        const x = i * TREE_SPACING + (hash2(i, k, seed + 101) - 0.5) * 2 * TREE_JITTER;
        const z = k * TREE_SPACING + (hash2(i, k, seed + 211) - 0.5) * 2 * TREE_JITTER;
        if (!field.contains(x, z)) continue;

        let density = this.densityAt(x, z);
        if (density <= 0) continue;
        // 町の中は街並みのもの。外へ出るまで薄めて、中には入れない。
        density *= townOpening(x, z, towns);
        if (density <= 0) continue;
        if (hash2(i, k, seed + 7) >= density) continue;

        if (field.water?.isWater(x, z)) continue;
        if (field.slopeAt(x, z) > TREE_MAX_SLOPE) continue;
        const y = field.heightAt(x, z);
        if (y < TREE_MIN_Y) continue;
        // 森林限界。上がるほど間引く。
        if (y > TREE_LINE) {
          const above = clamp((y - TREE_LINE) / TREE_LINE_FADE);
          if (hash2(i, k, seed + 331) < above) continue;
        }

        out.push(makeTree(x, z, y, i, k, seed));
      }
    }
    return out;
  }
}

/**
 * 町の中を空ける割合。
 *
 * 町の中心から `radiusM` までは 0 (街並みがある)、そこから 1.6 倍まで薄める。
 * 町の平面 (`TownPlans.at`) は組むのに時間がかかるので、位置と広がりだけで見る。
 */
function townOpening(x: number, z: number, towns: readonly Town[]): number {
  let factor = 1;
  for (const town of towns) {
    const d = Math.hypot(town.x - x, town.z - z);
    const inner = town.radiusM;
    if (d >= inner * 1.6) continue;
    if (d <= inner) return 0;
    factor = Math.min(factor, (d - inner) / (inner * 0.6));
  }
  return factor;
}

/** 1 本の木の姿。すべて位置ハッシュから決まる。 */
function makeTree(x: number, z: number, y: number, i: number, k: number, seed: number): Tree {
  const pick = hash2(i, k, seed + 577);
  const size = hash2(i, k, seed + 733);
  // 高い所と痩せた所は針葉樹、低地は広葉樹。1 割ほどは低木。
  const conifer = clamp((y - 120) / 180) * 0.75 + 0.1;
  const species: Species = pick < 0.1 ? 2 : pick < 0.1 + conifer * 0.9 ? 0 : 1;
  const height =
    species === 2 ? 2.4 + size * 1.8 : species === 0 ? 12 + size * 10 : 9 + size * 7;
  const radius =
    species === 2 ? 1.3 + size * 0.9 : species === 0 ? 2.2 + size * 1.4 : 3.0 + size * 3.0;
  return {
    x,
    z,
    y,
    height,
    radius,
    species,
    angle: hash2(i, k, seed + 881) * Math.PI * 2,
  };
}
