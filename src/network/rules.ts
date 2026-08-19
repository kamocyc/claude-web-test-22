import { Vector3 } from 'three';
import type { Alignment } from '../core/alignment';
import {
  CLEARANCE_OVER_RAIL,
  CLEARANCE_OVER_ROAD,
  DECK_THICKNESS,
  DEG,
  LEVEL_CROSSING_TOLERANCE,
  clamp,
} from '../core/units';
import { MAX_CROSSING_LIFT } from '../build/crossing';
import type { NetworkClass } from './classes';
import { intersectPolylines, toPolyline, type PolylinePoint } from './crossings';
import type { Anchor } from './editing';
import { CORNER_MARGIN, requiredTrims, type BranchLike } from './junction';
import type { Branch, Network, NodeId, SegmentId } from './network';
import { classify } from './structure';
import type { Heightfield } from '../terrain/heightfield';

/**
 * 敷設してよいかの判定。
 *
 * 「作ってから警告を出す」のではなく、**作れないようにする**ための規則を
 * ここにまとめる。プレビューの段階で同じ判定を掛けるので、置けるかどうかは
 * クリックする前に分かる。
 */

/** 交差点として成り立たない浅すぎる交差角。 */
const MIN_CROSSING_ANGLE = 20 * DEG;
/** 交差点 1 つが 1 本のセグメントから取れる長さの上限 (区間長に対する比)。 */
const MAX_TRIM_RATIO = 0.45;
/** 交差点 1 つが取り込める長さの上限 [m]。 */
const MAX_TRIM = 40;

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
  /**
   * 自然地形。渡すと「トンネルの中の交差点」を止められる。
   * 省略した場合はその判定を行わない。
   */
  field?: Heightfield;
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
    // 途中に取り付く相手も「端点で繋がる相手」。ここを重なりとして数えると、
    // T 字に取り付くだけで必ず「交差点が近すぎます」になってしまう。
    // 取り付きの成否は `checkJunctionSpacing` で分割後の形として見る。
    if (!anchor.split) continue;
    connected.add(anchor.split.segment);
    const seg = network.segments.get(anchor.split.segment);
    if (seg) {
      visit(seg.a, 0);
      visit(seg.b, 0);
    }
  }
  if (ctx.ignore !== undefined) connected.add(ctx.ignore);

  blockers.push(...checkOverlaps(ctx, connected));
  blockers.push(...checkJunctionSpacing(ctx));
  blockers.push(...checkTunnelJunctions(ctx, connected));

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
          // 交差点は取り付き部の分だけ両側の線形を食べる。取り付きが端から
          // はみ出すようなら、交差点の形が崩れるので置かせない。
          // (「余裕をもって離す」ではなく、**実際に要る長さ**で判定する。)
          const cos = Math.abs(hit.dirA.x * hit.dirB.x + hit.dirA.y * hit.dirB.y);
          const mine = crossingTrim(cls, other, sin, cos);
          const theirs = crossingTrim(other, cls, sin, cos);
          // 交差点はここで両方を分割する。トリムを飲み込めるかは、
          // 分割してできる**短い方**の長さで決まる。
          tooClose = Math.max(
            tooClose,
            mine - roomFor(Math.min(hit.sA, ctx.alignment.length - hit.sA), 0),
            theirs - roomFor(Math.min(hit.sB, otherLength - hit.sB), 0),
          );
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

    if (tooClose > 0.05) {
      out.push(
        `交差点が近すぎます (あと ${Math.max(1, tooClose).toFixed(0)} m 離すか、既存のノードに繋いでください)。`,
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
 * 交差点として形が保てるか。
 *
 * 「何 m 離す」という一律の余裕ではなく、**交差点が実際に食べる長さ**
 * (トリム) が取れるかどうかで判定する。トリムは交差点を解くときと同じ
 * 計算 (`requiredTrims`) なので、通った配置は必ず形が保たれ、形が乱れる
 * ほど詰まった配置は必ず止まる。
 *
 * 見るのは 3 通り。
 *  - 既存ノードに繋ぐ … 集まる枝それぞれがトリムを飲み込めるか
 *  - 既存セグメントの途中に繋ぐ … 分割してできる 2 本が飲み込めるか
 *  - 新しいノードを作る … その点が既存の交差点の中に入っていないか
 */
function checkJunctionSpacing(ctx: PlacementContext): string[] {
  const { network, cls, alignment } = ctx;
  const out: string[] = [];
  const length = alignment.length;
  const mineAt: number[] = [0, 0];

  const ends: [Anchor, boolean][] = [
    [ctx.start, true],
    [ctx.end, false],
  ];
  ends.forEach(([anchor, atStart], index) => {
    const dir = atStart
      ? alignment.sampleAt(0).forwardXZ.clone()
      : alignment.sampleAt(length).forwardXZ.clone().negate();
    const mine: BranchLike = { dir, cls };

    if (anchor.node !== undefined) {
      const branches = network
        .branchesAt(anchor.node)
        .filter((b) => b.segment !== ctx.ignore);
      const trims = requiredTrims([...branches, mine]);
      mineAt[index] = trims[trims.length - 1];
      branches.forEach((branch, k) => {
        if (trims[k] < 1e-3) return; // 一直線に繋がる枝はトリムしない
        const shortfall = trims[k] + CORNER_MARGIN - branchRoom(network, branch);
        if (shortfall > 0.05) out.push(tooClose(shortfall));
      });
      return;
    }

    if (anchor.split) {
      const seg = network.segments.get(anchor.split.segment);
      if (!seg) return;
      const split = network.alignmentOf(anchor.split.segment);
      const s = clamp(anchor.split.s, 0, split.length);
      const tangent = split.sampleAt(s).forwardXZ;
      const splitCls = network.classOf(seg);
      // 分割すると、切った点から両側へ 1 本ずつの枝ができる。
      const halves: { branch: BranchLike; length: number; far: NodeId }[] = [
        { branch: { dir: tangent.clone().negate(), cls: splitCls }, length: s, far: seg.a },
        {
          branch: { dir: tangent.clone(), cls: splitCls },
          length: split.length - s,
          far: seg.b,
        },
      ];
      const trims = requiredTrims([...halves.map((h) => h.branch), mine]);
      mineAt[index] = trims[trims.length - 1];
      halves.forEach((half, k) => {
        if (trims[k] < 1e-3) return;
        const far = trimAt(network, half.far, anchor.split!.segment);
        const shortfall =
          trims[k] + CORNER_MARGIN - roomFor(half.length, far + CORNER_MARGIN);
        if (shortfall > 0.05) out.push(tooClose(shortfall));
      });
      return;
    }

    // 新しいノードを作る場合。既存の交差点の**面の中**に端点を置くと、
    // 舗装どうしが重なって形が乱れる。逆に交差点の外なら、多少近くても
    // 形は保たれるので止めない。
    for (const node of network.nodes.values()) {
      const distance = node.pos.distanceTo(anchor.pos);
      if (distance > 60) continue;
      const reach = junctionReach(network, node.id) + cls.halfWidth * 0.5;
      if (distance < reach) {
        out.push(
          `交差点の中に端点があります (あと ${Math.max(1, reach - distance).toFixed(0)} m 離すか、` +
            `交差点のノードに繋いでください)。`,
        );
      }
    }
  });

  // 新しい線形自身が、両端の取り付きを飲み込めるか。
  // (トリムのいらない端 = 交差点にならない端は見ない。引き始めの
  //  長さ 0 のプレビューで「区間長が足りない」と言わないため。)
  mineAt.forEach((trim, index) => {
    if (trim < 1e-3) return;
    const shortfall =
      trim + CORNER_MARGIN - roomFor(length, mineAt[1 - index] + CORNER_MARGIN);
    if (shortfall > 0.05) {
      out.push(
        `交差点の取り付きに ${(trim + CORNER_MARGIN).toFixed(0)} m 必要ですが、` +
          `区間長が ${length.toFixed(0)} m しかありません。`,
      );
    }
  });
  return out;
}

function tooClose(shortfall: number): string {
  return `交差点が近すぎます (あと ${Math.max(1, shortfall).toFixed(0)} m 離すか、既存のノードに繋いでください)。`;
}

/**
 * 長さ `length` のセグメントが、反対の端で `farTrim` を取られたうえで
 * こちらの端に差し出せる長さ [m]。
 *
 * 交差点を解くときに掛かる上限 (区間長の 45%・40 m・両端の合計) と
 * 同じ条件にしてある。これを超える配置は、必ずトリムが頭打ちになって
 * 形が乱れる。
 */
function roomFor(length: number, farTrim: number): number {
  return Math.min(length * MAX_TRIM_RATIO, MAX_TRIM, length - farTrim - 1);
}

/** その枝がノード側に差し出せる長さ [m]。 */
function branchRoom(network: Network, branch: Branch): number {
  const seg = network.segments.get(branch.segment);
  if (!seg) return 0;
  const length = network.alignmentOf(branch.segment).length;
  const far = trimAt(network, branch.atStart ? seg.b : seg.a, branch.segment);
  return roomFor(length, far + CORNER_MARGIN);
}

/** そのノードで、指定したセグメントの枝に必要なトリム量 [m]。 */
function trimAt(network: Network, node: NodeId, segment: SegmentId): number {
  const branches = network.branchesAt(node);
  const index = branches.findIndex((b) => b.segment === segment);
  if (index < 0) return 0;
  return requiredTrims(branches)[index];
}

/** その交差点の面が広がっている範囲 [m] (端点・継ぎ目なら 0)。 */
function junctionReach(network: Network, node: NodeId): number {
  const branches = network.branchesAt(node);
  if (branches.length < 2) return 0;
  const trims = requiredTrims(branches);
  const trim = Math.max(...trims);
  if (trim < 1e-3) return 0;
  return Math.min(trim + CORNER_MARGIN, MAX_TRIM);
}

/**
 * 同一平面で交差する 2 本のうち、片方が交差点に差し出す長さ [m]。
 * 交差点を解くときの路端線の交点と同じ式。
 */
function crossingTrim(
  own: NetworkClass,
  other: NetworkClass,
  sin: number,
  cos: number,
): number {
  return (other.halfWidth + own.halfWidth * cos) / Math.max(0.05, sin) + CORNER_MARGIN;
}

/** 坑門が交差点の外に立つために要る余裕 [m] (柱の奥行き + 隅の丸め)。 */
const PORTAL_STANDOFF = 3;

/**
 * トンネルの中・坑口にかかる交差点を止める。
 *
 * トンネルの中に交差点があると、四方の口に坑門が立って車がぶつかり、
 * 交差点そのものも山の中に埋まる。地形と線形の高さで決まることなので、
 * 「掘ってから直す」ことができない。置く前に止める。
 *
 * 判定は交差点になる点 (既存ノード・取り付き・同一平面の交差) のまわりで、
 * **交差点が食べる長さ + 坑門の余裕**の範囲を線形に沿って歩き、そこが
 * トンネルの区間に入るかどうかを見る。地形を横に見ないのは、山腹を
 * 走っているだけの道路を巻き込まないため。
 */
function checkTunnelJunctions(ctx: PlacementContext, connected: Set<SegmentId>): string[] {
  const field = ctx.field;
  if (!field) return [];
  const { network, cls, alignment } = ctx;
  const out: string[] = [];

  /** 線形の s0 から前後 `reach` の範囲に、トンネルの区間があるか。 */
  const tunnelNear = (line: Alignment, s0: number, reach: number): boolean => {
    for (let d = 0; d <= reach; d += 2) {
      for (const s of d === 0 ? [s0] : [s0 - d, s0 + d]) {
        if (s < 0 || s > line.length) continue;
        const p = line.sampleAt(s).pos;
        if (classify(p.y, field.baseHeightAt(p.x, p.z)) === 'tunnel') return true;
      }
    }
    return false;
  };

  const blocked = (): void => {
    out.push('トンネルの中には交差点を作れません (坑口から離してください)。');
  };

  // 1. 既存の線形と同じ高さで交わる所 (新しくできる交差点)。
  const mine = polyline(alignment);
  for (const seg of network.segments.values()) {
    if (connected.has(seg.id)) continue;
    const other = network.classOf(seg);
    if (other.kind !== cls.kind) continue;
    const otherAlignment = network.alignmentOf(seg.id);
    for (const hit of intersectPolylines(mine, polyline(otherAlignment))) {
      if (Math.abs(hit.yA - hit.yB) > LEVEL_CROSSING_TOLERANCE) continue;
      const sin = Math.abs(hit.dirA.x * hit.dirB.y - hit.dirA.y * hit.dirB.x);
      const cos = Math.abs(hit.dirA.x * hit.dirB.x + hit.dirA.y * hit.dirB.y);
      if (
        tunnelNear(alignment, hit.sA, crossingTrim(cls, other, sin, cos) + PORTAL_STANDOFF) ||
        tunnelNear(otherAlignment, hit.sB, crossingTrim(other, cls, sin, cos) + PORTAL_STANDOFF)
      ) {
        blocked();
        return dedupe(out);
      }
    }
  }

  // 2. 端点が既存のノード・既存の線形の途中に取り付く所。
  const ends: [Anchor, number][] = [
    [ctx.start, 0],
    [ctx.end, alignment.length],
  ];
  for (const [anchor, s] of ends) {
    const neighbours: { line: Alignment; s: number; cls: NetworkClass }[] = [];
    if (anchor.node !== undefined) {
      for (const branch of network.branchesAt(anchor.node)) {
        if (branch.segment === ctx.ignore) continue;
        const seg = network.segments.get(branch.segment);
        if (!seg) continue;
        const line = network.alignmentOf(branch.segment);
        neighbours.push({
          line,
          s: branch.atStart ? 0 : line.length,
          cls: network.classOf(seg),
        });
      }
    } else if (anchor.split) {
      const seg = network.segments.get(anchor.split.segment);
      if (seg) {
        const line = network.alignmentOf(anchor.split.segment);
        neighbours.push({
          line,
          s: clamp(anchor.split.s, 0, line.length),
          cls: network.classOf(seg),
        });
      }
    }
    // 交差点にならない端 (行き止まり) は見ない。
    if (neighbours.length === 0) continue;
    for (const neighbour of neighbours) {
      // 直角に取り付く場合のトリム。斜めの取り付きはこれより長くなるが、
      // 足りない分は「止めない側」に外れるので誤検知にならない。
      const reach = cls.halfWidth + neighbour.cls.halfWidth + CORNER_MARGIN + PORTAL_STANDOFF;
      if (tunnelNear(alignment, s, reach) || tunnelNear(neighbour.line, neighbour.s, reach)) {
        blocked();
        return dedupe(out);
      }
    }
  }

  return out;
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
