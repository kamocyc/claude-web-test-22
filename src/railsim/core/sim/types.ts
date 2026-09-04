import type { ConsistSpec, RailCondition } from '../vehicle/spec.ts';
import type { CompiledRoute } from '../route/types.ts';
import type { ScheduledTrain } from '../signalling/system.ts';
import type { Meters, MetersPerSecond, Seconds } from '../units.ts';
import type { SafetySystemKind } from '../route/types.ts';

/** 運転士の操作入力。これだけがシミュレーションへの外部入力になる。 */
export interface ControlInput {
  /** 力行ノッチ（0 = 切） */
  readonly powerNotch: number;
  /** 常用ブレーキノッチ（0 = 緩解） */
  readonly brakeNotch: number;
  /** 非常ブレーキ */
  readonly emergency: boolean;
  /**
   * 抑速ブレーキ位置。
   *
   * 運転士のブレーキハンドルにある抑速位置は**段が 1 つしかない**。入れると装置
   * （`HoldingBrakeRegulator`）が速度を見て適切な段を選び続けるので、運転士が
   * 段を数えて込め直す必要は無い。
   */
  readonly holding: boolean;
  /**
   * 抑速ブレーキの段を直接指定する（0 = 切）。
   *
   * 自動運転装置のように「何段を出すか」まで決めている使い手のための入口で、
   * `holding` が true のときはそちらが優先される（装置が段を選ぶ）。
   */
  readonly holdingNotch: number;
  /** 逆転機（1 = 前、0 = 中立、-1 = 後） */
  readonly reverser: 1 | 0 | -1;
  /** ATS 確認扱い／EB リセット（押している間 true） */
  readonly acknowledge: boolean;
  /** 保安装置の復帰扱い（停止中のみ有効） */
  readonly safetyReset: boolean;
  /** 警笛 */
  readonly horn: boolean;
  /** 砂撒き */
  readonly sanding: boolean;
  /** 戸閉め（false = 開扉指令） */
  readonly doorsClosed: boolean;
  /** 直通予備ブレーキ */
  readonly backupBrake: boolean;
  /**
   * 耐雪ブレーキ。
   *
   * 降雪時に制輪子と踏面のあいだへ雪が入って利きが落ちるのを防ぐため、走行中に
   * 低い圧力を込め続けておく装置。常用ブレーキを込めればそちらが上回るので、
   * 運転士は入れっぱなしにしておく。
   */
  readonly snowproofBrake: boolean;
}

export const NEUTRAL_INPUT: ControlInput = {
  powerNotch: 0,
  brakeNotch: 0,
  emergency: false,
  holding: false,
  holdingNotch: 0,
  reverser: 1,
  acknowledge: false,
  safetyReset: false,
  horn: false,
  sanding: false,
  doorsClosed: true,
  backupBrake: false,
  snowproofBrake: false,
};

/** シナリオ（路線 + 車両 + 初期条件） */
export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly route: CompiledRoute;
  readonly consist: ConsistSpec;
  /** ダイヤ上の他列車 */
  readonly scheduledTrains: readonly ScheduledTrain[];
  /** 開始時刻 [s]（0 時からの秒） */
  readonly startTime: Seconds;
  /** 開始位置（列車先頭端の距離程）[m] */
  readonly startPosition: Meters;
  /** 開始速度 [m/s] */
  readonly startSpeed: MetersPerSecond;
  /** 乗車率 */
  readonly loadFactor: number;
  /** レール踏面状態 */
  readonly railCondition: RailCondition;
  /** 架線の回生負荷受け入れ率 0..1 */
  readonly regenerationReceptivity: number;
  /** 乱数シード（決定論のため必須） */
  readonly seed: number;
  /** 使用する保安装置（区間で切り替わらない場合の既定値） */
  readonly safetySystems: readonly SafetySystemKind[];
  /** EB 装置を搭載するか */
  readonly hasVigilance: boolean;
  /** 列車を単一剛体として扱う（BVE 相当の比較用） */
  readonly rigidConsist?: boolean;
}
