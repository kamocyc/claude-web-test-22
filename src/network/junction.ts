import { Vector2, Vector3 } from 'three';
import { perp } from '../core/curve';
import { clamp } from '../core/units';
import { profileFor, type ProfilePoint } from '../build/surface';
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
  /** 外向き方向に見た縦断勾配 dy/ds。分岐器の縦断を枝と繋げるのに使う。 */
  outwardGrade: number;
  /** 方位角が小さい隣の枝を向く側の断面端点。 */
  edgePrev: Vector3;
  /** 方位角が大きい隣の枝を向く側の断面端点。 */
  edgeNext: Vector3;
  /** 車道部だけの断面端点 (横断歩道・停止線の幅に使う)。 */
  carriagewayPrev: Vector3;
  carriagewayNext: Vector3;
  /**
   * トリム位置の横断面をワールド座標に展開した点列 (種別の断面と同じ順序)。
   * 交差点面はこの点を繋いで作るので、セグメント側の帯とぴったり噛み合う。
   */
  section: Vector3[];
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
  /**
   * 交差点面のリング。断面の点ごとに 1 本ずつ、外側から内側の順に並ぶ。
   * 道路なら [歩道外端, 縁石上端, 車道端]、線路なら [法尻, 道床天端]。
   * 全て同じ頂点数なので、隣り合うリングの間を帯で埋められる。
   */
  rings: Vector3[][];
  /** いちばん外側のリング (`rings[0]`)。整地の footprint や当たり判定に使う。 */
  ring: Vector3[];
  /**
   * リングの辺 i (点 i → 点 i+1) が「枝の口」かどうか。
   *
   * 枝の口ではセグメントの帯がそのまま続くので、歩道・縁石の帯や垂れ壁を
   * 作ってはいけない (道路を横切る縁石ができてしまう)。
   */
  openEdge: boolean[];
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
export function solveJunctions(
  network: Network,
  /**
   * 描画高さの補正 (踏切に合わせた道路の上下・傾斜)。交差点の断面にも
   * 同じ補正を掛けないと、トリム位置が踏切の近くのとき帯と面がずれる。
   */
  heightOffset?: HeightOffset,
): JunctionSolution {
  const junctions = new Map<NodeId, Junction>();
  const trims = new Map<SegmentId, SegmentTrim>();
  for (const id of network.segments.keys()) trims.set(id, { a: 0, b: 0 });

  for (const nodeId of network.nodes.keys()) {
    const branches = network.branchesAt(nodeId);
    const junction = solveNode(network, nodeId, branches, heightOffset);
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
        updateApproachGeometry(network, ap, heightOffset);
      }
    }
    const built = buildRings(junction);
    junction.rings = built.rings;
    junction.ring = built.rings[0] ?? [];
    junction.openEdge = built.openEdge;
    // 交差角が鋭すぎると枝の断面どうしが重なり、交差点面がねじれる。
    // 形を破綻させずに解く一般的な方法がないので、警告して知らせる。
    if (selfIntersects(junction.ring)) {
      junction.warnings.push(
        '交差角が鋭すぎて交差点の形状が乱れています。角度を広げるか、少し離して繋いでください。',
      );
    }
  }

  return { junctions, trims };
}

/** セグメント上の弧長に対する、描画高さの補正 (中心線の上下と横断勾配)。 */
export type HeightOffset = (
  segment: SegmentId,
  s: number,
) => {
  dy: number;
  roll: number;
  /** 断面の段差 (縁石・歩道) に掛ける係数。踏切では 0 に近づく。 */
  heightScale: number;
};

