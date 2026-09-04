import { firstOrderLag } from '../math/scalar.ts';
import type { Amperes, Henries, NewtonMeters, Ohms, RadiansPerSecond, Volts } from '../units.ts';
import type { DcSeriesMotorSpec } from '../vehicle/spec.ts';

/**
 * 直流直巻電動機の物理。純関数だけを置く。
 * 抵抗制御（`resistor.ts`）と電機子チョッパ（`chopper.ts`）が共有する。
 *
 * ここに引張力の「曲線」は無い。あるのは電機子回路の式だけで、加速度曲線は
 * その解として出てくる。VVVF (`vvvf.ts`) が 3 領域の折れ線を仕様として持つのと
 * ちょうど裏返しの関係にある。
 */

/**
 * 磁化曲線 `φ(I) = I / (I + I_飽和)`（0..1）。
 *
 * 直巻機では界磁磁束を電機子電流そのものが作るが、鉄心が飽和するので電流に比例では
 * 増えない。この 1 本の式で
 *
 *   小電流 `φ ≒ I / I_飽和` → `T ∝ I²`   （起動時の大きな引張力）
 *   大電流 `φ → 1`          → `T ∝ I`    （飽和して他励機と同じ）
 *
 * という直巻機の 2 つの顔が同時に出る。
 */
export function fluxRatio(spec: DcSeriesMotorSpec, current: Amperes): number {
  const i = Math.abs(current);
  return i / (i + spec.saturationCurrent);
}

/**
 * 逆起電力 `E = kΦ_max · φ(I) · β · ω_m` [V]。
 * β は界磁率（分路界磁・界磁短絡による弱め界磁）、ω_m は電動機の角速度。
 */
export function backEmf(
  spec: DcSeriesMotorSpec,
  current: Amperes,
  fieldRatio: number,
  motorOmega: RadiansPerSecond,
): Volts {
  return spec.fluxConstant * fluxRatio(spec, current) * fieldRatio * motorOmega;
}

/**
 * 電動機トルク `T = kΦ_max · φ(I) · β · I` [N*m]。
 *
 * `backEmf` と同じ係数を使っているので `E·I = T·ω_m` が厳密に成り立つ。
 * つまり電気的な入力と機械的な出力が数値誤差の範囲で一致する — 損失を別に
 * 引くのではなく、そもそも保存する形で書いてある。
 */
export function motorTorque(
  spec: DcSeriesMotorSpec,
  current: Amperes,
  fieldRatio: number,
): NewtonMeters {
  return spec.fluxConstant * fluxRatio(spec, current) * fieldRatio * current;
}

/**
 * 目標トルクを出すのに要る電機子電流 [A]（`motorTorque` の逆関数）。
 *
 * トルクは電流に**比例していない**（低電流では 2 乗に近い）ので、「制動力を半分に
 * したいから電流を半分にする」は誤りである。φ(I) = I/(I+I_飽和) を代入すると
 *
 * ```
 * kΦ_max · β · I² / (I + I_飽和) = T
 *   →  kΦ_max·β·I² − T·I − T·I_飽和 = 0
 *   →  I = [ T + √(T² + 4·kΦ_max·β·T·I_飽和) ] / (2·kΦ_max·β)
 * ```
 *
 * と 2 次方程式になり、正の根が求める電流である。
 */
export function currentForTorque(
  spec: DcSeriesMotorSpec,
  torque: NewtonMeters,
  fieldRatio: number,
): Amperes {
  const k = spec.fluxConstant * fieldRatio;
  if (k <= 0 || torque <= 0) return 0;
  const discriminant = torque * torque + 4 * k * torque * spec.saturationCurrent;
  return (torque + Math.sqrt(discriminant)) / (2 * k);
}

/** 電機子回路 1 分岐の 1 ステップに必要な量 */
export interface ArmatureCircuit {
  readonly spec: DcSeriesMotorSpec;
  /** 現在の電機子電流 [A] */
  readonly current: Amperes;
  /** 分岐へ印加されている電圧 [V]（電動機 m 台ぶんの合計） */
  readonly appliedVoltage: Volts;
  /** 1 分岐に直列に入っている電動機の数 */
  readonly motorsInSeries: number;
  /** 1 分岐に直列に入っている外部抵抗（起動抵抗・制動抵抗）[Ω] */
  readonly externalResistance: Ohms;
  /** 界磁率 */
  readonly fieldRatio: number;
  /** 電動機の角速度 [rad/s] */
  readonly motorOmega: RadiansPerSecond;
  readonly dt: number;
}

/**
 * 電機子電流を 1 ステップ進める [A]。
 *
 * ```
 * R_合計 = m·R_a + R_外部,     L_合計 = m·L_a
 * I_ss   = (V_印加 − m·E) / R_合計
 * τ      = L_合計 / R_合計
 * ```
 *
 * 定常解 `I_ss` は φ が I に依存するせいで本当は陰関数だが、インダクタンスを
 * 持たせて時間発展させれば解く必要がない。むしろこの遅れこそが、段が進んだ瞬間に
 * 電流が跳ね上がって落ちていくという実車の挙動そのものである。
 *
 * 積分には一次遅れの**厳密解**（`firstOrderLag`）を使う。起動抵抗が入っている段では
 * τ が数 ms まで小さくなるので、陽的オイラーだと制御周期 10ms で発散してしまう。
 *
 * 逆流は許さない（0 でクランプ）。主回路にはダイオードが入っており、直巻機は
 * 電流の向きが変わると界磁も反転してトルクの向きが変わらないので、
 * そもそも負の電流は流れない。
 */
