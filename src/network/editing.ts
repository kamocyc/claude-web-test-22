import { Vector2, Vector3 } from 'three';
import {
  HorizontalCurve,
  arcFromTangent,
  curveFromTangents,
  reversedCurve,
  type XZ,
} from '../core/curve';
import { easementFromTangent } from '../core/easement';
import { VerticalProfile } from '../core/profile';
import { DEG, clamp } from '../core/units';
import type { NetworkClass } from './classes';
import type { Branch, Network, NetNode, NodeId, SegmentId } from './network';

/** 自動的に交差点にまとめる高低差の上限 [m]。 */
export const AUTO_JUNCTION_TOLERANCE = 0.4;

/**
 * 交点でセグメントを分割してよい、端からの最小距離 [m]。
 *
 * これより端に寄った所で分けると、極端に短いセグメントが残って交差点の形が
 * 保てない。自動交差点も、交点の高さ合わせも、同じ足切りを使う。
 */
export const CROSSING_END_MARGIN = 2;

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
  /** セグメント途中のように、接線の正逆どちらへも出入りできる。 */
  bidirectional?: boolean;
  /** 接続先から引き継ぐ縦断勾配。 */
  grade?: number;
  /**
   * 接続先ノードに集まっている枝 (外向きの方位と外向き勾配)。
   *
   * 3 叉以上のノードでは「どの枝の続きか」が、出入りする向きが決まるまで
   * 決まらない。方位を添えて全部渡しておき、`computePlacement` が向きから
   * 選ぶ。分岐器で本線の反対側の勾配や曲率を拾って繋ぎ目が折れるのを防ぐ。
   */
  branches?: { dir: Vector2; grade: number; curvature: number }[];
  /**
   * 接続先から引き継ぐ曲率 [1/m] (`tangent` の向きに進んだときの値)。
   * これを繋いでいくと、緩和曲線で曲率が連続する線形になる。
   */
  curvature?: number;
}

/** 建設プレビューの計算結果。 */
export interface PlacementPreview {
  horizontal: HorizontalCurve;
  /** 実際の始点 (円弧の掃引角制限で、指定点と異なることがある)。 */
  start: Vector3;
  /** 実際の終点 (円弧の掃引角制限で、指定点と異なることがある)。 */
  end: Vector3;
  startGrade: number;
  endGrade: number;
  radius: number;
  grade: number;
  endTangent: Vector2;
  /** 終端の曲率 [1/m] (`endTangent` の向き)。次の区間へ引き継ぐ。 */
  endCurvature: number;
}

/**
 * 解いた線形が、指した点に「届いた」とみなす距離 [m]。
 *
 * 始点も終点もクリックした点そのもの (そこにノードを作る) なので、実質 0。
 */
const REACH = 0.05;

/**
 * 線形の端が、指した点から離れていても**そこへ繋ぐ**距離 [m]。
 *
 * 円弧は掃引角で頭打ちになるので、真後ろに近い所を指すと線形は指した所まで
 * 届かない。以前はそれを「指した所まで届きません」として置かせなかったが、
 * 届く所までは敷けた方が素直なので、離れていたら**届いた所で切る**。
 * これを超えて離れた端は接続 (ノード・取り付き・接線) を諦め、届いた所に
 * 自由な端点を作る。平行スナップは既存ノードに 2 m まで寄せて繋ぐので、
 * そこは離れていても繋いだままにする。
 */
export const REACH_GAP = 5;

/**
 * 線形が実際に届いた点を端にしたアンカー。
 *
 * ノードの位置と制御点から線形を組み直すので (`Network.alignmentOf`)、
 * ノードは必ず線形の端に置く。届かなかった端は接続を諦めるので、
 * 敷いた線形はプレビューと同じ形になる。
 */
export function reachedAnchor(anchor: Anchor, at: Vector3): Anchor {
  const gap = Math.hypot(at.x - anchor.pos.x, at.z - anchor.pos.z);
  return gap <= REACH_GAP ? { ...anchor, pos: at.clone() } : { pos: at.clone() };
}

/**
 * 始点の接線を保ったまま、カーソル位置まで伸びる線形を求める。
 *
 * 既存の線形に接続しているときは接線と勾配を引き継ぐので、繋いだ所で
 * 折れ曲がったり勾配が急変したりしない。
 */
