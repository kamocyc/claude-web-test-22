import type { Meters, MetersPerSecond, Seconds } from '../units.ts';
import type { BeaconPayload, SignalAspect } from '../route/types.ts';
import type { SignallingSystem } from '../signalling/system.ts';

/** 保安装置が運転士へ示す表示・報知 */
export interface SafetyIndication {
  /** ベル（連続的な警報音） */
  bell: boolean;
  /** チャイム（確認扱い後の継続音） */
  chime: boolean;
  /** パターン接近表示 */
  patternApproach: boolean;
  /** ブレーキ動作中表示 */
  brakeApplied: boolean;
  /** 車内信号の現示速度 [m/s]（ATC のみ。それ以外は null） */
  cabSignalSpeed: MetersPerSecond | null;
  /** 現在のパターン速度 [m/s]（照査していないときは null） */
  patternSpeed: MetersPerSecond | null;
}

/** 保安装置からの出力 */
export interface SafetyOutput {
  /** 非常ブレーキを動作させる */
  emergencyBrake: boolean;
  /** 常用ブレーキノッチの下限指令（null なら介入しない） */
  serviceBrakeNotch: number | null;
  /** 力行を遮断する */
  cutOffTraction: boolean;
  readonly indication: SafetyIndication;
}

/** 運転士の操作状況（EB・デッドマン装置の判定に使う） */
export interface DriverActivity {
  /** 確認扱い（ATS 確認ボタン）が押されたか（そのステップで立ち上がったか） */
  readonly acknowledge: boolean;
  /** 直近に何らかの操作があったか（ノッチ操作・警笛など） */
  readonly anyOperation: boolean;
}

/** 保安装置に渡される情報 */
export interface SafetyContext {
  readonly time: Seconds;
  /** 列車先頭端の距離程 [m] */
  readonly position: Meters;
  /** 前ステップの先頭端距離程 [m]（地上子の通過判定に使う） */
  readonly previousPosition: Meters;
  readonly speed: MetersPerSecond;
  readonly signalling: SignallingSystem;
  readonly driver: DriverActivity;
  /** 路線の最高速度 [m/s] */
  readonly lineSpeedLimit: MetersPerSecond;
  /** 現在位置の速度制限 [m/s] */
  readonly currentSpeedLimit: MetersPerSecond;
}

/**
 * 保安装置のインタフェース。
 * ATS-SN / ATS-P / ATC をそれぞれ別実装として持ち、区間ごとに切り替える。
 */
export interface SafetySystem {
  readonly kind: string;
  /** 地上子を通過したときに呼ばれる */
  onBeacon(payload: BeaconPayload, atPosition: Meters, ctx: SafetyContext): void;
  /** 制御周期ごとに呼ばれる */
  update(dt: Seconds, ctx: SafetyContext): SafetyOutput;
  /** 非常ブレーキの復帰操作（停止後のみ有効） */
  reset(): void;
}

export const NO_INDICATION: SafetyIndication = {
  bell: false,
  chime: false,
  patternApproach: false,
  brakeApplied: false,
  cabSignalSpeed: null,
  patternSpeed: null,
};

export const noOutput = (): SafetyOutput => ({
  emergencyBrake: false,
  serviceBrakeNotch: null,
  cutOffTraction: false,
  indication: { ...NO_INDICATION },
});

/** 現示が進行を許すか（ATS-SN の警報判定） */
export function isRestrictive(aspect: SignalAspect): boolean {
  return aspect === 'R' || aspect === 'YY' || aspect === 'Y';
}
