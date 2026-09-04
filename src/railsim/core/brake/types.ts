import type { MetersPerSecondSquared, Newtons, Pascals } from '../units.ts';
import type { TrainDynamics } from '../train/dynamics.ts';
import type { TractionSystem } from '../traction/types.ts';
import type { RailCondition } from '../vehicle/spec.ts';

/** 運転士（または保安装置）からのブレーキ指令 */
export interface BrakeCommand {
  /** 常用ブレーキノッチ（0 = 緩解） */
  readonly notch: number;
  /** 非常ブレーキ */
  readonly emergency: boolean;
  /** 抑速ブレーキノッチ（0 = 切、電気ブレーキのみで勾配を抑速する） */
  readonly holdingNotch: number;
  /** 直通予備ブレーキ（電気指令系が失われたときの直通空気ブレーキ） */
  readonly backup: boolean;
  /** 耐雪ブレーキ（緩解中に低い圧力を込め続ける） */
  readonly snowproof: boolean;
}

export const RELEASED_BRAKE: BrakeCommand = {
  notch: 0,
  emergency: false,
  holdingNotch: 0,
  backup: false,
  snowproof: false,
};

/** ブレーキ装置の状態（表示・記録用） */
export interface BrakeState {
  /** 現在の指令 */
  command: BrakeCommand;
  /** 指令減速度 [m/s^2] */
  targetDeceleration: MetersPerSecondSquared;
  /** 必要制動力 [N]（編成合計） */
  requiredForce: Newtons;
  /** 電気ブレーキが分担している力 [N] */
  electricForce: Newtons;
  /** 空気ブレーキが分担している力 [N]（指令値） */
  airForceCommand: Newtons;
  /** 空気ブレーキが実際に出している力 [N]（BC 圧から換算） */
  airForceActual: Newtons;
  /** 各車のブレーキシリンダ圧 [Pa] */
  cylinderPressure: number[];
  /** 回生が失効しているか（要求に対して電気ブレーキが不足） */
  regenerationLost: boolean;
  /** 滑走防止装置が動作しているか */
  antiSkidActive: boolean;
  /** 滑走防止による各車の緩解率 0..1 */
  antiSkidFactor: number[];
  /**
   * 雪の噛み込みで落ちている制動力の割合 0..1（編成でいちばん悪い車）。
   * 耐雪ブレーキを入れて制輪子を当てておけば 0 へ戻る。
   */
  snowLoss: number;
}

export interface BrakeContext {
  readonly dynamics: TrainDynamics;
  readonly traction: TractionSystem;
  readonly loadFactor: number;
  readonly regenerationReceptivity: number;
  readonly lineVoltage: number;
  /**
   * 軌条（天候）の状態。省略時は乾燥。
   *
   * 粘着だけでなく制輪子の利きにも効く。降雪中に制輪子を離したままにしておくと
   * 踏面とのあいだへ雪が入り込み、同じ BC 圧でも制動力が落ちる。
   */
  readonly railCondition?: RailCondition;
}

/**
 * ブレーキ装置のインタフェース。
 * 電気指令式（電空協調）のほかに、自動空気ブレーキ（ブレーキ管圧力伝播）などを
 * 同じインタフェースの別実装として差し込める。
 */
export interface BrakeSystem {
  readonly state: BrakeState;
  setCommand(command: BrakeCommand): void;
  /** 制御周期ごとに呼ばれ、各軸の brakeTorque を更新する */
  update(dt: number, ctx: BrakeContext): void;
  /** ノッチに対応する指令減速度 [m/s^2] */
  decelerationForNotch(notch: number): MetersPerSecondSquared;
  /** 編成の平均ブレーキシリンダ圧 [Pa]（計器表示用） */
  averageCylinderPressure(): Pascals;
}
