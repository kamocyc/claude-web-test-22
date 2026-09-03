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

/** バケツの一辺 [m]。 */
const BUCKET = 64;

/**
 * 河道の空間索引。
 *
 * 区間を「その区間が地面に影響しうる矩形」に掛かるバケツ**すべて**に
 * 登録する。こうすると問い合わせは自分の 1 マスを見るだけで済む
 * (3x3 を見る作りだと、いちばん広い川に合わせてバケツを大きく取ることに
 * なり、狭い川しか無い所でも何十本もの区間を当たることになる)。
 */
export function buildRiverField(network: RiverNetwork): RiverField {
  const buckets = new Map<number, Segment[]>();
  const key = (bx: number, bz: number): number => bx * 65536 + bz;
  const coord = (v: number): number => Math.floor(v / BUCKET);
  let reach = 0;

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
      const widthM = (a.widthM + b.widthM) * 0.5;
      const segment: Segment = {
        ax: a.x,
        az: a.z,
        bx: b.x,
        bz: b.z,
        widthM,
        depthM: (a.depthM + b.depthM) * 0.5,
        waterY: (a.waterY + b.waterY) * 0.5,
      };
      // `channelHeight` が触る範囲 (河床の半幅 + 岸)。ここまでを索引に入れる。
      const pad = widthM * 0.5 + Math.max(6, widthM * 0.6);
      if (pad > reach) reach = pad;
      const lo = coord(Math.min(a.x, b.x) - pad);
      const hi = coord(Math.max(a.x, b.x) + pad);
      const loZ = coord(Math.min(a.z, b.z) - pad);
      const hiZ = coord(Math.max(a.z, b.z) + pad);
      for (let bz = loZ; bz <= hiZ; bz++) for (let bx = lo; bx <= hi; bx++) add(bx, bz, segment);
    }
  }

  const sample = (x: number, z: number): RiverSample | null => {
    const bucket = buckets.get(key(coord(x), coord(z)));
    if (!bucket) return null;
    let best: Segment | null = null;
    let bestSq = Infinity;
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
    if (!best) return null;
    return { distance: Math.sqrt(bestSq), widthM: best.widthM, depthM: best.depthM, waterY: best.waterY };
  };

  return { sample, reach };
}
