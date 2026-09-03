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

export type WaterKind = 'sea' | 'lake' | 'river';

export interface WaterInfo {
  kind: WaterKind;
  /** 水面の高さ [m]。 */
  level: number;
}

export class TerrainWater {
  readonly seaY = SEA_LEVEL_Y;
  readonly network: RiverNetwork;
  readonly field: RiverField;

  constructor(
    private readonly terrain: Heightfield,
    readonly grid: HydroGrid,
    readonly sea: Uint8Array,
    readonly lake: Uint8Array,
    /** 湖ごとの水面の高さ [m] (湖でないセルは意味を持たない)。 */
    readonly lakeY: Float32Array,
    /** 水文格子の地面の高さ [m]。水深の色分けに使う。 */
    readonly groundY: Float32Array,
    network: RiverNetwork,
  ) {
    this.network = network;
    this.field = buildRiverField(network);
  }

  /** その位置を覆う水文セルの添字 (いちばん近い格子点)。 */
  private nodeAt(x: number, z: number): number {
    const n = this.grid.n;
    const gx = Math.min(n - 1, Math.max(0, Math.round(this.grid.cellAt(x))));
    const gz = Math.min(n - 1, Math.max(0, Math.round(this.grid.cellAt(z))));
    return gz * n + gx;
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
    const ground = this.terrain.baseHeightAt(x, z);
    if (ground < this.seaY && this.seaNear(x, z)) return { kind: 'sea', level: this.seaY };
    const i = this.nodeAt(x, z);
    if (this.lake[i] && ground < this.lakeY[i]) return { kind: 'lake', level: this.lakeY[i] };
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
