import { Vector3 } from 'three';
import type { NetworkKind } from './classes';
import type { Junction } from './junction';
import type { Network, NodeId, SegmentId } from './network';

/**
 * 「その地点が道路・線路・交差点に覆われているか」を答える索引。
 *
 * 信号機・架線柱・電柱といった小物は、路側に立てたつもりでも交差する
 * 別の線形の真ん中に来てしまうことがある。置く前にここへ問い合わせて、
 * 塞がっていれば位置をずらすか諦める、という使い方をする。
 */

export interface Occupant {
  kind: NetworkKind;
  segment?: SegmentId;
  node?: NodeId;
  /** 中心線 (交差点ではリング) からの距離 [m]。負なら内側。 */
  distance: number;
  /** その地点での線形の高さ [m]。 */
  y: number;
}

export interface OccupancyQuery {
  /** 判定から除外するセグメント (自分自身)。 */
  exceptSegments?: Iterable<SegmentId>;
  /** 判定から除外するノード。 */
  exceptNodes?: Iterable<NodeId>;
  /** この種別だけを見る。省略時は全て。 */
  kinds?: NetworkKind[];
  /** 幅員に加える余裕 [m]。 */
  margin?: number;
  /**
   * 判定する高さ [m]。指定すると、これと離れた高さの線形は無視する。
   * 立体交差では、桁の上の支柱が真下を通る線形の「上」に来るのが正常。
   */
  y?: number;
  /** 同じ高さとみなす差 [m]。 */
  verticalTolerance?: number;
}

/**
 * 同じ高さとみなす既定の差 [m]。
 * 縁石 (0.15)・道床の法尻 (0.87)・床版厚 (1.1) を飲み込み、建築限界
 * (道路 4.5 / 線路 5.7) よりは十分小さい値。
 */
const DEFAULT_VERTICAL_TOLERANCE = 2.0;

interface Span {
  segment: SegmentId;
  kind: NetworkKind;
  halfWidth: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  y1: number;
}

interface Ring {
  node: NodeId;
  kind: NetworkKind;
  points: { x: number; z: number }[];
  y: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** 索引の格子間隔 [m]。線形の分割長 (2 m) より十分大きく取る。 */
const BUCKET = 24;

export class Occupancy {
  private readonly spans: Span[] = [];
  private readonly rings: Ring[] = [];
  private readonly spanBuckets = new Map<number, number[]>();
  private readonly ringBuckets = new Map<number, number[]>();

  constructor(
    network: Network,
    options: {
      junctions?: Map<NodeId, Junction>;
      /**
       * 描画高さの補正 (踏切に合わせた道路の上下)。索引の高さが実際に
       * 描かれた路面とずれると、その高さで問い合わせた小物が舗装を
       * 素通りしてしまう。急勾配の道路が踏切を渡る所で 2 m 以上ずれる。
       */
      heightOffset?: (segment: SegmentId, s: number, y: number) => number;
    } = {},
  ) {
    const offsetAt = options.heightOffset ?? ((): number => 0);
    for (const seg of network.segments.values()) {
      const cls = network.classOf(seg);
      const alignment = network.alignmentOf(seg.id);
      const at = (s: number): Vector3 => {
        const pos = alignment.sampleAt(s).pos.clone();
        pos.y += offsetAt(seg.id, s, pos.y);
        return pos;
      };
      // 描画された範囲だけでなく、交差点に飲み込まれたトリム区間も含める。
      // 鋭角の交差点ではリングの形が乱れることがあり、リングの内外判定
      // だけでは交差点の内側を取りこぼすため。
      const steps = Math.max(1, Math.ceil(alignment.length / 4));
      let prev = at(0);
      for (let i = 1; i <= steps; i++) {
        const p = at((alignment.length * i) / steps);
        this.addSpan({
          segment: seg.id,
          kind: cls.kind,
          halfWidth: cls.halfWidth,
          x0: prev.x,
          z0: prev.z,
          x1: p.x,
          z1: p.z,
          y0: prev.y,
          y1: p.y,
        });
        prev = p;
      }
    }

    for (const junction of options.junctions?.values() ?? []) {
      if (junction.ring.length < 3) continue;
      const kind = junction.approaches[0]?.branch.cls.kind;
      if (!kind) continue;
      this.addRing(junction.node, kind, junction.ring);
    }
  }

