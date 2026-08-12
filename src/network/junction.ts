import { Vector2, Vector3 } from 'three';
import { perp } from '../core/curve';
import { clamp } from '../core/units';
import { MAX_TURNOUT_ANGLE, STRAIGHT_THROUGH_ANGLE, type NetworkKind } from './classes';
import type { Branch, Network, NodeId, SegmentId } from './network';

export type JunctionKind =
  | 'end' // 行き止まり
  | 'seam' // 同一線形の継ぎ目 (トリム不要)
  | 'joint' // 2 枝の折れ点
  | 'intersection' // 3 枝以上の道路交差点
  | 'railSwitch' // 線路の分岐器
  | 'railCrossing' // 線路同士のダイヤモンドクロッシング
  | 'invalid'; // 道路と線路が同一ノードで接続されている等

/** 交差点における 1 本の接続枝の断面情報。 */
export interface Approach {
  branch: Branch;
  /** ノードからのトリム距離 [m]。ここからセグメント本体を描く。 */
  trim: number;
  /** トリム位置の中心線上の点。 */
  center: Vector3;
  /** 外向き方向 (水平、単位)。 */
  dir: Vector2;
  /** 方位角が小さい隣の枝を向く側の断面端点。 */
  edgePrev: Vector3;
  /** 方位角が大きい隣の枝を向く側の断面端点。 */
  edgeNext: Vector3;
  /** 車道部だけの断面端点 (横断歩道・停止線の幅に使う)。 */
  carriagewayPrev: Vector3;
  carriagewayNext: Vector3;
}

/** 線路の分岐で接続される 2 本の枝の組。 */
export interface TrackConnection {
  from: SegmentId;
  to: SegmentId;
  /** 直進側なら true。 */
  through: boolean;
  /** 分岐角 [rad]。 */
  deflection: number;
}

export interface Junction {
  node: NodeId;
  kind: JunctionKind;
  approaches: Approach[];
  /** 交差点面のリング (XZ 反時計回り、Y は各点の路面高)。 */
  ring: Vector3[];
  /** 信号制御されるか。 */
  signalized: boolean;
  /** 線路分岐での接続関係。 */
  connections: TrackConnection[];
  /** 警告メッセージ。 */
  warnings: string[];
}

/** セグメント両端のトリム量。 */
export interface SegmentTrim {
  a: number;
  b: number;
}

export interface JunctionSolution {
  junctions: Map<NodeId, Junction>;
  trims: Map<SegmentId, SegmentTrim>;
}

/** 隅角部を丸めるために各接続枝へ追加で与える余裕 [m]。 */
const CORNER_MARGIN = 0.6;

/**
 * ネットワーク全体の交差点形状を解く。
 *
 * 各ノードで、隣り合う枝どうしの路端線の交点を求め、そこまでセグメントを
 * 引っ込める (トリムする)。トリム位置の断面端点を繋ぐと交差点の面になる。
 */
export function solveJunctions(network: Network): JunctionSolution {
  const junctions = new Map<NodeId, Junction>();
  const trims = new Map<SegmentId, SegmentTrim>();
  for (const id of network.segments.keys()) trims.set(id, { a: 0, b: 0 });

  for (const nodeId of network.nodes.keys()) {
    const branches = network.branchesAt(nodeId);
    const junction = solveNode(network, nodeId, branches);
    junctions.set(nodeId, junction);
    for (const ap of junction.approaches) {
      const t = trims.get(ap.branch.segment);
      if (!t) continue;
      if (ap.branch.atStart) t.a = Math.max(t.a, ap.trim);
      else t.b = Math.max(t.b, ap.trim);
    }
  }

  // 短いセグメントで両端のトリムが衝突しないよう按分する。
  for (const [id, t] of trims) {
    const L = network.alignmentOf(id).length;
    const usable = Math.max(L - 1.0, L * 0.1);
    if (t.a + t.b > usable) {
      const k = usable / (t.a + t.b);
      t.a *= k;
      t.b *= k;
    }
  }

  // トリムを按分した結果を交差点形状へ反映し直す。
  for (const junction of junctions.values()) {
    for (const ap of junction.approaches) {
      const t = trims.get(ap.branch.segment);
      if (!t) continue;
      const applied = ap.branch.atStart ? t.a : t.b;
      if (Math.abs(applied - ap.trim) > 1e-6) {
        ap.trim = applied;
        updateApproachGeometry(network, ap);
      }
    }
    junction.ring = buildRing(junction);
  }

  return { junctions, trims };
}

