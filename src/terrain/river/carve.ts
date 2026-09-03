/**
 * 河道の断面 — 河床、岸、そこから元の地面への馴染ませ。
 *
 * 移植元 `src/river/carve.ts` の移植。あちらは 1 ワールド単位 = 10 m だったが、
 * TrackBuilder は 1 単位 = 1 m なので換算は要らない。
 */
import type { RiverSample } from './field';

/**
 * 滑らかな最小値。素の `min` は 2 つの面が出会う所に折れ目を残し、
 * その折れ目こそが「貼り付けた川」に見える原因になる。
 */
export function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** 岸から地面へ馴染ませる幅 [m]。 */
const BLEND = 2;

/**
 * 中心線から `sample.distance` 離れた所の地面の高さ。谷の外では `base` のまま。
 */
export function channelHeight(sample: RiverSample, base: number): number {
  const half = sample.widthM * 0.5;
  const depth = sample.depthM;
  const bed = sample.waterY - depth;
  const freeboard = 0.6 + depth * 0.25;
  const shoulder = sample.waterY + freeboard;
  // 河道とその岸だけ。広い「谷」まで馴染ませると、川が通る斜面がことごとく
  // 川面の高さまで削られて溝になる。川のそばに崖があるのは正しい。
  const bank = Math.max(6, sample.widthM * 0.6);
  const d = sample.distance;

  if (d <= half) {
    // 平らな溝ではなく、浅い放物線の河床。
    const across = half > 1e-6 ? d / half : 0;
    return Math.min(base, bed + depth * 0.18 * across * across);
  }
  if (d <= half + bank) {
    const t = smoothstep((d - half) / bank);
    return smoothMin(base, bed + (shoulder - bed) * t, BLEND);
  }
  return base;
}

const smoothstep = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};