export function computePlacement(
  anchor: Anchor,
  target: Vector3 | Anchor,
  options: { straight: boolean; cls?: NetworkClass },
): PlacementPreview {
  const destination: Anchor = target instanceof Vector3 ? { pos: target } : target;
  const a: XZ = new Vector2(anchor.pos.x, anchor.pos.z);
  const b: XZ = new Vector2(destination.pos.x, destination.pos.z);
  const chord = b.clone().sub(a);

  // セグメント途中はどちら向きにも分岐できる。カーソル側を向く接線を選ぶ
  // ことで、クリック位置そのものを接点にした分岐を最初のプレビューから出す。
  let startDirection = anchor.tangent?.clone();
  let startSign = 1;
  if (startDirection && anchor.bidirectional && startDirection.dot(chord) < 0) {
    startDirection.negate();
    startSign = -1;
  }

  // 出ていく向きの真逆を向いている枝が「この線形の続き元」。継ぎ目でも
  // 分岐器でも、同じ規則で正しい枝を選べる。勾配と曲率はそこから引き継ぐ。
  const away = startDirection ?? (chord.lengthSq() > 1e-9 ? chord.clone().normalize() : null);
  const from = away ? pickBranch(anchor.branches, away.clone().negate()) : undefined;
  // 継ぎ目のように枝が 2 本ある所では、続き元が決まってはじめて接線も
  // 決まる。折れた継ぎ目でも、入ってきた枝の延長として出ていく。
  if (startDirection && from && anchor.bidirectional) {
    startDirection = from.dir.clone().negate();
  }
  const startCurvature = from ? -from.curvature : (anchor.curvature ?? 0) * startSign;

  // 終点アンカーの tangent は「そこから先へ延長するときの向き」。到着側では
  // 逆向きが線形の終端接線になる。途中接続なら、弦から遠ざかる向きを選べる。
  let endOutward = destination.tangent?.clone();
  let endSign = 1;
  if (endOutward && destination.bidirectional && endOutward.dot(chord) > 0) {
    endOutward.negate();
    endSign = -1;
  }
  const endDirection = endOutward?.clone().negate();

  let horizontal: HorizontalCurve;
  let endTangent: Vector2;
  let radius = Infinity;

  // 緩和曲線を使う種別 (線路) では、曲率が跳ばないよう接続元の曲率も
  // 引き継ぐ。`straight` は接線も曲率も無視して素直に直線を引く。
  const cls = options.cls;
  const easing = !options.straight && (cls?.easement ?? false);
  // 緩和曲線は**標準半径**まで。それより急な繋ぎ方は徐行区間として、
  // 緩和曲線を挟まない素の円弧で解く (`smoothRadius` を参照)。
  const easementOptions = {
    minRadius: cls?.smoothRadius ?? cls?.minRadius ?? 1,
    designSpeed: cls?.designSpeed ?? 60,
  };

  if (options.straight || (!startDirection && !endDirection)) {
    horizontal = HorizontalCurve.straight(a, b);
    endTangent = b.clone().sub(a);
    if (endTangent.lengthSq() < 1e-9) endTangent = startDirection ?? new Vector2(1, 0);
    endTangent.normalize();
  } else if (startDirection && endDirection) {
    horizontal = curveFromTangents(a, startDirection, b, endDirection);
    endTangent = horizontal.tangentAt(horizontal.length);
    radius = horizontal.extremeCurvature(48).minRadius;
  } else if (startDirection) {
    const eased = easing
      ? easementFromTangent(a, startDirection, b, {
          ...easementOptions,
          startCurvature,
        })
      : null;
    if (eased && eased.gap <= REACH) {
      horizontal = eased.curve;
      endTangent = eased.endTangent as Vector2;
      radius = horizontal.extremeCurvature(48).minRadius;
    } else {
      const arc = arcFromTangent(a, startDirection, b);
      horizontal = arc.curve;
      endTangent = arc.endTangent;
      radius = arc.radius;
    }
  } else {
    // 終点から逆向きに解いて反転すれば、始点が自由でも終点では既存線形へ
    // 接する。端点へ繋ぐ場合も確定後に形が変わらない。
    //
    // ただし「自由」なのは始点の**向き**だけで、位置は動かせない (クリック
    // した点に置く)。緩和曲線は標準半径で頭打ちになるので、短い渡り線では
    // 始点まで届かないことがある。そのときは緩和曲線を諦めて円弧で解く。
    // 円弧は必ず始点を通るので、置いた線形がクリックした点からずれない
    // (規格を割るほど短ければ、最小半径の判定がそれを止める)。
    const eased = easing
      ? easementFromTangent(b, endOutward!, a, {
          // 終点から外向きに辿るので、引き継ぐ曲率も外向きの符号にする。
          ...easementOptions,
          startCurvature: (destination.curvature ?? 0) * endSign,
        })
      : null;
    if (eased && eased.gap <= REACH) {
      horizontal = reversedCurve(eased.curve);
      radius = horizontal.extremeCurvature(48).minRadius;
    } else {
      const arc = arcFromTangent(b, endOutward!, a);
      horizontal = reversedCurve(arc.curve);
      radius = arc.radius;
    }
    endTangent = horizontal.tangentAt(horizontal.length);
  }

  const length = Math.max(horizontal.length, 1e-3);
  const startXZ = horizontal.p0;
  const start = new Vector3(startXZ.x, anchor.pos.y, startXZ.y);
  const endXZ = horizontal.p1;
  const end = new Vector3(endXZ.x, destination.pos.y, endXZ.y);

  const average = (end.y - anchor.pos.y) / length;
  const maximum = options.cls?.maxGrade ?? 0.35;

  const inherited =
    from !== undefined
      ? -from.grade
      : anchor.grade !== undefined
        ? anchor.grade * startSign
        : average;

  const solved = solveVerticalTangents(
    inherited,
    average,
    maximum,
    length,
    options.cls?.minVerticalRadius ?? Infinity,
  );
  const startGrade = solved.startGrade;
  // 到着側は、終端接線の向きに続く枝の外向き勾配に合わせる。
  const into = pickBranch(destination.branches, endTangent);
  const endGrade =
    into !== undefined
      ? clamp(into.grade, -maximum, maximum)
      : destination.grade === undefined
        ? solved.endGrade
        : clamp(-destination.grade * endSign, -maximum, maximum);

  return {
    horizontal,
    start,
    end,
    startGrade,
    endGrade,
    radius,
    grade: profileMaxGrade(startGrade, endGrade, average, length),
    endTangent,
    endCurvature: horizontal.curvatureAt(horizontal.length),
  };
}

