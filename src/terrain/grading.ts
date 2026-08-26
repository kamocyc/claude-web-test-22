import type { Vector3 } from 'three';
import { earcutXZ } from '../core/meshbuilder';
import { CUT_SLOPE, FILL_SLOPE } from '../core/units';
import type { Heightfield } from './heightfield';

const INF = Infinity;

/**
 * 法面の起点として、footprint の**連続な縁**からの距離を直接求める帯の幅
 * (セル数)。
 *
 * 伝播だけに任せると、法面は「footprint の**内側の格子点**」からの円錐の
 * 下側包絡になる。格子点の並びは斜めの縁では階段状なので、縁からの距離が
 * 最大で半セル分ばらつき、法面が道路に沿ってぎざぎざに波打つ (セルを
 * 粗くするほど目立つ)。この帯の中だけは三角形の縁までの距離を厳密に
 * 求めて上限・下限を置き、そこから先を伝播させる。
 */
const EDGE_BAND_CELLS = 1;

/** 格子添字で表した矩形 (両端を含む)。 */
export interface GridRegion {
  ix0: number;
  iz0: number;
  ix1: number;
  iz1: number;
}

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
   * その三角形が footprint の**内側にしかない**か (外周を含まない)。
   *
   * 既定では、焼き込む三角形のまわりの格子点に「縁からの厳密な距離」で
   * 法面の上限・下限を置く (`EDGE_BAND_CELLS`)。内側の帯にこれをしても
   * 結果は変わらない (内側の縁は外周より必ず遠い) 一方、細い帯ほど周囲の
   * 格子点が増えて無駄が大きいので、外周を含まないと分かっている帯は
   * これを立てて省く。
   */
  interior?: boolean;
  /**
   * その帯が中心線からどれだけ離れているか [m]。
   *
   * 高さの違う舗装どうしが重なったとき、常に低い方を採ると高い方が宙に
   * 浮く (平坦な幹線に 12% の枝が取り付く交差点など)。中心線がより近い
   * 舗装を優先することで、「自分の真下の地面は自分が決める」ようにする。
   */
  distance?: number;
}

/** 道路の舗装が押さえている矩形 (踏切の下)。 */
interface ProtectedRect {
  x: number;
  z: number;
  /** 道路の進行方向 (単位)。 */
  ux: number;
  uz: number;
  /** 進行方向の半長 / 直交方向の半幅 [m]。 */
  halfAlong: number;
  halfAcross: number;
}

export class TerrainGrading {
  private readonly field: Heightfield;
  private readonly target: Float32Array;
  private readonly seeded: Uint8Array;
  private readonly core: Uint8Array;
  private readonly coreDistance: Float32Array;
  private readonly blocked: Uint8Array;
  private readonly ceiling: Float32Array;
  private readonly upper: Float32Array;
  private readonly lower: Float32Array;
  private readonly edgeUpper: Float32Array;
  private readonly edgeLower: Float32Array;
  private readonly protectedRects: ProtectedRect[] = [];
  /**
   * いま焼き込んだ範囲と、前回 `apply` で地形を書き換えた範囲。
   *
   * 格子はマップ全体ぶんあるが、実際に触るのは線形のまわりだけ。走査を
   * この矩形に絞ることで、マップを広げても再構築の重さが変わらない。
   */
  private stamped: GridRegion | null = null;
  private applied: GridRegion | null = null;

  constructor(field: Heightfield) {
    this.field = field;
    const n = field.stride * field.stride;
    this.target = new Float32Array(n);
    this.seeded = new Uint8Array(n);
    this.core = new Uint8Array(n);
    this.coreDistance = new Float32Array(n);
    this.blocked = new Uint8Array(n);
    this.ceiling = new Float32Array(n).fill(INF);
    this.upper = new Float32Array(n).fill(INF);
    this.lower = new Float32Array(n).fill(-INF);
    this.edgeUpper = new Float32Array(n).fill(INF);
    this.edgeLower = new Float32Array(n).fill(-INF);
  }

  reset(): void {
    // 触った範囲だけを戻す。全体を埋めると、格子の数だけ空回りする。
    this.forEachIndex(this.stamped, (i) => {
      this.seeded[i] = 0;
      this.core[i] = 0;
      this.coreDistance[i] = 0;
      this.blocked[i] = 0;
      this.ceiling[i] = INF;
      this.edgeUpper[i] = INF;
      this.edgeLower[i] = -INF;
    });
    this.stamped = null;
    this.protectedRects.length = 0;
  }

