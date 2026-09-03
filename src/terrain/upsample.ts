/**
 * 水文格子 (40 m) から、編集用の高さ場 (8 m) へ。
 *
 * 双一次補間だけだとセルごとに平面が切り替わり、40 m の格子に沿って
 * マップ全体に折れ目が入る。ここでは移植元と同じく **Catmull-Rom** を使う。
 * 与えた点をそのまま通り、接線が連続する。ただし補間は行き過ぎるので、
 * 近傍 2x2 の最小・最大で挟んで、無い山や無い窪みを作らせない。
 *
 * 川はこの段で初めて刻む。40 m のセルは 20 m の河道を持てないので、
 * 水文格子ではなく**曲線から**、細かい格子に断面を切る。
 */
import { clamp } from '../core/units';
import type { HydroGrid } from './hydro/grid';
import type { Heightfield } from './heightfield';
import { channelHeight } from './river/carve';
import type { RiverField } from './river/field';
import type { RiverNetwork } from './river/network';

/**
 * Catmull-Rom の重み。
 *
 * 格子点ごとに多項式を解くと 650 万点 × 5 回になる。粗いセルの中の位置は
 * 分割数ぶんしか種類が無いので、重みを先に作っておいて掛け合わせるだけにする。
 */
function catmullWeights(t: number, out: Float32Array, at: number): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[at] = 0.5 * (-t + 2 * t2 - t3);
  out[at + 1] = 0.5 * (2 - 5 * t2 + 3 * t3);
  out[at + 2] = 0.5 * (t + 4 * t2 - 3 * t3);
  out[at + 3] = 0.5 * (-t2 + t3);
}

export interface UpsampleInput {
  grid: HydroGrid;
  /** 水文格子の地面の高さ [m]。 */
  groundY: Float32Array;
  /** 1 = 海。 */
  sea: Uint8Array;
}

/**
 * `field.base` を水文格子から作り直す。`resetWork` はここでは呼ばない
 * (川を刻んだあとに呼ぶため)。
 */
export function upsampleTerrain(field: Heightfield, input: UpsampleInput): void {
  const { grid, groundY, sea } = input;
  const n = grid.n;
  const stride = field.stride;
  const base = field.base;

  // 外周を 1 マス複製した写しを作る。こうすると 4x4 の窓を取るのに
  // 内側のループで毎回クランプせずに済む (格子点ごとに 16 回効く)。
  const pn = n + 2;
  const padded = new Float32Array(pn * pn);
  for (let y = 0; y < pn; y++) {
    const sy = Math.min(n - 1, Math.max(0, y - 1));
    for (let x = 0; x < pn; x++) {
      padded[y * pn + x] = groundY[sy * n + Math.min(n - 1, Math.max(0, x - 1))];
    }
  }

  // 「まわりに水があるセル」も先に 1 回だけ数える。
  const nearWater = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let wet = 0;
      for (let oy = -1; oy <= 2 && !wet; oy++) {
        const sy = Math.min(n - 1, Math.max(0, y + oy));
        for (let ox = -1; ox <= 2; ox++) {
          const i = sy * n + Math.min(n - 1, Math.max(0, x + ox));
          if (sea[i]) {
            wet = 1;
            break;
          }
        }
      }
      nearWater[y * n + x] = wet;
    }
  }

  // 格子点ごとの粗いセルと、その中の位置。X と Z で同じ並びなので 1 組でよい。
  const cellOf = new Int32Array(stride);
  const fracOf = new Float32Array(stride);
  const weightOf = new Float32Array(stride * 4);
  for (let i = 0; i < stride; i++) {
    const g = clamp(grid.cellAt(field.worldX(i)), 0, n - 1);
    const c = Math.min(n - 2, Math.floor(g));
    cellOf[i] = c;
    fracOf[i] = g - c;
    catmullWeights(g - c, weightOf, i * 4);
  }

  for (let iz = 0; iz < stride; iz++) {
    const cz = cellOf[iz];
    const tz = fracOf[iz];
    const row = iz * stride;
    // 4x4 の窓の 4 行。写しの添字なので +1 ずれる。
    const r0 = cz * pn;
    const r1 = (cz + 1) * pn;
    const r2 = (cz + 2) * pn;
    const r3 = (cz + 3) * pn;
    const waterRow = cz * n;
    const wz0 = weightOf[iz * 4];
    const wz1 = weightOf[iz * 4 + 1];
    const wz2 = weightOf[iz * 4 + 2];
    const wz3 = weightOf[iz * 4 + 3];
    for (let ix = 0; ix < stride; ix++) {
      const cx = cellOf[ix];
      const tx = fracOf[ix];
      const c1 = cx + 1;

      const h00 = padded[r1 + c1];
      const h10 = padded[r1 + c1 + 1];
      const h01 = padded[r2 + c1];
      const h11 = padded[r2 + c1 + 1];
      const top = h00 + (h10 - h00) * tx;
      const bilinear = top + (h01 + (h11 - h01) * tx - top) * tz;

      let height = bilinear;
      // 水際は直線のまま。水面は「地面が水面高さを跨ぐ所」を線形補間で
      // 探すので、ここだけ別の補間にすると汀線が水面板の下から動き、
      // 地面が水を突き抜ける。
      if (!nearWater[waterRow + cx]) {
        const wx0 = weightOf[ix * 4];
        const wx1 = weightOf[ix * 4 + 1];
        const wx2 = weightOf[ix * 4 + 2];
        const wx3 = weightOf[ix * 4 + 3];
        const a =
          wx0 * padded[r0 + cx] + wx1 * padded[r0 + c1] + wx2 * padded[r0 + c1 + 1] + wx3 * padded[r0 + c1 + 2];
        const b = wx0 * padded[r1 + cx] + wx1 * h00 + wx2 * h10 + wx3 * padded[r1 + c1 + 2];
        const c = wx0 * padded[r2 + cx] + wx1 * h01 + wx2 * h11 + wx3 * padded[r2 + c1 + 2];
        const d =
          wx0 * padded[r3 + cx] + wx1 * padded[r3 + c1] + wx2 * padded[r3 + c1 + 1] + wx3 * padded[r3 + c1 + 2];
        const smooth = wz0 * a + wz1 * b + wz2 * c + wz3 * d;
        // 補間の行き過ぎで無い山や無い窪みを作らないよう、2x2 の範囲で挟む。
        const lo = h00 < h10 ? h00 : h10;
        const lo2 = h01 < h11 ? h01 : h11;
        const hi = h00 > h10 ? h00 : h10;
        const hi2 = h01 > h11 ? h01 : h11;
        height = Math.min(hi > hi2 ? hi : hi2, Math.max(lo < lo2 ? lo : lo2, smooth));
      }
      base[ix + row] = height;
    }
  }
}

