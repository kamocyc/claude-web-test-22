import { Vector2, Vector3 } from 'three';
import { HorizontalCurve, arcFromTangent, type XZ } from '../core/curve';
import { clamp } from '../core/units';
import type { NetworkClass } from './classes';
import type { Network, NetNode, NodeId, SegmentId } from './network';

/** 自動的に交差点にまとめる高低差の上限 [m]。 */
const AUTO_JUNCTION_TOLERANCE = 0.4;

/** 建設時の接続先。 */
export interface Anchor {
  /** 接続点の 3 次元位置。 */
  pos: Vector3;
  /** 既存ノードに接続する場合の ID。 */
  node?: NodeId;
  /** 既存セグメントの途中に接続する場合。commit 時に分割する。 */
  split?: { segment: SegmentId; s: number };
  /** 接続先から引き継ぐ進行方向 (この向きに接線を合わせる)。 */
  tangent?: Vector2;
  /** 接続先から引き継ぐ縦断勾配。 */
  grade?: number;
}

/** 建設プレビューの計算結果。 */
export interface PlacementPreview {
  horizontal: HorizontalCurve;
  /** 実際の終点 (円弧の掃引角制限で、指定点と異なることがある)。 */
  end: Vector3;
  startGrade: number;
  endGrade: number;
  radius: number;
  grade: number;
  endTangent: Vector2;
}

/**
 * 始点の接線を保ったまま、カーソル位置まで伸びる線形を求める。
 *
 * 既存の線形に接続しているときは接線と勾配を引き継ぐので、繋いだ所で
 * 折れ曲がったり勾配が急変したりしない。
 */
export function computePlacement(
  anchor: Anchor,
  target: Vector3,
  options: { straight: boolean; cls?: NetworkClass },
): PlacementPreview {
  const a: XZ = new Vector2(anchor.pos.x, anchor.pos.z);
  const b: XZ = new Vector2(target.x, target.z);

  let horizontal: HorizontalCurve;
  let endTangent: Vector2;
  let radius = Infinity;

  if (options.straight || !anchor.tangent) {
    horizontal = HorizontalCurve.straight(a, b);
    endTangent = b.clone().sub(a);
    if (endTangent.lengthSq() < 1e-9) endTangent = anchor.tangent?.clone() ?? new Vector2(1, 0);
    endTangent.normalize();
  } else {
    const arc = arcFromTangent(a, anchor.tangent, b);
    horizontal = arc.curve;
    endTangent = arc.endTangent;
    radius = arc.radius;
  }

  const length = Math.max(horizontal.length, 1e-3);
  const endXZ = horizontal.p1;
  const end = new Vector3(endXZ.x, target.y, endXZ.y);

  const average = (end.y - anchor.pos.y) / length;
  const { startGrade, endGrade } = solveVerticalTangents(
    anchor.grade ?? average,
    average,
    options.cls?.maxGrade ?? 0.35,
  );

  return {
    horizontal,
    end,
    startGrade,
    endGrade,
    radius,
    grade: profileMaxGrade(startGrade, endGrade, average),
    endTangent,
  };
}

/**
 * 縦断の端点勾配を決める。
 *
 * 終点勾配は区間の平均勾配に合わせる。`2*avg - m0` にすると勾配変化が
 * 線形の素直な縦断になるが、起伏を追って区間をつなぐと勾配が区間ごとに
 * 増幅し、平均の 3 倍まで育ってしまうため採用しない。
 *
 * 始点勾配は接続元から引き継ぐが、そのままだと区間内の最大勾配が規格を
 * 超えることがある。3 次エルミートの勾配は
 *   q(t) = avg + d * (3t - 1)(t - 1),  d = m0 - avg
 * なので値域は `[avg - d/3, avg + d]`。ここから、規格を守れる範囲まで
 * `d` を縮める。接続点の勾配が僅かに不連続になるが、非現実的な急勾配が
 * できるよりは望ましい。
 */
export function solveVerticalTangents(
  inheritedGrade: number,
  average: number,
  maxGrade: number,
): { startGrade: number; endGrade: number } {
  const headroom = Math.max(0, maxGrade - Math.abs(average));
  const d = clamp(inheritedGrade - average, -headroom, headroom);
  return { startGrade: average + d, endGrade: average };
}

/** 端点勾配と平均勾配から、区間内の最大勾配 (絶対値) を求める。 */
function profileMaxGrade(startGrade: number, endGrade: number, average: number): number {
  void endGrade;
  const d = startGrade - average;
  return Math.max(Math.abs(average + d), Math.abs(average - d / 3));
}

/** アンカーを実際のノードに解決する (必要ならセグメントを分割する)。 */
export function resolveAnchor(network: Network, anchor: Anchor): NetNode {
  if (anchor.node !== undefined && network.nodes.has(anchor.node)) {
    return network.getNode(anchor.node);
  }
  if (anchor.split) {
    return network.splitSegment(anchor.split.segment, anchor.split.s);
  }
  return network.addNode(anchor.pos);
}

export interface PlaceResult {
  segment: SegmentId;
  startNode: NodeId;
  endNode: NodeId;
  /** 自動生成された交差点のノード。 */
  autoJunctions: NodeId[];
}

/**
 * プレビュー内容を実際のセグメントとしてネットワークに追加する。
 * 追加後、既存の線形と平面交差している所は自動的に交差点にまとめる。
 */
export function placeSegment(
  network: Network,
  classId: string,
  start: Anchor,
  end: Anchor,
  preview: PlacementPreview,
): PlaceResult {
  const startNode = resolveAnchor(network, start);
  const endAnchor: Anchor = { ...end, pos: preview.end };
  const endNode = resolveAnchor(network, endAnchor);

  const segment = network.addSegment({
    classId,
    a: startNode.id,
    b: endNode.id,
    ctrlA: preview.horizontal.c0,
    ctrlB: preview.horizontal.c1,
    gradeA: preview.startGrade,
    gradeB: preview.endGrade,
  });

  const autoJunctions = resolveAutoJunctions(network, segment.id);
  return { segment: segment.id, startNode: startNode.id, endNode: endNode.id, autoJunctions };
}

