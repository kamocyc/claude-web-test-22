import type { DavisCoefficients } from '../vehicle/spec.ts';
import type { Meters, MetersPerSecond, Slope } from '../units.ts';
import { GRAVITY, slopeToSin } from '../units.ts';

/**
 * 走行抵抗の比抵抗 [N/kg]（常に正の大きさ）。
 *
 *   r = a + b|v| + c v^2
 *
 * a は転がり抵抗・軸受抵抗などの速度に依らない成分、b は機械抵抗の速度比例成分、
 * c は空気抵抗成分。日本形では先頭車と中間車で c が大きく異なるため、係数は車両ごとに持つ。
 * トンネル内では空気抵抗が増えるため、c 項に `tunnelFactor` を掛ける。
 */
export function specificRunningResistance(
  coef: DavisCoefficients,
  v: MetersPerSecond,
  tunnelFactor = 1,
): number {
  const av = Math.abs(v);
  return coef.a + coef.b * av + coef.c * tunnelFactor * av * av;
}

/**
 * 曲線抵抗の比抵抗 [N/kg]。
 *
 *   r_c = f / R
 *
 * f は軌間と台車の特性で決まる係数（慣用式では狭軌 600、標準軌 800 kgf/t·m 程度）。
 * 直線（R = Infinity）では 0。
 */
export function specificCurveResistance(coefficient: number, radius: Meters): number {
  if (!Number.isFinite(radius) || radius <= 0) return 0;
  return coefficient / radius;
}

/**
 * 勾配による軌道方向の加速度 [m/s^2]（正 = 進行方向を加速する向き）。
 * 上り勾配（i > 0）では負になる。
 */
export function gradeAcceleration(grade: Slope): number {
  return -GRAVITY * slopeToSin(grade);
}
