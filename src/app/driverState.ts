import { NEUTRAL_INPUT, type ControlInput } from '../railsim/core/index.ts';

/**
 * 運転台への指令。
 *
 * キーボードのキーとも画面のボタンとも独立した語彙にしてある。こうしておくと、
 * ノッチの進め方（力行を上げたらブレーキが落ちる、といった相互排他）を
 * キー入力とタッチ操作で二重に書かずに済む。
 */
export type DriverCommand =
  /** 力行側へ 1 段 */
  | 'powerUp'
  /** N 側へ 1 段。N を越えてブレーキ側へは入らない */
  | 'powerDown'
  /** 制動側へ 1 段。ワンハンドルでは N を越えて抑速・常用へ続く */
  | 'notchToBrake'
  /** 一息に N へ戻す */
  | 'notchNeutral'
  /** B1 へ入れる */
  | 'notchB1'
  | 'brakeUp'
  | 'brakeDown'
  | 'emergency'
  | 'doorsToggle'
  | 'doorsOpen'
  | 'doorsClose'
  /** 逆転ハンドルを前へ 1 段（後 → 中立 → 前） */
  | 'reverserForward'
  /** 逆転ハンドルを後へ 1 段（前 → 中立 → 後） */
  | 'reverserBackward'
  /** 前照灯の入切 */
  | 'headlightToggle'
  /** 前照灯の減光（High / Low） */
  | 'headlightDim'
  /** ワイパー（切 → 低速 → 高速） */
  | 'wiper'
  /** 耐雪ブレーキの入切 */
  | 'snowproofToggle';

/** ワイパーの位置 */
export type WiperMode = 'off' | 'slow' | 'fast';

const NEXT_WIPER: Readonly<Record<WiperMode, WiperMode>> = {
  off: 'slow',
  slow: 'fast',
  fast: 'off',
};

/** 「押している間だけ有効」な指令（離すと戻る操作） */
export type HeldCommand = 'acknowledge' | 'safetyReset' | 'horn' | 'sanding';

/**
 * 運転台の型。
 *
 * - `one-handle` — 1 本のハンドルに力行とブレーキが並ぶ。手前へ引くほど強い力行、
 *   向こうへ押すほど強いブレーキ。既定はこちら。
 * - `two-handle` — 主幹制御器とブレーキ設定器が別々。左手で力行、右手でブレーキ。
 *
 * 段の並びそのものはどちらでも同じで、違うのは**同じ並びを 1 本で操作するか
 * 2 本で操作するか**だけである。
 */
export type DeskLayout = 'two-handle' | 'one-handle';

/** ノッチ段数。シナリオ（車両）を切り替えても追従できるよう関数で受ける。 */
export interface NotchCounts {
  powerNotchCount(): number;
  brakeNotchCount(): number;
  /** 抑速位置を持つか（抑速ブレーキを持たない車両には無い） */
  hasHoldingBrake(): boolean;
  /**
   * 逆転ハンドルを動かせるか。
   *
   * 実車の逆転ハンドルは停止中しか動かせない（走らせたまま向きを変えれば
   * 主回路を壊す）。この状態機械は速度を知らないので、判定だけを外から借りる。
   * 省略時は常に動かせる。
   */
  canMoveReverser?(): boolean;
}

/** 運転士が握っているハンドルの位置（シミュレーションの実効ノッチとは別） */
export interface HandlePosition {
  readonly power: number;
  readonly brake: number;
  /**
   * 抑速位置にあるか。
   *
   * 段は持たない。実際に何段の電気ブレーキを出すかは装置（`HoldingBrakeRegulator`）が
   * 速度を見て選ぶので、運転士の手元にあるのは「入れたか、入れていないか」だけである。
   */
  readonly holding: boolean;
  readonly emergency: boolean;
  readonly doorsClosed: boolean;
  /** 逆転機（1 = 前、0 = 中立、-1 = 後） */
  readonly reverser: 1 | 0 | -1;
  /** 前照灯を点けているか */
  readonly headlight: boolean;
  /** 減光していないか（`headlight` が入のときだけ意味を持つ） */
  readonly headlightHigh: boolean;
  readonly wiper: WiperMode;
  /** 耐雪ブレーキ */
  readonly snowproof: boolean;
}

