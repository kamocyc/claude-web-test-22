import type { Meters, MetersPerSecond, Seconds } from '../units.ts';
import {
  aspectFromRank,
  aspectRank,
  occupancyOverlaps,
  type BlockSection,
  type CompiledRoute,
  type Occupancy,
  type SignalAspect,
  type SignalDefinition,
} from '../route/types.ts';

/**
 * ダイヤ上の他列車が走る線路。
 *
 * - `own` — 自列車と同じ線路。先行列車がこれで、閉塞を占有するので信号現示が変わる。
 * - `adjacent` — 交換設備の隣の線路。**別の線路なので閉塞は占有しない**。
 *   対向列車がこれで、影響するのは信号ではなく、すれ違うときの音と踏切の鳴動である。
 */
export type ScheduledTrainTrack = 'own' | 'adjacent';

/** ダイヤ上の他列車（先行列車・対向列車）。時刻に対する位置の折れ線で表す。 */
export interface ScheduledTrain {
  readonly id: string;
  /** 編成長 [m] */
  readonly length: Meters;
  /** どの線路を走るか（省略時は自列車と同じ線路） */
  readonly track?: ScheduledTrainTrack;
  /**
   * 時刻 [s] と**先頭端**の距離程 [m] の折れ線（時刻昇順）。
   *
   * 距離程が減っていく折れ線を書けば対向列車になる。先頭端はつねに進行方向の
   * 先の端なので、対向列車では編成が距離程の**大きい側**へ伸びる。
   */
  readonly waypoints: ReadonlyArray<{ readonly time: Seconds; readonly position: Meters }>;
}

/** 他列車の走行状態 */
export interface ScheduledTrainState {
  readonly train: ScheduledTrain;
  /** 先頭端の距離程 [m] */
  readonly leadPosition: Meters;
  /** 進行の向き（+1 = 距離程が増える向き） */
  readonly direction: 1 | -1;
  /** 速度 [m/s]（進行方向の大きさ） */
  readonly speed: MetersPerSecond;
  /** 距離程での在線範囲 */
  readonly occupancy: Occupancy;
}

/** 折れ線を時刻で内挿して、先頭端の位置と速度を求める */
export function scheduledTrainState(
  train: ScheduledTrain,
  time: Seconds,
): ScheduledTrainState | null {
  const wp = train.waypoints;
  if (wp.length === 0) return null;
  if (time < wp[0]!.time || time > wp[wp.length - 1]!.time) return null;
  let lead = wp[0]!.position;
  let velocity = 0;
  for (let i = 1; i < wp.length; i++) {
    const a = wp[i - 1]!;
    const b = wp[i]!;
    if (time <= b.time) {
      const span = b.time - a.time;
      const t = span === 0 ? 0 : (time - a.time) / span;
      lead = a.position + (b.position - a.position) * t;
      velocity = span === 0 ? 0 : (b.position - a.position) / span;
      break;
    }
    lead = b.position;
    velocity = b.time === a.time ? 0 : (b.position - a.position) / (b.time - a.time);
  }
  // 進行の向きは折れ線の向きそのもの。距離程が減っていれば対向列車である。
  const direction: 1 | -1 = velocity < 0 ? -1 : 1;
  const occupancy: Occupancy =
    direction > 0
      ? { front: lead, rear: lead - train.length }
      : { front: lead + train.length, rear: lead };
  return { train, leadPosition: lead, direction, speed: Math.abs(velocity), occupancy };
}

/** 他列車の在線位置を求める。区間外なら null（在線していない）。 */
export function scheduledOccupancy(train: ScheduledTrain, time: Seconds): Occupancy | null {
  return scheduledTrainState(train, time)?.occupancy ?? null;
}

/** 信号機の現在状態 */
export interface SignalState {
  readonly definition: SignalDefinition;
  aspect: SignalAspect;
  /** この現示で許容される速度 [m/s] */
  speed: MetersPerSecond;
  /** 防護する閉塞が在線しているか */
  blockOccupied: boolean;
}

/**
 * 閉塞・信号現示を管理する。
 *
 * 現示の決定は実際の自動閉塞式と同じ考え方で行う:
 *
 *  1. 防護する閉塞に列車が在線していれば停止現示 (R)
 *  2. そうでなければ、前方の信号機の現示より 1 段高い現示を出す
 *     （R の手前は Y、Y の手前は YG、YG の手前は G）
 *  3. ただし信号機ごとの最大現示（3 現示信号機なら Y まで）で頭打ちにする
 *
 * これにより、先行列車が進むにつれて後方の信号が段階的に現示アップしていく
 * 実際の動きがそのまま再現される。
 */
export class SignallingSystem {
  private readonly route: CompiledRoute;
  private readonly states = new Map<string, SignalState>();
  /** 直前の更新時点の現示。信号機を通過した瞬間の判定に使う。 */
  private readonly previousAspects = new Map<string, SignalAspect>();
  private readonly blocksBySignal = new Map<string, BlockSection>();
  /** 距離程昇順に並べた信号機 */
  private readonly ordered: SignalDefinition[];
  readonly scheduledTrains: ScheduledTrain[];
  /**
   * いま走っているダイヤ列車の状態（`update()` のたびに作り直す）。
   * 信号のためだけでなく、踏切の鳴動・すれ違いの音・描画もここから読む。
   */
  readonly trainStates: ScheduledTrainState[] = [];

