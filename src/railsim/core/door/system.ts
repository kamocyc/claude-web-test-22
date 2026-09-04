import { clamp } from '../math/scalar.ts';
import type { Seconds } from '../units.ts';
import type { DoorSpec } from '../vehicle/spec.ts';

/** 客用扉の動作段階 */
export type DoorPhase = 'closed' | 'opening' | 'open' | 'warning' | 'closing';

/**
 * 客用扉の状態（表示・音響用）。
 *
 * 走行そのものには関与しないが、**戸閉連動だけは走りに効く**。実車の力行回路は
 * 全部の扉が閉じて施錠されたことを確かめる接点を通っているので、指令ではなく
 * この状態が力行を許すかどうかを決める。
 */
export interface DoorState {
  phase: DoorPhase;
  /** 開き具合 0（全閉）..1（全開） */
  position: number;
  /** 戸閉連動が成立しているか（＝力行してよいか） */
  interlocked: boolean;
  /** ドアチャイムが鳴っているか */
  chiming: boolean;
  /** 扉が動いているか（開閉どちらでも true） */
  moving: boolean;
  /** 閉じる向きに動いているか */
  closing: boolean;
  /**
   * チャイムが鳴り始めた回数（単調増加）。
   * 音は「鳴っているあいだ」ではなく「鳴り始めた瞬間」に組み立てるので、
   * 状態ではなくカウンタで渡す。
   */
  chimeEvents: number;
  /** 扉が閉じ切って施錠された回数（単調増加）。戸閉めの「ガシャン」が鳴る。 */
  latchEvents: number;
  /** 扉が開き切った回数（単調増加）。戸袋に当たる音が鳴る。 */
  openEvents: number;
}

export function createDoorState(): DoorState {
  return {
    phase: 'closed',
    position: 0,
    interlocked: true,
    chiming: false,
    moving: false,
    closing: false,
    chimeEvents: 0,
    latchEvents: 0,
    openEvents: 0,
  };
}

/**
 * 客用扉。
 *
 * 指令（開 / 閉）に対して**有限の時間をかけて動く**。この装置の要点は 2 つある。
 *
 * 1 つは戸閉連動である。力行回路は全部の扉が閉じて施錠されたことを確かめる接点を
 * 通っているので、閉指令を出した瞬間ではなく、**実際に閉まり切ってから**力行できる。
 * ブレーキシリンダ圧や回生の受け渡しと同じで、指令と実出力を分けて時間発展させる。
 *
 * もう 1 つは閉扉予告である。閉指令が出ると、まずチャイムが鳴り、少し置いてから
 * 扉が動き出す。駆け込み乗車への予告であり、「ピンポーン…（間）…プシュー ガシャン」
 * という順番はこの予告時間そのものである。開くときは予告が要らないので、
 * チャイムと動き出しが同時になる。
 */
export class DoorSystem {
  readonly state: DoorState = createDoorState();

  private readonly spec: DoorSpec;
  /** 運転士の指令（true = 戸閉め） */
  private command = true;
  /** 現在の段階に入ってからの経過時間 [s] */
  private elapsed: Seconds = 0;
  /** チャイムの残り時間 [s] */
  private chimeLeft: Seconds = 0;

  constructor(spec: DoorSpec) {
    this.spec = spec;
  }

  /** 戸閉め指令（false = 開扉指令） */
  setCommand(closed: boolean): void {
    if (closed === this.command) return;
    this.command = closed;
    this.elapsed = 0;
    if (closed) {
      // 閉扉予告。チャイムが鳴ってから扉が動き出す。
      this.state.phase = 'warning';
      this.startChime(this.spec.chimeOnClose);
    } else {
      // 開くときは予告が要らない。チャイムと同時に動き出す。
      this.state.phase = 'opening';
      this.startChime(this.spec.chimeOnOpen);
    }
  }

  private startChime(enabled: boolean): void {
    if (!enabled) return;
    this.chimeLeft = this.spec.chimeDuration;
    this.state.chimeEvents++;
  }

  update(dt: number): void {
    const st = this.state;
    const spec = this.spec;
    this.elapsed += dt;
    this.chimeLeft = Math.max(0, this.chimeLeft - dt);

    switch (st.phase) {
      case 'warning':
        // 予告のあいだ扉はまだ動かない（＝まだ乗り降りできる）
        if (this.elapsed >= spec.closeWarningTime) {
          st.phase = 'closing';
          this.elapsed = 0;
        }
        break;
      case 'closing':
        st.position = clamp(st.position - dt / spec.closeTime, 0, 1);
        if (st.position <= 0) {
          st.position = 0;
          st.phase = 'closed';
          st.latchEvents++;
        }
        break;
      case 'opening':
        st.position = clamp(st.position + dt / spec.openTime, 0, 1);
        if (st.position >= 1) {
          st.position = 1;
          st.phase = 'open';
          st.openEvents++;
        }
        break;
      case 'closed':
      case 'open':
        break;
    }

    st.chiming = this.chimeLeft > 0;
    st.moving = st.phase === 'opening' || st.phase === 'closing';
    st.closing = st.phase === 'closing';
    // 戸閉連動は「全閉かつ施錠」でだけ成立する。予告中はまだ開いている。
    st.interlocked = st.phase === 'closed';
  }

  /** 力行を許してよいか（戸閉連動） */
  get interlocked(): boolean {
    return this.state.interlocked;
  }
}

/** 扉の状態の表示名 */
export function doorLabel(state: DoorState): string {
  switch (state.phase) {
    case 'closed':
      return '戸閉';
    case 'opening':
      return `開扉中 ${(state.position * 100).toFixed(0)}%`;
    case 'open':
      return '戸開';
    case 'warning':
      return '閉扉予告';
    case 'closing':
      return `閉扉中 ${(state.position * 100).toFixed(0)}%`;
  }
}
