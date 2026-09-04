import type { BeaconPayload } from '../route/types.ts';
import type { Meters, Seconds } from '../units.ts';
import {
  NO_INDICATION,
  type SafetyContext,
  type SafetyIndication,
  type SafetyOutput,
  type SafetySystem,
} from './types.ts';

/**
 * 複数の保安装置を束ねる。
 *
 * 実車でも ATS-P と EB 装置のように複数の装置が同時に載っており、
 * どれか 1 つでも非常ブレーキを指令すればブレーキがかかる（フェイルセーフ）。
 * 常用ブレーキ指令は最も強いものを採用する。
 */
export class CompositeSafetySystem implements SafetySystem {
  readonly kind = 'composite';
  readonly systems: SafetySystem[];

  constructor(systems: readonly SafetySystem[]) {
    this.systems = [...systems];
  }

  onBeacon(payload: BeaconPayload, atPosition: Meters, ctx: SafetyContext): void {
    for (const s of this.systems) s.onBeacon(payload, atPosition, ctx);
  }

  update(dt: Seconds, ctx: SafetyContext): SafetyOutput {
    const indication: SafetyIndication = { ...NO_INDICATION };
    let emergency = false;
    let cutOff = false;
    let notch: number | null = null;

    for (const sys of this.systems) {
      const out = sys.update(dt, ctx);
      emergency = emergency || out.emergencyBrake;
      cutOff = cutOff || out.cutOffTraction;
      if (out.serviceBrakeNotch !== null) {
        notch = notch === null ? out.serviceBrakeNotch : Math.max(notch, out.serviceBrakeNotch);
      }
      indication.bell = indication.bell || out.indication.bell;
      indication.chime = indication.chime || out.indication.chime;
      indication.patternApproach = indication.patternApproach || out.indication.patternApproach;
      indication.brakeApplied = indication.brakeApplied || out.indication.brakeApplied;
      if (out.indication.cabSignalSpeed !== null) {
        indication.cabSignalSpeed =
          indication.cabSignalSpeed === null
            ? out.indication.cabSignalSpeed
            : Math.min(indication.cabSignalSpeed, out.indication.cabSignalSpeed);
      }
      if (out.indication.patternSpeed !== null) {
        indication.patternSpeed =
          indication.patternSpeed === null
            ? out.indication.patternSpeed
            : Math.min(indication.patternSpeed, out.indication.patternSpeed);
      }
    }

    return {
      emergencyBrake: emergency,
      serviceBrakeNotch: notch,
      cutOffTraction: cutOff,
      indication,
    };
  }

  reset(): void {
    for (const s of this.systems) s.reset();
  }

  /** 種別で個別の装置を取り出す */
  find<T extends SafetySystem>(kind: string): T | undefined {
    return this.systems.find((s) => s.kind === kind) as T | undefined;
  }
}
