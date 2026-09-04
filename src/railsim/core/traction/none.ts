import type { MetersPerSecond, Newtons } from '../units.ts';
import { clearDriveTorques, createTractionState } from './common.ts';
import { createIdleDriveState, type IdleDriveState } from './driveState.ts';
import type { TractionContext, TractionState, TractionSystem } from './types.ts';

/**
 * 動力装置を持たない編成のための空実装。
 *
 * 付随車だけの編成（機関車に牽かれる客車など）を表せるようにしておくと、
 * 呼ぶ側が `traction` の有無を気にしなくて済む。何も出さず、何も受け取らない。
 */
export class NoTractionSystem implements TractionSystem {
  readonly state: TractionState = createTractionState();
  readonly driveState: IdleDriveState = createIdleDriveState();

  setNotch(): void {
    /* 力行できない */
  }

  requestElectricBrakeForce(): void {
    /* 電気ブレーキを持たない */
  }

  cutOff(): void {
    /* 切るものが無い */
  }

  availableElectricBrakeForce(_v: MetersPerSecond, _ctx: TractionContext): Newtons {
    return 0;
  }

  update(_dt: number, ctx: TractionContext): void {
    clearDriveTorques(ctx.dynamics);
  }
}
