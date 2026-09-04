import type { AdjacentTrack } from '../track/passingLoop.ts';
import type { Meters, MetersPerSecond } from '../units.ts';
import type { ScheduledTrainState } from './system.ts';

/**
 * 対向列車とのすれ違い。
 *
 * 運転台から見た**相手の両端の位置**と**相対速度**だけを持つ。音の作り方
 * （ドップラー・距離減衰・圧力波）はこの 3 つから決まるので、ここでは音の話は
 * せず、幾何と運動だけを出す。
 *
 * すれ違いで起きることは 2 つある。
 *
 *  1. **圧力波** — 2 つの車体が至近距離で交差すると、先頭部が押しのけた空気の
 *     圧力場が相手の側面を叩く。車体表面の圧力変化は動圧に比例するので、
 *     大きさは相対速度の 2 乗で効く。先頭がすれ違うときと最後尾が抜けるときの
 *     2 回、向きが逆の圧が来る。
 *  2. **相手の走行音** — 相手の転動音が、線路中心間隔ぶんだけ離れた場所から
 *     直接届く。近づいているあいだは音源が自分へ向かってくるので音程が上がり、
 *     すれ違った瞬間に下がる。下がり幅は**相対速度**で決まるので、対向列車の
 *     ほうが自分より速ければ、自分が止まっていても大きく変わる。
 */
export interface PassingEncounter {
  readonly trainId: string;
  /** 相手の先頭端が運転台からどれだけ前方か [m]（負 = すれ違い済み） */
  readonly headGap: Meters;
  /** 相手の最後尾が運転台からどれだけ前方か [m]（負 = 抜けきった） */
  readonly tailGap: Meters;
  /** 相対速度 [m/s]（近づく向きが正）。すれ違いの速さそのもの。 */
  readonly closingSpeed: MetersPerSecond;
  /** 相手の速度 [m/s] */
  readonly otherSpeed: MetersPerSecond;
  /** 線路中心間隔 [m]。すれ違いの最接近距離になる。 */
  readonly lateralSeparation: Meters;
}

/**
 * すれ違いの音が届く範囲 [m]。
 * これより遠い対向列車は、自分の走行音に埋もれて聞こえない。
 */
const AUDIBLE_RANGE: Meters = 400;

/** 線路中心間隔の下限 [m]（分岐器の中では 0 に近づくので、そこで割らないため） */
const MIN_SEPARATION: Meters = 1.5;

/** 運転台と相手の編成との、線路方向の隙間 [m]（並んでいるあいだは 0） */
export function passingLongitudinalGap(encounter: PassingEncounter): Meters {
  const { headGap, tailGap } = encounter;
  if (headGap <= 0 && tailGap >= 0) return 0;
  return headGap > 0 ? headGap : -tailGap;
}

/** 運転台から相手までの距離 [m]（線路方向の隙間と線路中心間隔の合成） */
export function passingDistance(encounter: PassingEncounter): Meters {
  return Math.hypot(passingLongitudinalGap(encounter), encounter.lateralSeparation);
}

/**
 * いちばん近い対向列車とのすれ違いを求める。
 *
 * 相手にするのは**隣の線路**を走る列車だけである。同じ線路の先行列車は追い越しも
 * すれ違いもしない（できてしまったら衝突である）。
 */
export function nearestPassingEncounter(
  cab: Meters,
  ownSpeed: MetersPerSecond,
  states: readonly ScheduledTrainState[],
  adjacent: AdjacentTrack,
): PassingEncounter | null {
  let best: PassingEncounter | null = null;
  let bestDistance = Infinity;

  for (const state of states) {
    if ((state.train.track ?? 'own') !== 'adjacent') continue;
    // 相手の先頭端は進行方向の先の端。対向列車なら距離程の小さい側になる。
    const head = state.direction > 0 ? state.occupancy.front : state.occupancy.rear;
    const tail = state.direction > 0 ? state.occupancy.rear : state.occupancy.front;
    const headGap = head - cab;
    const tailGap = tail - cab;
    // 相手のいちばん近い端の位置で線路中心間隔を読む（分岐器の中では狭い）
    const nearest = Math.abs(headGap) < Math.abs(tailGap) ? head : tail;
    const encounter: PassingEncounter = {
      trainId: state.train.id,
      headGap,
      tailGap,
      // 隙間が縮む速さ。相手が逆向きなら両方の速度が足し合わされる。
      closingSpeed: ownSpeed - state.direction * state.speed,
      otherSpeed: state.speed,
      lateralSeparation: Math.max(MIN_SEPARATION, Math.abs(adjacent.offsetAt(nearest))),
    };
    const distance = passingDistance(encounter);
    if (distance > AUDIBLE_RANGE || distance >= bestDistance) continue;
    bestDistance = distance;
    best = encounter;
  }
  return best;
}
