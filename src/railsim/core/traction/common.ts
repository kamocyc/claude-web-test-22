import { travelSign } from '../physics/adhesion.ts';
import { clamp } from '../math/scalar.ts';
import type { Hertz, Meters, MetersPerSecond, Newtons, RadiansPerSecond, Watts } from '../units.ts';
import type { TrainDynamics } from '../train/dynamics.ts';
import type {
  ConsistSpec,
  VehicleTractionSpec,
  TractionSpecBase,
  VehicleSpec,
} from '../vehicle/spec.ts';
import { vehicleMass } from '../vehicle/spec.ts';
import type { TractionState } from './types.ts';

/**
 * 制御方式によらず共通の計算。
 *
 * 「電動機のトルクをどう作るか」は方式ごとに違うが、**作ったあとの扱いは同じ**である。
 * 車輪周への換算・応荷重補正・各動軸への配分・空転検知と再粘着制御は、VVVF でも
 * 抵抗制御でも一字一句同じことをしている。ここに集めて 1 か所だけ持つ。
 */

/**
 * 歯車のかみ合い周波数 [Hz] を車速から求める。
 *
 *   かみ合い周波数 = 電動機の回転数/60 × 小歯車の歯数
 *                  = (v / (D/2)) × 歯車比 / 2π × 歯数
 *
 * 走っている列車の状態（`DriveState`）から取れるならそちらを使うべきだが、
 * **位置しか分からない列車**（ダイヤ上の対向列車）についてはこれで見積もる。
 * 歯車の音は力行しているかどうかに依らず鳴るので、速度だけで決まるこの式で足りる。
 */
export function gearMeshFrequencyAt(
  spec: VehicleTractionSpec,
  wheelDiameter: Meters,
  speed: MetersPerSecond,
): Hertz {
  const teeth = pinionTeethOf(spec);
  if (teeth <= 0 || wheelDiameter <= 0) return 0;
  const motorOmega = (Math.abs(speed) / (wheelDiameter / 2)) * spec.gearRatio;
  return (motorOmega / (2 * Math.PI)) * teeth;
}

/** 小歯車の歯数。方式で電動機の持ち方が違うだけで、歯車は同じように付いている。 */
function pinionTeethOf(spec: VehicleTractionSpec): number {
  switch (spec.kind) {
    case 'vvvf':
      return spec.inverter.pinionTeeth;
    case 'resistor':
    case 'chopper':
      return spec.motor.pinionTeeth;
    default:
      return 0;
  }
}

/** 電動機トルクから車輪周の引張力 [N] へ換算する（1 両分） */
export function rimForceFromMotorTorque(
  spec: TractionSpecBase,
  vehicle: VehicleSpec,
  motorTorque: number,
): Newtons {
  const r = vehicle.wheelDiameter / 2;
  return (motorTorque * spec.motorCount * spec.gearRatio * spec.driveEfficiency) / r;
}

/** 1 両分の電動機トルク合計から、動軸 1 本あたりの軸トルク [N*m] を求める */
export function axleTorqueFromMotorTorque(
  spec: TractionSpecBase,
  vehicle: VehicleSpec,
  motorTorque: number,
): number {
  if (vehicle.drivenAxleCount === 0) return 0;
  return (
    (motorTorque * spec.motorCount * spec.gearRatio * spec.driveEfficiency) /
    vehicle.drivenAxleCount
  );
}

/** 電気ブレーキトルクの符号を滑らかにする角速度スケール [rad/s] */
export const ELECTRIC_BRAKE_SIGN_SCALE = 1.0;

/**
 * 電気ブレーキトルクの向き（-1..1）。
 *
 * 電気ブレーキは電動機の回転を妨げる向きにしか働かず、回転が止まれば消える。
 * 向きを車速ではなく**車輪の実回転**から決めるのが要点で、車速で決めてしまうと、
 * 滑走して回転が落ちた軸へ逆向きのトルクを与え続け、車輪を逆回転させてしまう。
 * （そうなると軸は滑走摩擦のぶんだけ列車を引きずり、ノッチを緩めても減速度が
 * 落ちないという実車ではありえない挙動になる。）
 */
export function electricBrakeSign(omega: RadiansPerSecond): number {
  return Math.tanh(omega / ELECTRIC_BRAKE_SIGN_SCALE);
}

/** 回生の絞り込み速度を持つ仕様（VVVF・電機子チョッパに共通） */
export interface RegenerativeFadeSpec {
  readonly regenFadeStartSpeed: MetersPerSecond;
  readonly regenFadeEndSpeed: MetersPerSecond;
}

/**
 * 回生ブレーキの絞り込み率（0..1）。
 * 低速域では架線電圧まで昇圧できず回生能力が落ちるため、指定速度で 1 → 0 へ絞られる。
 * 絞り込みが進むあいだ、空気ブレーキが不足分を補う必要がある（電空協調）。
 *
 * 発電ブレーキ（抵抗器へ捨てる方式）にはこの絞り込みは使わない。あちらは自励の
 * 閾値そのものが低速での落ち込みを作るので、曲線を外から与える必要がない。
 */
export function regenerationFade(spec: RegenerativeFadeSpec, v: MetersPerSecond): number {
  const av = Math.abs(v);
  const hi = spec.regenFadeStartSpeed;
  const lo = spec.regenFadeEndSpeed;
  if (av >= hi) return 1;
  if (av <= lo) return 0;
  return (av - lo) / (hi - lo);
}

