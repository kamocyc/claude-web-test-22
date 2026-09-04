import type { MetersPerSecond, Newtons, Watts } from '../units.ts';
import type { TrainDynamics } from '../train/dynamics.ts';
import type { DriveState } from './driveState.ts';

/** 動力装置の状態（表示・記録用） */
export interface TractionState {
  /** 現在の力行ノッチ（0 = 切） */
  notch: number;
  /** レート制限後のトルク指令率 0..1 */
  torqueCommand: number;
  /** 車輪周の引張力 [N]（正 = 力行、負 = 電気ブレーキ） */
  tractiveEffort: Newtons;
  /** 主回路電流 [A]（編成合計） */
  motorCurrent: number;
  /** 電力 [W]（正 = 消費、負 = 回生） */
  power: Watts;
  /** 電気ブレーキとして動作中か */
  electricBraking: boolean;
  /** 再粘着制御による引張力の絞り込み率 0..1 */
  reAdhesionFactor: number;
  /** 空転を検知しているか */
  slipDetected: boolean;
}

/** 動力装置に渡される制御コンテキスト */
export interface TractionContext {
  readonly dynamics: TrainDynamics;
  /** 乗車率 */
  readonly loadFactor: number;
  /**
   * 架線の回生負荷受け入れ率 0..1。
   * 1 = 十分な負荷があり全量回生できる、0 = 回生失効。
   */
  readonly regenerationReceptivity: number;
  /** 架線電圧 [V] */
  readonly lineVoltage: number;
  /**
   * 逆転機の向き（1 = 前、-1 = 後）。省略時は前。
   *
   * 力行トルクの向きだけを決める。電気ブレーキは実際に回っている向きから
   * 逆向きのトルクを出すので、この値では切り替えない。
   */
  readonly direction?: 1 | -1;
}

/**
 * 動力装置のインタフェース。
 *
 * VVVF インバータ制御のほかに、抵抗制御（カム軸進段・直並列切替・弱め界磁）などを
 * 同じインタフェースの別実装として差し込めるようにしている。
 */
export interface TractionSystem {
  readonly state: TractionState;
  /**
   * 制御方式ごとの詳細状態（変調 / 進段 / 通流率）。表示と音響のためだけにあり、
   * 引張力の計算には関与しない。呼ぶ側が `instanceof` で実装を判別しなくて済むよう、
   * インタフェースに載せている。
   */
  readonly driveState: DriveState;
  /** 力行ノッチを設定する */
  setNotch(notch: number): void;
  /** 制御周期ごとに呼ばれ、各動軸の driveTorque を更新する */
  update(dt: number, ctx: TractionContext): void;
  /** 速度 v で利用可能な電気ブレーキ力の上限 [N]（編成合計・正値） */
  availableElectricBrakeForce(v: MetersPerSecond, ctx: TractionContext): Newtons;
  /** ブレーキ装置から要求される電気ブレーキ力 [N]（正値）を設定する */
  requestElectricBrakeForce(force: Newtons): void;
  /** すべての出力を切る */
  cutOff(): void;
}
