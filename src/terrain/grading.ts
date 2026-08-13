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
/** 焼き込みの優先度。 */
export interface StampOptions {
  /**
   * 舗装そのものの範囲か。路肩の余裕幅 (`false`) は、他の線形の舗装が
   * 既に焼き込んだ格子点には手を出さない。平坦な道路の余裕幅が、隣の
   * 急勾配な取り付きの盛土を掘り下げてしまうのを防ぐ。
   */
  core?: boolean;
  /** 保護領域 (踏切の舗装の下) を無視して焼き込む。道路側だけが使う。 */
  ignoreProtected?: boolean;
  /**
   * その帯が中心線からどれだけ離れているか [m]。
   *
   * 高さの違う舗装どうしが重なったとき、常に低い方を採ると高い方が宙に
   * 浮く (平坦な幹線に 12% の枝が取り付く交差点など)。中心線がより近い
   * 舗装を優先することで、「自分の真下の地面は自分が決める」ようにする。
   */
  distance?: number;
}

interface ProtectedDisc {
  x: number;
  z: number;
  radius: number;
}

export class TerrainGrading {
  private readonly field: Heightfield;
  private readonly target: Float32Array;
  private readonly seeded: Uint8Array;
  private readonly core: Uint8Array;
  private readonly coreDistance: Float32Array;
  private readonly blocked: Uint8Array;
  private readonly protectedDiscs: ProtectedDisc[] = [];

  constructor(field: Heightfield) {
    this.field = field;
    const n = field.stride * field.stride;
    this.target = new Float32Array(n);
    this.seeded = new Uint8Array(n);
    this.core = new Uint8Array(n);
    this.coreDistance = new Float32Array(n);
    this.blocked = new Uint8Array(n);
  }

  reset(): void {
    this.seeded.fill(0);
    this.core.fill(0);
    this.coreDistance.fill(0);
    this.blocked.fill(0);
    this.protectedDiscs.length = 0;
  }

  /**
   * 「ここは道路の舗装の下なので、他の線形は整地してはいけない」範囲。
   * 踏切で、線路の断面 (道床の法尻) が道路の路面の下を掘るのを防ぐ。
   */
  protect(x: number, z: number, radius: number): void {
    this.protectedDiscs.push({ x, z, radius });
  }

  /** 三角形の範囲の格子点に目標高さを焼き込む。重なった場合は低い方を採用する。 */
  stampTriangle(a: Vector3, b: Vector3, c: Vector3, options: StampOptions = {}): void {
    const core = options.core ?? true;
    const distance = options.distance ?? 0;
    const respectProtected = !options.ignoreProtected && this.protectedDiscs.length > 0;
    this.rasterize(a, b, c, (i, y, x, z) => {
      if (respectProtected && this.isProtected(x, z)) return;
      if (!core) {
        // 余裕幅は、舗装が押さえている格子点には触らない。
        if (this.core[i]) return;
        this.target[i] = this.seeded[i] ? Math.min(this.target[i], y) : y;
      } else if (this.core[i]) {
        // 舗装どうしが重なったら、中心線が近い方が勝つ。同じくらいなら低い方。
        if (distance < this.coreDistance[i] - 1e-6) {
          this.target[i] = y;
          this.coreDistance[i] = distance;
        } else if (distance <= this.coreDistance[i] + 1e-6) {
          this.target[i] = Math.min(this.target[i], y);
        }
      } else {
        this.target[i] = y;
        this.core[i] = 1;
        this.coreDistance[i] = distance;
      }
      this.seeded[i] = 1;
      this.blocked[i] = 0;
    });
  }

  private isProtected(x: number, z: number): boolean {
    for (const disc of this.protectedDiscs) {
      const dx = x - disc.x;
      const dz = z - disc.z;
      if (dx * dx + dz * dz <= disc.radius * disc.radius) return true;
    }
    return false;
  }

  /**
   * 多角形 (リング) を焼き込む。
   *
   * 扇状の分割だと凹んだリングでは外側まで焼いてしまうので、描画と同じ
   * earcut で三角形分割する。交差点面の形と整地の形が必ず一致する。
   */
  stampPolygon(ring: Vector3[], options: StampOptions = {}): void {
    if (ring.length < 3) return;
    const flat: number[] = [];
    for (const p of ring) flat.push(p.x, p.z);
    const tris = earcutXZ(flat);
    for (let i = 0; i + 2 < tris.length; i += 3) {
      this.stampTriangle(ring[tris[i]], ring[tris[i + 1]], ring[tris[i + 2]], options);
    }
  }

  /** 4 点を 2 三角形として焼き込む。 */
  stampQuad(a: Vector3, b: Vector3, c: Vector3, d: Vector3, options: StampOptions = {}): void {
    this.stampTriangle(a, b, c, options);
    this.stampTriangle(a, c, d, options);
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
    write: (index: number, y: number, x: number, z: number) => void,
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
        write(
          f.index(ix, iz),
          w0 * a.y + w1 * b.y + w2 * c.y,
          f.worldX(ix),
          f.worldZ(iz),
        );
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
