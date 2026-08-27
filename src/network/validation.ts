import type { Vector3 } from 'three';
import type { Alignment } from '../core/alignment';
import { DEG, clamp } from '../core/units';
import { SPEED_FACTOR, type NetworkClass } from './classes';
import { MIN_SMOOTHED_DEFLECTION } from './editing';
import type { Network, NodeId } from './network';

/** 縦曲線を見はじめる区間長 [m]。 */
const MIN_VERTICAL_SPAN = 5;

/**
 * 継ぎ目の勾配の折れを報せる閾値。
 *
 * 敷設時の均し (`smoothGradeJoint`) は、規格が許すかぎり折れを 0.05% 未満まで
 * 詰めます。ここまで残るのは「両側とも規格いっぱいで、これ以上動かせない」
 * ときだけなので、それは黙って作らずに報せます。
 */
const GRADE_BREAK_WARNING = 0.01;

/**
 * 継ぎ目で接線が折れているとみなす角 [rad]。
 *
 * 敷設時の均し (`smoothJoint`) が「折れている」とみなす角と同じにします。
 * これより浅い折れはツールも触らない — そこまで報せると、交点で区切って
 * 引いた線路のような、見た目には真っ直ぐな継ぎ目まで鳴ってしまいます。
 *
 * ここまで残るのは、均しても詰めきれなかった折れ (両側とも規格いっぱい)、
 * 角にしたいとみなされるほど深い折れ、そして接線を引き継がずに座標だけで
 * 置いた線形です。
 */
const TANGENT_BREAK_WARNING = MIN_SMOOTHED_DEFLECTION;

/**
 * 継ぎ目で曲率が飛んだときに許す、横加速度の段差 [m/s²]。
 *
 * 曲率が Δk 飛ぶと、速度 V で通る車内には `V²·Δk` の横加速度が**その場で**
 * かかります。緩和曲線はこれを避けるために入れるものなので、継ぎ目で同じ
 * ことが起きていたら報せます。実物の設計で許す急変を目安にした値です。
 * 速度から決めるので、遅い側線では大きな曲率差まで許されます。
 */
const CURVE_BREAK_ACCEL = 0.3;



export interface SegmentDiagnostics {
  length: number;
  /** 区間内の最小曲線半径 [m]。 */
  minRadius: number;
  /** 区間内の最大縦断勾配 (絶対値)。 */
  maxGrade: number;
  /** 区間内の最小縦曲線半径 [m] (勾配の変わり方の急さ)。 */
  minVerticalRadius: number;
  radiusOk: boolean;
  gradeOk: boolean;
  verticalOk: boolean;
  /** 0 = 余裕あり, 1 = 規格ちょうど, >1 = 規格超過。 */
  radiusRisk: number;
  gradeRisk: number;
  verticalRisk: number;
  messages: string[];
}

export function evaluateAlignment(alignment: Alignment, cls: NetworkClass): SegmentDiagnostics {
  const { minRadius } = alignment.horizontal.extremeCurvature(48);
  const maxGrade = alignment.vertical.maxGrade(32);
  // 極端に短い区間で縦曲線を論じても意味がない (1 クリックした直後の
  // プレビューは長さ 0 で、端点勾配だけが残るため半径が 0 と出てしまう)。
  const minVerticalRadius =
    alignment.length < MIN_VERTICAL_SPAN ? Infinity : alignment.vertical.minVerticalRadius();
  const radiusRisk = minRadius > 1e6 ? 0 : cls.minRadius / Math.max(minRadius, 1e-3);
  const gradeRisk = maxGrade / cls.maxGrade;
  const verticalRisk =
    !Number.isFinite(cls.minVerticalRadius) || minVerticalRadius > 1e6
      ? 0
      : cls.minVerticalRadius / Math.max(minVerticalRadius, 1e-3);
  const messages: string[] = [];
  if (radiusRisk > 1) {
    messages.push(
      `曲線半径 ${minRadius.toFixed(0)} m は ${cls.label} の最小半径 ${cls.minRadius} m を下回ります。`,
    );
  }
  if (gradeRisk > 1) {
    messages.push(
      `勾配 ${(maxGrade * 100).toFixed(1)}% は ${cls.label} の最大勾配 ${(cls.maxGrade * 100).toFixed(1)}% を超えています。`,
    );
  }
  if (verticalRisk > 1) {
    messages.push(
      `縦曲線半径 ${minVerticalRadius.toFixed(0)} m は ${cls.label} の規格 ${cls.minVerticalRadius} m を下回ります (勾配の変わり方が急すぎます)。`,
    );
  }
  return {
    length: alignment.length,
    minRadius,
    maxGrade,
    minVerticalRadius,
    radiusOk: radiusRisk <= 1,
    gradeOk: gradeRisk <= 1,
    verticalOk: verticalRisk <= 1,
    radiusRisk,
    gradeRisk,
    verticalRisk,
    messages,
  };
}

