import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  type Material,
} from 'three';
import { TERRAIN_CHUNK_CELLS, VIEW_DISTANCE } from '../core/units';
import type { GridRegion } from './grading';
import type { Heightfield } from './heightfield';

interface Chunk {
  mesh: Mesh;
  /** 覆っている格子の左上。常駐していないチャンクでは意味を持たない。 */
  ix0: number;
  iz0: number;
  cellsX: number;
  cellsZ: number;
  position: BufferAttribute;
  normal: BufferAttribute;
  uv: BufferAttribute;
}

/**
 * ハイトフィールドを描画するためのチャンク分割メッシュ。
 *
 * チャンクは**カメラのまわりだけ**に置く。20,480 m 四方・4 m 格子では
 * 全部で 6,400 枚 = 2,700 万頂点になり、そのまま持つと 1 GB を超えるが、
 * 遠クリップ面は 3,840 m しかないので、実際に見えるのは常に一部でしかない。
 * 離れたチャンクはジオメトリをプールへ返して使い回す (作り直しはしない)。
 *
 * 頂点バッファは確保したら中身だけ書き換えるので、整地のたびにジオメトリを
 * 作り直すコストがかからない。法線は高さ場から中心差分で求めるため、
 * チャンクの継ぎ目でも連続する。
 */
export class TerrainMesh {
  readonly group = new Group();
  /** 常駐しているチャンク。キーは `chunkKey`。 */
  private readonly resident = new Map<number, Chunk>();
  /** 大きさごとの空きチャンク。 */
  private readonly pool = new Map<number, Chunk[]>();
  /** 大きさごとの索引バッファ。同じ形のチャンクで共有する。 */
  private readonly indices = new Map<number, BufferAttribute>();
  private readonly normalAppearance: {
    transparent: boolean;
    opacity: number;
    depthWrite: boolean;
  };
  private underground = false;
  /** 最後に反映した自然地形の版。変わっていたら常駐ぶんを作り直す。 */
  private baseVersion = -1;
  /** 常駐させる範囲の中心 [m]。 */
  private centerX = 0;
  private centerZ = 0;
  private readonly chunksPerSide: number;

  constructor(
    private readonly field: Heightfield,
    private readonly material: Material,
    /**
     * 常駐させる半径 [m]。既定は遠クリップ面 (`VIEW_DISTANCE * 1.6`)。
     * これより遠いチャンクは描かれないので持たない。
     */
    private readonly radius = VIEW_DISTANCE * 1.6,
  ) {
    this.group.name = 'terrain';
    this.normalAppearance = {
      transparent: material.transparent,
      opacity: material.opacity,
      depthWrite: material.depthWrite,
    };
    this.chunksPerSide = Math.ceil(field.cells / TERRAIN_CHUNK_CELLS);
  }

  /**
   * 常駐させる範囲の中心を決める。カメラが見ている地面の点を渡す。
   *
   * 半チャンク以上動いたときだけ入れ替えを見直すので、毎フレーム呼んでよい。
   */
  setCenter(x: number, z: number): void {
    const size = TERRAIN_CHUNK_CELLS * this.field.cell;
    if (
      this.resident.size > 0 &&
      Math.abs(x - this.centerX) < size * 0.5 &&
      Math.abs(z - this.centerZ) < size * 0.5
    ) {
      return;
    }
    this.centerX = x;
    this.centerZ = z;
    this.refreshResidency();
  }

  /** 地下ビューでは地形を薄い覆いにして、地中の線形を透かして見せる。 */
  setUndergroundView(active: boolean): void {
    this.underground = active;
    this.material.transparent = active || this.normalAppearance.transparent;
    this.material.opacity = active ? 0.3 : this.normalAppearance.opacity;
    this.material.depthWrite = active ? false : this.normalAppearance.depthWrite;
    this.material.needsUpdate = true;
    for (const chunk of this.resident.values()) this.applyAppearance(chunk);
  }

