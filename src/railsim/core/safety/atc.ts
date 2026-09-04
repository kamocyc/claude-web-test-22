import type { BeaconPayload } from '../route/types.ts';
import type { MetersPerSecond, Seconds } from '../units.ts';
import { patternSpeedAt, type PatternParameters } from './pattern.ts';
import {
  NO_INDICATION,
  type SafetyContext,
  type SafetyOutput,
  type SafetySystem,
} from './types.ts';

export interface AtcOptions extends Partial<PatternParameters> {
  /**
   * - 'step':    段階 ATC。車内信号の現示速度を超えるとブレーキが動作し、
   *              現示速度以下になるまで緩解しない（多段の階段状の減速になる）。
   * - 'digital': デジタル ATC。停止点までの距離から 1 本のパターンを作り、
   *              滑らかな一段ブレーキで減速する。
   */
  readonly mode?: 'step' | 'digital';
  /** ブレーキを緩解する速度余裕 [m/s]（digital のみ） */
  readonly releaseMargin?: MetersPerSecond;
  /** 照査超過時に用いる常用ブレーキノッチ */
  readonly serviceBrakeNotch?: number;
}

/**
 * ATC（自動列車制御装置）。車内信号方式。
 *
 * 地上子ではなく軌道回路から連続的に情報を受け取るため、`onBeacon` は使わず
 * `update` のたびに信号システムへ現示・停止点を問い合わせる。
 *
 * 段階 ATC は「現示速度まで落ちるまでブレーキが緩まない」ため、実車と同じく
 * 減速→緩解→再減速という階段状の速度曲線になる。デジタル ATC は停止点からの
 * パターンで一段減速するため、階段が現れず乗り心地が良い。
 */
export class AtcSystem implements SafetySystem {
  readonly kind = 'atc';
  private readonly params: PatternParameters;
  private readonly mode: 'step' | 'digital';
  private readonly releaseMargin: MetersPerSecond;
  private readonly serviceBrakeNotch: number;
  private braking = false;
  private lastPatternSpeed: MetersPerSecond | null = null;
  private lastCabSpeed: MetersPerSecond | null = null;

  constructor(options: AtcOptions = {}) {
    this.params = {
      deceleration: options.deceleration ?? 0.7,
      margin: options.margin ?? 20,
      responseTime: options.responseTime ?? 1.0,
    };
    this.mode = options.mode ?? 'digital';
    this.releaseMargin = options.releaseMargin ?? 0.5;
    this.serviceBrakeNotch = options.serviceBrakeNotch ?? Number.POSITIVE_INFINITY;
  }

  onBeacon(_payload: BeaconPayload, _atPosition: number, _ctx: SafetyContext): void {
    // ATC は軌道回路から連続的に情報を得るため、地上子は使わない
  }

  update(dt: Seconds, ctx: SafetyContext): SafetyOutput {
    void dt;
    const indication = { ...NO_INDICATION };
    const cabSpeed = ctx.signalling.cabSignalSpeed(ctx.position);
    this.lastCabSpeed = cabSpeed;
    indication.cabSignalSpeed = cabSpeed;

    const ceiling = Math.min(ctx.lineSpeedLimit, ctx.currentSpeedLimit);
    let allowed: number;

    if (this.mode === 'step') {
      allowed = Math.min(cabSpeed, ceiling);
      if (ctx.speed > allowed) {
        this.braking = true;
      } else if (this.braking && ctx.speed <= allowed) {
        // 現示速度以下に落ちるまで緩解しないのが段階 ATC の特徴
        this.braking = false;
      }
    } else {
      const stopDistance = ctx.signalling.distanceToStopSignal(ctx.position);
      const patternToStop = Number.isFinite(stopDistance)
        ? patternSpeedAt(stopDistance, 0, this.params)
        : Number.POSITIVE_INFINITY;
      allowed = Math.min(cabSpeed, ceiling, patternToStop);
      if (ctx.speed > allowed) {
        this.braking = true;
      } else if (ctx.speed < allowed - this.releaseMargin) {
        this.braking = false;
      }
    }

    this.lastPatternSpeed = allowed;
    indication.patternSpeed = allowed;
    indication.patternApproach = ctx.speed > allowed - 1.5;
    indication.brakeApplied = this.braking;
    indication.bell = this.braking;

    return {
      emergencyBrake: false,
      serviceBrakeNotch: this.braking ? this.serviceBrakeNotch : null,
      cutOffTraction: this.braking,
      indication,
    };
  }

  reset(): void {
    this.braking = false;
  }

  get patternSpeed(): MetersPerSecond | null {
    return this.lastPatternSpeed;
  }

  get cabSignalSpeed(): MetersPerSecond | null {
    return this.lastCabSpeed;
  }
}
