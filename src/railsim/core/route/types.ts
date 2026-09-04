import type { PointTable, SpanTable, StepTable } from '../math/table.ts';
import type { TrackIrregularity } from '../physics/irregularity.ts';
import type { RailJointFeature } from '../physics/railJoint.ts';
import type { Alignment } from '../track/alignment.ts';
import type { BridgeTrack } from '../track/bridge.ts';
import type { LevelCrossingTrack } from '../track/levelCrossing.ts';
import type { AdjacentTrack } from '../track/passingLoop.ts';
import type { TurnoutTrack } from '../track/turnout.ts';
import type { Meters, MetersPerSecond, Seconds } from '../units.ts';

/** 信号現示。数値が大きいほど高速で進行できる。 */
export type SignalAspect = 'R' | 'YY' | 'Y' | 'YG' | 'G';

/** 現示の序列（現示アップの計算に使う） */
export const ASPECT_ORDER: readonly SignalAspect[] = ['R', 'YY', 'Y', 'YG', 'G'];

export const aspectRank = (a: SignalAspect): number => ASPECT_ORDER.indexOf(a);
export const aspectFromRank = (r: number): SignalAspect =>
  ASPECT_ORDER[Math.max(0, Math.min(ASPECT_ORDER.length - 1, r))]!;

/** 現示ごとの許容速度 [m/s] */
export type AspectSpeeds = Readonly<Record<SignalAspect, MetersPerSecond>>;

/** 信号機の種別 */
export type SignalKind = 'block' | 'home' | 'starting' | 'distant';

export interface SignalDefinition {
  readonly id: string;
  /** 信号機の位置（距離程）[m] */
  readonly position: Meters;
  /** 種別 */
  readonly kind: SignalKind;
  /** この信号機が出しうる最大現示（3 現示の信号機なら 'Y' など） */
  readonly maxAspect: SignalAspect;
  /** 現示ごとの許容速度（省略時は路線既定値） */
  readonly aspectSpeeds?: Partial<AspectSpeeds>;
}

/** 閉塞区間。信号機の位置から次の信号機の位置までを 1 閉塞とする。 */
export interface BlockSection {
  readonly id: string;
  readonly start: Meters;
  readonly end: Meters;
  /** この閉塞を防護する信号機 */
  readonly signalId: string;
}

/** 駅 */
export interface Station {
  readonly id: string;
  readonly name: string;
  /** 停止位置目標（列車先頭端を合わせる距離程）[m] */
  readonly stopPosition: Meters;
  /** ホーム始端 [m] */
  readonly platformStart: Meters;
  /** ホーム終端 [m] */
  readonly platformEnd: Meters;
  /** 通過駅か */
  readonly isPass: boolean;
  /** 停車時分 [s] */
  readonly dwellTime: Seconds;
  /** 停止位置の許容誤差 [m] */
  readonly stopTolerance: Meters;
  /** 着時刻（基準時刻からの秒）*/
  readonly arrivalTime?: Seconds;
  /** 発時刻 */
  readonly departureTime?: Seconds;
}

/** 速度制限 */
export interface SpeedLimitEntry {
  readonly id: string;
  /** 制限が始まる距離程 [m] */
  readonly start: Meters;
  /** 制限速度 [m/s] */
  readonly speed: MetersPerSecond;
  /** 制限の理由（表示用） */
  readonly reason: 'curve' | 'turnout' | 'temporary' | 'line' | 'station';
}

/** トンネル区間 */
export interface TunnelSection {
  readonly id: string;
  readonly start: Meters;
  readonly end: Meters;
}

/** 地上子が車上装置へ伝える情報 */
export type BeaconPayload =
  /** ATS-SN のロング地上子（警報。確認扱いが必要） */
  | { readonly kind: 'ats-sn-long'; readonly signalId: string }
  /** ATS-SN の直下地上子（停止現示なら即時非常） */
  | { readonly kind: 'ats-sn-immediate'; readonly signalId: string }
  /** ATS-P: 信号機までの距離を伝える */
  | { readonly kind: 'ats-p-signal'; readonly signalId: string; readonly distance: Meters }
  /** ATS-P: 速度制限の始端までの距離と制限速度を伝える */
  | {
      readonly kind: 'ats-p-limit';
      readonly limitId: string;
      readonly distance: Meters;
      readonly speed: MetersPerSecond;
    }
  /** ATS-P: 線路終端（車止め）までの距離 */
  | { readonly kind: 'ats-p-terminus'; readonly distance: Meters };

/** 保安装置の種別 */
export type SafetySystemKind = 'ats-sn' | 'ats-p' | 'atc';

/** 保安装置の適用区間 */
export interface SafetySection {
  readonly start: Meters;
  readonly end: Meters;
  readonly kind: SafetySystemKind;
}

