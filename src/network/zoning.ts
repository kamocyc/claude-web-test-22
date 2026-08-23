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
 * 道路の左右に、道路に沿った小さなマス目を並べる。用途を塗ったマスは
 * **1 つ以上まとまって** 1 棟の敷地になり、そこに建物が建つ。奥まで塗れば
 * 奥行きのある建物、道路沿いに続けて塗れば間口の広い建物になる。
 *
 * マスも敷地もネットワークから毎回作り直す**導出物**で、保存するのは
 * 「どこにどの用途を塗ったか」だけ (`ZoneMap`)。こうすると道路を引き直しても
 * 塗った用途が残り、道路を消せば建物も消える。
 *
 *   塗る (ワールド格子) → マスを割り付ける (道路に沿う) →
 *   マスをまとめて敷地にする → 建物を建てる
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

/** マス 1 つの間口 [m] (道路に沿う向きの長さ)。 */
export const ZONE_CELL = 8;

/** マス 1 つの奥行き [m] (道路から離れる向きの長さ)。 */
export const ZONE_ROW_DEPTH = 10;

/** 道路から数えて何列のマスを並べるか。 */
export const ZONE_ROWS = 2;

/** 沿道の区画全体の奥行き [m]。 */
export const ZONE_DEPTH = ZONE_ROWS * ZONE_ROW_DEPTH;

/** 舗装の縁からマス目までの離れ [m]。歩道のすぐ外から始める。 */
export const ZONE_SETBACK = 1.0;

/** 用途を塗るワールド格子の 1 辺 [m]。マスより細かくして塗り分けを効かせる。 */
export const ZONE_PAINT_CELL = 4;

/**
 * 敷地の中で、道路側の高さより地形が**高く**なってよい量 [m]。
 *
 * 建物の床は道路に接する縁の高さに合わせる (`Lot.padY`) ので、背後の地形が
 * これより高いと建物が斜面に埋まってしまう。切土の法面はここで弾かれる。
 */
const ZONE_MAX_RISE = 4.0;

/**
 * 敷地の中で、道路側の高さより地形が**低く**なってよい量 [m]。
 *
 * こちらは基礎を伸ばせば吸収できるので、高くなる側よりずっと甘くてよい。
 */
const ZONE_MAX_DROP = 8.0;

/** 1 棟にまとめてよいマスの数 (間口方向)。用途ごとに大きさの性格を変える。 */
const MAX_WIDTH: Record<ZoneType, number> = {
  residential: 2,
  commercial: 3,
  industrial: 4,
};

/**
 * まとめてよい向きの差 [rad]。
 *
 * 敷地は 1 つの長方形なので、曲線に沿って何マスもまとめると角がはみ出す。
 * 曲がっている所では自然に小さい建物になる。
 */
const MAX_HEADING_SPREAD = 0.16;

/** マスどうしの重なりを判定する格子の 1 辺 [m]。 */
const OVERLAP_CELL = 2.5;

/** 重なっているとみなす占有率。これを超えたら後から来たマスをあきらめる。 */
const OVERLAP_LIMIT = 0.34;

/** 用途を塗る単位となるマス 1 つ。 */
export interface ZoneCell {
  segment: SegmentId;
  /** 道路の右手側なら +1、左手側なら -1。 */
  side: 1 | -1;
  /** 道路に沿った通し番号。 */
  index: number;
  /** 道路から数えた列 (0 が道路側)。 */
  row: number;
  /** マスの中心 (整地後の地表高)。 */
  center: Vector3;
  /** 道路に沿う向き (単位)。 */
  along: Vector3;
  /** 道路から離れる向き (単位)。 */
  outward: Vector3;
  /** 道路側の縁のいちばん高い所。 */
  frontY: number;
  /** マスの中の地形の最低 / 最高。 */
  lowY: number;
  highY: number;
  /** 塗られている用途。未指定なら空きマス。 */
  zone: ZoneType | null;
  /**
   * 建物を建てられるか。
   *
   * 急斜面のマスは残したうえで建てられない印を付ける。マス目が消えるより
   * 「ここは土地が急で建たない」と分かるほうがよい。他の線形と重なる所は
   * そもそもマスにしない (マス目も出さない)。
   */
  buildable: boolean;
}

