import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  type Material,
} from 'three';
import { TERRAIN_CHUNK_CELLS } from '../core/units';
import type { GridRegion } from './grading';
import type { Heightfield } from './heightfield';

interface Chunk {
  mesh: Mesh;
  ix0: number;
  iz0: number;
  cells: number;
  position: BufferAttribute;
  normal: BufferAttribute;
}

/**
 * ハイトフィールドを描画するためのチャンク分割メッシュ。
 *
 * 頂点バッファは最初に確保して以後は中身だけ書き換えるので、整地のたびに
 * ジオメトリを作り直すコストがかからない。法線は高さ場から中心差分で
 * 求めるため、チャンクの継ぎ目でも連続する。
 */
export class TerrainMesh {
  readonly group = new Group();
  private readonly chunks: Chunk[] = [];
  private readonly normalAppearance: {
    transparent: boolean;
    opacity: number;
    depthWrite: boolean;
  };
  /** 最後に反映した自然地形の版。変わっていたら全チャンクを作り直す。 */
  private baseVersion = -1;

  constructor(
    private readonly field: Heightfield,
    private readonly material: Material,
  ) {
    this.group.name = 'terrain';
    this.normalAppearance = {
      transparent: material.transparent,
      opacity: material.opacity,
      depthWrite: material.depthWrite,
    };
    const size = TERRAIN_CHUNK_CELLS;
    for (let iz0 = 0; iz0 < field.cells; iz0 += size) {
      for (let ix0 = 0; ix0 < field.cells; ix0 += size) {
        const cells = Math.min(size, field.cells - ix0);
        const cellsZ = Math.min(size, field.cells - iz0);
        this.chunks.push(this.createChunk(ix0, iz0, cells, cellsZ, material));
      }
    }
    this.update();
  }

  /** 地下ビューでは地形を薄い覆いにして、地中の線形を透かして見せる。 */
  setUndergroundView(active: boolean): void {
    this.material.transparent = active || this.normalAppearance.transparent;
    this.material.opacity = active ? 0.3 : this.normalAppearance.opacity;
    this.material.depthWrite = active ? false : this.normalAppearance.depthWrite;
    this.material.needsUpdate = true;
    for (const chunk of this.chunks) {
      chunk.mesh.renderOrder = active ? 6 : 0;
      chunk.mesh.receiveShadow = !active;
    }
  }

  private createChunk(
    ix0: number,
    iz0: number,
    cellsX: number,
    cellsZ: number,
    material: Material,
  ): Chunk {
    const nx = cellsX + 1;
    const nz = cellsZ + 1;
    const count = nx * nz;
    const position = new BufferAttribute(new Float32Array(count * 3), 3);
    const normal = new BufferAttribute(new Float32Array(count * 3), 3);
    const uv = new BufferAttribute(new Float32Array(count * 2), 2);
    const indices: number[] = [];
    for (let z = 0; z < cellsZ; z++) {
      for (let x = 0; x < cellsX; x++) {
        const i = x + z * nx;
        indices.push(i, i + nx, i + 1);
        indices.push(i + 1, i + nx, i + nx + 1);
      }
    }
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const i = x + z * nx;
        uv.setXY(i, (ix0 + x) / this.field.cells, (iz0 + z) / this.field.cells);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', normal);
    geometry.setAttribute('uv', uv);
    geometry.setIndex(indices);

    const mesh = new Mesh(geometry, material);
    mesh.name = `terrain-chunk-${ix0}-${iz0}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.group.add(mesh);

    return { mesh, ix0, iz0, cells: cellsX, position, normal };
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
    for (const chunk of this.chunks) {
      if (!all && !this.overlaps(chunk, region)) continue;
      const geometry = chunk.mesh.geometry;
      const nx = chunk.cells + 1;
      const total = chunk.position.count;
      const nz = total / nx;
      for (let z = 0; z < nz; z++) {
        const iz = chunk.iz0 + z;
        for (let x = 0; x < nx; x++) {
          const ix = chunk.ix0 + x;
          const i = x + z * nx;
          const wx = f.worldX(ix);
          const wz = f.worldZ(iz);
          chunk.position.setXYZ(i, wx, f.work[f.index(ix, iz)], wz);

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
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
    }
  }

  /** チャンクが範囲に掛かるか。法線のぶん 1 マス広げて見る。 */
  private overlaps(chunk: Chunk, region: GridRegion): boolean {
    const rows = chunk.position.count / (chunk.cells + 1);
    const ix1 = chunk.ix0 + chunk.cells;
    const iz1 = chunk.iz0 + rows - 1;
    return (
      chunk.ix0 <= region.ix1 + 1 &&
      ix1 >= region.ix0 - 1 &&
      chunk.iz0 <= region.iz1 + 1 &&
      iz1 >= region.iz0 - 1
    );
  }

  /** レイキャスト対象のメッシュ一覧。 */
  get meshes(): Mesh[] {
    return this.chunks.map((c) => c.mesh);
  }

  dispose(): void {
    for (const chunk of this.chunks) chunk.mesh.geometry.dispose();
    this.chunks.length = 0;
    this.group.clear();
  }
}
