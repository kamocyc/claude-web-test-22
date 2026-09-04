import type { Meters, MetersPerSecond, Seconds } from '../units.ts';

/** 照査パターンの 1 本 */
export interface BrakePattern {
  /** 生成元の識別子（信号機 ID・制限 ID など） */
  readonly id: string;
  readonly kind: 'signal' | 'limit' | 'terminus';
  /** 目標地点の距離程 [m] */
  readonly targetPosition: Meters;
  /** 目標地点での許容速度 [m/s]（停止パターンなら 0） */
  readonly targetSpeed: MetersPerSecond;
}

export interface PatternParameters {
  /** パターンの設計減速度 [m/s^2] */
  readonly deceleration: number;
  /** 目標地点手前に取る余裕距離 [m] */
  readonly margin: Meters;
  /** ブレーキが立ち上がるまでの応答時間 [s]（空走時間） */
  readonly responseTime: Seconds;
}

/**
 * 目標地点まで距離 `distance` の地点で許容される速度 [m/s]。
 *
 * 応答時間 tr のあいだは減速しないものとすると、許容速度 v は
 *
 *   v^2 = v_t^2 + 2 a (d - margin - v tr)
 *
 * を満たす。これを v について解くと
 *
 *   v = -a tr + sqrt((a tr)^2 + v_t^2 + 2 a (d - margin))
 *
 * となる。応答時間を距離に換算して差し引く近似ではなく、この 2 次方程式の
 * 厳密解を用いることで、高速域でもパターンが過大／過小にならない。
 */
export function patternSpeedAt(
  distance: Meters,
  targetSpeed: MetersPerSecond,
  params: PatternParameters,
): MetersPerSecond {
  const a = params.deceleration;
  const tr = params.responseTime;
  const d = distance - params.margin;
  if (d <= 0) return targetSpeed;
  const disc = a * a * tr * tr + targetSpeed * targetSpeed + 2 * a * d;
  return Math.max(targetSpeed, -a * tr + Math.sqrt(Math.max(0, disc)));
}

/** 複数のパターンのうち最も厳しい許容速度を返す */
export function evaluatePatterns(
  patterns: Iterable<BrakePattern>,
  position: Meters,
  params: PatternParameters,
  ceiling: MetersPerSecond,
): { speed: MetersPerSecond; active: BrakePattern | null } {
  let best = ceiling;
  let active: BrakePattern | null = null;
  for (const p of patterns) {
    const distance = p.targetPosition - position;
    if (distance < -1) continue; // 目標地点を通過済み
    const v = patternSpeedAt(Math.max(0, distance), p.targetSpeed, params);
    if (v < best) {
      best = v;
      active = p;
    }
  }
  return { speed: best, active };
}
