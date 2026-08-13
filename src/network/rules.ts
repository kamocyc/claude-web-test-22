import { Vector2, Vector3 } from 'three';
import type { Alignment } from '../core/alignment';
import {
  CLEARANCE_OVER_RAIL,
  CLEARANCE_OVER_ROAD,
  DECK_THICKNESS,
  DEG,
  LEVEL_CROSSING_TOLERANCE,
} from '../core/units';
import { MAX_CROSSING_LIFT } from '../build/crossing';
import type { NetworkClass } from './classes';
import { intersectPolylines, toPolyline, type PolylinePoint } from './crossings';
import type { Anchor } from './editing';
import type { Network, NodeId, SegmentId } from './network';

/**
 * 敷設してよいかの判定。
 *
 * 「作ってから警告を出す」のではなく、**作れないようにする**ための規則を
 * ここにまとめる。プレビューの段階で同じ判定を掛けるので、置けるかどうかは
 * クリックする前に分かる。
 */

/** 交差点として成り立たない浅すぎる交差角。 */
const MIN_CROSSING_ANGLE = 20 * DEG;
/** 交差点どうしを離す最小距離 [m] (幅員に加える分)。 */
const JUNCTION_CLEARANCE = 8;

export interface PlacementCheck {
  /** 空なら敷設できる。 */
  blockers: string[];
}

export interface PlacementContext {
  network: Network;
  cls: NetworkClass;
  alignment: Alignment;
  start: Anchor;
  end: Anchor;
  /** 判定から外すセグメント (既存の線形を引き直すときの自分自身)。 */
  ignore?: SegmentId;
}

/**
 * 敷設できない理由を列挙する。1 つでもあれば置けない。
 *
 * 見るのは次の 4 点。
 *  1. 規格 (最小曲線半径・最大縦断勾配)
 *  2. 既存の線形との重なり (浅い角度での交差・並走)
 *  3. 立体交差の建築限界 (桁下が足りない / 同一平面で交差する)
 *  4. 交差点が近すぎる (取り付き長が取れない)
 */
export function checkPlacement(ctx: PlacementContext): PlacementCheck {
  const blockers: string[] = [...evaluate(ctx)];
  const network = ctx.network;

  // 端点で繋がる相手は「重なり」ではないので、判定から外す。
  // 分岐したばかりの所は本線の続きとも近いので、2 ホップ先まで見る。
  const connected = new Set<SegmentId>();
  const visit = (node: NodeId, depth: number): void => {
    for (const branch of network.branchesAt(node)) {
      if (connected.has(branch.segment)) continue;
      connected.add(branch.segment);
      if (depth <= 0) continue;
      const seg = network.segments.get(branch.segment);
      if (!seg) continue;
      visit(seg.a === node ? seg.b : seg.a, depth - 1);
    }
  };
  for (const anchor of [ctx.start, ctx.end]) {
    if (anchor.node !== undefined) visit(anchor.node, 1);
  }
  if (ctx.ignore !== undefined) connected.add(ctx.ignore);

  blockers.push(...checkOverlaps(ctx, connected));
  blockers.push(...checkJunctionSpacing(ctx));

  return { blockers: dedupe(blockers) };
}

function evaluate(ctx: PlacementContext): string[] {
  const { alignment, cls } = ctx;
  const out: string[] = [];
  const { minRadius } = alignment.horizontal.extremeCurvature(48);
  const maxGrade = alignment.vertical.maxGrade(32);
  if (minRadius < cls.minRadius - 1e-6) {
    out.push(
      `曲線半径 ${minRadius.toFixed(0)} m は ${cls.label} の最小半径 ${cls.minRadius} m を下回ります。`,
    );
  }
  if (maxGrade > cls.maxGrade + 1e-6) {
    out.push(
      `勾配 ${(maxGrade * 100).toFixed(1)}% は ${cls.label} の最大勾配 ${(cls.maxGrade * 100).toFixed(1)}% を超えます。`,
    );
  }
  return out;
}

type Sample = PolylinePoint;

function polyline(alignment: Alignment, step = 3): Sample[] {
  return toPolyline(alignment, step);
}

/**
 * 既存の線形との干渉を見る。
 *
 * - 同じ高さで重なって走っている (並走・浅い角度の交差) → 置けない
 * - 同じ高さで交差する道路どうし・線路どうし → 交差点にできないので置けない
 * - 立体交差だが桁下が足りない → 置けない
 */
