/**
 * いちばん近い河道中心線までの距離と、その地点の川の寸法。
 *
 * 地形に刻む河床も、描く水面も、敷設の水判定もすべてここから引くので、
 * 地形と水が食い違いようがない。
 */
import type { RiverNetwork } from './network';

export interface RiverSample {
  /** 中心線までの距離 [m]。 */
  distance: number;
  widthM: number;
  depthM: number;
  /** 水面の高さ [m]。 */
  waterY: number;
}

export interface RiverField {
  /** 届く川が無ければ null (マップのほとんどはこれ)。 */
  sample(x: number, z: number): RiverSample | null;
  /** 河道と岸が地面に影響しうる距離 [m]。 */
  reach: number;
}

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  widthM: number;
  depthM: number;
  waterY: number;
}

export function buildRiverField(network: RiverNetwork): RiverField {
  // 1 バケツ = 影響距離。問い合わせは常に 9 個しか見ない。
  const reach = Math.max(60, network.maxWidthM * 3);
  const buckets = new Map<number, Segment[]>();
  const key = (bx: number, bz: number): number => bx * 65536 + bz;
  const coord = (v: number): number => Math.floor(v / reach);

  const add = (bx: number, bz: number, segment: Segment): void => {
    const id = key(bx, bz);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(segment);
    else buckets.set(id, [segment]);
  };
  for (const stem of network.stems) {
    for (let k = 1; k < stem.points.length; k++) {
      const a = stem.points[k - 1];
      const b = stem.points[k];
      const segment: Segment = {
        ax: a.x,
        az: a.z,
        bx: b.x,
        bz: b.z,
        widthM: (a.widthM + b.widthM) * 0.5,
        depthM: (a.depthM + b.depthM) * 0.5,
        waterY: (a.waterY + b.waterY) * 0.5,
      };
      // 区間はバケツをまたぐので、掛かるバケツすべてに入れる。
      const lo = coord(Math.min(a.x, b.x));
      const hi = coord(Math.max(a.x, b.x));
      const loZ = coord(Math.min(a.z, b.z));
      const hiZ = coord(Math.max(a.z, b.z));
      for (let bz = loZ; bz <= hiZ; bz++) for (let bx = lo; bx <= hi; bx++) add(bx, bz, segment);
    }
  }

  const sample = (x: number, z: number): RiverSample | null => {
    const bx = coord(x);
    const bz = coord(z);
    let best: Segment | null = null;
    let bestSq = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = buckets.get(key(bx + dx, bz + dz));
        if (!bucket) continue;
        for (const segment of bucket) {
          const ex = segment.bx - segment.ax;
          const ez = segment.bz - segment.az;
          const lengthSq = ex * ex + ez * ez;
          const t =
            lengthSq < 1e-9
              ? 0
              : Math.max(0, Math.min(1, ((x - segment.ax) * ex + (z - segment.az) * ez) / lengthSq));
          const ddx = segment.ax + ex * t - x;
          const ddz = segment.az + ez * t - z;
          const sq = ddx * ddx + ddz * ddz;
          if (sq < bestSq) {
            bestSq = sq;
            best = segment;
          }
        }
      }
    }
    if (!best) return null;
    return { distance: Math.sqrt(bestSq), widthM: best.widthM, depthM: best.depthM, waterY: best.waterY };
  };

  return { sample, reach };
}