/**
 * 河道の断面を高さ場へ刻む。
 *
 * 全格子点を空間ハッシュに問い合わせると 650 万回になるので、**川の区間の
 * 境界矩形に掛かる格子点だけ**を集めて 1 回ずつ問い合わせる。1 回ずつなのは
 * 速さのためだけではない: `channelHeight` の岸は `smoothMin` で、同じ点に
 * 2 回掛けると岸が余計に深くなる。
 */
export function carveRivers(field: Heightfield, network: RiverNetwork, riverField: RiverField): void {
  const stride = field.stride;
  const cells = field.cells;
  const marked = new Uint8Array(stride * stride);
  let ix0 = stride;
  let ix1 = -1;
  let iz0 = stride;
  let iz1 = -1;

  for (const stem of network.stems) {
    for (let k = 1; k < stem.points.length; k++) {
      const a = stem.points[k - 1];
      const b = stem.points[k];
      const width = Math.max(a.widthM, b.widthM);
      // 河床の半幅 + 岸 + 格子 1 マス。`channelHeight` がこれより外を触らない。
      const pad = width * 0.5 + Math.max(6, width * 0.6) + field.cell;
      const gx0 = Math.max(0, Math.floor(field.toGridX(Math.min(a.x, b.x) - pad)));
      const gx1 = Math.min(cells, Math.ceil(field.toGridX(Math.max(a.x, b.x) + pad)));
      const gz0 = Math.max(0, Math.floor(field.toGridZ(Math.min(a.z, b.z) - pad)));
      const gz1 = Math.min(cells, Math.ceil(field.toGridZ(Math.max(a.z, b.z) + pad)));
      for (let iz = gz0; iz <= gz1; iz++) {
        const row = iz * stride;
        for (let gx = gx0; gx <= gx1; gx++) marked[gx + row] = 1;
      }
      if (gx0 < ix0) ix0 = gx0;
      if (gx1 > ix1) ix1 = gx1;
      if (gz0 < iz0) iz0 = gz0;
      if (gz1 > iz1) iz1 = gz1;
    }
  }
  if (ix1 < ix0) return;

  const base = field.base;
  for (let iz = iz0; iz <= iz1; iz++) {
    const row = iz * stride;
    const wz = field.worldZ(iz);
    for (let ix = ix0; ix <= ix1; ix++) {
      const i = ix + row;
      if (!marked[i]) continue;
      const sample = riverField.sample(field.worldX(ix), wz);
      if (sample) base[i] = channelHeight(sample, base[i]);
    }
  }
}
