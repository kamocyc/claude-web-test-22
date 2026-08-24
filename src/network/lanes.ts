import type { Vector2 } from 'three';
import { DEG } from '../core/units';
import { STRAIGHT_THROUGH_ANGLE, type NetworkClass } from './classes';
import type { Approach, Junction } from './junction';
import type { SegmentId } from './network';

/**
 * 車線のモデル。
 *
 * 種別 (`NetworkClass.lanes`) が持っているのは断面の中の位置だけなので、
 * 「どの車線がどちら向きに走るか」「交差点でどの車線からどこへ行けるか」を
 * ここで組み立てる。左側通行 (`DRIVE_ON_LEFT`) を前提にしている。
 *
 * 進路の呼び方は日本の道路標示に合わせる。左折は歩道側へ回るだけの小回り、
 * 右折は対向車線を横切る大回りで、右折車線は中央寄りに置く。
 */

/** 交差点での進路。 */
export type Movement = 'left' | 'through' | 'right' | 'uturn';

/** 転回とみなす偏角。これより大きく曲がる進路は車線を割り当てない。 */
export const UTURN_ANGLE = 160 * DEG;

/** セグメント上の 1 車線。 */
export interface Lane {
  segment: SegmentId;
  /** `cls.lanes` の添字。 */
  index: number;
  /** 中心線からの横距離 (線形の右手側が正)。 */
  offset: number;
  width: number;
  /** 線形の向き (弧長が増える向き) に走るか。 */
  forward: boolean;
}

/**
 * セグメントの車線を、断面の左から順に返す。
 *
 * 線路は 1 本の軌道を両方向の車線として持つので、同じ横距 (0) の車線が
 * 向き違いで 2 本返る。
 */
export function lanesOf(cls: NetworkClass, segment: SegmentId): Lane[] {
  return cls.lanes.map((spec, index) => ({
    segment,
    index,
    offset: spec.offset,
    width: spec.width,
    forward: spec.direction === 1,
  }));
}

/**
 * 進行方向 `inbound` で交差点に入った車が、`outbound` の向きへ出るときの進路。
 *
 * XZ 平面を `Vector2(x = X, y = Z)` として扱うと、外積が正 = 右へ曲がる。
 */
export function movementBetween(inbound: Vector2, outbound: Vector2): Movement {
  const cross = inbound.x * outbound.y - inbound.y * outbound.x;
  const angle = Math.atan2(cross, inbound.dot(outbound));
  const turn = Math.abs(angle);
  if (turn <= STRAIGHT_THROUGH_ANGLE) return 'through';
  if (turn >= UTURN_ANGLE) return 'uturn';
  return angle > 0 ? 'right' : 'left';
}

/** 標示・シミュレーションで扱う進路を、左から右の順に並べたもの。 */
const MOVEMENT_ORDER: Movement[] = ['left', 'through', 'right'];

/** 交差点の 1 枝から出ていける行き先。 */
export interface Exit {
  movement: Movement;
  approach: Approach;
  /** その枝の、この交差点から出ていく車線 (歩道側から中央側の順)。 */
  lanes: Lane[];
}

/** 交差点の 1 枝の車線割り当て。 */
export interface ApproachLanes {
  approach: Approach;
  segment: SegmentId;
  /**
   * 交差点へ入る車線と、そこから行ける進路。
   * 並びは歩道側 (左側通行では車の左手) から中央側。
   */
  entry: { lane: Lane; movements: Movement[] }[];
  /** 交差点から出ていく車線 (歩道側から中央側の順)。 */
  exit: Lane[];
  /** 行ける先。 */
  exits: Exit[];
}

/**
 * 枝の車線を、外向き方向から見た横距で並べ替えるための係数。
 *
 * 外向き方向 (ノードから離れる向き) の右手側を正とすると、左側通行では
 * 交差点へ**入る**車線が正の側、**出る**車線が負の側に来る。
 */
function outwardOffset(lane: Lane, atStart: boolean): number {
  return atStart ? lane.offset : -lane.offset;
}

/** 交差点に入る車線か (`atStart` はノードがセグメントの a 側かどうか)。 */
function isEntry(lane: Lane, atStart: boolean): boolean {
  return lane.forward !== atStart;
}

/**
 * 交差点の全ての枝について、車線と進路の対応を解く。
 *
 * 道路の交差点だけを扱う。線路の進路は分岐器として `Junction.connections`
 * が持っているので、そちらを使う。
 */