function solveNode(network: Network, nodeId: NodeId, branches: Branch[]): Junction {
  const warnings: string[] = [];
  const kinds = new Set<NetworkKind>(branches.map((b) => b.cls.kind));
  if (kinds.size > 1) {
    warnings.push('道路と線路が同じノードで接続されています。踏切にするには交差させてください。');
  }
  const kind = classifyNode(branches, kinds);

  const n = branches.length;
  const approaches: Approach[] = branches.map((branch) => ({
    branch,
    trim: 0,
    center: new Vector3(),
    dir: branch.dir.clone(),
    edgePrev: new Vector3(),
    edgeNext: new Vector3(),
    carriagewayPrev: new Vector3(),
    carriagewayNext: new Vector3(),
  }));

  if (n >= 2) {
    // 2 枝のときも (0,1) と (1,0) の両方を見る。折れ点では外側だけに隙間ができ、
    // どちら側にできるかは折れる向きで決まるため。
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const solved = borderIntersection(branches[i], branches[j]);
      if (solved) {
        approaches[i].trim = Math.max(approaches[i].trim, solved.ti);
        approaches[j].trim = Math.max(approaches[j].trim, solved.tj);
      }
    }
  }

  const needsMargin = kind === 'intersection' || kind === 'railSwitch' || kind === 'railCrossing';
  for (const ap of approaches) {
    const L = network.alignmentOf(ap.branch.segment).length;
    const maxTrim = Math.min(L * 0.45, 40);
    if (needsMargin && ap.trim > 1e-3) ap.trim += CORNER_MARGIN;
    if (ap.trim > maxTrim) {
      ap.trim = maxTrim;
      warnings.push('交差点に対してセグメントが短すぎます。形状が乱れる場合があります。');
    }
    ap.trim = clamp(ap.trim, 0, maxTrim);
    updateApproachGeometry(network, ap);
  }

  const signalized =
    kind === 'intersection' &&
    branches.length >= 3 &&
    branches.some((b) => b.cls.signalCapable);

  const connections = kind === 'railSwitch' || kind === 'railCrossing' || kind === 'seam'
    ? solveTrackConnections(branches, warnings)
    : [];

  return {
    node: nodeId,
    kind,
    approaches,
    ring: [],
    signalized,
    connections,
    warnings,
  };
}

function classifyNode(branches: Branch[], kinds: Set<NetworkKind>): JunctionKind {
  if (branches.length === 0) return 'invalid';
  if (kinds.size > 1) return 'invalid';
  const isRail = branches[0].cls.kind === 'rail';
  if (branches.length === 1) return 'end';
  if (branches.length === 2) {
    const deflection = Math.abs(
      Math.PI - Math.abs(angleBetween(branches[0].dir, branches[1].dir)),
    );
    // ほぼ一直線なら継ぎ目扱いにして交差点面を作らない。
    if (deflection < 2 * (Math.PI / 180)) return 'seam';
    return isRail ? 'railSwitch' : 'joint';
  }
  if (isRail) return branches.length >= 4 ? 'railCrossing' : 'railSwitch';
  return 'intersection';
}

function angleBetween(a: Vector2, b: Vector2): number {
  return Math.acos(clamp(a.dot(b), -1, 1));
}

/**
 * 隣り合う 2 枝の路端線の交点を求め、それぞれのトリム距離を返す。
 *
 * 枝 `i` の「方位角が大きい側」の路端と、枝 `j` の「方位角が小さい側」の
 * 路端が向かい合う。`perp` は方位角が増える向きを指すのでこの対応になる。
 */
function borderIntersection(bi: Branch, bj: Branch): { ti: number; tj: number } | null {
  const di = bi.dir;
  const dj = bj.dir;
  const det = -(di.x * dj.y - di.y * dj.x);
  if (Math.abs(det) < 1e-6) return null;

  const ni = perp(di).multiplyScalar(bi.cls.halfWidth);
  const nj = perp(dj).multiplyScalar(-bj.cls.halfWidth);
  const rhs = new Vector2(nj.x - ni.x, nj.y - ni.y);

  const ti = (-rhs.x * dj.y + dj.x * rhs.y) / det;
  const tj = (di.x * rhs.y - di.y * rhs.x) / det;
  return { ti: Math.max(0, ti), tj: Math.max(0, tj) };
}

function updateApproachGeometry(network: Network, ap: Approach): void {
  const al = network.alignmentOf(ap.branch.segment);
  const L = al.length;
  const s = ap.branch.atStart ? ap.trim : L - ap.trim;
  const sample = al.sampleAt(clamp(s, 0, L));
  const cls = ap.branch.cls;

  // 外向き方向はトリム位置の接線で取り直す (曲線ではノードでの接線とずれるため)。
  const outward = ap.branch.atStart ? sample.forwardXZ.clone() : sample.forwardXZ.clone().negate();
  ap.dir.copy(outward);

  const normal = perp(outward);
  ap.center.copy(sample.pos);
  ap.edgeNext.set(
    sample.pos.x + normal.x * cls.halfWidth,
    sample.pos.y,
    sample.pos.z + normal.y * cls.halfWidth,
  );
  ap.edgePrev.set(
    sample.pos.x - normal.x * cls.halfWidth,
    sample.pos.y,
    sample.pos.z - normal.y * cls.halfWidth,
  );
  const cw = cls.carriagewayHalfWidth;
  ap.carriagewayNext.set(
    sample.pos.x + normal.x * cw,
    sample.pos.y,
    sample.pos.z + normal.y * cw,
  );
  ap.carriagewayPrev.set(
    sample.pos.x - normal.x * cw,
    sample.pos.y,
    sample.pos.z - normal.y * cw,
  );
}