/** 建物 1 棟ぶんの敷地 (マスを 1 つ以上まとめたもの)。 */
export interface Lot {
  segment: SegmentId;
  side: 1 | -1;
  zone: ZoneType;
  /** 敷地の中心 (地表高)。 */
  center: Vector3;
  /** 道路に沿う向き (単位)。 */
  along: Vector3;
  /** 道路から離れる向き (単位)。 */
  outward: Vector3;
  /** 間口の半分 [m]。 */
  halfFrontage: number;
  /** 奥行き [m]。 */
  depth: number;
  /**
   * 建物の床の高さ。
   *
   * **道路に接する縁のいちばん高い所**に合わせる。低い方に合わせると
   * 傾いた道路では建物の一部が路面より下に沈み、平均を採ると道路との
   * 境で段差が出る。
   */
  padY: number;
  /** 敷地の中の地形のいちばん低い所。基礎はここまで下ろす。 */
  lowY: number;
  /** まとめたマスの数 (間口方向 × 奥行き方向)。 */
  cells: { wide: number; deep: number };
}

/**
 * どこにどの用途を塗ったかを覚えるワールド格子。
 *
 * マスではなく地面に塗るので、道路を引き直しても・分割しても塗りが残る。
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
  // マップの範囲 (±2560 m) を細かい格子で割った添字が一意になればよい。
  return (cx + 16384) * 131072 + (cz + 16384);
}

export interface LotPlanInput {
  network: Network;
  /** 区間ごとの構造形式。地表区間にだけマスを割り付ける。 */
  structures: Map<SegmentId, StructureRun[]>;
  /** 交差点に飲み込まれた分を除いた、描画される範囲。 */
  ranges: Map<SegmentId, { s0: number; s1: number }>;
  /** 道路・線路・交差点の占有索引。マスがぶつかっていないかを見る。 */
  occupancy: Occupancy;
  field: Heightfield;
  zones: ZoneMap;
}

export interface Zoning {
  /** 用途を塗る単位のマス目。 */
  cells: ZoneCell[];
  /** マスをまとめた、建物 1 棟ぶんの敷地。 */
  lots: Lot[];
}

/**
 * 道路の左右にマスを割り付け、塗られた用途ごとにまとめて敷地にする。
 *
 * 割り付けるのは**地表を走る沿道向けの道路**の、交差点に飲み込まれていない
 * 範囲だけ。橋・トンネルの区間、自動車専用道・ランプ、他の線形や交差点と
 * 重なる所は外す。
 */
export function planZoning(input: LotPlanInput): Zoning {
  const { network, structures, ranges, zones } = input;
  const cells: ZoneCell[] = [];
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
      // 余りは両端に等分して、マスの並びを区間の真ん中に寄せる。
      const start = s0 + (length - count * ZONE_CELL) / 2;
      const samples: AlignmentSample[] = [];
      for (let i = 0; i < count; i++) {
        samples.push(alignment.sampleAt(start + (i + 0.5) * ZONE_CELL));
      }

      for (const side of [-1, 1] as const) {
        // 列は道路側から順に作る。手前が置けない所には奥も作らない
        // (道路に接していない土地には建てられないので、意味がない)。
        const columns: ZoneCell[][] = [];
        for (let i = 0; i < count; i++) {
          const column: ZoneCell[] = [];
          for (let row = 0; row < ZONE_ROWS; row++) {
            const cell = planCell(input, seg.id, cls, samples[i], i, row, side, taken);
            if (!cell) break;
            cell.zone = zones.at(cell.center.x, cell.center.z);
            cells.push(cell);
            column.push(cell);
          }
          columns.push(column);
        }
        mergeLots(columns, lots);
      }
    }
  }
  return { cells, lots };
}

