import { Vector2, Vector3 } from 'three';
import type { Alignment } from '../core/alignment';
import {
  CLEARANCE_OVER_RAIL,
  CLEARANCE_OVER_ROAD,
  DECK_THICKNESS,
  LEVEL_CROSSING_TOLERANCE,
} from '../core/units';
import type { NetworkClass } from './classes';
import type { Network, SegmentId } from './network';

export type CrossingKind =
  | 'level' // 踏切
  | 'separated' // 立体交差 (建築限界を満たしている)
  | 'insufficient' // 立体交差だが桁下が足りない
  | 'conflict'; // 平面で交差しているのに交差点にも踏切にもならない組み合わせ

export interface Crossing {
  kind: CrossingKind;
  /** 交差位置 (道路側の路面上)。 */
  point: Vector3;
  lower: SegmentId;
  upper: SegmentId;
  /** 各セグメント上の弧長。 */
  sLower: number;
  sUpper: number;
  /** 下側の路面から上側の構造物下面までの空き高さ [m]。 */
  clearance: number;
  /** 踏切のときの線路側・道路側。 */
  rail?: { segment: SegmentId; s: number; dir: Vector2; cls: NetworkClass };
  road?: { segment: SegmentId; s: number; dir: Vector2; cls: NetworkClass };
  message?: string;
}

export interface PolylinePoint {
  s: number;
  x: number;
  z: number;
  y: number;
}

export function toPolyline(alignment: Alignment, step = 3): PolylinePoint[] {
  const L = alignment.length;
  const n = Math.max(1, Math.ceil(L / step));
  const out: PolylinePoint[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (L * i) / n;
    const p = alignment.sampleAt(s).pos;
    out.push({ s, x: p.x, y: p.y, z: p.z });
  }
  return out;
}

/**
 * ノードを共有せずに平面上で交わっているセグメントの組を全て見つけ、
 * 高低差から踏切・立体交差・不正な交差のいずれかに分類する。
 */
export function findCrossings(network: Network): Crossing[] {
  const segments = [...network.segments.values()];
  const polylines = new Map<SegmentId, PolylinePoint[]>();
  const bounds = new Map<SegmentId, { minX: number; maxX: number; minZ: number; maxZ: number }>();

  for (const seg of segments) {
    const poly = toPolyline(network.alignmentOf(seg.id));
    polylines.set(seg.id, poly);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    bounds.set(seg.id, { minX, maxX, minZ, maxZ });
  }

  const crossings: Crossing[] = [];

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const sa = segments[i];
      const sb = segments[j];
      // ノードを共有していれば交差点・分岐器として処理済み。
      if (sa.a === sb.a || sa.a === sb.b || sa.b === sb.a || sa.b === sb.b) continue;

      const ba = bounds.get(sa.id)!;
      const bb = bounds.get(sb.id)!;
      const pad = network.classOf(sa).halfWidth + network.classOf(sb).halfWidth;
      if (
        ba.maxX + pad < bb.minX ||
        bb.maxX + pad < ba.minX ||
        ba.maxZ + pad < bb.minZ ||
        bb.maxZ + pad < ba.minZ
      ) {
        continue;
      }

      const hits = intersectPolylines(polylines.get(sa.id)!, polylines.get(sb.id)!);
      for (const hit of hits) {
        crossings.push(classifyCrossing(network, sa.id, sb.id, hit));
      }
    }
  }

  return dedupeCrossings(crossings);
}

/** 同じ交差を指す重複を 1 つにまとめるときの距離 [m]。 */
const MERGE_DISTANCE = 2.5;

/**
 * 同じ交差が重複して検出されるのを取り除く。
 *
 * 折れ線の頂点上で交わると隣り合う辺の組で二重に当たる。交点がちょうど
 * ノード位置にあると、分割された前後 2 本がそれぞれ当たるため、双方が
 * 分割されていると 4 通りの組み合わせが出てくる。数メートル以内で同種の
 * 交差は、物理的には 1 箇所とみなしてよい。
 */