/** `dir` の向きにいちばん近い枝を返す。枝が無ければ `undefined`。 */
function pickBranch<T extends { dir: Vector2 }>(
  branches: T[] | undefined,
  dir: Vector2,
): T | undefined {
  if (!branches || branches.length === 0) return undefined;
  let best = branches[0];
  for (const b of branches) {
    if (b.dir.dot(dir) > best.dir.dot(dir)) best = b;
  }
  return best;
}

/**
 * 縦断の端点勾配を決める。
 *
 * 終点勾配は区間の平均勾配に合わせる。`2*avg - m0` にすると勾配変化が
 * 線形の素直な縦断になるが、起伏を追って区間をつなぐと勾配が区間ごとに
 * 増幅し、平均の 3 倍まで育ってしまうため採用しない。
 *
 * 始点勾配は接続元からそのまま引き継ぐ。ここを削ると繋ぎ目で勾配が跳ぶ
 * ので、削るのは規格を守れなくなるときだけにする。
 *
 * どこまで引き継げるかは、縦断の勾配の値域そのものから出る。3 次エルミートの
 * 勾配は
 *   q(t) = avg + d * (3t - 1)(t - 1),  d = m0 - avg
 * で、値域はちょうど `avg + d` (= 始点) と `avg - d/3` (= t が 2/3 の所) の
 * 間。つまり
 *   |avg + d| <= maxGrade  かつ  |avg - d/3| <= maxGrade
 * を満たす `d` なら、区間のどこも規格を割らない。
 *
 * 以前はここを `|d| <= maxGrade - |avg|` にしていたが、これは上の条件より
 * ずっと厳しい。平均勾配が規格の半分を超えたあたりから、繋げるはずの勾配まで
 * 削ってしまい、継ぎ目で勾配が不連続になっていた。
 *
 * 同じ `d` に、規格最小縦曲線半径からの上限もかける。短い区間で勾配を
 * 大きく変えると縦断が折れる (勾配は連続でも、変わり方が急すぎる) ため。
 */
