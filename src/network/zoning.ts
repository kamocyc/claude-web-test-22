import { Vector3 } from 'three';
import type { AlignmentSample } from '../core/alignment';
import type { NetworkClass } from './classes';
import type { Network, SegmentId } from './network';
import type { Occupancy } from './occupancy';
import type { StructureRun } from './structure';
import type { Heightfield } from '../terrain/heightfield';

/**
 * 沿道の区画 (ゾーニング)。
 *
 * 道路の左右に、道路に沿った四角い区画を並べる。用途を塗った区画には
 * 建物が建つ。区画そのものはネットワークから毎回作り直す**導出物**で、
 * 保存するのは「どこにどの用途を塗ったか」だけ (`ZoneMap`)。こうすると
 * 道路を引き直しても塗った用途が残り、道路を消せば建物も消える。
 *
 *   塗る (ワールド格子) → 区画を割り付ける (道路に沿う) → 建物を建てる
 */

/** 区画の用途。 */
export type ZoneType = 'residential' | 'commercial' | 'industrial';

export const ZONE_TYPES: ZoneType[] = ['residential', 'commercial', 'industrial'];

/** 用途の表示名。 */
export const ZONE_LABELS: Record<ZoneType, string> = {
  residential: '住宅',
  commercial: '商業',
  industrial: '工業',
};

/** 区画 1 マスの間口 [m] (道路に沿う向きの長さ)。 */
export const ZONE_CELL = 16;

/** 区画の奥行き [m] (道路から離れる向きの長さ)。 */
export const ZONE_DEPTH = 20;

/** 舗装の縁から区画までの離れ [m]。歩道のすぐ外から始める。 */
export const ZONE_SETBACK = 1.0;

/** 用途を塗るワールド格子の 1 辺 [m]。区画より細かくして塗り分けを効かせる。 */
export const ZONE_PAINT_CELL = 8;

/** 区画の中で許す地形の高低差 [m]。これを超える斜面には建てない。 */
const ZONE_MAX_RELIEF = 4.0;

/** 区画どうしの重なりを判定する格子の 1 辺 [m]。 */
const OVERLAP_CELL = 4;

/** 重なっているとみなす占有率。これを超えたら後から来た区画をあきらめる。 */
const OVERLAP_LIMIT = 0.34;

/** 割り付けた区画 1 マス。 */
export interface Lot {
  segment: SegmentId;
  /** 道路の右手側なら +1、左手側なら -1。 */
  side: 1 | -1;
  /** 道路に沿った通し番号。 */
  index: number;
  /** 区画の中心 (整地後の地表高)。 */
  center: Vector3;
  /** 道路に沿う向き (単位)。 */
  along: Vector3;
  /** 道路から離れる向き (単位)。 */
  outward: Vector3;
  /** 間口の半分 [m]。 */
  halfFrontage: number;
  /** 奥行き [m]。 */
  depth: number;
  /** 塗られている用途。未指定なら空き区画。 */
  zone: ZoneType | null;
  /**
   * 建物を建てられるか。
   *
   * 急斜面の区画は残したうえで建てられない印を付ける。マス目が消えるより
   * 「ここは土地が急で建たない」と分かるほうがよい。他の線形と重なる所は
   * そもそも区画にしない (マス目も出さない)。
   */
  buildable: boolean;
}

/**
 * どこにどの用途を塗ったかを覚えるワールド格子。
 *
 * 区画ではなく地面に塗るので、道路を引き直しても・分割しても塗りが残る。
 */
export class ZoneMap {
  private readonly cells = new Map<number, ZoneType>();

  get size(): number {
    return this.cells.size;
  }

  /** その地点に塗られている用途。 */
  at(x: number, z: number): ZoneType | null {
    return this.cells.get(cellKey(x, z)) ?? null;
  }

