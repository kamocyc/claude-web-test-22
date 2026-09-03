/**
 * 水面の問い合わせ。
 *
 * 海・湖・川のどれがそこにあるか、水面の高さはいくつかを返す。描画も、
 * 橋にするかの判定も、整地が触ってよいかも、区画を置けるかも、
 * すべてここを見るので、見えている水と敷設の判定が食い違わない。
 */
import { SEA_LEVEL_Y } from '../core/units';
import type { HydroGrid } from './hydro/grid';
import type { Heightfield } from './heightfield';
import { buildRiverField, type RiverField } from './river/field';
import type { RiverNetwork } from './river/network';

export type WaterKind = 'sea' | 'river';

export interface WaterInfo {
  kind: WaterKind;
  /** 水面の高さ [m]。 */
  level: number;
}

export class TerrainWater {
  readonly seaY = SEA_LEVEL_Y;
  readonly network: RiverNetwork;
  readonly field: RiverField;
  /** 水がありうる水文セル。`near` の下敷き。 */
  private readonly coarse: Uint8Array;

  constructor(
    private readonly terrain: Heightfield,
    readonly grid: HydroGrid,
    readonly sea: Uint8Array,
    /** 水文格子の地面の高さ [m]。水深の色分けに使う。 */
    readonly groundY: Float32Array,
    network: RiverNetwork,
  ) {
    this.network = network;
    this.field = buildRiverField(network);
    this.coarse = buildCoarseMask(grid, sea, network);
  }

  /**
   * 水があるかもしれない所か (水文格子の粗い判定)。
   *
   * `waterAt` は空間ハッシュを引くので、整地や区画のように格子点を舐める
   * 側から毎回呼ぶと効く。マップのほとんどは水から遠いので、まず配列 1 回で
   * 落とす。ここが false なら水は無い (取りこぼしはしない)。
   */
  near(x: number, z: number): boolean {
    const n = this.grid.n;
    const gx = Math.round(this.grid.cellAt(x));
    const gz = Math.round(this.grid.cellAt(z));
    if (gx < 0 || gz < 0 || gx >= n || gz >= n) return false;
    return this.coarse[gz * n + gx] === 1;
  }

  /** まわりの水文セルに海があるか。汀線は細かい格子の高さで決める。 */
  private seaNear(x: number, z: number): boolean {
    const n = this.grid.n;
    const gx = this.grid.cellAt(x);
    const gz = this.grid.cellAt(z);
    const x0 = Math.min(n - 1, Math.max(0, Math.floor(gx)));
    const z0 = Math.min(n - 1, Math.max(0, Math.floor(gz)));
    const x1 = Math.min(n - 1, x0 + 1);
    const z1 = Math.min(n - 1, z0 + 1);
    return (
      this.sea[z0 * n + x0] === 1 ||
      this.sea[z0 * n + x1] === 1 ||
      this.sea[z1 * n + x0] === 1 ||
      this.sea[z1 * n + x1] === 1
    );
  }

  /**
   * そこにある水面。陸なら null。
   *
   * 安い順に見る: 海 → 湖 → 川。海と湖は水文格子のマスクだが、汀線だけは
   * 自然地形の高さで決めるので、描いた水面と 1 セルずれない。
   */
  waterAt(x: number, z: number): WaterInfo | null {
    if (!this.near(x, z)) return null;
    const ground = this.terrain.baseHeightAt(x, z);
    if (ground < this.seaY && this.seaNear(x, z)) return { kind: 'sea', level: this.seaY };
    const sample = this.field.sample(x, z);
    if (sample && sample.distance <= sample.widthM * 0.5) {
      return { kind: 'river', level: sample.waterY };
    }
    return null;
  }

  isWater(x: number, z: number): boolean {
    return this.waterAt(x, z) !== null;
  }
}


/**
 * 水がありうるセルの印。海のセルと河道が通るセルを立て、取りこぼしが
 * 出ないよう 1 セル膨らませる。
 */
function buildCoarseMask(grid: HydroGrid, sea: Uint8Array, network: RiverNetwork): Uint8Array {
  const n = grid.n;
  const raw = new Uint8Array(n * n);
  for (let i = 0; i < raw.length; i++) if (sea[i]) raw[i] = 1;
  for (const stem of network.stems) {
    for (const point of stem.points) {
      const gx = Math.round(grid.cellAt(point.x));
      const gz = Math.round(grid.cellAt(point.z));
      if (gx < 0 || gz < 0 || gx >= n || gz >= n) continue;
      raw[gz * n + gx] = 1;
    }
  }
  const mask = new Uint8Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      if (!raw[z * n + x]) continue;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
          mask[nz * n + nx] = 1;
        }
      }
    }
  }
  return mask;
}