export function solveApproachLanes(junction: Junction): Map<SegmentId, ApproachLanes> {
  const out = new Map<SegmentId, ApproachLanes>();
  // 継ぎ目・折れ点でも車線は繋がる (交差点面は作らないが通行はできる)。
  const passable =
    junction.kind === 'intersection' || junction.kind === 'joint' || junction.kind === 'seam';
  if (!passable) return out;

  const lanesFor = (approach: Approach): Lane[] =>
    lanesOf(approach.branch.cls, approach.branch.segment);

  for (const approach of junction.approaches) {
    if (approach.branch.cls.kind !== 'road') continue;
    const atStart = approach.branch.atStart;
    const lanes = lanesFor(approach);

    // 入る車線は歩道側 (外向きから見て横距が大きい方) から並べる。
    const entryLanes = lanes
      .filter((lane) => isEntry(lane, atStart))
      .sort((a, b) => outwardOffset(b, atStart) - outwardOffset(a, atStart));
    // 出る車線も歩道側 (横距が小さい = 負に大きい方) から並べる。
    const exitLanes = lanes
      .filter((lane) => !isEntry(lane, atStart))
      .sort((a, b) => outwardOffset(a, atStart) - outwardOffset(b, atStart));

    const inbound = approach.dir.clone().negate();
    const exits: Exit[] = [];
    for (const other of junction.approaches) {
      if (other === approach) continue;
      if (other.branch.cls.kind !== 'road') continue;
      const otherLanes = lanesFor(other)
        .filter((lane) => !isEntry(lane, other.branch.atStart))
        .sort(
          (a, b) =>
            outwardOffset(a, other.branch.atStart) - outwardOffset(b, other.branch.atStart),
        );
      // 出ていく車線がない (一方通行の入口側) 枝へは進めない。
      if (otherLanes.length === 0) continue;
      const movement = movementBetween(inbound, other.dir);
      if (movement === 'uturn') continue;
      // 中央分離帯のある道路では対向車線を横切れない。左側通行では、
      // 進行方向の右手へ出る進路がそれにあたる。自動車専用道の出入りが
      // 走行車線側 (左) のランプに限られるのは、この 1 つの規則から出る。
      //
      // 例外は「同じ道路がまっすぐ続く枝」で、そこは対向車線ではなく
      // 本線そのものなので、わずかに右へ曲がっていても通れる。
      const rightward =
        inbound.x * other.dir.y - inbound.y * other.dir.x > 0 &&
        !(movement === 'through' && other.branch.cls.id === approach.branch.cls.id);
      if (rightward && (approach.branch.cls.divided || other.branch.cls.divided)) continue;
      exits.push({ movement, approach: other, lanes: otherLanes });
    }

    const movements = MOVEMENT_ORDER.filter((m) => exits.some((e) => e.movement === m));
    const assignment = allocateMovements(entryLanes.length, movements);
    out.set(approach.branch.segment, {
      approach,
      segment: approach.branch.segment,
      entry: entryLanes.map((lane, i) => ({ lane, movements: assignment[i] ?? [] })),
      exit: exitLanes,
      exits,
    });
  }
  return out;
}

/**
 * 流入車線に進路を割り当てる。
 *
 * `movements` は左から右の順 (左折・直進・右折)。車線数が足りなければ
 * 隣り合う進路をまとめ、余れば直進に厚く配る。左側通行なので、いちばん
 * 歩道寄りの車線が左折、いちばん中央寄りの車線が右折になる。
 */
export function allocateMovements(count: number, movements: Movement[]): Movement[][] {
  if (count <= 0) return [];
  if (movements.length === 0) return Array.from({ length: count }, () => []);
  if (count === 1) return [movements.slice()];

  if (count <= movements.length) {
    // 車線数より進路が多い。左から順に、なるべく均等な塊に切る。
    const out: Movement[][] = [];
    let taken = 0;
    for (let i = 0; i < count; i++) {
      const remaining = movements.length - taken;
      const size = Math.ceil(remaining / (count - i));
      out.push(movements.slice(taken, taken + size));
      taken += size;
    }
    return out;
  }

  // 進路より車線が多い。まず 1 本ずつ配り、余りは直進に足す。
  const share = movements.map(() => 1);
  const throughIndex = movements.indexOf('through');
  let extra = count - movements.length;
  if (throughIndex >= 0) {
    share[throughIndex] += extra;
  } else {
    // 直進のない交差点 (T 字の突き当たり) では左右に均等に配る。
    for (let i = 0; extra > 0; i = (i + 1) % movements.length, extra--) share[i]++;
  }

  const out: Movement[][] = [];
  movements.forEach((movement, i) => {
    for (let k = 0; k < share[i]; k++) out.push([movement]);
  });
  return out;
}

/**
 * その進路で入る、行き先の車線を選ぶ。
 *
 * 左折は歩道側の車線へ、右折は中央側の車線へ入る。直進は、入ってきた
 * 車線の並び順をなるべく保つ。
 */
export function exitLaneFor(exit: Exit, entryIndex: number, entryCount: number): Lane {
  const lanes = exit.lanes;
  if (lanes.length === 1) return lanes[0];
  if (exit.movement === 'left') return lanes[0];
  if (exit.movement === 'right') return lanes[lanes.length - 1];
  // 直進は歩道側からの順番を保つ (車線数が違えば端に寄せる)。
  const index = Math.round((entryIndex / Math.max(1, entryCount - 1)) * (lanes.length - 1));
  return lanes[Math.min(lanes.length - 1, Math.max(0, index))];
}