  /**
   * 半径 `radius` [m] の円の中を塗る。`zone` が null なら消す。
   * 実際に変わったら true を返す。
   */
  paint(x: number, z: number, radius: number, zone: ZoneType | null): boolean {
    const half = ZONE_PAINT_CELL / 2;
    const cx0 = Math.floor((x - radius) / ZONE_PAINT_CELL);
    const cx1 = Math.floor((x + radius) / ZONE_PAINT_CELL);
    const cz0 = Math.floor((z - radius) / ZONE_PAINT_CELL);
    const cz1 = Math.floor((z + radius) / ZONE_PAINT_CELL);
    let changed = false;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        // マスの中心が円に入っていれば塗る。
        const px = cx * ZONE_PAINT_CELL + half;
        const pz = cz * ZONE_PAINT_CELL + half;
        if (Math.hypot(px - x, pz - z) > radius) continue;
        const key = gridKey(cx, cz);
        const current = this.cells.get(key) ?? null;
        if (current === zone) continue;
        if (zone === null) this.cells.delete(key);
        else this.cells.set(key, zone);
        changed = true;
      }
    }
    return changed;
  }

  clear(): void {
    this.cells.clear();
  }
}

function cellKey(x: number, z: number): number {
  return gridKey(Math.floor(x / ZONE_PAINT_CELL), Math.floor(z / ZONE_PAINT_CELL));
}

function gridKey(cx: number, cz: number): number {
  // 32 bit に収まる範囲でユニークになればよい。
  return (cx + 8192) * 65536 + (cz + 8192);
}

export interface LotPlanInput {
  network: Network;
  /** 区間ごとの構造形式。地表区間にだけ区画を割り付ける。 */
  structures: Map<SegmentId, StructureRun[]>;
  /** 交差点に飲み込まれた分を除いた、描画される範囲。 */
  ranges: Map<SegmentId, { s0: number; s1: number }>;
  /** 道路・線路・交差点の占有索引。区画がぶつかっていないかを見る。 */
  occupancy: Occupancy;
  field: Heightfield;
  zones: ZoneMap;
}

/**
 * 道路の左右に区画を割り付ける。
 *
 * 割り付けるのは**地表を走る沿道向けの道路**の、交差点に飲み込まれていない
 * 範囲だけ。橋・トンネルの区間、自動車専用道・ランプ、他の線形や交差点と
 * 重なる所、急斜面は外す。
 */
export function planLots(input: LotPlanInput): Lot[] {
  const { network, structures, ranges, zones } = input;
  const lots: Lot[] = [];
  const taken = new Set<number>();

  for (const seg of network.segments.values()) {
    const cls = network.classOf(seg);
    if (!cls.zonable) continue;
    const range = ranges.get(seg.id);
    if (!range) continue;
    const alignment = network.alignmentOf(seg.id);

    for (const run of structures.get(seg.id) ?? []) {
      if (run.mode !== 'ground') continue;
      const s0 = Math.max(run.s0, range.s0);
      const s1 = Math.min(run.s1, range.s1);
      const length = s1 - s0;
      const count = Math.floor(length / ZONE_CELL);
      if (count < 1) continue;
      // 余りは両端に等分して、区画の並びを区間の真ん中に寄せる。
      const start = s0 + (length - count * ZONE_CELL) / 2;

      for (let i = 0; i < count; i++) {
        const sample = alignment.sampleAt(start + (i + 0.5) * ZONE_CELL);
        for (const side of [-1, 1] as const) {
          const lot = planLot(input, seg.id, cls, sample, i, side, taken);
          if (!lot) continue;
          lot.zone = zones.at(lot.center.x, lot.center.z);
          lots.push(lot);
        }
      }
    }
  }
  return lots;
}

