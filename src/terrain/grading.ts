import type { Vector3 } from 'three';
import { earcutXZ } from '../core/meshbuilder';
import { CUT_SLOPE, FILL_SLOPE } from '../core/units';
import type { Heightfield } from './heightfield';

const INF = Infinity;

/**
 * 切土・盛土による整地。
 *
 * 手順は 2 段階:
 *  1. 路面などの「地面に接する面」を高さ場に焼き込む (シード)。
 *  2. シードから外側へ、許容法面勾配で高さの上限・下限を伝播させ、
 *     自然地形をその範囲にクランプする。
 *
 * この方式だと、シードから遠い所では上限 = +∞ / 下限 = -∞ になるため
 * 自然地形がそのまま残り、道路の近くだけが法面として繋がる。結果として
 *  - 路端で地形と路面が必ず一致する (道路が浮かない / 埋まらない)
 *  - 途中が途切れない (空洞ができない)
 * ことが保証される。
 *
 * 橋・トンネル区間は `block()` で伝播を遮断する。これにより橋台やトンネル
 * 坑口で地形が垂直に切り立ち、その前後だけが法面として整地される。
 */
export class TerrainGrading {
  private readonly field: Heightfield;
  private readonly target: Float32Array;
  private readonly seeded: Uint8Array;
  private readonly blocked: Uint8Array;

  constructor(field: Heightfield) {
    this.field = field;
    const n = field.stride * field.stride;
    this.target = new Float32Array(n);
    this.seeded = new Uint8Array(n);
    this.blocked = new Uint8Array(n);
  }

  reset(): void {
    this.seeded.fill(0);
    this.blocked.fill(0);
  }

  /** 三角形の範囲の格子点に目標高さを焼き込む。重なった場合は低い方を採用する。 */
  stampTriangle(a: Vector3, b: Vector3, c: Vector3): void {
    this.rasterize(a, b, c, (i, y) => {
      if (this.seeded[i]) this.target[i] = Math.min(this.target[i], y);
      else {
        this.target[i] = y;
        this.seeded[i] = 1;
      }
      this.blocked[i] = 0;
    });
  }

  /**
   * 多角形 (リング) を焼き込む。
   *
   * 扇状の分割だと凹んだリングでは外側まで焼いてしまうので、描画と同じ
   * earcut で三角形分割する。交差点面の形と整地の形が必ず一致する。
   */
  stampPolygon(ring: Vector3[]): void {
    if (ring.length < 3) return;
    const flat: number[] = [];
    for (const p of ring) flat.push(p.x, p.z);
    const tris = earcutXZ(flat);
    for (let i = 0; i + 2 < tris.length; i += 3) {
      this.stampTriangle(ring[tris[i]], ring[tris[i + 1]], ring[tris[i + 2]]);
    }
  }

  /** 4 点を 2 三角形として焼き込む。 */
  stampQuad(a: Vector3, b: Vector3, c: Vector3, d: Vector3): void {
    this.stampTriangle(a, b, c);
    this.stampTriangle(a, c, d);
  }

  /** 整地の伝播を遮断する領域 (橋・トンネルの下) を指定する。 */
  block(a: Vector3, b: Vector3, c: Vector3): void {
    this.rasterize(a, b, c, (i) => {
      if (!this.seeded[i]) this.blocked[i] = 1;
    });
  }

  blockQuad(a: Vector3, b: Vector3, c: Vector3, d: Vector3): void {
    this.block(a, b, c);
    this.block(a, c, d);
  }

  private rasterize(
    a: Vector3,
    b: Vector3,
    c: Vector3,
    write: (index: number, y: number) => void,
  ): void {
    const f = this.field;
    const ax = f.toGridX(a.x);
    const az = f.toGridZ(a.z);
    const bx = f.toGridX(b.x);
    const bz = f.toGridZ(b.z);
    const cx = f.toGridX(c.x);
    const cz = f.toGridZ(c.z);

    const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(area) < 1e-9) return;

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1);
    const maxX = Math.min(f.cells, Math.ceil(Math.max(ax, bx, cx)) + 1);
    const minZ = Math.max(0, Math.floor(Math.min(az, bz, cz)) - 1);
    const maxZ = Math.min(f.cells, Math.ceil(Math.max(az, bz, cz)) + 1);

    // 格子点が三角形の辺上に乗る場合を取りこぼさないよう、わずかに外側まで含める。
    const eps = 0.06;

    for (let iz = minZ; iz <= maxZ; iz++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const px = ix;
        const pz = iz;
        const w0 = ((bx - px) * (cz - pz) - (cx - px) * (bz - pz)) / area;
        const w1 = ((cx - px) * (az - pz) - (ax - px) * (cz - pz)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -eps || w1 < -eps || w2 < -eps) continue;
        write(f.index(ix, iz), w0 * a.y + w1 * b.y + w2 * c.y);
      }
    }
  }

  /**
   * 焼き込んだ結果を `field.work` に反映する。
   * `base` は変更しないので、ネットワークを消せば地形は元に戻る。
   */
  apply(): void {
    const f = this.field;
    const n = f.stride * f.stride;
    const stride = f.stride;
    const cells = f.cells;
    const upper = new Float32Array(n).fill(INF);
    const lower = new Float32Array(n).fill(-INF);
    const seeded = this.seeded;
    const blocked = this.blocked;
    const target = this.target;

    for (let i = 0; i < n; i++) {
      if (seeded[i]) {
        upper[i] = target[i];
        lower[i] = target[i];
      }
    }

    const d0 = f.cell;
    const d1 = f.cell * Math.SQRT2;
    const cutO = CUT_SLOPE * d0;
    const cutD = CUT_SLOPE * d1;
    const fillO = FILL_SLOPE * d0;
    const fillD = FILL_SLOPE * d1;

    const relax = (i: number, j: number, cut: number, fill: number): void => {
      if (blocked[i] || blocked[j]) return;
      const u = upper[j] + cut;
      if (u < upper[i]) upper[i] = u;
      const l = lower[j] - fill;
      if (l > lower[i]) lower[i] = l;
    };

    // チャンファ距離変換と同じ 2 パス走査で、min-plus の伝播を行う。
    for (let iz = 0; iz <= cells; iz++) {
      for (let ix = 0; ix <= cells; ix++) {
        const i = ix + iz * stride;
        if (seeded[i] || blocked[i]) continue;
        if (ix > 0) relax(i, i - 1, cutO, fillO);
        if (iz > 0) {
          relax(i, i - stride, cutO, fillO);
          if (ix > 0) relax(i, i - stride - 1, cutD, fillD);
          if (ix < cells) relax(i, i - stride + 1, cutD, fillD);
        }
      }
    }
    for (let iz = cells; iz >= 0; iz--) {
      for (let ix = cells; ix >= 0; ix--) {
        const i = ix + iz * stride;
        if (seeded[i] || blocked[i]) continue;
        if (ix < cells) relax(i, i + 1, cutO, fillO);
        if (iz < cells) {
          relax(i, i + stride, cutO, fillO);
          if (ix < cells) relax(i, i + stride + 1, cutD, fillD);
          if (ix > 0) relax(i, i + stride - 1, cutD, fillD);
        }
      }
    }

    const base = f.base;
    const work = f.work;
    for (let i = 0; i < n; i++) {
      if (blocked[i]) {
        work[i] = base[i];
        continue;
      }
      const v = base[i];
      work[i] = v > upper[i] ? upper[i] : v < lower[i] ? lower[i] : v;
    }
  }
}
