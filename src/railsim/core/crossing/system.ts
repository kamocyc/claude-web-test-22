import { clamp } from '../math/scalar.ts';
import type { Occupancy } from '../route/types.ts';
import {
  crossingEdges,
  type LevelCrossing,
  type LevelCrossingTrack,
} from '../track/levelCrossing.ts';
import type { Seconds } from '../units.ts';

/**
 * 踏切保安装置。
 *
 * 踏切は列車の位置を見て自分で鳴り、自分で遮断する装置なので、扉
 * （`DoorSystem`）と同じく**時間発展を持つ装置**として扱う。位置から
 * その場で計算できるのは「鳴っているか」までで、遮断桿の角度は
 * 「警報開始からどれだけ経ったか」で決まるため、状態を持たないと出せない。
 *
 * 動きは実物の順序どおり:
 *
 *   列車が警報開始点を踏む → 警報開始（鳴動・閃光）
 *   → 数秒おいて遮断桿が下り始める → 下りきる → 列車通過
 *   → 最後部が踏切道を抜ける → 警報停止・遮断桿上昇
 *
 * 遮断が警報より遅れて始まるのは、鳴り出した瞬間に竿が下りると渡っている
 * 途中の人が閉じ込められるためで、この数秒があるから「カンカン鳴り始めてから
 * 竿が下りる」という見え方になる。
 */

/** 進行の向きを持つ在線範囲 */
export interface DirectedOccupancy extends Occupancy {
  /** 進行の向き（+1 = 距離程が増える向き） */
  readonly direction: 1 | -1;
}

/** 踏切 1 か所の状態 */
export interface LevelCrossingState {
  readonly crossing: LevelCrossing;
  /** 鳴動しているか */
  ringing: boolean;
  /** 警報開始からの経過時間 [s]（鳴っていなければ 0） */
  elapsed: Seconds;
  /** 遮断桿の下がり具合 0（上）..1（下） */
  barrier: number;
}

/**
 * 列車が踏切の警報を要求しているか。
 *
 * 前方（進行方向）は警報開始距離まで、後方は**最後部が踏切道を抜けるまで**。
 * 抜けた瞬間に切れるので、長い編成ほど鳴り終わりが遅い。反対方向から来る列車も
 * 同じ判定を向きだけ入れ替えて行う（踏切はどちらから来る列車にも鳴る）。
 */
function demandsWarning(crossing: LevelCrossing, train: DirectedOccupancy): boolean {
  const [entry, exit] = crossingEdges(crossing);
  if (train.direction > 0) {
    return train.front > entry - crossing.warningDistance && train.rear < exit;
  }
  return train.rear < exit + crossing.warningDistance && train.front > entry;
}

export class LevelCrossingSystem {
  readonly states: LevelCrossingState[];

  constructor(track: LevelCrossingTrack) {
    this.states = track.crossings.map((crossing) => ({
      crossing,
      ringing: false,
      elapsed: 0,
      barrier: 0,
    }));
  }

  /**
   * @param trains 在線している列車すべて（自列車とダイヤ列車）。
   *               踏切は線路上の列車を検知するだけで、どの列車かは区別しない。
   */
  update(dt: Seconds, trains: readonly DirectedOccupancy[]): void {
    for (const state of this.states) {
      const ringing = trains.some((train) => demandsWarning(state.crossing, train));
      if (ringing) {
        state.elapsed = state.ringing ? state.elapsed + dt : 0;
        state.ringing = true;
        const { barrierDelay, barrierFall } = state.crossing;
        state.barrier = clamp((state.elapsed - barrierDelay) / barrierFall, 0, 1);
      } else {
        state.ringing = false;
        state.elapsed = 0;
        state.barrier = clamp(state.barrier - dt / state.crossing.barrierRise, 0, 1);
      }
    }
  }

  /** 距離程 s にいちばん近い、鳴っている踏切 */
  nearestRinging(s: number): LevelCrossingState | undefined {
    let best: LevelCrossingState | undefined;
    let bestDistance = Infinity;
    for (const state of this.states) {
      if (!state.ringing) continue;
      const d = Math.abs(state.crossing.position - s);
      if (d < bestDistance) {
        bestDistance = d;
        best = state;
      }
    }
    return best;
  }

  state(id: string): LevelCrossingState | undefined {
    return this.states.find((s) => s.crossing.id === id);
  }
}
