import type { Seconds } from '../units.ts';
import { hashNumbers } from '../math/scalar.ts';
import type { Simulation } from './simulation.ts';
import { NEUTRAL_INPUT, type ControlInput } from './types.ts';

/** 入力が変化した時点の記録 */
export interface InputEvent {
  readonly time: Seconds;
  readonly input: ControlInput;
}

/** リプレイ用の記録 */
export interface Recording {
  readonly scenarioId: string;
  readonly seed: number;
  readonly events: readonly InputEvent[];
  /** 記録の総時間 [s] */
  readonly duration: Seconds;
}

const sameInput = (a: ControlInput, b: ControlInput): boolean =>
  a.powerNotch === b.powerNotch &&
  a.brakeNotch === b.brakeNotch &&
  a.emergency === b.emergency &&
  a.holding === b.holding &&
  a.holdingNotch === b.holdingNotch &&
  a.reverser === b.reverser &&
  a.acknowledge === b.acknowledge &&
  a.safetyReset === b.safetyReset &&
  a.horn === b.horn &&
  a.sanding === b.sanding &&
  a.doorsClosed === b.doorsClosed &&
  a.backupBrake === b.backupBrake &&
  a.snowproofBrake === b.snowproofBrake;

/**
 * 運転士の操作を記録する。
 *
 * シミュレーションは入力以外に外部状態へ依存しないため、
 * 「シナリオ ID + シード + 入力の変化列」だけで走行を完全に再現できる。
 * 不具合の再現やリグレッションテストの素材として使う。
 */
export class InputRecorder {
  private readonly _events: InputEvent[] = [];
  private last: ControlInput = NEUTRAL_INPUT;
  private duration = 0;

  constructor(initial: ControlInput = NEUTRAL_INPUT) {
    this.last = initial;
    this._events.push({ time: 0, input: initial });
  }

  /** 現在時刻の入力を記録する（変化があったときだけ 1 件追加される） */
  record(time: Seconds, input: ControlInput): void {
    this.duration = Math.max(this.duration, time);
    if (sameInput(this.last, input)) return;
    this._events.push({ time, input: { ...input } });
    this.last = { ...input };
  }

  get events(): readonly InputEvent[] {
    return this._events;
  }

  toRecording(scenarioId: string, seed: number): Recording {
    return { scenarioId, seed, events: [...this._events], duration: this.duration };
  }
}

/**
 * 記録を再生する。`onStep` で各ステップの状態を取り出せる。
 * @param stepSeconds 1 回の step() で進める時間（記録時と同じ値でなくても結果は同じ）
 */
export function replay(
  sim: Simulation,
  recording: Recording,
  stepSeconds = 0.05,
  onStep?: (sim: Simulation) => void,
): void {
  let index = 0;
  // 経過時間は浮動小数の累積で誤差が出るため、ステップ数から時刻を組み立てる
  const steps = Math.round(recording.duration / stepSeconds);
  for (let i = 0; i < steps; i++) {
    const t = i * stepSeconds;
    while (index < recording.events.length && recording.events[index]!.time <= t + 1e-9) {
      sim.input = recording.events[index]!.input;
      index++;
    }
    sim.step(stepSeconds);
    onStep?.(sim);
  }
}

/**
 * 走行結果の決定論ハッシュ。
 * 同じシナリオ・同じ入力なら実行環境に関係なく一致する。
 */
export function stateHash(sim: Simulation): number {
  const values: number[] = [sim.time, sim.elapsed];
  for (const veh of sim.dynamics.vehicles) {
    values.push(veh.s, veh.v, veh.a);
    for (const ax of veh.axles) values.push(ax.omega, ax.creepForce);
  }
  for (const p of sim.brake.state.cylinderPressure) values.push(p);
  values.push(sim.traction.state.torqueCommand, sim.traction.state.reAdhesionFactor);
  return hashNumbers(values);
}