/** マス 1 つを組み立てる。置けない所では null を返す。 */
function planCell(
  input: LotPlanInput,
  segment: SegmentId,
  cls: NetworkClass,
  sample: AlignmentSample,
  index: number,
  row: number,
  side: 1 | -1,
  taken: Set<number>,
): ZoneCell | null {
  const { field, occupancy } = input;
  const outward = new Vector3(sample.right.x * side, 0, sample.right.z * side).normalize();
  const along = new Vector3(sample.forwardXZ.x, 0, sample.forwardXZ.y).normalize();
  const half = ZONE_CELL / 2;
  const front = new Vector3(sample.pos.x, 0, sample.pos.z).addScaledVector(
    outward,
    cls.halfWidth + ZONE_SETBACK + row * ZONE_ROW_DEPTH,
  );
  const center = front.clone().addScaledVector(outward, ZONE_ROW_DEPTH / 2);

  // 道路側の縁と奥の縁で、マップの内か・他の線形と重ならないかを見る。
  let frontY = -Infinity;
  let lowY = Infinity;
  let highY = -Infinity;
  for (const back of [0, 1]) {
    for (const a of [-1, 0, 1]) {
      const p = front
        .clone()
        .addScaledVector(along, a * half)
        .addScaledVector(outward, back * ZONE_ROW_DEPTH);
      if (!field.contains(p.x, p.z)) return null;
      const y = field.heightAt(p.x, p.z);
      if (back === 0 && y > frontY) frontY = y;
      if (y < lowY) lowY = y;
      if (y > highY) highY = y;
      // 路面の高さで問い合わせる。頭上を跨ぐ橋はマスを潰さない。
      if (occupancy.at(p.x, p.z, { y, margin: 0.5, verticalTolerance: 4 })) return null;
    }
  }
  if (coversStation(input.network, center)) return null;
  if (!claim(taken, front, along, outward, half)) return null;

  return {
    segment,
    side,
    index,
    row,
    center: new Vector3(center.x, field.heightAt(center.x, center.z), center.z),
    along,
    outward,
    frontY,
    lowY,
    highY,
    zone: null,
    buildable: highY - frontY <= ZONE_MAX_RISE && frontY - lowY <= ZONE_MAX_DROP,
  };
}

/**
 * 並んだマスを、同じ用途ごとにまとめて敷地にする。
 *
 * 奥行きは**塗った深さ**がそのまま決める (道路沿いだけ塗れば手前の 1 列、
 * 奥まで塗れば 2 列)。間口は場所ごとに決まる目標の大きさまで、同じ用途・
 * 同じ向き・同じ高さで続く限り伸ばす。手前の列が使えないマスからは始めない
 * (道路に接していない敷地は作らない)。
 */
function mergeLots(columns: ZoneCell[][], out: Lot[]): void {
  const used = columns.map((column) => column.map(() => false));

  const free = (i: number, row: number, zone: ZoneType): boolean => {
    const cell = columns[i]?.[row];
    return !!cell && !used[i][row] && cell.buildable && cell.zone === zone;
  };

  for (let i = 0; i < columns.length; i++) {
    const head = columns[i]?.[0];
    if (!head || !head.zone || !head.buildable || used[i][0]) continue;
    const zone = head.zone;

    // 奥行き: 同じ用途が続く限り奥へ。
    let deep = 1;
    while (deep < ZONE_ROWS && free(i, deep, zone)) deep++;

    // 間口: 場所で決まる目標の大きさまで、同じ奥行き・同じ向き・同じ高さの
    // 範囲で伸ばす。いつも上限まで伸ばすと同じ大きさの建物が並んでしまう。
    const want = 1 + (positionHash(head.center.x, head.center.z) % MAX_WIDTH[zone]);
    let wide = 1;
    while (wide < want && fits(columns, i, wide + 1, deep, zone, free)) wide++;

    for (let w = 0; w < wide; w++) {
      for (let r = 0; r < deep; r++) used[i + w][r] = true;
    }
    out.push(makeLot(columns, i, wide, deep, zone));
  }
}

