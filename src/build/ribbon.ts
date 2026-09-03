import { Vector3 } from 'three';
import { TERRAIN_CELL } from '../core/units';
import type { MeshBuilder } from '../core/meshbuilder';
import type { RGB } from './surface';

/**
 * 地形に貼り付いた帯。
 *
 * 道路・線路の帯 (`src/build/surface.ts`) は**線形の高さ**で作るので、
 * ネットワークに属さない町の街路には使えない。ここは折れ線と幅と高さ関数だけを
 * 受け取り、地面に沿って敷く。
 *
 * 地形の格子 (4 m) 刻みで細分するのが肝で、90 m の街区を 1 枚の板で張ると
 * 途中で地面に潜る。区画のマス目 (`buildZoneGrid`) が同じ手を使っている。
 */

/** 地面から浮かせる量 [m]。Z ファイティング避け。 */
const LIFT = 0.06;

export interface RibbonOptions {
  lift?: number;
  /** 細分の間隔 [m]。既定は地形の格子。 */
  step?: number;
}

export function drapedRibbon(
  mb: MeshBuilder,
  points: readonly Vector3[],
  halfWidth: number,
  ground: (x: number, z: number) => number,
  color: RGB,
  options: RibbonOptions = {},
): void {
  if (points.length < 2) return;
  const lift = options.lift ?? LIFT;
  const step = options.step ?? TERRAIN_CELL;

  const left: number[] = [];
  const right: number[] = [];
  const at = new Vector3();
  const normal = new Vector3();

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    if (span < 1e-6) continue;
    const count = Math.max(1, Math.ceil(span / step));
    // 継ぎ目では前後の接線を平均して、外側が開かないようにする。
    const before = points[Math.max(0, i - 1)];
    const after = points[Math.min(points.length - 1, i + 2)];
    const start = tangent(before, a, b);
    const end = tangent(a, b, after);
    const last = i + 2 === points.length;
    for (let k = 0; k <= count; k++) {
      if (k === 0 && i > 0) continue;
      const t = k / count;
      at.set(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t);
      const tx = start.x + (end.x - start.x) * t;
      const tz = start.z + (end.z - start.z) * t;
      const length = Math.hypot(tx, tz) || 1;
      const nx = -tz / length;
      const nz = tx / length;
      const lx = at.x + nx * halfWidth;
      const lz = at.z + nz * halfWidth;
      const rx = at.x - nx * halfWidth;
      const rz = at.z - nz * halfWidth;
      left.push(mb.vertex(new Vector3(lx, ground(lx, lz) + lift, lz), groundNormal(ground, lx, lz, normal), 0, 0, color));
      right.push(mb.vertex(new Vector3(rx, ground(rx, rz) + lift, rz), groundNormal(ground, rx, rz, normal), 1, 0, color));
      if (k === count && !last) break;
    }
  }
  if (left.length >= 2) mb.strip(left, right);
}

const _tangent = new Vector3();

function tangent(before: Vector3, a: Vector3, b: Vector3): Vector3 {
  const ax = b.x - a.x;
  const az = b.z - a.z;
  const bx = a.x - before.x;
  const bz = a.z - before.z;
  const la = Math.hypot(ax, az) || 1;
  const lb = Math.hypot(bx, bz) || 1;
  return _tangent.set(ax / la + bx / lb, 0, az / la + bz / lb).clone();
}

/** 地面の傾きから法線を作る。 */
function groundNormal(
  ground: (x: number, z: number) => number,
  x: number,
  z: number,
  out: Vector3,
): Vector3 {
  const d = TERRAIN_CELL;
  const gx = ground(x + d, z) - ground(x - d, z);
  const gz = ground(x, z + d) - ground(x, z - d);
  return out.set(-gx, 2 * d, -gz).normalize().clone();
}
