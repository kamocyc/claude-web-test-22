import { Vector3 } from 'three';
import { TERRAIN_CELL, TERRAIN_CELLS, clamp } from '../core/units';

/**
 * 地形の高さ場。
 *
 * `base` は自然地形 (編集されない元の地形)、`work` は道路等による切土・盛土を
 * 反映した実際に描画される地形。整地は必ず `base` から `work` を作り直すので、
 * 道路を消せば地形も元に戻る。
 */
export class Heightfield {
  /** 1 辺のセル数。頂点数は `cells + 1`。 */
  readonly cells: number;
  readonly cell: number;
  /** 添字 0 に対応するワールド座標 (X, Z 共通)。 */
  readonly origin: number;
  readonly stride: number;
  readonly base: Float32Array;
  readonly work: Float32Array;

  constructor(cells = TERRAIN_CELLS, cell = TERRAIN_CELL) {
    this.cells = cells;
    this.cell = cell;
    // 原点はマップ中心。格子の大きさから決めるので、既定以外の解像度でも合う。
    this.origin = -(cells * cell) / 2;
    this.stride = cells + 1;
    const n = this.stride * this.stride;
    this.base = new Float32Array(n);
    this.work = new Float32Array(n);
  }

  index(ix: number, iz: number): number {
    return ix + iz * this.stride;
  }

  /** ワールド座標を格子座標 (実数) に変換する。 */
  toGridX(x: number): number {
    return (x - this.origin) / this.cell;
  }

  toGridZ(z: number): number {
    return (z - this.origin) / this.cell;
  }

  /** 格子添字をワールド座標に変換する。 */
  worldX(ix: number): number {
    return this.origin + ix * this.cell;
  }

  worldZ(iz: number): number {
    return this.origin + iz * this.cell;
  }

  private sampleBilinear(field: Float32Array, x: number, z: number): number {
    const gx = clamp(this.toGridX(x), 0, this.cells);
    const gz = clamp(this.toGridZ(z), 0, this.cells);
    const ix = Math.min(Math.floor(gx), this.cells - 1);
    const iz = Math.min(Math.floor(gz), this.cells - 1);
    const fx = gx - ix;
    const fz = gz - iz;
    const s = this.stride;
    const i = ix + iz * s;
    const h00 = field[i];
    const h10 = field[i + 1];
    const h01 = field[i + s];
    const h11 = field[i + s + 1];
    return (
      h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz
    );
  }

  /** 整地後の地形高さ。 */
  heightAt(x: number, z: number): number {
    return this.sampleBilinear(this.work, x, z);
  }

  /** 自然地形の高さ。橋・トンネルの判定はこちらを使う。 */
  baseHeightAt(x: number, z: number): number {
    return this.sampleBilinear(this.base, x, z);
  }

  /** 整地後の地形の法線。 */
  normalAt(x: number, z: number, out = new Vector3()): Vector3 {
    const d = this.cell;
    const hl = this.heightAt(x - d, z);
    const hr = this.heightAt(x + d, z);
    const hd = this.heightAt(x, z - d);
    const hu = this.heightAt(x, z + d);
    return out.set(hl - hr, 2 * d, hd - hu).normalize();
  }

  /** 傾斜角 [rad]。 */
  slopeAt(x: number, z: number): number {
    const n = this.normalAt(x, z, _n);
    return Math.acos(clamp(n.y, -1, 1));
  }

  /**
   * `work` を `base` の内容で初期化する。
   *
   * 自然地形を書き換えたときは必ずここを通す (`generateTerrain` も呼ぶ)。
   * 高さの範囲の控えもここで捨てるので、書き換えたのに呼ばないと
   * 整地が古い範囲を見ることになる。
   */
  resetWork(): void {
    this.work.set(this.base);
    this.cachedBaseRange = null;
    this.baseVersion++;
  }

  /**
   * 自然地形を作り直した回数。
   *
   * 地形メッシュは整地で触った範囲だけを書き換えるので、自然地形そのものが
   * 変わったこと (地形の再生成) は範囲では伝わらない。この番号が変われば
   * 全チャンクを作り直す。
   */
  baseVersion = 0;

  private cachedBaseRange: { min: number; max: number } | null = null;

  /**
   * 自然地形の高さの範囲。
   *
   * 整地が「法面をどこまで伝播させれば足りるか」を見積もるのに使う。
   * 格子全体の走査は 1 回で済むよう控えておく。
   */
  get baseRange(): { min: number; max: number } {
    if (!this.cachedBaseRange) {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < this.base.length; i++) {
        const v = this.base[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      this.cachedBaseRange = { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
    }
    return this.cachedBaseRange;
  }

  get worldMin(): number {
    return this.origin;
  }

  get worldMax(): number {
    return this.origin + this.cells * this.cell;
  }

  /** 座標がマップ内かどうか。 */
  contains(x: number, z: number): boolean {
    return x >= this.worldMin && x <= this.worldMax && z >= this.worldMin && z <= this.worldMax;
  }
}

const _n = new Vector3();
