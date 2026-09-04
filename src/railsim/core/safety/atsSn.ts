import type { BeaconPayload } from '../route/types.ts';
import type { Meters, Seconds } from '../units.ts';
import {
  NO_INDICATION,
  isRestrictive,
  type SafetyContext,
  type SafetyOutput,
  type SafetySystem,
} from './types.ts';

export interface AtsSnOptions {
  /** 警報が鳴ってから確認扱いを行うまでの猶予 [s] */
  readonly acknowledgeWindow?: Seconds;
  /** 確認扱い後にチャイムが鳴り続ける時間 [s]（0 で即停止） */
  readonly chimeDuration?: Seconds;
}

type Phase = 'idle' | 'warning' | 'acknowledged' | 'emergency';

/**
 * ATS-S 形（SN 形）。
 *
 * 車上装置は速度を照査せず、「停止信号に接近したことを運転士へ知らせ、
 * 一定時間内に確認扱いが行われなければ非常ブレーキをかける」だけの装置である。
 * 確認扱いさえすればそのまま信号を冒進できてしまうという性質も含めて再現する。
 *
 * - ロング地上子（信号機の約 600m 手前）: 停止・注意現示ならベルが鳴る。
 *   `acknowledgeWindow` 秒以内に確認扱いが無ければ非常ブレーキ。
 * - 確認扱い後はチャイムに変わり、警報状態は解除される。
 * - 直下地上子（信号機の直下）: 停止現示のまま通過すると即時に非常ブレーキ。
 */
export class AtsSnSystem implements SafetySystem {
  readonly kind = 'ats-sn';
  private phase: Phase = 'idle';
  private timer = 0;
  private chimeTimer = 0;
  private readonly opts: Required<AtsSnOptions>;

  constructor(options: AtsSnOptions = {}) {
    this.opts = {
      acknowledgeWindow: options.acknowledgeWindow ?? 5,
      chimeDuration: options.chimeDuration ?? 0,
    };
  }

  onBeacon(payload: BeaconPayload, _atPosition: Meters, ctx: SafetyContext): void {
    if (payload.kind === 'ats-sn-long') {
      const aspect = ctx.signalling.aspectOf(payload.signalId);
      if (isRestrictive(aspect)) {
        if (this.phase !== 'emergency') {
          this.phase = 'warning';
          this.timer = 0;
        }
      }
      return;
    }
    if (payload.kind === 'ats-sn-immediate') {
      // 自列車が閉塞へ進入したことによる現示変化に反応しないよう、
      // 手前の閉塞にいた時点の現示で判定する
      const aspect = ctx.signalling.aspectBefore(payload.signalId);
      if (aspect === 'R') {
        // 停止信号の直下地上子を通過 = 信号冒進。即時に非常ブレーキ。
        this.phase = 'emergency';
        this.timer = 0;
      }
    }
  }

  update(dt: Seconds, ctx: SafetyContext): SafetyOutput {
    const indication = { ...NO_INDICATION };

    switch (this.phase) {
      case 'warning':
        this.timer += dt;
        indication.bell = true;
        if (ctx.driver.acknowledge) {
          this.phase = 'acknowledged';
          this.chimeTimer = 0;
        } else if (this.timer >= this.opts.acknowledgeWindow) {
          this.phase = 'emergency';
        }
        break;
      case 'acknowledged':
        this.chimeTimer += dt;
        indication.chime =
          this.opts.chimeDuration <= 0 || this.chimeTimer < this.opts.chimeDuration;
        break;
      case 'emergency':
        indication.bell = true;
        indication.brakeApplied = true;
        break;
      case 'idle':
        break;
    }

    return {
      emergencyBrake: this.phase === 'emergency',
      serviceBrakeNotch: null,
      cutOffTraction: this.phase === 'emergency',
      indication,
    };
  }

  /** 停止後に運転士が復帰扱いを行う */
  reset(): void {
    this.phase = 'idle';
    this.timer = 0;
    this.chimeTimer = 0;
  }

  /** 現在の状態（テスト・表示用） */
  get currentPhase(): string {
    return this.phase;
  }
}
