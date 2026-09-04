import type { AdhesionSpec, RailCondition } from '../vehicle/spec.ts';
import type { MetersPerSecond } from '../units.ts';
import { mpsToKmh } from '../units.ts';

/** レール踏面状態ごとの粘着係数の倍率（代表値。データ側で上書きできる） */
export const RAIL_CONDITION_FACTOR: Readonly<Record<RailCondition, number>> = {
  dry: 1.0,
  wet: 0.65,
  leaves: 0.35,
  snow: 0.45,
};

export interface AdhesionConditions {
  /** レール踏面状態 */
  readonly rail: RailCondition;
  /** 砂撒き中か */
  readonly sanding: boolean;
  /** 追加の粘着係数倍率（区間ごとのレール状態のゆらぎなど） */
  readonly factor?: number;
}

/**
 * ピーク粘着係数 μ_max。
 *
 *   μ_max(V) = mu0 / (1 + k V) * 状態倍率
 *
 * 速度が上がるほど粘着係数が下がる、鉄道で広く用いられる形。
 */
/**
 * 進行方向の符号。
 *
 * すべり率は「車輪の周速 − 車体速度」なので、後退中は空転と滑走の符号が
 * そっくり裏返る。判定の前にこの符号を掛けて向きをそろえる。ほとんど止まって
 * いるときは前進として扱う（起動直後にどちらとも決められないため）。
 */
export function travelSign(v: MetersPerSecond): 1 | -1 {
  return v < -0.05 ? -1 : 1;
}

export function peakAdhesion(
  spec: AdhesionSpec,
  v: MetersPerSecond,
  cond: AdhesionConditions,
): number {
  const V = Math.abs(mpsToKmh(v));
  const base = spec.mu0 / (1 + spec.speedCoefficient * V);
  const weather = RAIL_CONDITION_FACTOR[cond.rail];
  const sand = cond.sanding ? spec.sandingFactor : 1;
  return base * weather * sand * (cond.factor ?? 1);
}

/**
 * クリープ曲線 μ(ξ)。すべり率 ξ に対する粘着係数（符号付き）。
 *
 * Polach 型のクリープ力特性を、扱いやすい解析関数で近似したもの:
 *
 *   x = ξ / ξ_peak
 *   μ(x) = μ_k tanh(2x) + (μ_p - μ_k) * 2x / (1 + x^2)
 *
 * - 微小すべりでは傾き 2 μ_p / ξ_peak でほぼ線形に立ち上がる（粘着域）
 * - x = 1 付近でほぼ μ_p のピークを取る
 * - 大すべりでは滑走摩擦係数 μ_k（= kineticRatio * μ_p）に漸近する
 *
 * この「ピークを越えると力が落ちる」形状があるために、空転・滑走が
 * 単なる力の頭打ちではなく不安定現象として自然に発生する。
 */
export function creepAdhesion(xi: number, peak: number, kineticRatio: number): number {
  const kin = peak * kineticRatio;
  const x = xi;
  return kin * Math.tanh(2 * x) + (peak - kin) * ((2 * x) / (1 + x * x));
}

/** クリープ曲線の微分 dμ/dx（x = ξ / ξ_peak に関する微分） */
export function creepAdhesionDerivative(xi: number, peak: number, kineticRatio: number): number {
  const kin = peak * kineticRatio;
  const x = xi;
  const sech2 = 1 / Math.cosh(2 * x) ** 2;
  const d1 = kin * 2 * sech2;
  const denom = (1 + x * x) * (1 + x * x);
  const d2 = (peak - kin) * ((2 * (1 + x * x) - 2 * x * (2 * x)) / denom);
  return d1 + d2;
}

/**
 * すべり率（クリープ率）。
 *
 *   ξ = (r ω - v) / max(|v|, v_ref)
 *
 * 正なら車輪が線路に対して先行している（空転側）、負なら遅れている（滑走側）。
 * 停止付近で分母が 0 になるのを避けるため、基準速度で下限を設ける。
 */
export function slipRatio(
  wheelSpeed: MetersPerSecond,
  vehicleSpeed: MetersPerSecond,
  referenceSpeed: MetersPerSecond,
): number {
  const denom = Math.max(Math.abs(vehicleSpeed), referenceSpeed);
  return (wheelSpeed - vehicleSpeed) / denom;
}