  /** 矩形の格子点を走査する。矩形が無ければ何もしない。 */
  private forEachIndex(region: GridRegion | null, visit: (index: number) => void): void {
    if (!region) return;
    const stride = this.field.stride;
    for (let iz = region.iz0; iz <= region.iz1; iz++) {
      const row = iz * stride;
      for (let ix = region.ix0; ix <= region.ix1; ix++) visit(ix + row);
    }
  }

  /** 焼き込んだ範囲を広げる。 */
  private include(ix0: number, iz0: number, ix1: number, iz1: number): void {
    if (!this.stamped) {
      this.stamped = { ix0, iz0, ix1, iz1 };
      return;
    }
    const r = this.stamped;
    if (ix0 < r.ix0) r.ix0 = ix0;
    if (iz0 < r.iz0) r.iz0 = iz0;
    if (ix1 > r.ix1) r.ix1 = ix1;
    if (iz1 > r.iz1) r.iz1 = iz1;
  }

  /**
   * 「ここは道路の舗装の下なので、他の線形は整地してはいけない」範囲。
   * 踏切で、線路の断面 (道床の法尻) が道路の路面の下を掘るのを防ぐ。
   *
   * 円で囲うと舗装の外まで押さえてしまい、その分だけ線路が埋まる。
   * 道路の向きに沿った矩形で、舗装の幅ぶんだけを押さえる。
   */
  protect(
    x: number,
    z: number,
    direction: { x: number; y: number },
    halfAlong: number,
    halfAcross: number,
  ): void {
    const len = Math.hypot(direction.x, direction.y) || 1;
    this.protectedRects.push({
      x,
      z,
      ux: direction.x / len,
      uz: direction.y / len,
      halfAlong,
      halfAcross,
    });
  }

  /** 三角形の範囲の格子点に目標高さを焼き込む。重なった場合は低い方を採用する。 */
  stampTriangle(a: Vector3, b: Vector3, c: Vector3, options: StampOptions = {}): void {
    const core = options.core ?? true;
    const distance = options.distance ?? 0;
    const respectProtected = !options.ignoreProtected && this.protectedRects.length > 0;
    const write = (i: number, y: number, x: number, z: number): void => {
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
    };
    if (options.interior) {
      this.rasterize(a, b, c, write);
      return;
    }
    this.rasterize(a, b, c, write, (i, y, toEdge, x, z) => {
      if (respectProtected && this.isProtected(x, z)) return;
      // 縁の高さから法面勾配で伸ばした上限・下限。複数の縁が届く所は、
      // 伝播と同じ min-plus / max-minus の包絡を採る。
      const upper = y + CUT_SLOPE * toEdge;
      if (upper < this.edgeUpper[i]) this.edgeUpper[i] = upper;
      const lower = y - FILL_SLOPE * toEdge;
      if (lower > this.edgeLower[i]) this.edgeLower[i] = lower;
    });
  }