/**
 * 続けて敷く区間の診断をまとめる。
 *
 * 長さは合計、それ以外は**いちばん悪い所**を採る。1 回の操作で何本か
 * まとめて敷くとき (ルートに沿った平行敷設)、パネルに出るのは「その操作
 * ぜんぶ」の値であってほしいため。
 */
export function worstDiagnostics(parts: readonly SegmentDiagnostics[]): SegmentDiagnostics | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const messages: string[] = [];
  for (const part of parts) {
    for (const message of part.messages) if (!messages.includes(message)) messages.push(message);
  }
  return {
    length: parts.reduce((sum, part) => sum + part.length, 0),
    minRadius: Math.min(...parts.map((p) => p.minRadius)),
    maxGrade: Math.max(...parts.map((p) => p.maxGrade)),
    minVerticalRadius: Math.min(...parts.map((p) => p.minVerticalRadius)),
    radiusOk: parts.every((p) => p.radiusOk),
    gradeOk: parts.every((p) => p.gradeOk),
    verticalOk: parts.every((p) => p.verticalOk),
    radiusRisk: Math.max(...parts.map((p) => p.radiusRisk)),
    gradeRisk: Math.max(...parts.map((p) => p.gradeRisk)),
    verticalRisk: Math.max(...parts.map((p) => p.verticalRisk)),
    messages,
  };
}

/** 表示用に 0..1 に丸めた危険度。1 に近いほど規格ぎりぎり。 */
export function riskLevel(diag: SegmentDiagnostics): number {
  return clamp(Math.max(diag.radiusRisk, diag.gradeRisk, diag.verticalRisk), 0, 2) / 2;
}

/** 点ごとの危険度。診断表示の色分けに使う。 */
export function pointRisk(curvature: number, grade: number, cls: NetworkClass): {
  gradeRisk: number;
  curveRisk: number;
} {
  const radius = Math.abs(curvature) > 1e-6 ? 1 / Math.abs(curvature) : Infinity;
  return {
    gradeRisk: Math.abs(grade) / cls.maxGrade,
    curveRisk: radius > 1e6 ? 0 : cls.minRadius / radius,
  };
}


/** 継ぎ目で勾配が折れている所。 */
export interface GradeBreak {
  node: NodeId;
  pos: Vector3;
  /** 折れの大きさ (勾配の差)。 */
  gap: number;
  cls: NetworkClass;
}

/**
 * 縦断が折れている継ぎ目を探す。
 *
 * ノードの枝は**外向き**の勾配を持つので、同じ道が真っ直ぐ続いていれば
 * 2 本の外向き勾配は符号違いで揃います (`g0 + g1 = 0`)。揃っていない分が
 * そのまま折れの大きさです。
 *
 * 見るのは**枝が 2 本のノード** — 1 本の道がそのまま続いている所だけです。
 * 3 本以上のノードでは枝ごとに勾配が違うのがふつうで (坂の途中の丁字路、
 * 分かれ方の違う分岐器)、その差は交差点の面が繋ぎます。どの 2 本を「同じ道
 * の続き」とみなすかは枝の並び方に依るので、機械的に組にすると丁字路の枝道
 * まで折れとして数えてしまいます。
 */
export function findGradeBreaks(
  network: Network,
  threshold = GRADE_BREAK_WARNING,
): GradeBreak[] {
  const out: GradeBreak[] = [];
  for (const node of network.nodes.values()) {
    const branches = network.branchesAt(node.id);
    if (branches.length !== 2) continue;
    const [a, b] = branches;
    if (a.cls.kind !== b.cls.kind) continue;
    const gap = Math.abs(a.grade + b.grade);
    if (gap < threshold) continue;
    out.push({ node: node.id, pos: node.pos.clone(), gap, cls: a.cls });
  }
  return out;
}

/** 継ぎ目で平面線形が不連続な所。 */
export interface CurveBreak {
  node: NodeId;
  pos: Vector3;
  cls: NetworkClass;
  /** 接線の折れ角 [rad]。 */
  deflection: number;
  /** 曲率の差 [1/m]。 */
  curvature: number;
  /** 継ぎ目の両側のうち、急なほうの曲線半径 [m] (どちらも直線なら `Infinity`)。 */
  radius: number;
  /** 接線が折れている (線形が曲がり角になっている)。 */
  tangentBreak: boolean;
  /** 曲率が飛んでいる (曲がり方が継ぎ目で急に変わる)。 */
  curvatureBreak: boolean;
}