  /**
   * 高さ場の現在値からチャンクを更新する。
   *
   * `region` を渡すと、その格子範囲に掛かるチャンクだけを書き換える。
   * 整地で触ったのは線形のまわりだけなので、広いマップでも 1 回の編集で
   * 全チャンクを舐め直さずに済む。法線は隣の格子点を見るので、範囲は
   * 1 マス広げて判定する。
   */
  update(region?: GridRegion | null): void {
    const f = this.field;
    // 自然地形そのものが変わったときは、範囲に関わらず全部を作り直す。
    const all = region === undefined || region === null || this.baseVersion !== f.baseVersion;
    this.baseVersion = f.baseVersion;
    if (all) {
      for (const chunk of this.resident.values()) this.fill(chunk);
      return;
    }
    const size = TERRAIN_CHUNK_CELLS;
    const cx0 = Math.floor((region.ix0 - 1) / size);
    const cx1 = Math.floor((region.ix1 + 1) / size);
    const cz0 = Math.floor((region.iz0 - 1) / size);
    const cz1 = Math.floor((region.iz1 + 1) / size);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const chunk = this.resident.get(this.chunkKey(cx, cz));
        if (chunk) this.fill(chunk);
      }
    }
  }

  /** レイキャスト対象のメッシュ一覧 (常駐しているぶん)。 */
  get meshes(): Mesh[] {
    return [...this.resident.values()].map((c) => c.mesh);
  }

  dispose(): void {
    for (const chunk of this.resident.values()) chunk.mesh.geometry.dispose();
    for (const list of this.pool.values()) for (const chunk of list) chunk.mesh.geometry.dispose();
    this.resident.clear();
    this.pool.clear();
    this.indices.clear();
    this.group.clear();
  }

  private chunkKey(cx: number, cz: number): number {
    return cz * (this.chunksPerSide + 1) + cx;
  }

  /** 中心のまわりのチャンクを常駐させ、外れたものはプールへ返す。 */
  private refreshResidency(): void {
    const f = this.field;
    const size = TERRAIN_CHUNK_CELLS;
    const span = size * f.cell;
    const reach = this.radius + span;
    const cx0 = Math.max(0, Math.floor(f.toGridX(this.centerX - reach) / size));
    const cx1 = Math.min(this.chunksPerSide - 1, Math.floor(f.toGridX(this.centerX + reach) / size));
    const cz0 = Math.max(0, Math.floor(f.toGridZ(this.centerZ - reach) / size));
    const cz1 = Math.min(this.chunksPerSide - 1, Math.floor(f.toGridZ(this.centerZ + reach) / size));

    const wanted = new Set<number>();
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        wanted.add(this.chunkKey(cx, cz));
        if (this.resident.has(this.chunkKey(cx, cz))) continue;
        this.acquire(cx, cz);
      }
    }
    for (const [key, chunk] of this.resident) {
      if (wanted.has(key)) continue;
      this.resident.delete(key);
      this.release(chunk);
    }
  }

  /** チャンクを 1 枚常駐させる。プールに同じ形があれば使い回す。 */
  private acquire(cx: number, cz: number): void {
    const f = this.field;
    const size = TERRAIN_CHUNK_CELLS;
    const ix0 = cx * size;
    const iz0 = cz * size;
    const cellsX = Math.min(size, f.cells - ix0);
    const cellsZ = Math.min(size, f.cells - iz0);
    if (cellsX <= 0 || cellsZ <= 0) return;
    const shape = cellsX * 4096 + cellsZ;
    const free = this.pool.get(shape);
    const chunk = free?.pop() ?? this.createChunk(cellsX, cellsZ, shape);
    chunk.ix0 = ix0;
    chunk.iz0 = iz0;
    chunk.mesh.name = `terrain-chunk-${ix0}-${iz0}`;
    this.applyAppearance(chunk);
    this.fill(chunk);
    this.group.add(chunk.mesh);
    this.resident.set(this.chunkKey(cx, cz), chunk);
  }

  private release(chunk: Chunk): void {
    this.group.remove(chunk.mesh);
    const shape = chunk.cellsX * 4096 + chunk.cellsZ;
    const list = this.pool.get(shape);
    if (list) list.push(chunk);
    else this.pool.set(shape, [chunk]);
  }

  private applyAppearance(chunk: Chunk): void {
    chunk.mesh.renderOrder = this.underground ? 6 : 0;
    chunk.mesh.receiveShadow = !this.underground;
    chunk.mesh.castShadow = false;
  }

  private createChunk(cellsX: number, cellsZ: number, shape: number): Chunk {
    const nx = cellsX + 1;
    const nz = cellsZ + 1;
    const count = nx * nz;
    const position = new BufferAttribute(new Float32Array(count * 3), 3);
    const normal = new BufferAttribute(new Float32Array(count * 3), 3);
    const uv = new BufferAttribute(new Float32Array(count * 2), 2);

    // 索引は形が同じなら中身も同じ。プールを跨いで共有する。
    let index = this.indices.get(shape);
    if (!index) {
      const list: number[] = [];
      for (let z = 0; z < cellsZ; z++) {
        for (let x = 0; x < cellsX; x++) {
          const i = x + z * nx;
          list.push(i, i + nx, i + 1);
          list.push(i + 1, i + nx, i + nx + 1);
        }
      }
      index = new BufferAttribute(
        count > 65535 ? new Uint32Array(list) : new Uint16Array(list),
        1,
      );
      this.indices.set(shape, index);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', normal);
    geometry.setAttribute('uv', uv);
    geometry.setIndex(index);

    const mesh = new Mesh(geometry, this.material);
    return { mesh, ix0: 0, iz0: 0, cellsX, cellsZ, position, normal, uv };
  }

  /** チャンクの頂点を、いまの高さ場から書き直す。 */
  private fill(chunk: Chunk): void {
    const f = this.field;
    const nx = chunk.cellsX + 1;
    const nz = chunk.cellsZ + 1;
    for (let z = 0; z < nz; z++) {
      const iz = chunk.iz0 + z;
      for (let x = 0; x < nx; x++) {
        const ix = chunk.ix0 + x;
        const i = x + z * nx;
        const wx = f.worldX(ix);
        const wz = f.worldZ(iz);
        chunk.position.setXYZ(i, wx, f.work[f.index(ix, iz)], wz);
        chunk.uv.setXY(i, ix / f.cells, iz / f.cells);

        // 隣接セルとの差分から法線を作る (端はクランプ)。
        const xl = Math.max(0, ix - 1);
        const xr = Math.min(f.cells, ix + 1);
        const zd = Math.max(0, iz - 1);
        const zu = Math.min(f.cells, iz + 1);
        const hl = f.work[f.index(xl, iz)];
        const hr = f.work[f.index(xr, iz)];
        const hd = f.work[f.index(ix, zd)];
        const hu = f.work[f.index(ix, zu)];
        const dx = (xr - xl) * f.cell;
        const dz = (zu - zd) * f.cell;
        let nxv = (hl - hr) * dz;
        let nyv = dx * dz;
        let nzv = (hd - hu) * dx;
        const len = Math.hypot(nxv, nyv, nzv) || 1;
        nxv /= len;
        nyv /= len;
        nzv /= len;
        chunk.normal.setXYZ(i, nxv, nyv, nzv);
      }
    }
    chunk.position.needsUpdate = true;
    chunk.normal.needsUpdate = true;
    chunk.uv.needsUpdate = true;
    chunk.mesh.geometry.computeBoundingSphere();
    chunk.mesh.geometry.computeBoundingBox();
  }
}