/** 区画 1 マスを組み立てる。置けない所では null を返す。 */
function planLot(
  input: LotPlanInput,
  segment: SegmentId,
  cls: NetworkClass,
  sample: AlignmentSample,
  index: number,
  side: 1 | -1,
  taken: Set<number>,
): Lot | null {
  const { field, occupancy } = input;
  const outward = new Vector3(sample.right.x * side, 0, sample.right.z * side).normalize();
  const along = new Vector3(sample.forwardXZ.x, 0, sample.forwardXZ.y).normalize();
  const halfFrontage = ZONE_CELL / 2;
  const front = new Vector3(sample.pos.x, 0, sample.pos.z).addScaledVector(
    outward,
    cls.halfWidth + ZONE_SETBACK,
  );
  const center = front.clone().addScaledVector(outward, ZONE_DEPTH / 2);

  // 四隅と中心で、マップの内か・平らか・他の線形と重ならないかを見る。
  const probes: Vector3[] = [center];
  for (const a of [-1, 1]) {
    for (const b of [0, 1]) {
      probes.push(
        front
          .clone()
          .addScaledVector(along, a * halfFrontage)
          .addScaledVector(outward, b * ZONE_DEPTH),
      );
    }
  }

  let low = Infinity;
  let high = -Infinity;
  for (const p of probes) {
    if (!field.contains(p.x, p.z)) return null;
    const y = field.heightAt(p.x, p.z);
    if (y < low) low = y;
    if (y > high) high = y;
    // 路面の高さで問い合わせる。頭上を跨ぐ橋は区画を潰さない。
    if (occupancy.at(p.x, p.z, { y, margin: 0.5, verticalTolerance: 4 })) return null;
  }
  if (coversStation(input.network, center)) return null;
  if (!claim(taken, front, along, outward, halfFrontage)) return null;

  return {
    segment,
    side,
    index,
    center: new Vector3(center.x, field.heightAt(center.x, center.z), center.z),
    along,
    outward,
    halfFrontage,
    depth: ZONE_DEPTH,
    zone: null,
    buildable: high - low <= ZONE_MAX_RELIEF,
  };
}

/** 駅の敷地に掛かっているか。線路の索引だけではホーム・駅舎を覆えない。 */
function coversStation(network: Network, point: Vector3): boolean {
  for (const station of network.stations.values()) {
    const dx = point.x - station.center.x;
    const dz = point.z - station.center.z;
    const cos = Math.cos(station.heading);
    const sin = Math.sin(station.heading);
    const along = dx * cos + dz * sin;
    const across = -dx * sin + dz * cos;
    const halfWidth = Math.max(Math.abs(station.minOffset), Math.abs(station.maxOffset)) + 6;
    if (Math.abs(along) <= station.length / 2 + 6 && Math.abs(across) <= halfWidth) return true;
  }
  return false;
}

/**
 * 区画の footprint を格子で押さえる。
 *
 * 近い所を通る 2 本の道路は、互いの沿道が重なる。先に割り付けたほうが
 * 勝ち、後から来たほうは (重なりが大きければ) あきらめる。
 */
function claim(
  taken: Set<number>,
  front: Vector3,
  along: Vector3,
  outward: Vector3,
  halfFrontage: number,
): boolean {
  const keys: number[] = [];
  const p = new Vector3();
  let overlap = 0;
  let total = 0;
  const stepsAlong = Math.max(1, Math.round((halfFrontage * 2) / OVERLAP_CELL));
  const stepsOut = Math.max(1, Math.round(ZONE_DEPTH / OVERLAP_CELL));
  for (let a = 0; a < stepsAlong; a++) {
    const offset = -halfFrontage + (a + 0.5) * ((halfFrontage * 2) / stepsAlong);
    for (let b = 0; b < stepsOut; b++) {
      p.copy(front)
        .addScaledVector(along, offset)
        .addScaledVector(outward, (b + 0.5) * (ZONE_DEPTH / stepsOut));
      const key = gridKey(
        Math.floor(p.x / OVERLAP_CELL),
        Math.floor(p.z / OVERLAP_CELL),
      );
      total++;
      if (taken.has(key)) overlap++;
      else keys.push(key);
    }
  }
  if (overlap / total > OVERLAP_LIMIT) return false;
  for (const key of keys) taken.add(key);
  return true;
}