function dedupeCrossings(crossings: Crossing[]): Crossing[] {
  const kept: Crossing[] = [];
  for (const candidate of crossings) {
    const duplicate = kept.some(
      (existing) =>
        existing.kind === candidate.kind &&
        existing.point.distanceTo(candidate.point) < MERGE_DISTANCE,
    );
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

export interface Hit {
  sA: number;
  sB: number;
  x: number;
  z: number;
  yA: number;
  yB: number;
  dirA: Vector2;
  dirB: Vector2;
}

export function intersectPolylines(a: PolylinePoint[], b: PolylinePoint[]): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i + 1 < a.length; i++) {
    const a0 = a[i];
    const a1 = a[i + 1];
    const ax = a1.x - a0.x;
    const az = a1.z - a0.z;
    for (let j = 0; j + 1 < b.length; j++) {
      const b0 = b[j];
      const b1 = b[j + 1];
      const bx = b1.x - b0.x;
      const bz = b1.z - b0.z;
      const det = ax * bz - az * bx;
      if (Math.abs(det) < 1e-9) continue;
      const rx = b0.x - a0.x;
      const rz = b0.z - a0.z;
      const t = (rx * bz - rz * bx) / det;
      const u = (rx * az - rz * ax) / det;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      hits.push({
        sA: a0.s + (a1.s - a0.s) * t,
        sB: b0.s + (b1.s - b0.s) * u,
        x: a0.x + ax * t,
        z: a0.z + az * t,
        yA: a0.y + (a1.y - a0.y) * t,
        yB: b0.y + (b1.y - b0.y) * u,
        dirA: new Vector2(ax, az).normalize(),
        dirB: new Vector2(bx, bz).normalize(),
      });
    }
  }
  return hits;
}

function classifyCrossing(network: Network, idA: SegmentId, idB: SegmentId, hit: Hit): Crossing {
  const clsA = network.classOf(network.getSegment(idA));
  const clsB = network.classOf(network.getSegment(idB));

  // 高さは折れ線の補間ではなく線形から取り直す。折れ線は縦断曲線を
  // 弦で近似しているので、そのままだと数十 cm ずれ、踏切かどうかの
  // 判定が揺らぐ。
  hit.yA = network.alignmentOf(idA).sampleAt(hit.sA).pos.y;
  hit.yB = network.alignmentOf(idB).sampleAt(hit.sB).pos.y;

  const dy = hit.yA - hit.yB;
  const point = new Vector3(hit.x, Math.max(hit.yA, hit.yB), hit.z);

  const aIsRail = clsA.kind === 'rail';
  const bIsRail = clsB.kind === 'rail';
  const isRailRoad = aIsRail !== bIsRail;

  if (Math.abs(dy) <= LEVEL_CROSSING_TOLERANCE) {
    if (isRailRoad) {
      const railFirst = aIsRail;
      return {
        kind: 'level',
        point: new Vector3(hit.x, railFirst ? hit.yA : hit.yB, hit.z),
        lower: idA,
        upper: idB,
        sLower: hit.sA,
        sUpper: hit.sB,
        clearance: 0,
        rail: railFirst
          ? { segment: idA, s: hit.sA, dir: hit.dirA, cls: clsA }
          : { segment: idB, s: hit.sB, dir: hit.dirB, cls: clsB },
        road: railFirst
          ? { segment: idB, s: hit.sB, dir: hit.dirB, cls: clsB }
          : { segment: idA, s: hit.sA, dir: hit.dirA, cls: clsA },
      };
    }
    return {
      kind: 'conflict',
      point,
      lower: idA,
      upper: idB,
      sLower: hit.sA,
      sUpper: hit.sB,
      clearance: 0,
      message:
        aIsRail && bIsRail
          ? '線路が同一平面で交差しています。ノードを置いてクロッシングにしてください。'
          : '道路が同一平面で交差しています。ノードを置いて交差点にしてください。',
    };
  }

  const upperIsA = dy > 0;
  const upper = upperIsA ? idA : idB;
  const lower = upperIsA ? idB : idA;
  const lowerCls = upperIsA ? clsB : clsA;
  const required = lowerCls.kind === 'rail' ? CLEARANCE_OVER_RAIL : CLEARANCE_OVER_ROAD;
  const clearance = Math.abs(dy) - DECK_THICKNESS;

  return {
    kind: clearance >= required ? 'separated' : 'insufficient',
    point,
    lower,
    upper,
    sLower: upperIsA ? hit.sB : hit.sA,
    sUpper: upperIsA ? hit.sA : hit.sB,
    clearance,
    message:
      clearance >= required
        ? undefined
        : `桁下 ${clearance.toFixed(1)} m は建築限界 ${required.toFixed(1)} m を下回っています。`,
  };
}