/** リングが自分自身と交差しているか (XZ 平面で見て)。 */
export function selfIntersects(ring: Vector3[]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a0 = ring[i];
    const a1 = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      // 隣り合う辺は端点を共有するので飛ばす。
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(a0, a1, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segmentsCross(a0: Vector3, a1: Vector3, b0: Vector3, b1: Vector3): boolean {
  const d1 = side(b0, b1, a0);
  const d2 = side(b0, b1, a1);
  const d3 = side(a0, a1, b0);
  const d4 = side(a0, a1, b1);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function side(a: Vector3, b: Vector3, p: Vector3): number {
  return (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
}

function solveNode(
  network: Network,
  nodeId: NodeId,
  branches: Branch[],
  heightOffset?: HeightOffset,
): Junction {
  const warnings: string[] = [];
  const kinds = new Set<NetworkKind>(branches.map((b) => b.cls.kind));
  if (kinds.size > 1) {
    warnings.push('道路と線路が同じノードで接続されています。踏切にするには交差させてください。');
  }
  const kind = classifyNode(branches, kinds);

  const n = branches.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // ほぼ同じ向きに出ている枝どうしは重なってしまう。
      if (branches[i].dir.dot(branches[j].dir) > 0.999) {
        warnings.push('同じ向きに重なった線形があります。どちらかの向きを変えてください。');
      }
    }
  }

  const approaches: Approach[] = branches.map((branch) => ({
    branch,
    trim: 0,
    center: new Vector3(),
    dir: branch.dir.clone(),
    outwardGrade: 0,
    edgePrev: new Vector3(),
    edgeNext: new Vector3(),
    carriagewayPrev: new Vector3(),
    carriagewayNext: new Vector3(),
    section: [],
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

  const connections = kind === 'railSwitch' || kind === 'railCrossing' || kind === 'seam'
    ? solveTrackConnections(branches, warnings)
    : [];

  // 分岐器は、規格の最小半径で振り分けられるだけの長さを交差点に取り込む。
  // 短いまま繋ぐと、線路とは思えない急な折れ線になってしまう。
  // (継ぎ目は交差点面を作らないので、トリムするとそこが穴になる。)
  for (const conn of kind === 'railSwitch' || kind === 'railCrossing' ? connections : []) {
    if (conn.deflection < 1e-3) continue;
    const pair = approaches.filter(
      (ap) => ap.branch.segment === conn.from || ap.branch.segment === conn.to,
    );
    // 分岐側の規格で決める。本線の最小半径を使うと、側線が浅い角度で
    // 分かれるだけで交差点が何十 m にも膨らんでしまう。
    const radius = Math.min(...pair.map((ap) => ap.branch.cls.minRadius));
    const tangent = turnoutTangentLength(radius, conn.deflection);
    for (const ap of pair) ap.trim = Math.max(ap.trim, tangent);
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
    updateApproachGeometry(network, ap, heightOffset);
  }

  const signalized =
    kind === 'intersection' &&
    branches.length >= 3 &&
    branches.some((b) => b.cls.signalCapable);

  return {
    node: nodeId,
    kind,
    approaches,
    rings: [],
    ring: [],
    openEdge: [],
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
  // 平行な 2 枝は路端線が交わらない。一直線に繋がる場合はトリム不要、
  // 同じ向きに重なっている場合は形状を決めようがないので触らない。
  if (Math.abs(det) < 1e-6) return null;

  const ni = perp(di).multiplyScalar(bi.cls.halfWidth);
  const nj = perp(dj).multiplyScalar(-bj.cls.halfWidth);
  const rhs = new Vector2(nj.x - ni.x, nj.y - ni.y);

  const ti = (-rhs.x * dj.y + dj.x * rhs.y) / det;
  const tj = (di.x * rhs.y - di.y * rhs.x) / det;
  return { ti: Math.max(0, ti), tj: Math.max(0, tj) };
}

function updateApproachGeometry(
  network: Network,
  ap: Approach,
  heightOffset?: HeightOffset,
): void {
  const al = network.alignmentOf(ap.branch.segment);
  const L = al.length;
  const s = clamp(ap.branch.atStart ? ap.trim : L - ap.trim, 0, L);
  const raw = al.sampleAt(s);
  const cls = ap.branch.cls;
  // 描画側と同じ高さ・同じ傾きで断面を作る。
  const offset = heightOffset?.(ap.branch.segment, s) ?? ZERO_OFFSET;
  const sample =
    offset.dy === 0 && offset.roll === 0
      ? raw
      : {
          ...raw,
          pos: new Vector3(raw.pos.x, raw.pos.y + offset.dy, raw.pos.z),
          roll: (raw.roll ?? 0) + offset.roll,
        };
  const roll = sample.roll ?? 0;

  // 外向き方向はトリム位置の接線で取り直す (曲線ではノードでの接線とずれるため)。
  const outward = ap.branch.atStart ? sample.forwardXZ.clone() : sample.forwardXZ.clone().negate();
  ap.dir.copy(outward);

  const normal = perp(outward);
  ap.center.copy(sample.pos);
  ap.outwardGrade = ap.branch.atStart ? sample.grade : -sample.grade;

  // 断面をそのまま展開する。セグメント側の帯も同じ点を通るので、
  // 高低差があっても交差点面との継ぎ目が開かない。
  const profile = profileFor(cls);
  // 断面の横オフセットは「外向き方向から見た右」で測る。線形の弧長が
  // 逆向きの枝では横断勾配の符号も反転する。
  const rollOutward = ap.branch.atStart ? roll : -roll;
  ap.section = profile.map((p) =>
    sectionPoint(sample.pos, normal, p, rollOutward, offset.heightScale),
  );

  const hw = cls.halfWidth;
  ap.edgePrev.set(
    sample.pos.x - normal.x * hw,
    sample.pos.y - rollOutward * hw,
    sample.pos.z - normal.y * hw,
  );
  ap.edgeNext.set(
    sample.pos.x + normal.x * hw,
    sample.pos.y + rollOutward * hw,
    sample.pos.z + normal.y * hw,
  );
  const cw = cls.carriagewayHalfWidth;
  ap.carriagewayNext.set(
    sample.pos.x + normal.x * cw,
    sample.pos.y + rollOutward * cw,
    sample.pos.z + normal.y * cw,
  );
  ap.carriagewayPrev.set(
    sample.pos.x - normal.x * cw,
    sample.pos.y - rollOutward * cw,
    sample.pos.z - normal.y * cw,
  );
}

const ZERO_OFFSET = { dy: 0, roll: 0, heightScale: 1 };

/**
 * 分岐角 `deflection` を最小半径 `radius` の円曲線で振り分けるのに必要な
 * 接線長。ノードから左右にこれだけ取れば、交差点の中の曲線がその半径に収まる。
 */
export function turnoutTangentLength(radius: number, deflection: number): number {
  return Math.min(40, radius * Math.tan(Math.min(deflection, Math.PI / 3) / 2));
}

function sectionPoint(
  pos: Vector3,
  normal: Vector2,
  p: ProfilePoint,
  roll = 0,
  heightScale = 1,
): Vector3 {
  return new Vector3(
    pos.x + normal.x * p.offset,
    pos.y + p.height * heightScale + p.offset * roll,
    pos.z + normal.y * p.offset,
  );
}

/**
 * 交差点面のリングを断面の点ごとに 1 本ずつ作る。
 *
 * 各枝の断面点を方位角順に並べ、隣り合う枝の間には路端線の交点を制御点と
 * する 2 次ベジエで隅丸めを入れる。全てのリングは同じ手順・同じ点数で作る
 * ので、隣り合うリングの間を帯で埋めれば交差点の歩道・縁石まで表現できる。
 */
function buildRings(junction: Junction): { rings: Vector3[][]; openEdge: boolean[] } {
  const aps = junction.approaches;
  const n = aps.length;
  const empty = { rings: [], openEdge: [] };
  if (n < 2 || junction.kind === 'seam' || junction.kind === 'end') return empty;
  if (aps.every((a) => a.trim < 1e-3)) return empty;

  // 断面の点数は種別によって違う。いちばん多い枝に合わせ、足りない枝は
  // 内側の点を繰り返して幅 0 の帯にする。
  const levels = Math.max(...aps.map((a) => Math.max(1, a.section.length >> 1)));
  const rings: Vector3[][] = Array.from({ length: levels }, () => []);
  const openEdge: boolean[] = [];
  /**
   * 折れ点 (同じ道が曲がっているだけの 2 枝) では隅を丸めない。
   *
   * 交差点の隅は道路と道路の間の余地なので丸めてよいが、折れ点の外側は
   * 道路自身の路端がそのまま続く所で、丸めるとその分だけ舗装が欠ける。
   * 路端線の交点をそのまま角に使えば、両側の帯と隙間なく繋がる。
   */
  const sharpCorner = junction.kind === 'joint' || junction.kind === 'railSwitch';

  for (let i = 0; i < n; i++) {
    const cur = aps[i];
    const next = aps[(i + 1) % n];
    for (let k = 0; k < levels; k++) {
      rings[k].push(sideOf(cur, k, 'prev'), sideOf(cur, k, 'next'));
    }
    // 断面の 2 点を結ぶ辺は枝の口。その先 (隅丸め) は交差点の外周。
    openEdge.push(true, false);

    // 隅丸めを入れるかどうかは、外側のリングで一度だけ決める。
    // レベルごとに判定すると点数が揃わず、帯が組めなくなる。
    const outerA = sideOf(cur, 0, 'next');
    const outerB = sideOf(next, 0, 'prev');
    if (outerA.distanceTo(outerB) > 0.05) {
      for (let k = 0; k < levels; k++) {
        const a = sideOf(cur, k, 'next');
        const b = sideOf(next, k, 'prev');
        // 内側のリードでは路端線が交わらないことがある。その場合は
        // 中点を制御点にして、点数だけ揃える。
        const corner =
          cornerControl(a, cur.dir, b, next.dir, sharpCorner) ?? a.clone().lerp(b, 0.5);
        if (sharpCorner) {
          rings[k].push(corner);
        } else {
          for (let t = 1; t <= 3; t++) {
            rings[k].push(quadratic(a, corner, b, t / 4));
          }
        }
      }
      openEdge.push(...(sharpCorner ? [false] : [false, false, false]));
    }
  }

  return dedupeRings(rings, openEdge);
}

/** 断面の外側から `k` 番目の点を、指定した側で取り出す。 */
function sideOf(ap: Approach, k: number, side: 'prev' | 'next'): Vector3 {
  const P = ap.section.length;
  if (P === 0) return (side === 'prev' ? ap.edgePrev : ap.edgeNext).clone();
  const last = Math.max(0, (P >> 1) - 1);
  const index = Math.min(k, last);
  return (side === 'prev' ? ap.section[index] : ap.section[P - 1 - index]).clone();
}

/**
 * 2 枝の路端線 (同じ断面高さ) の交点。隅丸めの制御点になる。
 *
 * 交差角が浅いと路端線の交点は遥か彼方になる。そのまま制御点にすると
 * 隅丸めが交差点の外へ大きく膨らみ、リングがねじれたり、面の下に地形の
 * ない所ができたりする。2 点の間隔を目安に打ち切る。
 */
function cornerControl(
  p: Vector3,
  dp: Vector2,
  q: Vector3,
  dq: Vector2,
  /**
   * 交点が断面より手前 (ノード側) にあっても使うか。
   *
   * 折れ点の外側では、路端線どうしの交点は断面とノードの間に来る。
   * 交差点では手前の交点は隅の形として意味を持たないので使わないが、
   * 折れ点では**そこが路端そのもの**なので、使わないと舗装が欠ける。
   */
  allowBehind = false,
): Vector3 | null {
  const det = dp.x * dq.y - dp.y * dq.x;
  if (Math.abs(det) < 1e-6) return null;
  const rx = q.x - p.x;
  const rz = q.z - p.z;
  const t = (rx * dq.y - rz * dq.x) / det;
  if (t < 0 && !allowBehind) return null;
  const limit = Math.max(2, p.distanceTo(q) * 1.2);
  if (Math.abs(t) > limit) return null;
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

/**
 * 重なった点を落とす。どのリングも同じ頂点数でなければ帯が作れないので、
 * 全リングに同じ取捨を適用する。
 *
 * 判定は**全てのリング**で見る。外側のリングだけで決めると、路端では
 * 重なっているのに車道の縁ではずれている点 (浅い折れ点の内側の隅) を
 * 落としてしまい、車道のリングが隅を切って舗装に穴が開く。
 */
function dedupeRings(
  rings: Vector3[][],
  openEdge: boolean[],
): { rings: Vector3[][]; openEdge: boolean[] } {
  const outer = rings[0];
  if (!outer) return { rings: [], openEdge: [] };
  const full = rings.filter((ring) => ring.length === outer.length);
  const same = (a: number, b: number): boolean =>
    full.every((ring) => ring[a].distanceToSquared(ring[b]) <= 1e-4);

  const keep: number[] = [];
  for (let i = 0; i < outer.length; i++) {
    const last = keep.length > 0 ? keep[keep.length - 1] : -1;
    if (last < 0 || !same(last, i)) keep.push(i);
  }
  while (keep.length > 1 && same(keep[0], keep[keep.length - 1])) {
    keep.pop();
  }
  return {
    // 念のため、点数の揃わないリングは落とす (帯が組めないため)。
    rings: rings
      .filter((ring) => ring.length === outer.length)
      .map((ring) => keep.map((i) => ring[i])),
    // 点を落とすと辺が繋ぎ変わる。落とした点の辺の性質を引き継ぐ。
    openEdge: keep.map((index, k) => {
      const next = keep[(k + 1) % keep.length];
      let open = false;
      for (let i = index; i !== next; i = (i + 1) % openEdge.length) {
        if (openEdge[i]) open = true;
      }
      return open;
    }),
  };
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
