import { Group, Mesh, Vector3, type Material } from 'three';
import { MeshBuilder, UP } from '../core/meshbuilder';
import { clamp, lerp } from '../core/units';
import type { TerrainWater } from '../terrain/water';

/**
 * 水面の描画。
 *
 * 海と湖は**マーチングスクエア**で切る。水文格子のセルをそのまま塗ると
 * 汀線が 40 m の階段になるし、境界矩形で切ると隣の陸まで水浸しになる。
 * 地面が水面の高さを跨ぐ所を辺の上で線形に求めて、そこで切る。
 * 地形の細分も水際だけは双一次補間にしてあるので (`upsample.ts`)、
 * この汀線は描かれた地面とちょうど一致する。
 *
 * 川は河道の曲線からリボンを張る。地形に刻んだ河床と同じ曲線なので、
 * 水が川床から外れることがない。
 */

/** 水面を地面から浮かせる量 [m]。Z ファイティング避け。 */
const WATER_LIFT = 0.05;

/** 浅瀬と深みの色。深さで混ぜる。 */
const SHALLOW: readonly [number, number, number] = [0.42, 0.68, 0.72];
const DEEP: readonly [number, number, number] = [0.09, 0.22, 0.38];
/** この深さで完全に「深み」の色になる [m]。 */
const DEPTH_SCALE = 22;

interface Corner {
  x: number;
  z: number;
  y: number;
  depth: number;
  inside: boolean;
  index: number;
}

export class WaterView {
  readonly group = new Group();
  private mesh: Mesh | null = null;

  constructor(private readonly material: Material) {
    this.group.name = 'water';
  }

  /** 水系から水面を組み立て直す。地形を作り直したときだけ呼ぶ。 */
  build(water: TerrainWater): void {
    this.dispose();
    const mb = new MeshBuilder();
    this.addSurface(mb, water, water.sea, () => water.seaY);
    this.addSurface(mb, water, water.lake, (i) => water.lakeY[i]);
    this.addRivers(mb, water);
    if (mb.isEmpty) return;
    const mesh = new Mesh(mb.build(), this.material);
    mesh.name = 'water-surface';
    // 地形 (0) より上、地下ビューの透かし (6) より下。
    mesh.renderOrder = 3;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    this.group.add(mesh);
    this.mesh = mesh;
  }

  /** 地下ビューでは水面も薄くする (水の下の線形が見えないと困る)。 */
  setUndergroundView(active: boolean): void {
    this.group.visible = !active;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.group.remove(this.mesh);
    this.mesh = null;
  }

  /** 溜まり水 (海・湖) の面。 */
  private addSurface(
    mb: MeshBuilder,
    water: TerrainWater,
    inside: Uint8Array,
    levelOf: (index: number) => number,
  ): void {
    const { grid, groundY } = water;
    const n = grid.n;
    const cornerAt = (x: number, z: number): Corner => {
      const index = z * n + x;
      const level = levelOf(index);
      return {
        x: grid.worldAt(x),
        z: grid.worldAt(z),
        y: level,
        depth: Math.max(0, level - groundY[index]),
        inside: inside[index] === 1,
        index,
      };
    };
    const emit = (corner: Corner): number => {
      const t = clamp(corner.depth / DEPTH_SCALE, 0, 1);
      const color: [number, number, number] = [
        lerp(SHALLOW[0], DEEP[0], t),
        lerp(SHALLOW[1], DEEP[1], t),
        lerp(SHALLOW[2], DEEP[2], t),
      ];
      return mb.vertex(new Vector3(corner.x, corner.y + WATER_LIFT, corner.z), UP, 0, 0, color);
    };

    const polygon: Corner[] = [];
    for (let z = 0; z < n - 1; z++) {
      for (let x = 0; x < n - 1; x++) {
        // 上から見て反時計回りになる順。
        const quad = [cornerAt(x, z), cornerAt(x, z + 1), cornerAt(x + 1, z + 1), cornerAt(x + 1, z)];
        if (!quad[0].inside && !quad[1].inside && !quad[2].inside && !quad[3].inside) continue;
        polygon.length = 0;
        for (let k = 0; k < 4; k++) {
          const current = quad[k];
          const next = quad[(k + 1) % 4];
          if (current.inside) polygon.push(current);
          if (current.inside === next.inside) continue;
          // 水のセルから陸のセルへの辺で、地面が水面を横切る所を採る。
          const wet = current.inside ? current : next;
          const dry = current.inside ? next : current;
          const drop = groundY[dry.index] - groundY[wet.index];
          const t = Math.min(
            0.92,
            Math.max(0.1, drop > 1e-4 ? (wet.y - groundY[wet.index]) / drop : 0.5),
          );
          polygon.push({
            x: lerp(wet.x, dry.x, t),
            z: lerp(wet.z, dry.z, t),
            y: wet.y,
            depth: 0,
            inside: true,
            index: wet.index,
          });
        }
        if (polygon.length < 3) continue;
        const first = emit(polygon[0]);
        let previous = emit(polygon[1]);
        for (let k = 2; k < polygon.length; k++) {
          const current = emit(polygon[k]);
          mb.triangle(first, previous, current);
          previous = current;
        }
      }
    }
  }

  /** 河道のリボン。 */
  private addRivers(mb: MeshBuilder, water: TerrainWater): void {
    for (const stem of water.network.stems) {
      const points = stem.points;
      if (points.length < 2) continue;
      const left: number[] = [];
      const right: number[] = [];
      for (let k = 0; k < points.length; k++) {
        const point = points[k];
        const previous = points[Math.max(0, k - 1)];
        const next = points[Math.min(points.length - 1, k + 1)];
        let tx = next.x - previous.x;
        let tz = next.z - previous.z;
        const length = Math.hypot(tx, tz) || 1;
        tx /= length;
        tz /= length;
        const half = point.widthM * 0.5;
        const y = point.waterY + WATER_LIFT;
        const t = clamp(point.depthM / DEPTH_SCALE, 0, 1);
        const color: [number, number, number] = [
          lerp(SHALLOW[0], DEEP[0], t),
          lerp(SHALLOW[1], DEEP[1], t),
          lerp(SHALLOW[2], DEEP[2], t),
        ];
        left.push(mb.vertex(new Vector3(point.x - tz * half, y, point.z + tx * half), UP, 0, 0, color));
        right.push(mb.vertex(new Vector3(point.x + tz * half, y, point.z - tx * half), UP, 0, 0, color));
      }
      mb.strip(left, right);
    }
  }
}
