import { Vector2, Vector3 } from 'three';
import { Alignment } from '../core/alignment';
import { HorizontalCurve, perp, type XZ } from '../core/curve';
import { VerticalProfile } from '../core/profile';
import { getClass, type NetworkClass } from './classes';

export type NodeId = number;
export type SegmentId = number;

export interface NetNode {
  id: NodeId;
  pos: Vector3;
  /** 接続しているセグメント。 */
  segments: SegmentId[];
}

export interface NetSegment {
  id: SegmentId;
  classId: string;
  a: NodeId;
  b: NodeId;
  /** a 側のベジエ制御点 (ワールド XZ)。 */
  ctrlA: Vector2;
  /** b 側のベジエ制御点 (ワールド XZ)。 */
  ctrlB: Vector2;
  /** a 端の縦断勾配 dy/ds。 */
  gradeA: number;
  /** b 端の縦断勾配 dy/ds。 */
  gradeB: number;
}

/** ノードから見た 1 本の接続枝。交差点の解析はこの形で行う。 */
export interface Branch {
  segment: SegmentId;
  /** このノードがセグメントの a 側か b 側か。 */
  atStart: boolean;
  /** ノードから外向きの単位方向 (水平)。 */
  dir: Vector2;
  /** `atan2(dir.y, dir.x)`。ソート用。 */
  angle: number;
  cls: NetworkClass;
  /** ノードから外向きに測った縦断勾配。 */
  grade: number;
}

/**
 * 道路・線路のネットワークを保持するグラフ。
 *
 * 幾何 (線形) はノード位置と制御点から都度導出する。編集のたびに
 * `version` が上がり、描画側はそれを見て再構築する。
 */
export class Network {
  private nextNodeId = 1;
  private nextSegmentId = 1;
  readonly nodes = new Map<NodeId, NetNode>();
  readonly segments = new Map<SegmentId, NetSegment>();
  private alignmentCache = new Map<SegmentId, Alignment>();
  version = 0;

  private touch(): void {
    this.version++;
    this.alignmentCache.clear();
  }

  addNode(pos: Vector3): NetNode {
    const node: NetNode = { id: this.nextNodeId++, pos: pos.clone(), segments: [] };
    this.nodes.set(node.id, node);
    this.touch();
    return node;
  }

  getNode(id: NodeId): NetNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  getSegment(id: SegmentId): NetSegment {
    const s = this.segments.get(id);
    if (!s) throw new Error(`unknown segment ${id}`);
    return s;
  }

  classOf(seg: NetSegment): NetworkClass {
    return getClass(seg.classId);
  }

  addSegment(params: {
    classId: string;
    a: NodeId;
    b: NodeId;
    ctrlA: Vector2;
    ctrlB: Vector2;
    gradeA: number;
    gradeB: number;
  }): NetSegment {
    const seg: NetSegment = {
      id: this.nextSegmentId++,
      classId: params.classId,
      a: params.a,
      b: params.b,
      ctrlA: params.ctrlA.clone(),
      ctrlB: params.ctrlB.clone(),
      gradeA: params.gradeA,
      gradeB: params.gradeB,
    };
    this.segments.set(seg.id, seg);
    this.getNode(seg.a).segments.push(seg.id);
    this.getNode(seg.b).segments.push(seg.id);
    this.touch();
    return seg;
  }