  private isProtected(x: number, z: number): boolean {
    for (const rect of this.protectedRects) {
      const dx = x - rect.x;
      const dz = z - rect.z;
      const along = dx * rect.ux + dz * rect.uz;
      const across = -dx * rect.uz + dz * rect.ux;
      if (Math.abs(along) <= rect.halfAlong && Math.abs(across) <= rect.halfAcross) return true;
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

  /**
   * その範囲の地形を、指定した高さより上に出さない (天井)。
   *
   * 橋の下に使う。橋の区間では整地の伝播を止めているので、そのままだと
   * 自然地形が残る。谷を渡るぶんには問題ないが、**近くのトンネル坑口や
   * 立体交差の都合で「地形より低い所も橋にした」区間**では、地形が桁の
   * 上に被さって道路が埋まってしまう。地形が桁より高い所だけを削る。
   */
  carveTriangle(a: Vector3, b: Vector3, c: Vector3): void {
    this.rasterize(a, b, c, (i, y) => {
      if (y < this.ceiling[i]) this.ceiling[i] = y;
    });
  }

  carveQuad(a: Vector3, b: Vector3, c: Vector3, d: Vector3): void {
    this.carveTriangle(a, b, c);
    this.carveTriangle(a, c, d);
  }

  private rasterize(
    a: Vector3,
    b: Vector3,
    c: Vector3,
    write: (index: number, y: number, x: number, z: number) => void,
    /**
     * 三角形の**外側**の格子点に対して、いちばん近い縁までの距離 [m] と
     * そこでの高さを渡す。渡した場合は走査する帯もその分だけ広げる。
     */
    outside?: (index: number, y: number, toEdge: number, x: number, z: number) => void,
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

    const pad = outside ? EDGE_BAND_CELLS : 1;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - pad);
    const maxX = Math.min(f.cells, Math.ceil(Math.max(ax, bx, cx)) + pad);
    const minZ = Math.max(0, Math.floor(Math.min(az, bz, cz)) - pad);
    const maxZ = Math.min(f.cells, Math.ceil(Math.max(az, bz, cz)) + pad);

    // 格子点が三角形の辺上に乗る場合を取りこぼさないよう、わずかに外側まで
    // 含める (格子 0.06 マス分)。重心座標のままで許容量を決めると三角形の
    // 大きさで意味が変わる (細長い三角形では 1 m 以上こぼれる) ので、辺
    // からの**距離**で決めて重心座標に直す。
    // (辺までの距離 = 重心座標 × その辺に対する高さ、高さ = |area| / 辺長。)
    const slack = 0.06;
    const eps0 = (slack * Math.hypot(bx - cx, bz - cz)) / Math.abs(area);
    const eps1 = (slack * Math.hypot(cx - ax, cz - az)) / Math.abs(area);
    const eps2 = (slack * Math.hypot(ax - bx, az - bz)) / Math.abs(area);

    this.include(minX, minZ, maxX, maxZ);

    // 縁までの距離を測る作業変数。点ごとに閉包を作らないよう外に置く。
    let bestD2 = 0;
    let bestY = 0;
    const consider = (
      px: number,
      pz: number,
      x0: number,
      z0: number,
      y0: number,
      x1: number,
      z1: number,
      y1: number,
    ): void => {
      const ex = x1 - x0;
      const ez = z1 - z0;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 1e-12 ? ((px - x0) * ex + (pz - z0) * ez) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - (x0 + ex * t);
      const qz = pz - (z0 + ez * t);
      const d2 = qx * qx + qz * qz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestY = y0 + (y1 - y0) * t;
      }
    };

    for (let iz = minZ; iz <= maxZ; iz++) {
      const wz = f.worldZ(iz);
      for (let ix = minX; ix <= maxX; ix++) {
        const px = ix;
        const pz = iz;
        const index = f.index(ix, iz);
        const w0 = ((bx - px) * (cz - pz) - (cx - px) * (bz - pz)) / area;
        const w1 = ((cx - px) * (az - pz) - (ax - px) * (cz - pz)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -eps0 && w1 >= -eps1 && w2 >= -eps2) {
          write(index, w0 * a.y + w1 * b.y + w2 * c.y, f.worldX(ix), wz);
        } else if (outside && !this.seeded[index]) {
          // 焼き込まれた格子点は目標高さそのものを使うので、縁からの距離は要らない。
          // 三角形の 3 辺への垂線の足のうち、いちばん近いものを採る。
          bestD2 = INF;
          consider(px, pz, ax, az, a.y, bx, bz, b.y);
          consider(px, pz, bx, bz, b.y, cx, cz, c.y);
          consider(px, pz, cx, cz, c.y, ax, az, a.y);
          outside(index, bestY, Math.sqrt(bestD2) * f.cell, f.worldX(ix), wz);
        }
      }
    }
  }