export function solveVerticalTangents(
  inheritedGrade: number,
  average: number,
  maxGrade: number,
  length = 0,
  minVerticalRadius = Infinity,
): { startGrade: number; endGrade: number } {
  // 始点勾配が規格に収まる範囲。
  let lo = -maxGrade - average;
  let hi = maxGrade - average;
  // 途中の折り返し (avg - d/3) も規格に収まる範囲。
  const bendLo = 3 * (average - maxGrade);
  const bendHi = 3 * (average + maxGrade);
  // 平均勾配が既に規格外だと両立しない。その場合は始点勾配だけを守る。
  if (bendLo <= hi && bendHi >= lo) {
    lo = Math.max(lo, bendLo);
    hi = Math.min(hi, bendHi);
  }
  // 縦曲線の半径。この形 (m1 = 平均勾配) では最大の 2 階微分が 4|d|/L に
  // なるので、半径の下限はそのまま d の上限になる。サンプリングは要らない。
  const byCurve =
    Number.isFinite(minVerticalRadius) && minVerticalRadius > 0
      ? length / (4 * minVerticalRadius)
      : Infinity;
  lo = Math.max(lo, -byCurve);
  hi = Math.min(hi, byCurve);
  const d = lo > hi ? 0 : clamp(inheritedGrade - average, lo, hi);
  return { startGrade: average + d, endGrade: average };
}

/**
 * 縦断が規格をどれだけ割っているか。0 以下なら規格に収まっている。
 *
 * 最大勾配と縦曲線半径を、それぞれ「規格に対する超過の割合」に直して
 * 大きい方を取る。単位を揃えるので、片方だけを見て他方を壊すことがない。
 */
function standardViolation(
  profile: VerticalProfile,
  standard: { maxGrade: number; minVerticalRadius: number },
): number {
  const byGrade = profile.maxGrade(32) / standard.maxGrade - 1;
  const radius = profile.minVerticalRadius();
  const byCurve =
    !Number.isFinite(standard.minVerticalRadius) || standard.minVerticalRadius <= 0
      ? -1
      : standard.minVerticalRadius / Math.max(radius, 1e-6) - 1;
  return Math.max(byGrade, byCurve);
}

/**
 * 節点の勾配 `g` を動かしたときの、その節点に接する区間の違反量。
 *
 * `heights` は動かさないので、`g` について違反量は**凸**になる
 * (区間内の勾配も 2 階微分も `g` について 1 次で、その絶対値の最大は凸)。
 */
function knotViolation(
  g: number,
  legs: readonly { y0: number; y1: number; other: number; length: number; atStart: boolean }[],
  standard: { maxGrade: number; minVerticalRadius: number },
): number {
  let worst = -Infinity;
  for (const leg of legs) {
    const m0 = leg.atStart ? g : leg.other;
    const m1 = leg.atStart ? leg.other : g;
    const profile = new VerticalProfile(leg.y0, leg.y1, m0, m1, leg.length);
    worst = Math.max(worst, standardViolation(profile, standard));
  }
  return worst;
}

/** 凸関数の最小点を 3 分探索で求める。 */
function minimizeConvex(f: (x: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 48; i++) {
    const p = a + (b - a) / 3;
    const q = b - (b - a) / 3;
    if (f(p) <= f(q)) b = q;
    else a = p;
  }
  return (a + b) / 2;
}

/** 凸関数が 0 以下になる区間の端を、`from` (0 以下) と `to` の間で二分探索する。 */
function feasibleEdge(f: (x: number) => number, from: number, to: number): number {
  if (f(to) <= 0) return to;
  let inside = from;
  let outside = to;
  for (let i = 0; i < 40; i++) {
    const mid = (inside + outside) / 2;
    if (f(mid) <= 0) inside = mid;
    else outside = mid;
  }
  return inside;
}

/**
 * 高さの決まった節点を順に通る縦断を解く。
 *
 * 交点の高さに合わせるときは、節点の高さが**全部先に決まっている**。
 * `solveVerticalTangents` の「終点勾配 = 平均勾配」は、終点の高さが未知の
 * 区間を繋いでいくときの約束なので、ここでは使えない。あれを区間ごとに
 * 繋ぐと、クランプが効いた所で節点の勾配が食い違う。しかも高さを合わせて
 * できるノードは枝が 4 本あるため、`smoothGradeJoint` も `findGradeBreaks`
 * も 2 枝しか見ず、折れが均されも警告されもせずに残ってしまう。
 *
 * ここでは節点ごとに**勾配を 1 つだけ**持ち、両側の区間で共有する。
 * 節点で縦断が折れないことが式の形から保証される。
 *
 * 初期値は区間長で重み付けした平均勾配 (ベッセル接線)。相手の区間長で
 * 重み付けするので、短い区間の勾配が勝ち、短い区間が暴れない。そこから
 * 規格に収まる範囲へ挟み込む。規格の条件は `g` について凸なので、
 * 最小点を 3 分探索で出し、そこから両側へ二分探索すれば区間が取れる。
 *
 * @param heights 節点の高さ [m] (区間数 + 1 個)
 * @param lengths 各区間の水平長 [m]
 * @param ends    両端の勾配。`end` が null なら平均勾配に任せる
 */
