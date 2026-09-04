/**
 * 最小限の 3 次元ベクトル。
 * コアは three.js に依存しないため、独自の平易な値オブジェクトを使う。
 * 座標系は three.js と同じ右手系 y-up（x-z 平面が地表面）。
 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const ZERO3: Vec3 = vec3(0, 0, 0);

export const add3 = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub3 = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale3 = (a: Vec3, k: number): Vec3 => vec3(a.x * k, a.y * k, a.z * k);
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const length3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export const cross3 = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export function normalize3(a: Vec3): Vec3 {
  const l = length3(a);
  return l === 0 ? ZERO3 : scale3(a, 1 / l);
}

export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