  constructor(route: CompiledRoute, scheduledTrains: readonly ScheduledTrain[] = []) {
    this.route = route;
    this.scheduledTrains = [...scheduledTrains];
    this.ordered = [...route.signals].sort((a, b) => a.position - b.position);
    for (const block of route.blocks) this.blocksBySignal.set(block.signalId, block);
    for (const sig of this.ordered) {
      this.states.set(sig.id, {
        definition: sig,
        aspect: 'R',
        speed: 0,
        blockOccupied: false,
      });
    }
  }

  get signals(): readonly SignalDefinition[] {
    return this.ordered;
  }

  state(signalId: string): SignalState | undefined {
    return this.states.get(signalId);
  }

  aspectOf(signalId: string): SignalAspect {
    return this.states.get(signalId)?.aspect ?? 'R';
  }

  /**
   * 直前の更新時点での現示。
   *
   * 列車が信号機を通過した瞬間、その列車自身が次の閉塞に入るために信号は停止現示へ変わる。
   * これは後続列車に対しては正しい動作だが、「その信号を冒進したか」を判定するのに
   * 使ってしまうと、正常に進行現示で通過した列車まで冒進と誤判定してしまう。
   * 通過判定には、列車がまだ手前の閉塞にいた時点の現示であるこちらを使う。
   */
  aspectBefore(signalId: string): SignalAspect {
    return this.previousAspects.get(signalId) ?? this.aspectOf(signalId);
  }

  /** 現示に対応する許容速度 [m/s] */
  speedForAspect(sig: SignalDefinition, aspect: SignalAspect): MetersPerSecond {
    const override = sig.aspectSpeeds?.[aspect];
    if (override !== undefined) return override;
    return this.route.aspectSpeeds[aspect];
  }

  /**
   * 在線情報から全信号機の現示を更新する。
   * @param own 自列車の在線範囲
   * @param time シミュレーション時刻（ダイヤ列車の位置算出に使う）
   */
  update(own: Occupancy, time: Seconds): void {
    for (const [id, st] of this.states) this.previousAspects.set(id, st.aspect);

    this.trainStates.length = 0;
    const occupancies: Occupancy[] = [own];
    for (const train of this.scheduledTrains) {
      const state = scheduledTrainState(train, time);
      if (!state) continue;
      this.trainStates.push(state);
      // 閉塞を占有するのは同じ線路を走る列車だけ。隣の線路（交換設備）の
      // 対向列車は、こちらの信号現示には関係しない。
      if ((train.track ?? 'own') === 'own') occupancies.push(state.occupancy);
    }

    // 1. 各閉塞の在線判定
    for (const sig of this.ordered) {
      const st = this.states.get(sig.id)!;
      const block = this.blocksBySignal.get(sig.id);
      st.blockOccupied = block
        ? occupancies.some((o) => occupancyOverlaps(o, block.start, block.end))
        : false;
    }

    // 2. 後方（距離程の小さい側）へ向かって現示を決める
    let nextRank = aspectRank('G'); // 最終閉塞の先は進行と見なす
    for (let i = this.ordered.length - 1; i >= 0; i--) {
      const sig = this.ordered[i]!;
      const st = this.states.get(sig.id)!;
      let rank: number;
      if (st.blockOccupied) {
        rank = aspectRank('R');
      } else {
        rank = Math.min(nextRank + 1, aspectRank(sig.maxAspect));
      }
      st.aspect = aspectFromRank(rank);
      st.speed = this.speedForAspect(sig, st.aspect);
      nextRank = rank;
    }
  }

  /** 距離程 s の直前（後方）にある信号機 */
  signalBehind(s: Meters): SignalState | undefined {
    let found: SignalDefinition | undefined;
    for (const sig of this.ordered) {
      if (sig.position <= s) found = sig;
      else break;
    }
    return found ? this.states.get(found.id) : undefined;
  }

  /** 距離程 s より前方にある直近の信号機 */
  signalAhead(s: Meters): { state: SignalState; distance: Meters } | undefined {
    for (const sig of this.ordered) {
      if (sig.position > s) {
        return { state: this.states.get(sig.id)!, distance: sig.position - s };
      }
    }
    return undefined;
  }

  /**
   * 現在位置で車内信号（ATC）が示すべき許容速度 [m/s]。
   * 直近の後方信号機の現示（＝いま走っている閉塞の許容速度）を採る。
   */
  cabSignalSpeed(s: Meters): MetersPerSecond {
    const behind = this.signalBehind(s);
    if (!behind) return this.route.aspectSpeeds.G;
    return behind.speed;
  }

  /** 前方の停止現示信号までの距離 [m]（無ければ Infinity） */
  distanceToStopSignal(s: Meters): Meters {
    for (const sig of this.ordered) {
      if (sig.position <= s) continue;
      const st = this.states.get(sig.id)!;
      if (st.aspect === 'R') return sig.position - s;
    }
    return Infinity;
  }

  /** 全信号機の現示を一覧で返す（描画用） */
  snapshot(): Array<{ id: string; position: Meters; aspect: SignalAspect; speed: number }> {
    return this.ordered.map((sig) => {
      const st = this.states.get(sig.id)!;
      return { id: sig.id, position: sig.position, aspect: st.aspect, speed: st.speed };
    });
  }
}