export function solveChainProfile(
  heights: readonly number[],
  lengths: readonly number[],
  ends: { start: number; end: number | null },
  standard: { maxGrade: number; minVerticalRadius: number },
): { grades: number[]; feasible: boolean } {
  const n = lengths.length;
  const average = lengths.map((L, i) => (L > 1e-6 ? (heights[i + 1] - heights[i]) / L : 0));
  const grades = new Array<number>(n + 1).fill(0);
  grades[0] = ends.start;
  grades[n] = ends.end ?? average[n - 1];
  // 内側の節点は、両隣の平均勾配を**相手の区間長**で重み付けした値から始める。
  for (let k = 1; k < n; k++) {
    const w = lengths[k - 1] + lengths[k];
    grades[k] =
      w > 1e-6
        ? (average[k - 1] * lengths[k] + average[k] * lengths[k - 1]) / w
        : average[k - 1];
  }

  // 内側の節点を、両隣を固定したまま規格に収まる範囲へ挟み込む。可行域は
  // 両隣の**高さ**だけで決まり、隣の勾配には (その節点を解く間) 依らないので、
  // 左右 1 往復すれば落ち着く。
  const limit = standard.maxGrade * 3;
  for (const pass of [0, 1]) {
    const order = pass === 0 ? [...Array(n - 1).keys()].map((i) => i + 1) : [];
    if (pass === 1) for (let k = n - 1; k >= 1; k--) order.push(k);
    for (const k of order) {
      const legs = [
        {
          y0: heights[k - 1],
          y1: heights[k],
          other: grades[k - 1],
          length: lengths[k - 1],
          atStart: false,
        },
        { y0: heights[k], y1: heights[k + 1], other: grades[k + 1], length: lengths[k], atStart: true },
      ];
      const f = (g: number): number => knotViolation(g, legs, standard);
      const best = minimizeConvex(f, -limit, limit);
      if (f(best) > 0) {
        grades[k] = best;
        continue;
      }
      const lo = feasibleEdge(f, best, -limit);
      const hi = feasibleEdge(f, best, limit);
      grades[k] = clamp(grades[k], lo, hi);
    }
  }

  const feasible = lengths.every(
    (L, i) =>
      standardViolation(
        new VerticalProfile(heights[i], heights[i + 1], grades[i], grades[i + 1], L),
        standard,
      ) <= 1e-9,
  );
  return { grades, feasible };
}

/** 端点勾配と平均勾配から、区間内の最大勾配 (絶対値) を求める。 */
function profileMaxGrade(
  startGrade: number,
  endGrade: number,
  average: number,
  length: number,
): number {
  // 縦断そのものを規則と同じサンプラで測る。閉じた式 (値域 [avg-d/3, avg+d])
  // は終点勾配が平均勾配のときしか正しくないが、線路の途中に取り付いた
  // ときは終点勾配を接続先から引き継ぐので、その前提が崩れる。
  return new VerticalProfile(0, average * length, startGrade, endGrade, length).maxGrade(32);
}

/** アンカーを実際のノードに解決する (必要ならセグメントを分割する)。 */
export function resolveAnchor(network: Network, anchor: Anchor): NetNode {
  if (anchor.node !== undefined && network.nodes.has(anchor.node)) {
    return network.getNode(anchor.node);
  }
  if (anchor.split) {
    if (network.segments.has(anchor.split.segment)) {
      return network.splitSegment(anchor.split.segment, anchor.split.s);
    }
    // 相手が既に分割されている (始点と終点で同じ線形に取り付いた場合など)。
    // その点は分かれた片方の上に乗っているので、そちらを分割する。
    const half = network.findSegmentNear(anchor.pos, 3);
    if (half) return network.splitSegment(half.segment, half.s);
  }
  return network.addNode(anchor.pos);
}

export interface PlaceResult {
  segment: SegmentId;
  startNode: NodeId;
  endNode: NodeId;
  /** 自動生成された交差点のノード。 */
  autoJunctions: NodeId[];
  /** 折れをなめらかにしたノード。 */
  smoothed: NodeId[];
  /** 勾配の折れをなめらかにしたノード。 */
  gradeSmoothed: NodeId[];
}

/** 折れをなめらかにする角度の範囲。これより浅ければ元から折れていない。 */
export const MIN_SMOOTHED_DEFLECTION = 1 * DEG;
/** これより深い折れは「角にしたい」意図とみなして触らない。 */
const MAX_SMOOTHED_DEFLECTION = 60 * DEG;
/** なめらかにする度合い。1 で完全に接線を揃える。 */
const SMOOTHING_STEPS = [1, 0.7, 0.45, 0.25];