function checkOverlaps(ctx: PlacementContext, connected: Set<SegmentId>): string[] {
  const { network, cls } = ctx;
  const mine = polyline(ctx.alignment);
  const bounds = boundsOf(mine);
  const out: string[] = [];

  for (const seg of network.segments.values()) {
    if (connected.has(seg.id)) continue;
    const other = network.classOf(seg);
    const otherLine = polyline(network.alignmentOf(seg.id));
    const reach = cls.halfWidth + other.halfWidth;
    // 遠い線形は見るまでもない。
    const otherBounds = boundsOf(otherLine);
    if (
      bounds.maxX + reach < otherBounds.minX ||
      otherBounds.maxX + reach < bounds.minX ||
      bounds.maxZ + reach < otherBounds.minZ ||
      otherBounds.maxZ + reach < bounds.minZ
    ) {
      continue;
    }

    let shallow = false;
    let tooClose = 0;
    let worstClearance = Infinity;
    let worstCrossing = 0;
    let lowerKindOfWorst: 'road' | 'rail' = other.kind;
    const otherAlignment = network.alignmentOf(seg.id);
    const otherLength = otherAlignment.length;

    // 交点での高さで判定する。横にずれた点どうしを比べると、勾配のある
    // 道路では実際より低い / 高い桁下を読んでしまう。
    const hits = intersectPolylines(mine, otherLine);
    for (const hit of hits) {
      const dy = hit.yA - hit.yB;
      const sin = Math.abs(hit.dirA.x * hit.dirB.y - hit.dirA.y * hit.dirB.x);
      if (Math.abs(dy) <= LEVEL_CROSSING_TOLERANCE) {
        // 同一平面。道路 × 線路は踏切、同じ種別どうしは交差点になる。
        if (sin < Math.sin(MIN_CROSSING_ANGLE)) shallow = true;
        if (cls.kind !== other.kind) {
          // 踏切。路面を線路の面に合わせるので、交差角が浅く道路の勾配が
          // 急だと、道路に何十 m もの平坦部を刻むことになる。
          const need = crossingDeformation(
            cls.kind === 'road' ? cls : other,
            cls.kind === 'road' ? other : cls,
            sin,
            cls.kind === 'road'
              ? ctx.alignment.vertical.gradeAt(hit.sA)
              : otherAlignment.vertical.gradeAt(hit.sB),
            cls.kind === 'rail'
              ? ctx.alignment.vertical.gradeAt(hit.sA)
              : otherAlignment.vertical.gradeAt(hit.sB),
          );
          if (need > MAX_CROSSING_LIFT) worstCrossing = Math.max(worstCrossing, need);
        }
        if (cls.kind === other.kind) {
          // 交差点は取り付き部の分だけ両側の線形を食べる。端に近すぎると
          // 交差点どうしが重なるので置かせない。
          const trim = (cls.halfWidth + other.halfWidth) / Math.max(0.2, sin) + JUNCTION_CLEARANCE;
          const room = Math.min(
            hit.sA,
            ctx.alignment.length - hit.sA,
            hit.sB,
            otherLength - hit.sB,
          );
          if (room < trim) tooClose = Math.max(tooClose, trim - room);
        }
        continue;
      }
      const lowerKind = dy > 0 ? other.kind : cls.kind;
      const required = lowerKind === 'rail' ? CLEARANCE_OVER_RAIL : CLEARANCE_OVER_ROAD;
      const clearance = Math.abs(dy) - DECK_THICKNESS;
      if (clearance < required && clearance < worstClearance) {
        worstClearance = clearance;
        lowerKindOfWorst = lowerKind;
      }
    }

    // 交わらないのに近接が続くのは並走。
    let overlapLength = 0;
    if (hits.length === 0) {
      for (let i = 1; i < mine.length; i++) {
        const a = mine[i];
        const near = nearestOn(otherLine, a.x, a.z);
        if (!near || near.distance > reach) continue;
        if (Math.abs(a.y - near.y) > LEVEL_CROSSING_TOLERANCE) continue;
        overlapLength += Math.hypot(a.x - mine[i - 1].x, a.z - mine[i - 1].z);
      }
    }

    if (tooClose > 0) {
      out.push(
        `交差点が近すぎます (あと ${tooClose.toFixed(0)} m 離すか、既存のノードに繋いでください)。`,
      );
    }
    if (shallow) {
      out.push(`交差角が浅すぎます (${(MIN_CROSSING_ANGLE / DEG).toFixed(0)}° 以上必要)。`);
    }
    if (worstCrossing > 0) {
      out.push(
        `踏切にできません。路面を線路に合わせるのに ±${worstCrossing.toFixed(1)} m の` +
          `すり付けが要ります (交差角を大きくするか、道路の勾配を緩めてください)。`,
      );
    }
    if (!shallow && overlapLength > reach * 2.5) {
      out.push('既存の線形と重なって並走しています。');
    }
    if (Number.isFinite(worstClearance)) {
      const required =
        lowerKindOfWorst === 'rail' ? CLEARANCE_OVER_RAIL : CLEARANCE_OVER_ROAD;
      out.push(
        `桁下 ${worstClearance.toFixed(1)} m は建築限界 ${required.toFixed(1)} m に足りません。高さを変えてください。`,
      );
    }
  }
  return out;
}