export function stepArmatureCurrent(circuit: ArmatureCircuit): Amperes {
  const { spec, motorsInSeries: m, dt } = circuit;
  const totalResistance = m * spec.armatureResistance + circuit.externalResistance;
  if (totalResistance <= 0) return circuit.current;
  const totalInductance: Henries = m * spec.armatureInductance;
  const emf = backEmf(spec, circuit.current, circuit.fieldRatio, circuit.motorOmega);
  const steady = (circuit.appliedVoltage - m * emf) / totalResistance;
  const tau = totalInductance / totalResistance;
  return Math.max(0, firstOrderLag(circuit.current, Math.max(0, steady), tau, dt));
}

/**
 * 発電（自励）ブレーキの定常電流 [A]。
 *
 * 電機子を制動抵抗へつないだだけの回路では、電流が界磁を作り、界磁が逆起電力を作り、
 * その逆起電力が電流を流す。つり合いは
 *
 * ```
 * I · R_合計 = m · kΦ_max · φ(I) · β · ω_m        φ(I) = I / (I + I_飽和)
 * ```
 *
 * で、φ の形のおかげで I が約分でき、閉じた式が出る:
 *
 * ```
 * I = m · kΦ_max · β · ω_m / R_合計 − I_飽和
 * ```
 *
 * 右辺が正になる速度より下では**自励しない**。実車の発電ブレーキが低速で落ちて
 * 空気ブレーキへ渡していくのは、フェード曲線を引いているからではなく、
 * この閾値そのものである。
 */
export function selfExcitedCurrent(
  spec: DcSeriesMotorSpec,
  fieldRatio: number,
  motorOmega: RadiansPerSecond,
  motorsInSeries: number,
  externalResistance: Ohms,
): Amperes {
  const totalResistance = motorsInSeries * spec.armatureResistance + externalResistance;
  if (totalResistance <= 0) return 0;
  const gain =
    (motorsInSeries * spec.fluxConstant * fieldRatio * Math.abs(motorOmega)) / totalResistance;
  return Math.max(0, gain - spec.saturationCurrent);
}

/**
 * 自励が始まる電動機角速度 [rad/s]。
 * `selfExcitedCurrent` が 0 を超える下限であり、発電ブレーキが効き始める速度に対応する。
 */
export function selfExcitationThreshold(
  spec: DcSeriesMotorSpec,
  fieldRatio: number,
  motorsInSeries: number,
  externalResistance: Ohms,
): RadiansPerSecond {
  const totalResistance = motorsInSeries * spec.armatureResistance + externalResistance;
  const gain = motorsInSeries * spec.fluxConstant * fieldRatio;
  if (gain <= 0) return Infinity;
  return (spec.saturationCurrent * totalResistance) / gain;
}

/**
 * 目標電流 `target` を流すのに要る分岐への印加電圧 [V]。
 * チョッパの通流率指令を作るのに使う（`V = m·E + I·R_合計`）。
 */
export function voltageForCurrent(
  spec: DcSeriesMotorSpec,
  target: Amperes,
  fieldRatio: number,
  motorOmega: RadiansPerSecond,
  motorsInSeries: number,
  externalResistance: Ohms = 0,
): Volts {
  const totalResistance = motorsInSeries * spec.armatureResistance + externalResistance;
  const emf = backEmf(spec, target, fieldRatio, motorOmega);
  return motorsInSeries * emf + target * totalResistance;
}

/**
 * 目標電流を流すのに要る界磁率（弱め界磁の指令）。
 * 印加電圧が上限に貼り付いたあと、界磁を弱めて電流を保つために使う。
 */
export function fieldRatioForCurrent(
  spec: DcSeriesMotorSpec,
  target: Amperes,
  availableVoltage: Volts,
  motorOmega: RadiansPerSecond,
  motorsInSeries: number,
  externalResistance: Ohms = 0,
): number {
  const totalResistance = motorsInSeries * spec.armatureResistance + externalResistance;
  const denom = motorsInSeries * spec.fluxConstant * fluxRatio(spec, target) * motorOmega;
  if (denom <= 0) return 1;
  return (availableVoltage - target * totalResistance) / denom;
}

/**
 * 電機子電流のリップル [A]（p-p）。
 *
 * ```
 * ΔI_pp = V_線 · D · (1 − D) / (f_チョッパ · L_合計)
 * ```
 *
 * オン期間に `V_線 − 平均電圧` が、オフ期間に `−平均電圧` がインダクタンスへ掛かる
 * ことから出る三角波の振幅である。**通流率 0.5 で最大、全通流 (D→1) で 0** になる
 * のが要点で、チョッパ音が全通流で消えるのはこのためである。走りには影響しない。
 */
export function currentRipple(
  spec: DcSeriesMotorSpec,
  lineVoltage: Volts,
  duty: number,
  chopFrequency: number,
  motorsInSeries: number,
): Amperes {
  const totalInductance = motorsInSeries * spec.armatureInductance;
  if (chopFrequency <= 0 || totalInductance <= 0) return 0;
  return (lineVoltage * duty * (1 - duty)) / (chopFrequency * totalInductance);
}