/**
 * 交差点面のリングを作る。各枝の断面端点を方位角順に並べ、隣り合う枝の
 * 間には路端線の交点を制御点とする 2 次ベジエで隅丸めを入れる。
 */
function buildRing(junction: Junction): Vector3[] {
  const aps = junction.approaches;
  const n = aps.length;
  if (n < 2 || junction.kind === 'seam' || junction.kind === 'end') return [];
  if (aps.every((a) => a.trim < 1e-3)) return [];

  const ring: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const cur = aps[i];
    const next = aps[(i + 1) % n];
    ring.push(cur.edgePrev.clone(), cur.edgeNext.clone());

    const corner = cornerControl(cur, next);
    if (corner) {
      const a = cur.edgeNext;
      const b = next.edgePrev;
      if (a.distanceTo(b) > 0.05) {
        for (let k = 1; k <= 3; k++) {
          const t = k / 4;
          ring.push(quadratic(a, corner, b, t));
        }
      }
    }
  }
  return dedupe(ring);
}

/** 2 枝の路端線の交点 (隅丸めの制御点)。 */
function cornerControl(cur: Approach, next: Approach): Vector3 | null {
  const p = cur.edgeNext;
  const q = next.edgePrev;
  const dp = cur.dir;
  const dq = next.dir;
  const det = dp.x * dq.y - dp.y * dq.x;
  if (Math.abs(det) < 1e-6) return null;
  const rx = q.x - p.x;
  const rz = q.z - p.z;
  const t = (rx * dq.y - rz * dq.x) / det;
  if (t < 0 || t > 200) return null;
  return new Vector3(p.x + dp.x * t, (p.y + q.y) / 2, p.z + dp.y * t);
}

function quadratic(a: Vector3, c: Vector3, b: Vector3, t: number): Vector3 {
  const u = 1 - t;
  return new Vector3(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
}

function dedupe(points: Vector3[]): Vector3[] {
  const out: Vector3[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.distanceToSquared(p) > 1e-4) out.push(p);
  }
  while (out.length > 1 && out[0].distanceToSquared(out[out.length - 1]) < 1e-4) out.pop();
  return out;
}

/**
 * 線路ノードでの進路 (どの枝とどの枝が繋がるか) を決める。
 *
 * 偏角が最も小さい (= 最も一直線に近い) 組を直進側とし、残りの枝は
 * 直進側のうち向かい合う方へ分岐させる。3 枝なら分岐器、4 枝なら
 * 直進 2 組のダイヤモンドクロッシングになる。
 */
export function solveTrackConnections(branches: Branch[], warnings: string[]): TrackConnection[] {
  const n = branches.length;
  if (n < 2) return [];
  const used = new Set<number>();
  const conns: TrackConnection[] = [];

  const pairs: { i: number; j: number; dot: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs.push({ i, j, dot: branches[i].dir.dot(branches[j].dir) });
    }
  }
  // dot が -1 に近いほど一直線。
  pairs.sort((a, b) => a.dot - b.dot);

  for (const p of pairs) {
    if (used.has(p.i) || used.has(p.j)) continue;
    const deflection = Math.PI - Math.acos(clamp(p.dot, -1, 1));
    const through = deflection < STRAIGHT_THROUGH_ANGLE;
    used.add(p.i);
    used.add(p.j);
    conns.push({
      from: branches[p.i].segment,
      to: branches[p.j].segment,
      through,
      deflection,
    });
    if (deflection > MAX_TURNOUT_ANGLE && n > 2) {
      warnings.push(
        `分岐角 ${(deflection * (180 / Math.PI)).toFixed(0)}° は分岐器としては急すぎます。`,
      );
    }
  }

  // 余った枝 (奇数本のとき) は、最も向かい合う既接続の枝へ分岐させる。
  for (let i = 0; i < n; i++) {
    if (used.has(i)) continue;
    let best = -1;
    let bestDot = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = branches[i].dir.dot(branches[j].dir);
      if (d < bestDot) {
        bestDot = d;
        best = j;
      }
    }
    if (best < 0) continue;
    const deflection = Math.PI - Math.acos(clamp(bestDot, -1, 1));
    conns.push({
      from: branches[i].segment,
      to: branches[best].segment,
      through: false,
      deflection,
    });
    if (deflection > MAX_TURNOUT_ANGLE) {
      warnings.push(
        `分岐角 ${(deflection * (180 / Math.PI)).toFixed(0)}° は分岐器としては急すぎます。`,
      );
    }
  }

  return conns;
}