/**
 * 踏切で道路をどれだけ変形させることになるか [m]。
 *
 * 舗装が線路に接するのは、道路の弧長で見て「線路の半幅 / sin + 道路の
 * 半幅 / tan」の範囲。その端で、道路の本来の縦断と線路の面がどれだけ
 * 離れるかを見る。交差角が浅いほど、道路の勾配が急なほど大きくなる。
 */
function crossingDeformation(
  roadCls: NetworkClass,
  railCls: NetworkClass,
  sin: number,
  roadGrade: number,
  railGrade: number,
): number {
  const s = Math.max(0.26, sin);
  const cos = Math.sqrt(Math.max(0, 1 - s * s));
  const reach = railCls.halfWidth / s + roadCls.halfWidth * (cos / s);
  // 道路の弧長方向に見た、線路の面の勾配との差。
  const slope = Math.abs(railGrade * cos - roadGrade);
  return reach * slope;
}

function boundsOf(line: Sample[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of line) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function nearestOn(
  line: Sample[],
  x: number,
  z: number,
): { distance: number; y: number } | null {
  let best: { distance: number; y: number } | null = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    let t = 0;
    if (lengthSq > 1e-9) {
      t = ((x - a.x) * dx + (z - a.z) * dz) / lengthSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const distance = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (!best || distance < best.distance) {
      best = { distance, y: a.y + (b.y - a.y) * t };
    }
  }
  return best;
}

/**
 * 交差点が近すぎないか。
 *
 * 交差点は取り付き部 (トリム) の分だけ線形を食べるので、両端の取り付き長を
 * 足して区間長を超えるようだと形が破綻する。新しくノードを作る場合は、
 * 既存のノードから十分離れていることも見る。
 */
function checkJunctionSpacing(ctx: PlacementContext): string[] {
  const { network, cls, alignment } = ctx;
  const out: string[] = [];
  const length = alignment.length;

  let needed = 0;
  for (const [anchor, atStart] of [
    [ctx.start, true],
    [ctx.end, false],
  ] as [Anchor, boolean][]) {
    const dir = atStart
      ? alignment.sampleAt(0).forwardXZ.clone()
      : alignment.sampleAt(length).forwardXZ.clone().negate();

    if (anchor.node !== undefined) {
      needed += requiredTrim(network, anchor.node, dir, cls);
      continue;
    }
    // 新しいノードを作る場合、既存のノードに近すぎると交差点が重なる。
    const spacing = cls.halfWidth + JUNCTION_CLEARANCE;
    const near = network.findNodeNear(anchor.pos, spacing);
    if (near && network.branchesAt(near.id).length > 0) {
      const distance = near.pos.distanceTo(anchor.pos);
      out.push(
        `交差点まで ${distance.toFixed(1)} m しかありません (${spacing.toFixed(0)} m 以上離してください)。`,
      );
    }
  }

  if (needed > 0 && needed > length * 0.85) {
    out.push(
      `交差点の取り付きに ${needed.toFixed(0)} m 必要ですが、区間長が ${length.toFixed(0)} m しかありません。`,
    );
  }
  return out;
}

/**
 * そのノードに取り付くのに必要な長さ。
 * 隣り合う枝との路端線の交点までの距離で、交差角が浅いほど長くなる。
 */
function requiredTrim(
  network: Network,
  node: NodeId,
  dir: Vector2,
  cls: NetworkClass,
): number {
  let trim = 0;
  for (const branch of network.branchesAt(node)) {
    const sin = Math.abs(dir.x * branch.dir.y - dir.y * branch.dir.x);
    const cos = dir.dot(branch.dir);
    // ほぼ一直線に繋がる場合はトリム不要。
    if (cos < -0.999) continue;
    if (sin < 1e-3) continue;
    trim = Math.max(trim, (branch.cls.halfWidth + cls.halfWidth * Math.max(0, cos)) / sin);
  }
  return trim;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/** 撤去してよいか (今は常に許す)。将来の拡張のために口を開けておく。 */
export function checkRemoval(_network: Network, _segment: SegmentId): PlacementCheck {
  return { blockers: [] };
}

/** デバッグ用: 判定に使った点を可視化したいとき向け。 */
export function placementSamples(alignment: Alignment): Vector3[] {
  return polyline(alignment).map((p) => new Vector3(p.x, p.y, p.z));
}