/**
 * 平面線形が継ぎ目で不連続な所を探す。
 *
 * ノードの枝は**外向き**の接線と曲率を持つので、同じ線形がそのまま続いて
 * いれば、2 本の外向き接線は逆向きに揃い (折れ角 0)、外向きの曲率は符号違いで
 * 一致します (`k0 + k1 = 0`)。揃っていない分がそのまま不連続の大きさです。
 *
 * 見るのは**枝が 2 本のノード**の**線路**だけです。枝が 3 本以上のノードでは
 * 枝ごとに向きが違うのがふつうで、その差は交差点の面や分岐器が繋ぎます。
 * 道路の 2 枝ノードは曲がり角で、そこは交差点の面が隅を丸めて繋ぎます
 * (道路は曲がり角を作れるので、折れていること自体は問題になりません)。
 * 線路にはそれが無く、レールは曲がり角にも曲率の飛びにも折り合えません。
 */
export function findCurveBreaks(
  network: Network,
  options: { tangent?: number; accel?: number } = {},
): CurveBreak[] {
  const tangentLimit = options.tangent ?? TANGENT_BREAK_WARNING;
  const accel = options.accel ?? CURVE_BREAK_ACCEL;
  const out: CurveBreak[] = [];
  for (const node of network.nodes.values()) {
    const branches = network.branchesAt(node.id);
    if (branches.length !== 2) continue;
    const [a, b] = branches;
    if (a.cls.kind !== 'rail' || b.cls.kind !== 'rail') continue;
    // 外向きの接線どうしの角。まっすぐ続いていれば 180°。
    const deflection = Math.PI - Math.acos(clamp(a.dir.dot(b.dir), -1, 1));
    const curvature = Math.abs(a.curvature + b.curvature);
    // 曲率の飛びは、遅い線ほど大きくても差し支えない。
    const speed = (Math.min(a.cls.designSpeed, b.cls.designSpeed) / 3.6) * SPEED_FACTOR;
    const curvatureLimit = accel / Math.max(speed * speed, 1e-3);
    const tangentBreak = deflection > tangentLimit;
    const curvatureBreak = curvature > curvatureLimit;
    if (!tangentBreak && !curvatureBreak) continue;
    const sharpest = Math.max(Math.abs(a.curvature), Math.abs(b.curvature));
    out.push({
      node: node.id,
      pos: node.pos.clone(),
      cls: a.cls,
      deflection,
      curvature,
      radius: sharpest > 1e-9 ? 1 / sharpest : Infinity,
      tangentBreak,
      curvatureBreak,
    });
  }
  return out;
}

/** 不連続な継ぎ目の説明文。 */
export function curveBreakMessage(brk: CurveBreak): string {
  const parts: string[] = [];
  if (brk.tangentBreak) {
    parts.push(
      `継ぎ目で線路が ${(brk.deflection / DEG).toFixed(1)}° 折れています。` +
        '線路は曲がり角を作れません。既存の端点に繋いで引く (接線を引き継ぐ) か、' +
        '前後の区間を長く取り直してください。',
    );
  }
  if (brk.curvatureBreak) {
    // 標準半径より急な曲線には、そもそも緩和曲線を入れていない (徐行区間
    // として素の円曲線で敷く)。理由が違うので、直し方も分けて出す。
    const tail =
      brk.radius < brk.cls.smoothRadius
        ? `半径 ${brk.radius.toFixed(0)} m は ${brk.cls.label} の標準半径 ` +
          `${brk.cls.smoothRadius} m より急なので、緩和曲線が入りません。` +
          '徐行して通る所ならこのままで、なめらかに繋ぎたければ半径を大きく取り直してください。'
        : '両端の向きが決まっている繋ぎ方 (端点どうしを結ぶ) には緩和曲線が入らないので、' +
          '横へ振る区間は長めに取ってください。';
    parts.push(
      `継ぎ目で曲率が半径 ${(1 / brk.curvature).toFixed(0)} m 相当だけ飛んでいます。` + tail,
    );
  }
  return parts.join(' ');
}

/** 折れた継ぎ目の説明文。 */
export function gradeBreakMessage(brk: GradeBreak): string {
  return (
    `継ぎ目で勾配が ${(brk.gap * 100).toFixed(1)}% 折れています ` +
    `(両側とも ${brk.cls.label} の規格いっぱいで、均しきれません)。` +
    '前後の勾配を緩めるか、区間を長く取り直してください。'
  );
}