  /** 覆っているものがあれば、いちばん内側に食い込んでいるものを返す。 */
  at(x: number, z: number, query: OccupancyQuery = {}): Occupant | null {
    const exceptSegments = new Set(query.exceptSegments ?? []);
    const exceptNodes = new Set(query.exceptNodes ?? []);
    const kinds = query.kinds;
    const margin = query.margin ?? 0;
    let best: Occupant | null = null;

    const tolerance = query.verticalTolerance ?? DEFAULT_VERTICAL_TOLERANCE;
    const differentLevel = (other: number): boolean =>
      query.y !== undefined && Math.abs(query.y - other) > tolerance;

    for (const index of this.spanBuckets.get(key(x, z)) ?? []) {
      const span = this.spans[index];
      if (exceptSegments.has(span.segment)) continue;
      if (kinds && !kinds.includes(span.kind)) continue;
      const projection = projectOnSegment(x, z, span.x0, span.z0, span.x1, span.z1);
      const gap = projection.distance - (span.halfWidth + margin);
      if (gap > 0) continue;
      if (differentLevel(span.y0 + (span.y1 - span.y0) * projection.t)) continue;
      if (!best || gap < best.distance) {
        best = {
          kind: span.kind,
          segment: span.segment,
          distance: gap,
          y: span.y0 + (span.y1 - span.y0) * projection.t,
        };
      }
    }

    for (const index of this.ringBuckets.get(key(x, z)) ?? []) {
      const ring = this.rings[index];
      if (exceptNodes.has(ring.node)) continue;
      if (kinds && !kinds.includes(ring.kind)) continue;
      if (differentLevel(ring.y)) continue;
      if (x < ring.minX - margin || x > ring.maxX + margin) continue;
      if (z < ring.minZ - margin || z > ring.maxZ + margin) continue;
      const inside = pointInRing(x, z, ring.points);
      const d = ringDistance(x, z, ring.points);
      const gap = inside ? -d : d - margin;
      if (gap > 0) continue;
      if (!best || gap < best.distance) {
        best = { kind: ring.kind, node: ring.node, distance: gap, y: ring.y };
      }
    }

    return best;
  }

  /** 塞がっていないか。 */
  isFree(x: number, z: number, query: OccupancyQuery = {}): boolean {
    return this.at(x, z, query) === null;
  }

  private addSpan(span: Span): void {
    const index = this.spans.push(span) - 1;
    const pad = span.halfWidth + 6;
    forEachBucket(
      Math.min(span.x0, span.x1) - pad,
      Math.min(span.z0, span.z1) - pad,
      Math.max(span.x0, span.x1) + pad,
      Math.max(span.z0, span.z1) + pad,
      (k) => push(this.spanBuckets, k, index),
    );
  }

  private addRing(node: NodeId, kind: NetworkKind, points: Vector3[]): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let sumY = 0;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
      sumY += p.y;
    }
    const index =
      this.rings.push({
        node,
        kind,
        points: points.map((p) => ({ x: p.x, z: p.z })),
        y: sumY / points.length,
        minX,
        maxX,
        minZ,
        maxZ,
      }) - 1;
    forEachBucket(minX - 6, minZ - 6, maxX + 6, maxZ + 6, (k) => push(this.ringBuckets, k, index));
  }
}

function push(map: Map<number, number[]>, k: number, index: number): void {
  const list = map.get(k);
  if (list) list.push(index);
  else map.set(k, [index]);
}

function key(x: number, z: number): number {
  return bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET));
}

function bucketKey(bx: number, bz: number): number {
  // 32 bit に収まる範囲でユニークになればよい。
  return (bx + 4096) * 16384 + (bz + 4096);
}

function forEachBucket(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  visit: (key: number) => void,
): void {
  const bx0 = Math.floor(minX / BUCKET);
  const bx1 = Math.floor(maxX / BUCKET);
  const bz0 = Math.floor(minZ / BUCKET);
  const bz1 = Math.floor(maxZ / BUCKET);
  for (let bz = bz0; bz <= bz1; bz++) {
    for (let bx = bx0; bx <= bx1; bx++) visit(bucketKey(bx, bz));
  }
}

/** 線分上の最近点までの距離と、その位置 (0..1)。 */
function projectOnSegment(
  px: number,
  pz: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): { distance: number; t: number } {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const lengthSq = dx * dx + dz * dz;
  let t = 0;
  if (lengthSq > 1e-12) {
    t = ((px - x0) * dx + (pz - z0) * dz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  return { distance: Math.hypot(px - (x0 + dx * t), pz - (z0 + dz * t)), t };
}

function distanceToSegment(
  px: number,
  pz: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): number {
  return projectOnSegment(px, pz, x0, z0, x1, z1).distance;
}

function pointInRing(x: number, z: number, ring: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function ringDistance(x: number, z: number, ring: { x: number; z: number }[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, distanceToSegment(x, z, ring[j].x, ring[j].z, ring[i].x, ring[i].z));
  }
  return best;
}