/** コンパイル済みの路線データ */
export interface CompiledRoute {
  readonly id: string;
  readonly name: string;
  readonly alignment: Alignment;
  readonly length: Meters;
  /** 線路の最高速度 [m/s] */
  readonly maxSpeed: MetersPerSecond;
  readonly stations: readonly Station[];
  readonly signals: readonly SignalDefinition[];
  readonly blocks: readonly BlockSection[];
  /** 距離程 -> 制限速度 [m/s] */
  readonly speedLimits: StepTable<number>;
  /** 制限速度の一覧（パターン生成用） */
  readonly speedLimitEntries: readonly SpeedLimitEntry[];
  readonly tunnels: SpanTable<TunnelSection>;
  readonly beacons: PointTable<BeaconPayload>;
  readonly safetySections: SpanTable<SafetySystemKind>;
  /** 軌道狂い（距離程の関数。線路そのものの性質なので路線データが持つ） */
  readonly irregularity: TrackIrregularity;
  /**
   * 分岐器。
   *
   * 開通方向（`route`）まで含めて路線データが持つ。分岐側へ開通している分岐器の
   * 先は別の線形になるため、進路が違えば**別の路線データ**になるという扱いである。
   */
  readonly turnouts: TurnoutTrack;
  /**
   * 橋りょう。桁の寸法から音が決まるので、形式ではなく寸法を持つ。
   */
  readonly bridges: BridgeTrack;
  /** 踏切道 */
  readonly levelCrossings: LevelCrossingTrack;
  /**
   * 交換設備の「隣の線路」。単線なのでここにしか無く、対向列車とすれ違えるのも
   * ここだけである。
   */
  readonly adjacentTrack: AdjacentTrack;
  /**
   * 距離程 -> レールの継目間隔 [m]（0 = ロングレール）。
   * 定尺レール区間では軸が継目を踏むたびに衝撃音が出る。
   */
  readonly railJointSpacing: StepTable<number>;
  /**
   * 個別に置かれた継目（絶縁継目・伸縮継目）。
   *
   * `railJointSpacing` が周期として持つ定尺の継目とは別に、**そこに置く理由が
   * ある継目**を 1 つずつ持つ。分岐器の前後には軌道回路を区切る絶縁継目が、
   * 橋りょうの両端には桁の伸縮を逃がす伸縮継目がある。したがって
   * ロングレール区間でも、分岐器と橋の前後だけは継目の音がする。
   */
  readonly railJoints: PointTable<RailJointFeature>;
  /**
   * 距離程 -> レール波状摩耗（コルゲーション）の深さ 0..1。
   *
   * レール踏面には走行を重ねるうちに波長数 cm の周期的な摩耗ができる。粗さの
   * スペクトルにその波長の峰が立つので、転動音に `v / 波長` の狭帯域のうなりが
   * 現れる。速度に比例して音程が上がるので、ロングレール区間を高速で走ると
   * 継目音の代わりにこの連続した唸りが主役になる。
   */
  readonly railCorrugation: StepTable<number>;
  /** 許容カント不足 [m]。曲線の制限速度はこれを基準に決まる。 */
  readonly maxCantDeficiency: Meters;
  /** 現示ごとの既定許容速度 */
  readonly aspectSpeeds: AspectSpeeds;
}

/** 列車が占有する距離程の範囲 */
export interface Occupancy {
  readonly rear: Meters;
  readonly front: Meters;
}

/** 区間が重なるか */
export function occupancyOverlaps(a: Occupancy, start: Meters, end: Meters): boolean {
  return a.front > start && a.rear < end;
}

/**
 * 列車にかかっている制限速度 [m/s]。
 *
 * 引くのは先頭端の 1 点ではなく**在線範囲**である。速度制限は先頭が制限区間へ
 * 入った時点で効きはじめ、**最後部が抜けるまで**解けない。曲線の中に車体が
 * 残っているうちに加速してよい理由は無いので、これは取扱の決まりごとである以前に
 * 物理の話である。閉塞の在線判定 (`occupancyOverlaps`) が最後部で閉塞を開放するのと
 * 同じ考え方で、列車を点ではなく長さのあるものとして扱う。
 *
 * 4 両編成なら 80m あるので、R400（制限 80km/h）を抜けたあとも 80m のあいだは
 * 制限が続く。80km/h で走っていれば 3.6 秒ぶんになる。分岐器の制限は制限区間の
 * ほうが編成長より短いことすらあり、そこでは**在線範囲で引くかどうかが制限の
 * 長さそのものを決める**。
 *
 * 在線範囲に複数の制限が跨がっているときは最も低いものを採る。編成より短い
 * 一時制限が編成の中にすっぽり収まっている場合も、これで拾える。
 */
export function occupiedSpeedLimit(
  limits: StepTable<number>,
  occupancy: Occupancy,
): MetersPerSecond {
  const rear = Math.max(0, Math.min(occupancy.rear, occupancy.front));
  let lowest = Number.POSITIVE_INFINITY;
  for (const entry of limits.entriesInRange(rear, occupancy.front)) {
    if (entry.value < lowest) lowest = entry.value;
  }
  return lowest;
}