/**
 * 追加したセグメントが既存の同種の線形と平面交差していたら、その位置で
 * 双方を分割して 1 つのノードに統合する。道路と線路の交差はここでは
 * 触らず、踏切として処理される。
 */
export function resolveAutoJunctions(network: Network, newSegment: SegmentId): NodeId[] {
  const created: NodeId[] = [];
  // 分割で ID が変わるので、自分側を先に分割してから相手を分割する。
  const queue: SegmentId[] = [newSegment];

  for (let guard = 0; guard < 32 && queue.length > 0; guard++) {
    const current = queue.shift()!;
    if (!network.segments.has(current)) continue;
    const hit = firstConflict(network, current);
    if (!hit) continue;

    const myNode = network.splitSegment(current, hit.sMine);
    const halves = myNode.segments.slice();
    const otherNode = network.splitSegment(hit.other, hit.sOther);
    const merged = network.mergeNodes(myNode.id, otherNode.id);
    created.push(merged.id);
    for (const half of halves) queue.push(half);
  }

  return created;
}

interface Conflict {
  other: SegmentId;
  sOther: number;
  sMine: number;
}

/** 同じ種別で、ノードを共有せず平面交差しているセグメントを 1 つ探す。 */
function firstConflict(network: Network, id: SegmentId): Conflict | null {
  const seg = network.getSegment(id);
  const cls = network.classOf(seg);
  const alignment = network.alignmentOf(id);
  const mine = samplePolyline(network, id);

  for (const other of network.segments.values()) {
    if (other.id === id) continue;
    if (network.classOf(other).kind !== cls.kind) continue;
    if (
      other.a === seg.a ||
      other.a === seg.b ||
      other.b === seg.a ||
      other.b === seg.b
    ) {
      continue;
    }

    const theirs = samplePolyline(network, other.id);
    for (let i = 0; i + 1 < mine.length; i++) {
      for (let j = 0; j + 1 < theirs.length; j++) {
        const hit = segmentIntersection(mine[i], mine[i + 1], theirs[j], theirs[j + 1]);
        if (!hit) continue;
        if (Math.abs(hit.ya - hit.yb) > AUTO_JUNCTION_TOLERANCE) continue;
        // 端点に近すぎる分割は避ける (極端に短いセグメントができるため)。
        const otherLength = network.alignmentOf(other.id).length;
        if (hit.sb < 2 || hit.sb > otherLength - 2) continue;
        if (hit.sa < 2 || hit.sa > alignment.length - 2) continue;
        return { other: other.id, sOther: hit.sb, sMine: hit.sa };
      }
    }
  }
  return null;
}

interface PolyPoint {
  s: number;
  x: number;
  y: number;
  z: number;
}

function samplePolyline(network: Network, id: SegmentId, step = 2.5): PolyPoint[] {
  const alignment = network.alignmentOf(id);
  const n = Math.max(1, Math.ceil(alignment.length / step));
  const out: PolyPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const s = (alignment.length * i) / n;
    const p = alignment.sampleAt(s).pos;
    out.push({ s, x: p.x, y: p.y, z: p.z });
  }
  return out;
}

function segmentIntersection(
  a0: PolyPoint,
  a1: PolyPoint,
  b0: PolyPoint,
  b1: PolyPoint,
): { x: number; z: number; sa: number; sb: number; ya: number; yb: number } | null {
  const ax = a1.x - a0.x;
  const az = a1.z - a0.z;
  const bx = b1.x - b0.x;
  const bz = b1.z - b0.z;
  const det = ax * bz - az * bx;
  if (Math.abs(det) < 1e-9) return null;
  const rx = b0.x - a0.x;
  const rz = b0.z - a0.z;
  const t = (rx * bz - rz * bx) / det;
  const u = (rx * az - rz * ax) / det;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return {
    x: a0.x + ax * t,
    z: a0.z + az * t,
    sa: a0.s + (a1.s - a0.s) * t,
    sb: b0.s + (b1.s - b0.s) * u,
    ya: a0.y + (a1.y - a0.y) * t,
    yb: b0.y + (b1.y - b0.y) * u,
  };
}

/**
 * 既存ノードに接続するアンカーを作る。
 *
 * 端点 (枝が 1 本) から引く場合は、その線形の延長として接線と勾配を
 * 引き継ぐので、繋ぎ目が折れない。既に 2 本以上が集まっているノードから
 * 引く場合は分岐を作りたい場面なので、向きは自由にする。勾配だけは
 * 段差ができないよう既存の枝から受け継ぐ。
 */
export function anchorFromNode(network: Network, node: NetNode, cls: NetworkClass): Anchor {
  const branches = network.branchesAt(node.id);
  const anchor: Anchor = { pos: node.pos.clone(), node: node.id };
  if (branches.length === 0) return anchor;

  const same = branches.find((b) => b.cls.kind === cls.kind) ?? branches[0];
  if (branches.length === 1) {
    anchor.tangent = same.dir.clone().negate();
    anchor.grade = -same.grade;
  }
  return anchor;
}

/**
 * セグメント途中に接続する場合のアンカー。
 * T 字の取り付きは向きを自由に決めたいので、接線は引き継がない。
 */
export function anchorFromSegment(network: Network, segment: SegmentId, s: number): Anchor {
  const sample = network.alignmentOf(segment).sampleAt(s);
  return { pos: sample.pos.clone(), split: { segment, s } };
}
