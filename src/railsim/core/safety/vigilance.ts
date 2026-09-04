import type { BeaconPayload } from '../route/types.ts';
import type { MetersPerSecond, Seconds } from '../units.ts';
import {
  NO_INDICATION,
  type SafetyContext,
  type SafetyOutput,
  type SafetySystem,
} from './types.ts';

export interface VigilanceOptions {
  /** 無操作を検知するまでの時間 [s] */
  readonly warningTime?: Seconds;
  /** 警報が鳴ってから非常ブレーキまでの猶予 [s] */
  readonly graceTime?: Seconds;
  /** この速度以下では監視しない [m/s] */
  readonly minSpeed?: MetersPerSecond;
}

/**
 * EB 装置（緊急列車停止装置）／デッドマン装置。
 *
 * 一定時間、運転士の操作がまったく無い状態が続くと警報を発し、
 * さらに猶予時間内に操作（リセット扱い）が無ければ非常ブレーキをかける。
 * 走行中のみ監視し、停車中や極低速では作動しない。
 */
export class VigilanceSystem implements SafetySystem {
  readonly kind = 'vigilance';
  private idleTime = 0;
  private warningTimer = 0;
  private warning = false;
  private emergency = false;
  private readonly opts: Required<VigilanceOptions>;

  constructor(options: VigilanceOptions = {}) {
    this.opts = {
      warningTime: options.warningTime ?? 60,
      graceTime: options.graceTime ?? 5,
      minSpeed: options.minSpeed ?? 1.0,
    };
  }

  onBeacon(_payload: BeaconPayload, _atPosition: number, _ctx: SafetyContext): void {
    // 地上子とは無関係
  }

  update(dt: Seconds, ctx: SafetyContext): SafetyOutput {
    const indication = { ...NO_INDICATION };
    const moving = Math.abs(ctx.speed) > this.opts.minSpeed;
    const operated = ctx.driver.anyOperation || ctx.driver.acknowledge;

    if (operated) {
      this.idleTime = 0;
      this.warning = false;
      this.warningTimer = 0;
    } else if (moving) {
      this.idleTime += dt;
      if (this.idleTime >= this.opts.warningTime) this.warning = true;
    } else {
      this.idleTime = 0;
      this.warning = false;
      this.warningTimer = 0;
    }

    if (this.warning) {
      this.warningTimer += dt;
      indication.bell = true;
      if (this.warningTimer >= this.opts.graceTime) this.emergency = true;
    }
    indication.brakeApplied = this.emergency;

    return {
      emergencyBrake: this.emergency,
      serviceBrakeNotch: null,
      cutOffTraction: this.emergency,
      indication,
    };
  }

  reset(): void {
    this.emergency = false;
    this.warning = false;
    this.idleTime = 0;
    this.warningTimer = 0;
  }

  /** 無操作が続いている時間 [s] */
  get elapsedIdle(): Seconds {
    return this.idleTime;
  }
}