  /**
   * 焼き込んだ結果を `field.work` に反映する。
   * `base` は変更しないので、ネットワークを消せば地形は元に戻る。
   *
   * 走査するのは「焼き込んだ矩形 + 法面が届く距離」だけ。その外では
   * 自然地形がそのまま残るので、マップが広くても線形のまわりしか見ない。
   * 戻り値は**地形が変わりうる範囲** (前回の範囲との和) で、地形メッシュを
   * 更新する範囲に使う。
   */
  apply(): GridRegion | null {
    const f = this.field;
    const stride = f.stride;
    const cells = f.cells;
    const base = f.base;
    const work = f.work;

    // まず自然地形へ戻す。前回の整地の跡はこれで消える。
    work.set(base);

    const region = this.workingRegion();
    const changed = union(region, this.applied);
    this.applied = region;
    if (!region) return changed;

    const upper = this.upper;
    const lower = this.lower;
    const seeded = this.seeded;
    const blocked = this.blocked;
    const target = this.target;

    // 走査する矩形の外側 1 マスも初期値に戻す。境界の格子点が、その外の
    // 古い値を参照して伝播してしまうのを防ぐ。
    const guard = {
      ix0: Math.max(0, region.ix0 - 1),
      iz0: Math.max(0, region.iz0 - 1),
      ix1: Math.min(cells, region.ix1 + 1),
      iz1: Math.min(cells, region.iz1 + 1),
    };
    for (let iz = guard.iz0; iz <= guard.iz1; iz++) {
      const row = iz * stride;
      for (let ix = guard.ix0; ix <= guard.ix1; ix++) {
        const i = ix + row;
        if (seeded[i]) {
          upper[i] = target[i];
          lower[i] = target[i];
        } else {
          // 縁の帯では、階段状の格子点ではなく連続な縁からの距離で始める。
          upper[i] = this.edgeUpper[i];
          lower[i] = this.edgeLower[i];
        }
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
    for (let iz = region.iz0; iz <= region.iz1; iz++) {
      for (let ix = region.ix0; ix <= region.ix1; ix++) {
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
    for (let iz = region.iz1; iz >= region.iz0; iz--) {
      for (let ix = region.ix1; ix >= region.ix0; ix--) {
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

    const ceiling = this.ceiling;
    for (let iz = region.iz0; iz <= region.iz1; iz++) {
      for (let ix = region.ix0; ix <= region.ix1; ix++) {
        const i = ix + iz * stride;
        if (!blocked[i]) {
          const v = base[i];
          work[i] = v > upper[i] ? upper[i] : v < lower[i] ? lower[i] : v;
        }
        // 橋桁の下は、整地を遮断していても地形が桁より上に出てはいけない。
        if (work[i] > ceiling[i]) work[i] = ceiling[i];
      }
    }

    return changed;
  }

  /**
   * 走査する矩形。焼き込んだ範囲に「法面が届きうる距離」を足す。
   *
   * 上限は `目標高さ + 切土勾配 × 距離` が自然地形を超えるまで、
   * 下限は `目標高さ − 盛土勾配 × 距離` が自然地形を下回るまでで、
   * どちらも地形の高さの幅から決まる。ここを外れた格子点は、伝播させても
   * 自然地形のままにしかならない。
   */
  private workingRegion(): GridRegion | null {
    const stamped = this.stamped;
    if (!stamped) return null;
    const f = this.field;
    const range = f.baseRange;

    let minTarget = INF;
    let maxTarget = -INF;
    let any = false;
    this.forEachIndex(stamped, (i) => {
      if (!this.seeded[i]) return;
      any = true;
      const v = this.target[i];
      if (v < minTarget) minTarget = v;
      if (v > maxTarget) maxTarget = v;
    });
    // 遮断と天井だけ (橋・トンネルしかない) のときは、焼き込んだ範囲そのもの。
    if (!any) return clampRegion(stamped, f.cells);

    const cut = Math.max(0, range.max - minTarget) / CUT_SLOPE;
    const fill = Math.max(0, maxTarget - range.min) / FILL_SLOPE;
    const reach = Math.ceil(Math.max(cut, fill) / f.cell) + 2;
    return clampRegion(
      {
        ix0: stamped.ix0 - reach,
        iz0: stamped.iz0 - reach,
        ix1: stamped.ix1 + reach,
        iz1: stamped.iz1 + reach,
      },
      f.cells,
    );
  }
}

function clampRegion(region: GridRegion, cells: number): GridRegion | null {
  const ix0 = Math.max(0, region.ix0);
  const iz0 = Math.max(0, region.iz0);
  const ix1 = Math.min(cells, region.ix1);
  const iz1 = Math.min(cells, region.iz1);
  return ix0 > ix1 || iz0 > iz1 ? null : { ix0, iz0, ix1, iz1 };
}

/** 2 つの矩形を含む最小の矩形。 */
function union(a: GridRegion | null, b: GridRegion | null): GridRegion | null {
  if (!a) return b;
  if (!b) return a;
  return {
    ix0: Math.min(a.ix0, b.ix0),
    iz0: Math.min(a.iz0, b.iz0),
    ix1: Math.max(a.ix1, b.ix1),
    iz1: Math.max(a.iz1, b.iz1),
  };
}
