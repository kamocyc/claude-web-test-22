/**
 * 単位系。
 *
 * 規約: **コア内部の値はすべて SI 単位**（m, s, kg, N, Pa, rad, W, J）で保持する。
 * km/h・‰・kgf/cm² などの鉄道慣用単位は、データ読み込み時と表示時にのみ換算する。
 * 型名エイリアスは「その数値がどの単位で解釈されるか」を読み手に伝えるための文書であり、
 * 算術演算を妨げないよう意図的にブランド型にはしていない。
 */

/** [m] 距離・距離程 */
export type Meters = number;
/** [m/s] 速度 */
export type MetersPerSecond = number;
/** [m/s^2] 加速度 */
export type MetersPerSecondSquared = number;
/** [s] 時間 */
export type Seconds = number;
/** [kg] 質量 */
export type Kilograms = number;
/** [N] 力 */
export type Newtons = number;
/** [N*m] トルク */
export type NewtonMeters = number;
/** [Pa] 圧力 */
export type Pascals = number;
/** [rad] 角度 */
export type Radians = number;
/** [rad/s] 角速度 */
export type RadiansPerSecond = number;
/** [Hz] 周波数 */
export type Hertz = number;
/** [1/m] 曲率（正 = 左曲がり） */
export type PerMeter = number;
/** [m/m] 勾配（正 = 上り） */
export type Slope = number;
/** [W] 電力 */
export type Watts = number;
/** [J] エネルギー */
export type Joules = number;
/** [A] 電流 */
export type Amperes = number;
/** [V] 電圧 */
export type Volts = number;
/** [Ω] 抵抗 */
export type Ohms = number;
/** [H] インダクタンス */
export type Henries = number;

/** 標準重力加速度 [m/s^2] */
export const GRAVITY = 9.80665;

/** [km/h] -> [m/s] */
export const kmhToMps = (v: number): MetersPerSecond => v / 3.6;
/** [m/s] -> [km/h] */
export const mpsToKmh = (v: MetersPerSecond): number => v * 3.6;

/** [km/h/s] -> [m/s^2]（起動加速度・減速度の公称値でよく使われる単位） */
export const kmhsToMps2 = (a: number): MetersPerSecondSquared => a / 3.6;
/** [m/s^2] -> [km/h/s] */
export const mps2ToKmhs = (a: MetersPerSecondSquared): number => a * 3.6;

/** ‰（パーミル、千分率）-> 勾配 [m/m] */
export const permilToSlope = (i: number): Slope => i / 1000;
/** 勾配 [m/m] -> ‰ */
export const slopeToPermil = (i: Slope): number => i * 1000;

/**
 * 勾配 [m/m] から重力の軌道方向成分の係数 sin(θ) を求める。
 * 鉄道では勾配が小さいため tan≒sin と近似されることが多いが、
 * ここでは厳密に sin(atan(i)) = i / sqrt(1 + i^2) を用いる。
 */
export const slopeToSin = (i: Slope): number => i / Math.sqrt(1 + i * i);

/** [t] -> [kg] */
export const tonsToKg = (t: number): Kilograms => t * 1000;
/** [kg] -> [t] */
export const kgToTons = (m: Kilograms): number => m / 1000;

/** [kPa] -> [Pa] */
export const kpaToPa = (p: number): Pascals => p * 1000;
/** [Pa] -> [kPa] */
export const paToKpa = (p: Pascals): number => p / 1000;

/** [kgf/cm^2] -> [Pa]（在来車のブレーキシリンダ圧計はこの単位が多い） */
export const kgfPerCm2ToPa = (p: number): Pascals => p * 98066.5;
/** [Pa] -> [kgf/cm^2] */
export const paToKgfPerCm2 = (p: Pascals): number => p / 98066.5;

/** [mm] -> [m] */
export const mmToM = (x: number): Meters => x / 1000;
/** [m] -> [mm] */
export const mToMm = (x: Meters): number => x * 1000;

/** [mH] -> [H] */
export const mhToH = (x: number): Henries => x / 1000;

/** [H] -> [mH] */
export const hToMh = (x: Henries): number => x * 1000;

/** [km] -> [m] */
export const kmToM = (x: number): Meters => x * 1000;

/** [rad/s] -> [rpm] */
export const radPerSecToRpm = (w: RadiansPerSecond): number => (w * 60) / (2 * Math.PI);
/** [rpm] -> [rad/s] */
export const rpmToRadPerSec = (n: number): RadiansPerSecond => (n * 2 * Math.PI) / 60;

/**
 * [kgf/t] -> [N/kg]（比抵抗）。
 * 日本の走行抵抗式・曲線抵抗式は伝統的に kgf/t（= 1/1000 重量比）で与えられる。
 * 1 kgf/t = 9.80665 N / 1000 kg = 9.80665e-3 N/kg
 */
export const kgfPerTonToNPerKg = (r: number): number => (r * GRAVITY) / 1000;
/** [N/kg] -> [kgf/t] */
export const nPerKgToKgfPerTon = (r: number): number => (r * 1000) / GRAVITY;

/**
 * 走行抵抗係数の単位換算。
 *
 * 日本形の走行抵抗式は `R [kgf/t] = a + b*V + c*V^2`（V は km/h）の形で与えられる。
 * コア内部は `r [N/kg] = a' + b'*v + c'*v^2`（v は m/s）で扱うため、係数を変換する。
 */
export function davisFromKgfPerTon(coef: { a: number; b: number; c: number }): {
  a: number;
  b: number;
  c: number;
} {
  return {
    a: kgfPerTonToNPerKg(coef.a),
    b: kgfPerTonToNPerKg(coef.b) * 3.6,
    c: kgfPerTonToNPerKg(coef.c) * 3.6 * 3.6,
  };
}

/** 秒 -> "H:MM:SS" 表記（ダイヤ表示用） */
export function formatClock(seconds: Seconds): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** "H:MM:SS" / "MM:SS" -> 秒 */
export function parseClock(text: string): Seconds {
  const parts = text.split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) {
    throw new Error(`時刻の形式が不正です: ${text}`);
  }
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  throw new Error(`時刻の形式が不正です: ${text}`);
}
