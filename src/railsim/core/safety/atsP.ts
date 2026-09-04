import type { BeaconPayload } from '../route/types.ts';
import type { Meters, MetersPerSecond, Seconds } from '../units.ts';
import { evaluatePatterns, type BrakePattern, type PatternParameters } from './pattern.ts';
import {
  NO_INDICATION,
  type SafetyContext,
  type SafetyOutput,
  type SafetySystem,
} from './types.ts';

/** 停止していると見なす速度 [m/s] */
const STOPPED_SPEED = 0.1;

export interface AtsPOptions extends Partial<PatternParameters> {
  /** パターン接近警報を出す速度余裕 [m/s] */
  readonly warningMargin?: MetersPerSecond;
  /** ブレーキを緩解する速度余裕 [m/s]（パターンをこれだけ下回ったら緩解） */
  readonly releaseMargin?: MetersPerSecond;
  /**
   * 信号が現示アップしたときのパターン解放の仕方。
   * - 'beacon': 次の地上子を通過するまでパターンを保持する（実機に近い）
   * - 'immediate': 現示アップを即座に反映する
   */
  readonly patternRelease?: 'beacon' | 'immediate';
  /** 照査超過時に用いる常用ブレーキノッチ */
  readonly serviceBrakeNotch?: number;
}

/**
 * ATS-P（パターン照査式 ATS）。
 *
 * 地上子から「目標地点までの距離」と「目標地点での許容速度」を受け取り、
 * 車上で減速パターンを生成して連続的に速度を照査する。ATS-SN と違って
 * 運転士の確認扱いでは解除できず、パターンを超えると自動的にブレーキがかかる。
 *
 * 実装している照査対象:
 *  - 停止信号（目標速度 0）
 *  - 曲線・分岐器・臨時の速度制限（目標速度 = 制限速度）
 *  - 線路終端（車止め）
 *  - 信号冒進（停止現示の信号機を通過したら即時に非常ブレーキ）
 *
 * パターン速度は応答時間を含む 2 次方程式の厳密解で求める（`patternSpeedAt`）。
 */
export class AtsPSystem implements SafetySystem {
  readonly kind = 'ats-p';
  private readonly patterns = new Map<string, BrakePattern>();
  private readonly params: PatternParameters;
  private readonly opts: Required<Omit<AtsPOptions, keyof PatternParameters>>;
  private braking = false;
  private emergency = false;
  private lastPatternSpeed: MetersPerSecond | null = null;

  constructor(options: AtsPOptions = {}) {
    this.params = {
      deceleration: options.deceleration ?? 0.7,
      margin: options.margin ?? 20,
      responseTime: options.responseTime ?? 2.0,
    };
    this.opts = {
      warningMargin: options.warningMargin ?? 1.5,
      releaseMargin: options.releaseMargin ?? 0.5,
      patternRelease: options.patternRelease ?? 'beacon',
      serviceBrakeNotch: options.serviceBrakeNotch ?? Number.POSITIVE_INFINITY,
    };
  }

  onBeacon(payload: BeaconPayload, atPosition: Meters, ctx: SafetyContext): void {
    switch (payload.kind) {
      case 'ats-p-signal': {
        const aspect = ctx.signalling.aspectOf(payload.signalId);
        const target = atPosition + payload.distance;
        if (aspect === 'R') {
          this.patterns.set(payload.signalId, {
            id: payload.signalId,
            kind: 'signal',
            targetPosition: target,
            targetSpeed: 0,
          });
        } else {
          // 現示アップを受信したのでパターンを解放する
          this.patterns.delete(payload.signalId);
        }
        break;
      }
      case 'ats-p-limit': {
        this.patterns.set(payload.limitId, {
          id: payload.limitId,
          kind: 'limit',
          targetPosition: atPosition + payload.distance,
          targetSpeed: payload.speed,
        });
        break;
      }
      case 'ats-p-terminus': {
        this.patterns.set('terminus', {
          id: 'terminus',
          kind: 'terminus',
          targetPosition: atPosition + payload.distance,
          targetSpeed: 0,
        });
        break;
      }
      default:
        break;
    }
  }

  update(dt: Seconds, ctx: SafetyContext): SafetyOutput {
    void dt;
    const indication = { ...NO_INDICATION };

    // 現示アップの即時反映（オプション）と、通過済みパターンの掃除
    const halted = Math.abs(ctx.speed) < STOPPED_SPEED;
    for (const [id, p] of [...this.patterns]) {
      if (p.kind === 'signal') {
        const cleared = ctx.signalling.aspectOf(id) !== 'R';
        // 停止信号の手前で止まった列車は、その信号が現示アップしたら発進できる。
        // パターンの余裕距離の内側には次の地上子が無く、パターン速度も 0 なので、
        // ここで解放しないと現示アップしても二度と動き出せない。
        // 実機で直下地上子がパターンを消去するのに相当する。
        if (cleared && (this.opts.patternRelease === 'immediate' || halted)) {
          this.patterns.delete(id);
          continue;
        }
      }
      if (p.targetPosition < ctx.position - 1 && p.kind !== 'signal') {
        this.patterns.delete(id);
      }
    }

    // 信号冒進の検知（停止現示の信号機を跨いだら即時非常）。
    // 自列車が閉塞へ進入したことで現示が赤へ変わるため、判定には
    // 手前の閉塞にいた時点の現示（aspectBefore）を使う。
    for (const sig of ctx.signalling.signals) {
      if (sig.position > ctx.previousPosition && sig.position <= ctx.position) {
        if (ctx.signalling.aspectBefore(sig.id) === 'R') {
          this.emergency = true;
        } else {
          this.patterns.delete(sig.id);
        }
      }
    }

    const ceiling = Math.min(ctx.lineSpeedLimit, ctx.currentSpeedLimit);
    const { speed: patternSpeed } = evaluatePatterns(
      this.patterns.values(),
      ctx.position,
      this.params,
      ceiling,
    );
    this.lastPatternSpeed = patternSpeed;
    indication.patternSpeed = patternSpeed;

    if (ctx.speed > patternSpeed) {
      this.braking = true;
    } else if (ctx.speed < patternSpeed - this.opts.releaseMargin) {
      this.braking = false;
    }
    indication.patternApproach = ctx.speed > patternSpeed - this.opts.warningMargin;
    indication.brakeApplied = this.braking || this.emergency;
    indication.bell = indication.patternApproach && !this.braking;

    return {
      emergencyBrake: this.emergency,
      serviceBrakeNotch: this.braking ? this.opts.serviceBrakeNotch : null,
      cutOffTraction: this.braking || this.emergency,
      indication,
    };
  }

  reset(): void {
    this.emergency = false;
    this.braking = false;
  }

  /** 現在のパターン速度 [m/s]（表示・テスト用） */
  get patternSpeed(): MetersPerSecond | null {
    return this.lastPatternSpeed;
  }

  /** 現在保持しているパターン（表示・テスト用） */
  get activePatterns(): readonly BrakePattern[] {
    return [...this.patterns.values()];
  }

  /** 指定距離程でのパターン速度（グラフ描画用） */
  patternSpeedAtPosition(position: Meters, ceiling: MetersPerSecond): MetersPerSecond {
    return evaluatePatterns(this.patterns.values(), position, this.params, ceiling).speed;
  }
}