/**
 * ノードでの折れをなめらかにする。
 *
 * 引いたばかりの線形を既存の線形の端に繋ぐと、そこで折れて「角」になる。
 * 実際の道路は取り付く側だけでなく**既存側も少し振って**繋ぐので、
 * ここでも両方の端点接線を二等分線へ寄せる。端点の位置は動かさないので、
 * 繋がっている相手の線形やノードの位置には影響しない。
 *
 * 寄せる量は、両方の線形が規格 (最小半径・最大勾配) に収まる範囲まで。
 * 収まらなければ段階的に控えめにし、それでも駄目なら元のままにする。
 */
export function smoothJoint(network: Network, node: NodeId): boolean {
  const branches = network.branchesAt(node);
  if (branches.length !== 2) return false;
  const [b0, b1] = branches;
  if (b0.cls.kind !== b1.cls.kind) return false;
  // 緩和曲線を含む線形は端の制御点だけを振ると中の曲率が壊れるので触らない
  // (曲率は敷設時に接続元から引き継いでいるので、そもそも折れていない)。
  if (branches.some((b) => (network.getSegment(b.segment).via?.length ?? 0) > 0)) return false;

  const deflection = Math.PI - Math.acos(clamp(b0.dir.dot(b1.dir), -1, 1));
  if (deflection < MIN_SMOOTHED_DEFLECTION || deflection > MAX_SMOOTHED_DEFLECTION) return false;

  // 二等分線。両方の枝がこの向き (と真逆) を向けば折れが消える。
  const bisector = b0.dir.clone().sub(b1.dir);
  if (bisector.lengthSq() < 1e-9) return false;
  bisector.normalize();
  const turn = [
    signedAngle(b0.dir, bisector),
    signedAngle(b1.dir, bisector.clone().negate()),
  ];
  // 縦断も同じように、外向き勾配が符号違いで揃うところを目標にする。
  const target = (b0.grade - b1.grade) / 2;
  const gradeShift = [target - b0.grade, -target - b1.grade];

  const before = branches.map((b) => network.getSegment(b.segment));
  const original = before.map((seg) => ({
    ctrlA: seg.ctrlA.clone(),
    ctrlB: seg.ctrlB.clone(),
    gradeA: seg.gradeA,
    gradeB: seg.gradeB,
  }));
  const restore = (): void => {
    branches.forEach((b, i) => network.updateSegment(b.segment, original[i]));
  };

  for (const k of SMOOTHING_STEPS) {
    branches.forEach((b, i) => {
      const seg = network.getSegment(b.segment);
      const origin = network.getNode(node).pos;
      const pivot = new Vector2(origin.x, origin.z);
      const handle = (b.atStart ? original[i].ctrlA : original[i].ctrlB).clone().sub(pivot);
      const rotated = rotate(handle, turn[i] * k).add(pivot);
      const grade = (b.atStart ? 1 : -1) * (b.grade + gradeShift[i] * k);
      network.updateSegment(seg.id, b.atStart
        ? { ctrlA: rotated, gradeA: grade }
        : { ctrlB: rotated, gradeB: grade });
    });
    if (branches.every((b) => withinStandard(network, b.segment, b.cls))) return true;
    restore();
  }
  return false;
}

/** 折れをこれ以下にできたら十分とみなす (0.05%)。 */
const GRADE_JOINT_TOLERANCE = 5e-4;
/** 寄せ直す回数の上限。 */
const GRADE_JOINT_PASSES = 6;

/**
 * ノードでの勾配の折れをなめらかにする。
 *
 * 敷設時に勾配は接続元から引き継ぐが、平均勾配が規格ぎりぎりの区間では
 * 引き継ぎきれずに削られる (`solveVerticalTangents`)。その残りをここで
 * 両側に振り分ける。片側だけを動かさないので、既に敷いてある線形の縦断も
 * 大きくは変わらない。
 *
 * 平面の `smoothJoint` と違って端の制御点は触らないので、緩和曲線の入った
 * 線形でも安全に掛けられる。線路は原則として緩和曲線つきなので、こちらが
 * 効かないと繋ぎ目の勾配差がそのまま残ってしまう。
 */
