import { createNoise2D } from 'simplex-noise';
import { MAP_SIZE, clamp, smoothstep } from '../core/units';
import type { Heightfield } from './heightfield';

/** 決定論的な擬似乱数 (mulberry32)。シードから同じ地形を再現するために使う。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TerrainOptions {
  seed: number;
  /** 起伏の大きさ [m]。 */
  amplitude: number;
  /** 谷 (川) を通すかどうか。 */
  valley: boolean;
}

export const DEFAULT_TERRAIN: TerrainOptions = {
  seed: 20260812,
  amplitude: 42,
  valley: true,
};

/**
 * fBm ノイズで起伏のある地形を作る。
 *
 * 建設しやすいように、低周波の「平坦度マスク」を掛けて所々に平地を作り、
 * さらに谷を 1 本通して橋・トンネルを試せる地形にしている。
 */
export function generateTerrain(field: Heightfield, options: TerrainOptions = DEFAULT_TERRAIN): void {
  const rand = mulberry32(options.seed);
  const noise = createNoise2D(rand);
  const flatNoise = createNoise2D(mulberry32(options.seed ^ 0x9e3779b9));

  const n = field.stride;
  const half = MAP_SIZE / 2;

  for (let iz = 0; iz < n; iz++) {
    const z = field.worldZ(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = field.worldX(ix);

      // fBm。周波数を倍にしながら振幅を減らしていく。道路の規格勾配で
      // 追える程度の起伏にしたいので、高周波成分は控えめにする。
      let h = 0;
      let amp = 1;
      let freq = 1 / 700;
      let norm = 0;
      for (let o = 0; o < 5; o++) {
        h += noise(x * freq, z * freq) * amp;
        norm += amp;
        amp *= 0.42;
        freq *= 2.05;
      }
      h /= norm;

      // 平坦度マスク: 値が小さいところは起伏を抑えて平地にする。
      const flat = flatNoise(x / 900, z / 900);
      const flatness = clamp(0.35 + 0.65 * smoothstep(flat * 0.5 + 0.5), 0.2, 1);

      let height = h * options.amplitude * flatness + options.amplitude * 0.35;

      if (options.valley) {
        // 緩く蛇行する谷。橋とトンネルの両方を試せるように深めに削る。
        const meander = Math.sin(z / 220) * 90 + Math.sin(z / 90) * 30;
        const d = Math.abs(x - meander);
        const carve = 1 - smoothstep(clamp(d / 130, 0, 1));
        height -= carve * 34;
      }

      // マップ外周は緩やかに海面へ落として、端が壁に見えないようにする。
      const edge = Math.max(Math.abs(x), Math.abs(z)) / half;
      const fade = 1 - smoothstep(clamp((edge - 0.86) / 0.14, 0, 1));
      height = height * fade - (1 - fade) * 6;

      field.base[field.index(ix, iz)] = height;
    }
  }
  field.resetWork();
}