/** 間口を `wide` マスに広げても、まとめて 1 棟にできるか。 */
function fits(
  columns: ZoneCell[][],
  i: number,
  wide: number,
  deep: number,
  zone: ZoneType,
  free: (i: number, row: number, zone: ZoneType) => boolean,
): boolean {
  const last = i + wide - 1;
  for (let row = 0; row < deep; row++) {
    if (!free(last, row, zone)) return false;
  }
  const head = columns[i][0];
  const tail = columns[last][0];
  // 曲がっている所では、長方形の敷地が弧からはみ出す前に切る。
  if (head.along.dot(tail.along) < Math.cos(MAX_HEADING_SPREAD)) return false;
  // 床は道路側のいちばん高い所に合わせるので、その高さで全マスが収まること。
  let padY = -Infinity;
  for (let w = 0; w < wide; w++) padY = Math.max(padY, columns[i + w][0].frontY);
  for (let w = 0; w < wide; w++) {
    for (let row = 0; row < deep; row++) {
      const cell = columns[i + w][row];
      if (cell.highY - padY > ZONE_MAX_RISE) return false;
      if (padY - cell.lowY > ZONE_MAX_DROP) return false;
    }
  }
  return true;
}

/** まとめたマスから敷地を作る。 */
function makeLot(
  columns: ZoneCell[][],
  i: number,
  wide: number,
  deep: number,
  zone: ZoneType,
): Lot {
  const head = columns[i][0];
  const tail = columns[i + wide - 1][0];
  // 向きは真ん中のマスのものを使う (曲線でも敷地が弧の中心に載る)。
  const mid = columns[i + Math.floor((wide - 1) / 2)][0];
  const depth = deep * ZONE_ROW_DEPTH;

  let padY = -Infinity;
  let lowY = Infinity;
  for (let w = 0; w < wide; w++) {
    padY = Math.max(padY, columns[i + w][0].frontY);
    for (let row = 0; row < deep; row++) {
      lowY = Math.min(lowY, columns[i + w][row].lowY);
    }
  }

  // 道路側の縁の中点 (端のマスの縁を結んだ真ん中) から奥へ寄せる。
  const front = frontPoint(head).lerp(frontPoint(tail), 0.5);
  const center = front.clone().addScaledVector(mid.outward, depth / 2);

  return {
    segment: head.segment,
    side: head.side,
    zone,
    center,
    along: mid.along,
    outward: mid.outward,
    halfFrontage: (wide * ZONE_CELL) / 2,
    depth,
    padY,
    lowY,
    cells: { wide, deep },
  };
}

/**
 * 位置から決まる整数の種。
 *
 * 同じ場所からは必ず同じ形が決まるので、道路を編集して作り直しても
 * 関係ない所の街並みは変わらない。
 */
export function positionHash(x: number, z: number): number {
  const ix = Math.round(x * 4);
  const iz = Math.round(z * 4);
  let h = (ix * 0x9e3779b1) ^ (iz * 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return (h ^ (h >>> 16)) >>> 0;
}

/** マスの道路側の縁の中点。 */
function frontPoint(cell: ZoneCell): Vector3 {
  return cell.center.clone().addScaledVector(cell.outward, -ZONE_ROW_DEPTH / 2);
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
 * マスの footprint を格子で押さえる。
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
  const stepsOut = Math.max(1, Math.round(ZONE_ROW_DEPTH / OVERLAP_CELL));
  for (let a = 0; a < stepsAlong; a++) {
    const offset = -halfFrontage + (a + 0.5) * ((halfFrontage * 2) / stepsAlong);
    for (let b = 0; b < stepsOut; b++) {
      p.copy(front)
        .addScaledVector(along, offset)
        .addScaledVector(outward, (b + 0.5) * (ZONE_ROW_DEPTH / stepsOut));
      const key = gridKey(Math.floor(p.x / OVERLAP_CELL), Math.floor(p.z / OVERLAP_CELL));
      total++;
      if (taken.has(key)) overlap++;
      else keys.push(key);
    }
  }
  if (overlap / total > OVERLAP_LIMIT) return false;
  for (const key of keys) taken.add(key);
  return true;
}
