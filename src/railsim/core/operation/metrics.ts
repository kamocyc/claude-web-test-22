import type { Joules, Meters, MetersPerSecondSquared, Seconds, Watts } from '../units.ts';

/** 乗り心地の指標 */
export interface RideMetrics {
  /** 最大加速度 [m/s^2] */
  maxAcceleration: MetersPerSecondSquared;
  /** 最大減速度 [m/s^2]（正値） */
  maxDeceleration: MetersPerSecondSquared;
  /** 最大加加速度（ジャーク）[m/s^3] */
  maxJerk: number;
  /** 最大の非平衡左右加速度 [m/s^2]（正値） */
  maxLateralAcceleration: MetersPerSecondSquared;
  /** 最大連結器力 [N] */
  maxCouplerForce: number;
  /**
   * 立っている乗客のよろけ具合の最大値（支持余裕に対する比）。
   * 1 を超えると足を出すしかない状態になったことを表す。
   */
  maxStagger: number;
  /**
   * 立っている乗客が足を出した回数。
   *
   * 加速度の**大きさ**ではなく**変え方**で決まる量で、同じ加減速でもノッチを
   * 刻めば 0 のままにできる。乗り心地の指標としては最大加速度より辛い。
   */
  passengerSteps: number;
}

/** 電力収支 */
export interface EnergyMetrics {
  /** 力行で消費した電力量 [J] */
  consumed: Joules;
  /** 回生で戻した電力量 [J] */
  regenerated: Joules;
  /** 走行抵抗で失われたエネルギー [J] */
  resistanceLoss: Joules;
  /** 機械ブレーキで熱になったエネルギー [J] */
  brakeLoss: Joules;
}

/** 停車の記録 */
export interface StopRecord {
  readonly stationId: string;
  readonly stationName: string;
  /** 停止位置目標に対する誤差 [m]（正 = 行き過ぎ） */
  readonly stopError: Meters;
  /** 到着時刻 [s] */
  readonly arrivalTime: Seconds;
  /** 定刻に対する遅れ [s]（正 = 遅延）。時刻が未設定なら null */
  readonly delay: Seconds | null;
  /** 出発時刻 [s]（未出発なら null） */
  departureTime: Seconds | null;
  /** 出発遅れ [s] */
  departureDelay: Seconds | null;
}

/** 保安装置の動作回数 */
export interface SafetyMetrics {
  emergencyBrakeCount: number;
  patternBrakeCount: number;
  atsWarningCount: number;
  slipEvents: number;
  slideEvents: number;
}

/**
 * 運転の評価指標を蓄積する。
 * 物理ステップごとに `sample()` を呼び、区間の終わりに結果を読み出す。
 */
export class MetricsRecorder {
  readonly ride: RideMetrics = {
    maxAcceleration: 0,
    maxDeceleration: 0,
    maxJerk: 0,
    maxLateralAcceleration: 0,
    maxCouplerForce: 0,
    maxStagger: 0,
    passengerSteps: 0,
  };
  readonly energy: EnergyMetrics = {
    consumed: 0,
    regenerated: 0,
    resistanceLoss: 0,
    brakeLoss: 0,
  };
  readonly safety: SafetyMetrics = {
    emergencyBrakeCount: 0,
    patternBrakeCount: 0,
    atsWarningCount: 0,
    slipEvents: 0,
    slideEvents: 0,
  };
  readonly stops: StopRecord[] = [];

  private previousAcceleration = 0;
  private started = false;

  sample(input: {
    dt: Seconds;
    acceleration: MetersPerSecondSquared;
    lateralAcceleration: number;
    couplerForce: number;
    electricPower: Watts;
    resistancePower: Watts;
    brakePower: Watts;
    /** 立っている乗客のよろけ具合（支持余裕に対する比） */
    stagger: number;
    /** 立っている乗客が足を出した累計回数 */
    passengerSteps: number;
  }): void {
    const { dt } = input;
    this.ride.maxAcceleration = Math.max(this.ride.maxAcceleration, input.acceleration);
    this.ride.maxDeceleration = Math.max(this.ride.maxDeceleration, -input.acceleration);
    if (this.started && dt > 0) {
      const jerk = Math.abs(input.acceleration - this.previousAcceleration) / dt;
      this.ride.maxJerk = Math.max(this.ride.maxJerk, jerk);
    }
    this.previousAcceleration = input.acceleration;
    this.started = true;

    this.ride.maxLateralAcceleration = Math.max(
      this.ride.maxLateralAcceleration,
      Math.abs(input.lateralAcceleration),
    );
    this.ride.maxCouplerForce = Math.max(this.ride.maxCouplerForce, Math.abs(input.couplerForce));
    this.ride.maxStagger = Math.max(this.ride.maxStagger, input.stagger);
    // 踏み出しの回数は乗客の模型が積算しているので、そのまま写す
    this.ride.passengerSteps = input.passengerSteps;

    if (input.electricPower >= 0) {
      this.energy.consumed += input.electricPower * dt;
    } else {
      this.energy.regenerated += -input.electricPower * dt;
    }
    this.energy.resistanceLoss += Math.abs(input.resistancePower) * dt;
    this.energy.brakeLoss += Math.abs(input.brakePower) * dt;
  }

  recordStop(record: StopRecord): void {
    this.stops.push(record);
  }

  /** 停止位置誤差の絶対値の最大 [m] */
  get worstStopError(): Meters {
    return this.stops.reduce((a, s) => Math.max(a, Math.abs(s.stopError)), 0);
  }

  /** 最終的な遅延 [s]（最後の停車の出発遅れ） */
  get finalDelay(): Seconds | null {
    for (let i = this.stops.length - 1; i >= 0; i--) {
      const s = this.stops[i]!;
      if (s.departureDelay !== null) return s.departureDelay;
      if (s.delay !== null) return s.delay;
    }
    return null;
  }
}