/** 段を 0〜max の整数へ丸める */
function clampNotch(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

/**
 * 運転台のハンドル位置を保持する状態機械。
 *
 * DOM には一切触れない。キーボード（`DriverDesk`）とタッチ運転台（`TouchConsole`）が
 * 同じインスタンスを共有するので、どちらで操作しても手元のハンドルは 1 組だけになる。
 *
 * ノッチの並びは実車と同じく次のとおり:
 *
 * ```
 *   力行:     N → P1 → P2 → … → Pn
 *   ブレーキ: N → 抑速 → B1 → B2 → … → Bn → 非常
 * ```
 *
 * 抑速はブレーキ側の**いちばん弱い位置**にあり、段を持たない。電気ブレーキだけで
 * 勾配を抑える位置なので常用ブレーキより手前にあり、そこから込めていくと常用へ移る、
 * という順番そのものが装置の作りと一致している。
 *
 * ワンハンドル（`one-handle`）では、この並びが 1 本の軸につながる:
 *
 * ```
 *   Pn … P1  N  抑速  B1 … Bn  非常
 * ```
 *
 * 力行とブレーキが同じ軸に乗るので、両方を同時に入れられないことが**構造として**
 * 保証される。ツーハンドルでは同じことを相互排他の規則として書く。
 */
export class DriverState {
  private powerNotch = 0;
  private brakeNotch = 0;
  private holdingOn = false;
  private emergencyOn = false;
  private doorsClosed = true;
  private reverserPosition: 1 | 0 | -1 = 1;
  private headlightOn = false;
  private headlightHighBeam = true;
  private wiperMode: WiperMode = 'off';
  private snowproofOn = false;
  private deskLayout: DeskLayout = 'one-handle';
  private readonly heldCommands = new Set<HeldCommand>();

  constructor(private readonly counts: NotchCounts) {}

  get layout(): DeskLayout {
    return this.deskLayout;
  }

  /**
   * 運転台の型を切り替える。
   *
   * 握っているハンドルの位置はそのまま残す。ワンハンドルとツーハンドルで
   * 段の並びは同じなので、走行中に切り替えてもノッチは動かない。
   */
  setLayout(layout: DeskLayout): void {
    this.deskLayout = layout;
  }

  /** 抑速位置のぶんだけブレーキ側の位置が 1 つ増える */
  private get holdingOffset(): number {
    return this.counts.hasHoldingBrake() ? 1 : 0;
  }

  /** ブレーキ側の位置の最大値（＝非常の位置） */
  get brakePositionCount(): number {
    return this.counts.brakeNotchCount() + this.holdingOffset + 1;
  }

  /**
   * ブレーキ側の通し位置。`0` = 切、`1` = 抑速（持つ車両のみ）、以降 B1…Bn、
   * 最後が非常。ハンドルを 1 段ずつ動かす操作はこの軸の上で行う。
   */
  get brakePosition(): number {
    if (this.emergencyOn) return this.brakePositionCount;
    if (this.holdingOn) return 1;
    return this.brakeNotch === 0 ? 0 : this.brakeNotch + this.holdingOffset;
  }

  /**
   * ワンハンドルの通し位置。正 = 力行、0 = 切、負 = ブレーキ側（抑速・常用・非常）。
   * ツーハンドルでも、2 本のハンドルの位置をこの 1 本の軸へ写したものになる。
   */
  get lever(): number {
    if (this.powerNotch > 0) return this.powerNotch;
    // 切は 0。`-0` を返すと `Object.is` での比較が食い違う。
    const brake = this.brakePosition;
    return brake === 0 ? 0 : -brake;
  }

  /** 一度の操作でハンドルが 1 段動くもの */
  apply(command: DriverCommand): void {
    // ワンハンドルでは力行とブレーキが 1 本の軸に乗るので、「力行を下げる」と
    // 「ブレーキを込める」が同じ動きになる。ツーハンドルではハンドルが別なので、
    // 力行側のキーでできるのは N まで戻すところまでである。
    const one = this.deskLayout === 'one-handle';
    switch (command) {
      case 'powerUp':
        if (one) this.setLever(this.lever + 1);
        else this.setPower(this.powerNotch + 1);
        return;
      case 'powerDown':
        // 「N 側へ 1 段」。ワンハンドルでは軸のどちら側にいても N へ近づく向きへ
        // 動き、N で止まる（越えて反対側へは入らない）。
        if (one) this.setLever(this.lever > 0 ? this.lever - 1 : Math.min(0, this.lever + 1));
        else this.setPower(this.powerNotch - 1);
        return;
      case 'notchToBrake':
        // 「制動側へ 1 段」。ワンハンドルだけが N を越えて抑速・常用へ入る。
        if (one) this.setLever(this.lever - 1);
        else this.setPower(this.powerNotch - 1);
        return;
      case 'notchNeutral':
        // 一息に N へ戻す。ハンドルを戻す操作なので非常も緩解する。
        this.setLever(0);
        return;
      case 'notchB1':
        this.setBrake(1);
        return;
      case 'brakeUp':
        // 非常はここでは解かない。込めていく操作で非常が緩んでは事故になる。
        if (one) this.setLever(this.lever - 1);
        else this.setBrakePosition(this.brakePosition + 1);
        return;
      case 'brakeDown':
        if (one) this.setLever(this.lever + 1);
        else this.setBrakePosition(this.brakePosition - 1);
        return;
      case 'emergency':
        this.setEmergency(true);
        return;
      case 'doorsToggle':
        this.doorsClosed = !this.doorsClosed;
        return;
      case 'doorsOpen':
        this.doorsClosed = false;
        return;
      case 'doorsClose':
        this.doorsClosed = true;
        return;
      case 'reverserForward':
        this.stepReverser(1);
        return;
      case 'reverserBackward':
        this.stepReverser(-1);
        return;
      case 'headlightToggle':
        this.headlightOn = !this.headlightOn;
        return;
      case 'headlightDim':
        this.headlightHighBeam = !this.headlightHighBeam;
        return;
      case 'wiper':
        this.wiperMode = NEXT_WIPER[this.wiperMode];
        return;
      case 'snowproofToggle':
        this.snowproofOn = !this.snowproofOn;
        return;
    }
  }

  /** 逆転ハンドルを 1 段動かす */
  private stepReverser(delta: 1 | -1): void {
    const next = Math.max(-1, Math.min(1, this.reverserPosition + delta)) as 1 | 0 | -1;
    this.setReverser(next);
  }

  /**
   * 逆転ハンドルの位置。
   *
   * 力行を入れたまま、あるいは走行中には動かせない（実車では主幹制御器と
   * 機械的に鎖錠されている）。
   */
  setReverser(position: 1 | 0 | -1): void {
    if (position === this.reverserPosition) return;
    if (this.powerNotch > 0) return;
    if (this.counts.canMoveReverser?.() === false) return;
    this.reverserPosition = position;
  }

  /**
   * ブレーキ側の位置を直接指定する（レバーのドラッグ用）。
   * 切より先へ入れた時点で力行は切れる（同時には使えない）。
   */
  setBrakePosition(position: number): void {
    const max = this.brakePositionCount;
    const offset = this.holdingOffset;
    const pos = clampNotch(position, max);
    if (pos > 0) this.powerNotch = 0;
    this.emergencyOn = pos === max;
    this.holdingOn = offset === 1 && pos === 1;
    // 非常は常用の最大段を伴う（実車の非常も常用の管を抜き切る）
    this.brakeNotch = pos === max ? this.counts.brakeNotchCount() : Math.max(0, pos - offset);
  }

  /**
   * ワンハンドルの位置を直接指定する。
   * 正 = 力行、0 = 切、負 = ブレーキ側。ツーハンドルでも同じ軸で受けられる。
   */
  setLever(position: number): void {
    const rounded = Math.round(position);
    if (rounded > 0) {
      this.setPower(rounded);
      return;
    }
    // 0 以下はブレーキ側。0（切）へ戻すときも力行を抜く必要があるので、
    // `setBrakePosition` に任せずここで落とす（あちらは切より先でしか力行を切らない）。
    this.powerNotch = 0;
    this.setBrakePosition(-rounded);
  }

  /** 力行ノッチを直接指定する（0 未満は切として扱う） */
  setPower(notch: number): void {
    const next = clampNotch(notch, this.counts.powerNotchCount());
    // 力行へ入れればブレーキは緩解する。切へ戻すだけならブレーキには触らない。
    if (next > 0) {
      this.brakeNotch = 0;
      this.holdingOn = false;
      this.emergencyOn = false;
    }
    this.powerNotch = next;
  }

  /**
   * 抑速位置の入切。
   *
   * 段は無い。入れれば装置が速度を見て段を選ぶ。常用ブレーキ・非常・力行とは
   * 同時に立たない。
   */
  setHolding(on: boolean): void {
    if (!on) {
      this.holdingOn = false;
      return;
    }
    if (!this.counts.hasHoldingBrake()) return;
    this.setBrakePosition(1);
  }

  /**
   * 常用ブレーキノッチを直接指定する（非常は `setEmergency` で扱う）。
   * 常用ブレーキ位置へ動かした時点で非常は解け、力行と抑速は切れる。
   */
  setBrake(notch: number): void {
    const next = clampNotch(notch, this.counts.brakeNotchCount());
    this.setBrakePosition(next === 0 ? 0 : next + this.holdingOffset);
  }

  /** 非常ブレーキ。入れると力行は切れ、常用ブレーキは最大段になる。 */
  setEmergency(on: boolean): void {
    if (!on) {
      this.emergencyOn = false;
      return;
    }
    this.setBrakePosition(this.brakePositionCount);
  }

  setDoorsClosed(closed: boolean): void {
    this.doorsClosed = closed;
  }

  hold(command: HeldCommand): void {
    this.heldCommands.add(command);
  }

  release(command: HeldCommand): void {
    this.heldCommands.delete(command);
  }

  /** 押しっぱなしの取りこぼしを断つ（ウィンドウが背面へ回った、指が奪われた） */
  releaseAll(): void {
    this.heldCommands.clear();
  }

  isHeld(command: HeldCommand): boolean {
    return this.heldCommands.has(command);
  }

  reset(): void {
    this.powerNotch = 0;
    this.brakeNotch = 0;
    this.holdingOn = false;
    this.emergencyOn = false;
    this.doorsClosed = true;
    this.reverserPosition = 1;
    this.headlightOn = false;
    this.headlightHighBeam = true;
    this.wiperMode = 'off';
    this.snowproofOn = false;
    this.heldCommands.clear();
  }

  /**
   * ハンドル位置を外から合わせる。
   * 自動運転を切った瞬間に運転士へ引き継ぐときに使う。合わせておかないと、
   * 装置が入れていたブレーキが解除に変わって列車が走り出してしまう。
   */
  takeOver(power: number, brake: number, doorsClosed: boolean, holding = 0): void {
    // 抑速も引き継ぐ。下り勾配の途中で手を替えたときにここが抜けると、
    // 装置が入れていた電気ブレーキが突然切れて列車が加速しはじめる。
    // 装置は段まで決めているが、運転士の手元には抑速位置しか無いので、
    // 入れ直したものとして扱う（調速器がその時点の速度を目標に取り直す）。
    this.emergencyOn = false;
    this.powerNotch = 0;
    this.brakeNotch = 0;
    this.holdingOn = false;
    if (holding > 0) this.setHolding(true);
    else if (brake > 0) this.setBrake(brake);
    else this.setPower(power);
    this.doorsClosed = doorsClosed;
  }

  get handles(): HandlePosition {
    return {
      power: this.powerNotch,
      brake: this.brakeNotch,
      holding: this.holdingOn,
      emergency: this.emergencyOn,
      doorsClosed: this.doorsClosed,
      reverser: this.reverserPosition,
      headlight: this.headlightOn,
      headlightHigh: this.headlightHighBeam,
      wiper: this.wiperMode,
      snowproof: this.snowproofOn,
    };
  }

  /** 現在の操作入力 */
  get input(): ControlInput {
    return {
      ...NEUTRAL_INPUT,
      powerNotch: this.powerNotch,
      // 手元にあるのは抑速位置の入切だけ。段は装置が選ぶ。
      holding: this.holdingOn,
      brakeNotch: this.brakeNotch,
      emergency: this.emergencyOn,
      reverser: this.reverserPosition,
      snowproofBrake: this.snowproofOn,
      // 前照灯とワイパーは物理に効かないので `ControlInput` には載せない。
      // 載せると記録が走行と関係のないイベントで膨らむ。
      acknowledge: this.heldCommands.has('acknowledge'),
      safetyReset: this.heldCommands.has('safetyReset'),
      horn: this.heldCommands.has('horn'),
      sanding: this.heldCommands.has('sanding'),
      doorsClosed: this.doorsClosed,
    };
  }
}
