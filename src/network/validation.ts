import type { Alignment } from '../core/alignment';
import { clamp } from '../core/units';
import type { NetworkClass } from './classes';

export interface SegmentDiagnostics {
  length: number;
  /** 区間内の最小曲線半径 [m]。 */
  minRadius: number;
  /** 区間内の最大縦断勾配 (絶対値)。 */
  maxGrade: number;
  radiusOk: boolean;
  gradeOk: boolean;
  /** 0 = 余裕あり, 1 = 規格ちょうど, >1 = 規格超過。 */
  radiusRisk: number;
  gradeRisk: number;
  messages: string[];
}

export function evaluateAlignment(alignment: Alignment, cls: NetworkClass): SegmentDiagnostics {
  const { minRadius } = alignment.horizontal.extremeCurvature(48);
  const maxGrade = alignment.vertical.maxGrade(32);
  const radiusRisk = minRadius > 1e6 ? 0 : cls.minRadius / Math.max(minRadius, 1e-3);
  const gradeRisk = maxGrade / cls.maxGrade;
  const messages: string[] = [];
  if (radiusRisk > 1) {
    messages.push(
      `曲線半径 ${minRadius.toFixed(0)} m は ${cls.label} の最小半径 ${cls.minRadius} m を下回ります。`,
    );
  }
  if (gradeRisk > 1) {
    messages.push(
      `勾配 ${(maxGrade * 100).toFixed(1)}% は ${cls.label} の最大勾配 ${(cls.maxGrade * 100).toFixed(1)}% を超えています。`,
    );
  }
  return {
    length: alignment.length,
    minRadius,
    maxGrade,
    radiusOk: radiusRisk <= 1,
    gradeOk: gradeRisk <= 1,
    radiusRisk,
    gradeRisk,
    messages,
  };
}

/** 表示用に 0..1 に丸めた危険度。1 に近いほど規格ぎりぎり。 */
export function riskLevel(diag: SegmentDiagnostics): number {
  return clamp(Math.max(diag.radiusRisk, diag.gradeRisk), 0, 2) / 2;
}

/** 点ごとの危険度。診断表示の色分けに使う。 */
export function pointRisk(curvature: number, grade: number, cls: NetworkClass): {
  gradeRisk: number;
  curveRisk: number;
} {
  const radius = Math.abs(curvature) > 1e-6 ? 1 / Math.abs(curvature) : Infinity;
  return {
    gradeRisk: Math.abs(grade) / cls.maxGrade,
    curveRisk: radius > 1e6 ? 0 : cls.minRadius / radius,
  };
}