/** 動軸の平均角速度 [rad/s]。動軸が無ければ 0。 */
export function meanDrivenAxleOmega(dyn: TrainDynamics): RadiansPerSecond {
  let sum = 0;
  let count = 0;
  for (const veh of dyn.vehicles) {
    for (const ax of veh.axles) {
      if (!ax.driven) continue;
      sum += ax.omega;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** すべての動軸の駆動トルクを 0 にする */
export function clearDriveTorques(dyn: TrainDynamics): void {
  for (const veh of dyn.vehicles) {
    for (const ax of veh.axles) ax.driveTorque = 0;
  }
}

/**
 * 応荷重制御の補正率。
 * 実際の編成質量が基準乗車率のときの質量より重ければ、同じ加速度を得るために
 * 引張力を増やす。頭打ちを設けて過大な出力を防ぐ。
 */
export function loadCompensationRatio(consist: ConsistSpec, loadFactor: number): number {
  const ctrl = consist.traction;
  if (!ctrl.loadCompensation) return 1;
  const actual = consist.vehicles.reduce((a, v) => a + vehicleMass(v, loadFactor), 0);
  const reference = consist.vehicles.reduce(
    (a, v) => a + vehicleMass(v, ctrl.referenceLoadFactor),
    0,
  );
  return clamp(actual / reference, 0.7, 1.3);
}

/** 等価質量（回転部慣性を含む）[kg] */
export function equivalentMass(consist: ConsistSpec, loadFactor: number): number {
  return consist.vehicles.reduce(
    (a, v) => a + vehicleMass(v, loadFactor) + v.rotatingMassFactor * v.tareMass,
    0,
  );
}

/**
 * 車輪周の機械的出力から架線側の電力 [W] を求める。
 * 力行時は効率で割り、回生時は効率を掛ける（どちらも損失は架線から見て損になる）。
 */
export function lineElectricPower(mechanicalPower: Watts, converterEfficiency: number): Watts {
  if (converterEfficiency <= 0) return mechanicalPower;
  return mechanicalPower >= 0
    ? mechanicalPower / converterEfficiency
    : mechanicalPower * converterEfficiency;
}

/** 停止状態の `TractionState` を作る */
export function createTractionState(): TractionState {
  return {
    notch: 0,
    torqueCommand: 0,
    tractiveEffort: 0,
    motorCurrent: 0,
    power: 0,
    electricBraking: false,
    reAdhesionFactor: 1,
    slipDetected: false,
  };
}

/** 再粘着制御の調整値 */
export interface ReAdhesionOptions {
  /** 空転検知のしきい値（ピークすべり率に対する倍率） */
  readonly slipThreshold?: number;
  /** 空転検知時に絞り込む時定数 [s]（0 まで絞るのに要する時間） */
  readonly cutTime?: number;
  /** 絞り込みから復帰する時定数 [s] */
  readonly recoverTime?: number;
  /** 再粘着制御の絞り込み下限 */
  readonly minReAdhesionFactor?: number;
}

/**
 * 空転検知と再粘着制御。
 *
 * 動軸のすべり率がピーク粘着を与えるすべり率を大きく超えたら空転と見なし、
 * 引張力の指令を時定数 `cutTime` で絞る。収まれば `recoverTime` で戻す。
 * 実機の再粘着制御も、空転を「消す」のではなく粘着の山の手前へ引き戻している。
 */
export class ReAdhesionController {
  /** 引張力の絞り込み率 0..1 */
  factor = 1;
  /** 空転を検知しているか */
  slipDetected = false;

  private readonly opts: Required<ReAdhesionOptions>;

  constructor(
    private readonly consist: ConsistSpec,
    options: ReAdhesionOptions = {},
  ) {
    this.opts = {
      slipThreshold: options.slipThreshold ?? 2.0,
      cutTime: options.cutTime ?? 0.35,
      recoverTime: options.recoverTime ?? 2.5,
      minReAdhesionFactor: options.minReAdhesionFactor ?? 0.15,
    };
  }

  update(dt: number, dyn: TrainDynamics): number {
    const threshold = this.consist.adhesion.peakCreep * this.opts.slipThreshold;
    // 後退中はすべり率の符号が裏返るので、進行方向の符号を掛けて見る
    const sign = travelSign(dyn.speed);
    let slipping = false;
    for (const veh of dyn.vehicles) {
      for (const ax of veh.axles) {
        if (ax.driven && ax.slip * sign > threshold) slipping = true;
      }
    }
    this.slipDetected = slipping;
    this.factor = slipping
      ? Math.max(this.opts.minReAdhesionFactor, this.factor - dt / this.opts.cutTime)
      : Math.min(1, this.factor + dt / this.opts.recoverTime);
    return this.factor;
  }

  reset(): void {
    this.factor = 1;
    this.slipDetected = false;
  }
}

/** 表示用: 現在の粘着余裕（引張力 / 粘着限界） */
export function adhesionUtilisation(dyn: TrainDynamics): number {
  let force = 0;
  let limit = 0;
  for (const veh of dyn.vehicles) {
    for (const ax of veh.axles) {
      if (!ax.driven) continue;
      force += Math.abs(ax.creepForce);
      limit += ax.adhesionLimit;
    }
  }
  return limit > 0 ? force / limit : 0;
}