  removeSegment(id: SegmentId): void {
    const seg = this.segments.get(id);
    if (!seg) return;
    this.segments.delete(id);
    for (const nodeId of [seg.a, seg.b]) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      node.segments = node.segments.filter((s) => s !== id);
      if (node.segments.length === 0) this.nodes.delete(nodeId);
    }
    this.touch();
  }

  /** 孤立ノードを削除する。 */
  pruneOrphanNodes(): void {
    let removed = false;
    for (const [id, node] of [...this.nodes]) {
      if (node.segments.length === 0) {
        this.nodes.delete(id);
        removed = true;
      }
    }
    if (removed) this.touch();
  }

  /** セグメントの線形 (3 次元) を返す。結果は version 単位でキャッシュされる。 */
  alignmentOf(id: SegmentId): Alignment {
    const cached = this.alignmentCache.get(id);
    if (cached) return cached;
    const seg = this.getSegment(id);
    const a = this.getNode(seg.a);
    const b = this.getNode(seg.b);
    const h = new HorizontalCurve(
      new Vector2(a.pos.x, a.pos.z),
      seg.ctrlA,
      seg.ctrlB,
      new Vector2(b.pos.x, b.pos.z),
    );
    const v = new VerticalProfile(a.pos.y, b.pos.y, seg.gradeA, seg.gradeB, h.length);
    const al = new Alignment(h, v);
    this.alignmentCache.set(id, al);
    return al;
  }

  /** ノードから外向きに見た接続枝を、方位角順 (昇順) で返す。 */
  branchesAt(nodeId: NodeId): Branch[] {
    const node = this.getNode(nodeId);
    const out: Branch[] = [];
    for (const segId of node.segments) {
      const seg = this.segments.get(segId);
      if (!seg) continue;
      const al = this.alignmentOf(segId);
      const atStart = seg.a === nodeId;
      // 自己ループは扱わない。
      if (seg.a === seg.b) continue;
      const t = atStart ? al.horizontal.tangentAt(0) : al.horizontal.tangentAt(al.length);
      const dir = atStart ? t.clone() : t.clone().negate();
      const grade = atStart ? seg.gradeA : -seg.gradeB;
      out.push({
        segment: segId,
        atStart,
        dir,
        angle: Math.atan2(dir.y, dir.x),
        cls: this.classOf(seg),
        grade,
      });
    }
    out.sort((p, q) => p.angle - q.angle);
    return out;
  }

  /**
   * セグメントを弧長 `s` の位置で 2 本に分割し、新しいノードを返す。
   * 分割点の位置・接線・勾配は元の線形から引き継ぐので形状は変わらない。
   */
  splitSegment(id: SegmentId, s: number): NetNode {
    const seg = this.getSegment(id);
    const al = this.alignmentOf(id);
    const L = al.length;
    const cut = Math.max(0.5, Math.min(L - 0.5, s));
    const first = al.subAlignment(0, cut);
    const second = al.subAlignment(cut, L);

    const mid = al.sampleAt(cut);
    const node = this.addNode(mid.pos);

    const classId = seg.classId;
    const a = seg.a;
    const b = seg.b;
    this.removeSegment(id);
    // removeSegment は孤立したノードを消すので、端点が生きているか確認する。
    const keepA = this.nodes.get(a) ?? this.restoreNode(a, first.horizontal.p0, first.vertical.y0);
    const keepB = this.nodes.get(b) ?? this.restoreNode(b, second.horizontal.p1, second.vertical.y1);

    this.addSegment({
      classId,
      a: keepA.id,
      b: node.id,
      ctrlA: first.horizontal.c0,
      ctrlB: first.horizontal.c1,
      gradeA: first.vertical.m0,
      gradeB: first.vertical.m1,
    });
    this.addSegment({
      classId,
      a: node.id,
      b: keepB.id,
      ctrlA: second.horizontal.c0,
      ctrlB: second.horizontal.c1,
      gradeA: second.vertical.m0,
      gradeB: second.vertical.m1,
    });
    return node;
  }

  /**
   * 2 つのノードを 1 つに統合する。自動交差点生成で、両方のセグメントを
   * 分割してできた 2 つのノードを 1 つにまとめるのに使う。
   */
  mergeNodes(keep: NodeId, drop: NodeId): NetNode {
    if (keep === drop) return this.getNode(keep);
    const target = this.getNode(keep);
    const source = this.nodes.get(drop);
    if (!source) return target;

    target.pos.lerp(source.pos, 0.5);
    for (const segId of source.segments) {
      const seg = this.segments.get(segId);
      if (!seg) continue;
      if (seg.a === drop) seg.a = keep;
      if (seg.b === drop) seg.b = keep;
      if (!target.segments.includes(segId)) target.segments.push(segId);
    }
    this.nodes.delete(drop);
    this.touch();
    return target;
  }

  private restoreNode(id: NodeId, xzPos: XZ, y: number): NetNode {
    const node: NetNode = { id, pos: new Vector3(xzPos.x, y, xzPos.y), segments: [] };
    this.nodes.set(id, node);
    return node;
  }

  /** 指定半径内で最も近いノードを返す。 */
  findNodeNear(point: Vector3, radius: number): NetNode | null {
    let best: NetNode | null = null;
    let bestDist = radius * radius;
    for (const node of this.nodes.values()) {
      const dx = node.pos.x - point.x;
      const dz = node.pos.z - point.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = node;
      }
    }
    return best;
  }

  /** 指定半径内で最も近いセグメント上の点を返す。 */
  findSegmentNear(
    point: Vector3,
    radius: number,
  ): { segment: SegmentId; s: number; pos: Vector3; dir: Vector2 } | null {
    let best: { segment: SegmentId; s: number; pos: Vector3; dir: Vector2 } | null = null;
    let bestDist = radius * radius;
    const p = new Vector2(point.x, point.z);
    for (const seg of this.segments.values()) {
      const al = this.alignmentOf(seg.id);
      const L = al.length;
      const steps = Math.max(4, Math.ceil(L / 2));
      for (let i = 0; i <= steps; i++) {
        const s = (i / steps) * L;
        const q = al.horizontal.pointAt(s);
        const d = q.distanceToSquared(p);
        if (d < bestDist) {
          bestDist = d;
          const sample = al.sampleAt(s);
          best = { segment: seg.id, s, pos: sample.pos, dir: sample.forwardXZ };
        }
      }
    }
    return best;
  }

  /** ノード位置を動かす。接続セグメントの制御点は相対関係を保って追従する。 */
  moveNode(id: NodeId, pos: Vector3): void {
    const node = this.getNode(id);
    const delta = new Vector2(pos.x - node.pos.x, pos.z - node.pos.z);
    node.pos.copy(pos);
    for (const segId of node.segments) {
      const seg = this.segments.get(segId);
      if (!seg) continue;
      if (seg.a === id) seg.ctrlA.add(delta);
      if (seg.b === id) seg.ctrlB.add(delta);
    }
    this.touch();
  }

  /** ネットワーク全体を空にする。 */
  clear(): void {
    this.nodes.clear();
    this.segments.clear();
    this.nextNodeId = 1;
    this.nextSegmentId = 1;
    this.touch();
  }

  /** 接続枝の外向き法線 (右手側)。 */
  static branchNormal(branch: Branch): Vector2 {
    return perp(branch.dir);
  }
}