export function smoothGradeJoint(network: Network, node: NodeId): boolean {
  const first = network.branchesAt(node);
  if (first.length !== 2) return false;
  if (first[0].cls.kind !== first[1].cls.kind) return false;

  let moved = false;
  // 片側が規格で動けないことがある。そのときは残りをもう片側に寄せるので、
  // 「中点で分ける」を 1 回だけ掛けても折れは半分しか消えない。動かなく
  // なるまで繰り返す。
  for (let pass = 0; pass < GRADE_JOINT_PASSES; pass++) {
    const [b0, b1] = network.branchesAt(node);
    // 外向き勾配が符号違いで揃っていれば、そこは折れていない。
    const gap = b0.grade + b1.grade;
    if (Math.abs(gap) < GRADE_JOINT_TOLERANCE) break;

    // 1 巡目は両側から同じだけ寄せる (既に敷いてある線形を大きく変えない)。
    // 2 巡目からは、動けなかったぶんを動ける側に全部寄せる。
    const target = pass === 0 ? (b0.grade - b1.grade) / 2 : -b1.grade;
    if (approachGrade(network, b0, target)) moved = true;
    // b0 が実際に動いた所に合わせるので、両側とも動ける場合は 1 巡で揃う。
    const [after0, after1] = network.branchesAt(node);
    if (approachGrade(network, after1, -after0.grade)) moved = true;

    const [end0, end1] = network.branchesAt(node);
    // どちらも動かなくなったら、それ以上は規格が許さない。
    if (Math.abs(end0.grade + end1.grade - gap) < 1e-9) break;
  }
  return moved;
}

/**
 * 枝の外向き勾配を `want` へ寄せる。動かせるのは、その区間の縦断が規格を
 * 割らない範囲まで。
 *
 * 最大勾配も縦曲線の 2 階微分も端点勾配について 1 次なので、「規格に収まる
 * 勾配」はひとつながりの区間になる。だから今の値 (収まっている) と目標の
 * 間を二分すれば、届く限界がそのまま出る。
 */
function approachGrade(network: Network, b: Branch, want: number): boolean {
  const seg = network.getSegment(b.segment);
  const original = { gradeA: seg.gradeA, gradeB: seg.gradeB };
  const before = gradeQuality(network, b.segment);
  const apply = (outward: number): void => {
    const grade = b.atStart ? outward : -outward;
    network.updateSegment(b.segment, b.atStart ? { gradeA: grade } : { gradeB: grade });
  };
  const accepts = (outward: number): boolean => {
    apply(outward);
    return withinVerticalStandard(gradeQuality(network, b.segment), before, b.cls);
  };

  if (accepts(want)) return true;
  let ok = b.grade;
  let bad = want;
  for (let i = 0; i < 12; i++) {
    const mid = (ok + bad) / 2;
    if (accepts(mid)) ok = mid;
    else bad = mid;
  }
  if (Math.abs(ok - b.grade) < 1e-9) {
    network.updateSegment(b.segment, original);
    return false;
  }
  apply(ok);
  return true;
}

interface GradeQuality {
  maxGrade: number;
  minVerticalRadius: number;
}

function gradeQuality(network: Network, segment: SegmentId): GradeQuality {
  const vertical = network.alignmentOf(segment).vertical;
  return { maxGrade: vertical.maxGrade(32), minVerticalRadius: vertical.minVerticalRadius() };
}

/**
 * 縦断が規格に収まっているか。元から規格を外れている線形 (地形に合わせて
 * 敷いた急勾配など) を触るときは、少なくとも悪化していなければよしとする。
 */
function withinVerticalStandard(
  after: GradeQuality,
  before: GradeQuality,
  cls: NetworkClass,
): boolean {
  return (
    after.maxGrade <= Math.max(cls.maxGrade, before.maxGrade) + 1e-9 &&
    after.minVerticalRadius >= Math.min(cls.minVerticalRadius, before.minVerticalRadius) - 1e-6
  );
}

function signedAngle(from: Vector2, to: Vector2): number {
  return Math.atan2(from.x * to.y - from.y * to.x, from.dot(to));
}

function rotate(v: Vector2, angle: number): Vector2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return new Vector2(v.x * c - v.y * s, v.x * s + v.y * c);
}

/** その線形が規格 (最小半径・最大勾配) に収まっているか。 */
function withinStandard(network: Network, segment: SegmentId, cls: NetworkClass): boolean {
  const alignment = network.alignmentOf(segment);
  return (
    alignment.horizontal.extremeCurvature(48).minRadius >= cls.minRadius - 1e-6 &&
    alignment.vertical.maxGrade(32) <= cls.maxGrade + 1e-6
  );
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
  // 線形が指した所まで届かなかった端は、届いた所を端点にする (`reachedAnchor`)。
  const startNode = resolveAnchor(network, reachedAnchor(start, preview.start));
  const endNode = resolveAnchor(network, reachedAnchor(end, preview.end));

  const segment = network.addSegment({
    classId,
    a: startNode.id,
    b: endNode.id,
    ctrlA: preview.horizontal.c0,
    ctrlB: preview.horizontal.c1,
    via: preview.horizontal.via,
    gradeA: preview.startGrade,
    gradeB: preview.endGrade,
  });

  const autoJunctions = resolveAutoJunctions(network, segment.id);
  // 既存の線形の端に繋いだ所は、両方を少し振って折れを消す。
  const smoothed = [startNode.id, endNode.id].filter((id) => smoothJoint(network, id));
  // 平面が見送られても (緩和曲線つきの線形など)、勾配の折れは別に均す。
  const gradeSmoothed = [startNode.id, endNode.id].filter((id) => smoothGradeJoint(network, id));
  return {
    segment: segment.id,
    startNode: startNode.id,
    endNode: endNode.id,
    autoJunctions,
    smoothed,
    gradeSmoothed,
  };
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
        if (hit.sb < CROSSING_END_MARGIN || hit.sb > otherLength - CROSSING_END_MARGIN) continue;
        if (hit.sa < CROSSING_END_MARGIN || hit.sa > alignment.length - CROSSING_END_MARGIN) {
          continue;
        }
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
 * 引き継ぐので、繋ぎ目が折れない。
 *
 * 線路の**継ぎ目** (同じ種別が 2 本つながっているだけの所) は、線形としては
 * 区間の途中と変わらないので、`anchorFromSegment` と同じ扱いにする。接線を
 * 渡さないと、継ぎ目に当たった所だけ分岐が線路の接線に沿わなくなる (継ぎ目を
 * 1 m 外すと接線に沿うのに、継ぎ目ちょうどでは折れる) ため。正逆どちらへ
 * 分かれるかは、カーソルの側から `computePlacement` が選ぶ。
 *
 * 3 本以上が集まっているノード (分岐器や交差) は、どの枝の続きとも言えない
 * ので向きは自由にする。勾配だけは段差ができないよう既存の枝から受け継ぐ。
 */
export function anchorFromNode(network: Network, node: NetNode, cls: NetworkClass): Anchor {
  const branches = network.branchesAt(node.id);
  const anchor: Anchor = { pos: node.pos.clone(), node: node.id };
  if (branches.length === 0) return anchor;

  const same = branches.find((b) => b.cls.kind === cls.kind) ?? branches[0];
  // 勾配は枝が何本あっても引き継ぐ (繋ぎ目に段差ができないように)。
  // どの枝の続きになるかは出入りの向き次第なので、方位を添えて全部渡す。
  anchor.grade = -same.grade;
  const kin = branches.filter((b) => b.cls.kind === same.cls.kind);
  anchor.branches = kin.map((b) => ({
    dir: b.dir.clone(),
    grade: b.grade,
    curvature: b.curvature,
  }));
  if (branches.length === 1) {
    anchor.tangent = same.dir.clone().negate();
    // 接線を引き継ぐときだけ、曲率も引き継ぐ (向きが自由な分岐では、
    // 曲率だけ引き継いでも意味が無い)。
    anchor.curvature = -same.curvature;
  } else if (same.cls.kind === 'rail' && kin.length === 2 && kin.length === branches.length) {
    // 継ぎ目。どちらの枝の続きになるかはカーソルの側で決まるので、接線は
    // 仮に片方の裏を入れておく (`computePlacement` が `branches` から
    // 選び直す)。接線・勾配・曲率のどれも、選ばれた枝から引き継がれる。
    anchor.tangent = kin[0].dir.clone().negate();
    anchor.bidirectional = true;
  }
  return anchor;
}

/**
 * セグメント途中に接続する場合のアンカー。
 * 線路上のクリック位置を接点にして分岐できるよう、接線と勾配を引き継ぐ。
 * 正逆どちらへ分かれるかは次のカーソル位置から `computePlacement` が選ぶ。
 */
export function anchorFromSegment(network: Network, segment: SegmentId, s: number): Anchor {
  const sample = network.alignmentOf(segment).sampleAt(s);
  if (network.classOf(network.getSegment(segment)).kind !== 'rail') {
    return { pos: sample.pos.clone(), split: { segment, s } };
  }
  return {
    pos: sample.pos.clone(),
    split: { segment, s },
    tangent: sample.forwardXZ.clone(),
    grade: sample.grade,
    curvature: sample.curvature,
    bidirectional: true,
  };
}
