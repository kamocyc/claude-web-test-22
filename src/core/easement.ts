import { Vector2 } from 'three';
import { HorizontalCurve, arcToBezier, perp, type XZ } from './curve';
import { clamp } from './units';

/**
 * 緩和曲線 (クロソイド) を含む平面線形。
 *
 * 実物の線路は直線からいきなり円曲線に入らない。曲率を 0 から 1/R まで
 * 弧長に比例して増やす区間 (緩和曲線) を挟む。ここでは
 *
 *   **緩和曲線 (κa → κ) + 円曲線 (κ)**
 *
 * の 2 要素で線形を作る。終端側の緩和曲線は入れない。次の区間が
 * 終端の曲率を引き継いで自分の緩和区間を作るので、線形を繋いでいけば
 * 曲率はどこでも連続になる。未知数 2 (終端曲率 κ・円曲線長 Lc) に対し
 * 「指した点を通る」で式が 2 本なので、解はちょうど決まる。
 *
 * 座標は「始点を原点・始点の接線を +x」にした正規座標で解く。曲率は
 * 右カーブが正 (`HorizontalCurve.curvatureAt` と同じ符号)。
 */

/** 緩和曲線区間で許す最大の方向変化 [rad]。級数展開の精度もこれで決まる。 */
const THETA_CAP = 0.6;

/** 緩和曲線長の下限・上限 [m]。 */
const LS_MIN = 8;
const LS_MAX = 60;

/** 移程量 (円曲線が内側へずれる量) の目安 [m]。設計速度 100 km/h のとき。 */
const SHIFT_AT_100 = 0.18;

/** ベジエ 1 片が受け持つ最大の方向変化 [rad]。 */
const PIECE_SWEEP = 6 * (Math.PI / 180);

/** 円曲線をベジエに分けるときの 1 片あたりの最大掃引角 [rad]。 */
const ARC_PIECE_SWEEP = 45 * (Math.PI / 180);

export interface EasementOptions {
  /** 規格最小曲線半径 [m]。 */
  minRadius: number;
  /** 設計速度 [km/h]。緩和曲線長の目安に使う。 */
  designSpeed: number;
  /** 始点の曲率 [1/m]。曲線の途中から分岐するときに引き継ぐ。既定 0。 */
  startCurvature?: number;
}

export interface EasementResult {
  curve: HorizontalCurve;
  /** 円曲線部の曲率半径 [m]。直線なら `Infinity`。 */
  radius: number;
  /** 終端の単位接線。 */
  endTangent: XZ;
  /** 終端の曲率 [1/m]。次の区間へ引き継ぐ。 */
  endCurvature: number;
  /** 緩和曲線長 [m]。 */
  spiralLength: number;
  /** 指した点から実際の終点までの距離 [m]。 */
  gap: number;
}

/** 8 点ガウス・ルジャンドル (区間 [0,1] に写したもの)。 */
const GL_NODES = [
  0.019855071751231856, 0.10166676129318664, 0.2372337950418355, 0.40828267875217505,
  0.591717321247825, 0.7627662049581645, 0.8983332387068134, 0.9801449282487682,
];
const GL_WEIGHTS = [
  0.05061426814518813, 0.11119051722668723, 0.15685332293894364, 0.18134189168918099,
  0.18134189168918099, 0.15685332293894364, 0.11119051722668723, 0.05061426814518813,
];

/**
 * 緩和曲線 (曲率が `k0` から `k1` へ弧長に比例して変わる区間) の、
 * 長さ `l` までの終点と方向。始点は原点、始点の方向は +x。
 */
export function spiralPoint(
  k0: number,
  k1: number,
  Ls: number,
  l: number,
): { x: number; y: number; theta: number } {
  if (l <= 1e-12) return { x: 0, y: 0, theta: 0 };
  const rate = Ls > 1e-9 ? (k1 - k0) / Ls : 0;
  const theta = (t: number): number => k0 * t + (rate * t * t) / 2;

  if (Math.abs(k0) < 1e-12) {
    // 直線から入る標準の場合は閉じた級数で出せる (τ ≤ 0.6 で機械精度)。
    const tau = theta(l);
    const t2 = tau * tau;
    const cos = 1 - t2 / 10 + (t2 * t2) / 216 - (t2 * t2 * t2) / 9360;
    const sin = tau / 3 - (tau * t2) / 42 + (tau * t2 * t2) / 1320;
    return { x: l * cos, y: l * sin, theta: tau };
  }

  // 始点の曲率が 0 でない場合は閉じた式が無いのでガウス積分する。
  let x = 0;
  let y = 0;
  for (let i = 0; i < GL_NODES.length; i++) {
    const th = theta(GL_NODES[i] * l);
    x += GL_WEIGHTS[i] * Math.cos(th);
    y += GL_WEIGHTS[i] * Math.sin(th);
  }
  return { x: x * l, y: y * l, theta: theta(l) };
}

/** 曲率 `kappa` の円弧を長さ `Lc` 進んだときの、始点から見たずれ。 */
function arcOffset(kappa: number, Lc: number): { u: number; v: number } {
  const a = kappa * Lc;
  if (Math.abs(a) < 1e-4) {
    // κ → 0 で 0/0 になるので展開する (数値微分の精度を保つため)。
    return { u: Lc * (1 - (a * a) / 6), v: ((Lc * a) / 2) * (1 - (a * a) / 12) };
  }
  return { u: Math.sin(a) / kappa, v: (1 - Math.cos(a)) / kappa };
}

/**
 * 緩和曲線長。
 *
 * 実物の式 (カント逓減から出す `Ls ≥ 5.9V²/R`) はこの縮尺では使えない
 * (100 km/h・R=120 で 492 m になり、区間長 40〜200 m に収まらない)。
 * 代わりに**移程量** `p ≈ Ls²/(24R)` から逆算する。見た目を決めているのは
 * 「円曲線がどれだけ内側へずれるか」なので、こちらの方が素直に効く。
 */
export function spiralLengthFor(
  k0: number,
  k1: number,
  designSpeed: number,
  available: number,
): number {
  const peak = Math.max(Math.abs(k0), Math.abs(k1));
  if (peak < 1e-7) return 0;
  const rRef = 1 / peak;
  const shift = SHIFT_AT_100 * (designSpeed / 100);
  const scale = Math.abs(k1 - k0) * rRef;
  const raw = Math.sqrt(24 * rRef * shift) * scale;
  // 方向変化を THETA_CAP までに抑えると、級数展開もベジエ近似も精度が出る。
  const upper = Math.max(1, Math.min(LS_MAX, 2 * rRef * THETA_CAP, 0.6 * available));
  return clamp(raw, Math.min(LS_MIN, upper), upper);
}

/** 緩和曲線を連結ベジエの制御点列にする (正規座標、原点から +x 方向へ)。 */
function spiralPieces(k0: number, k1: number, Ls: number): Vector2[] {
  if (Ls <= 1e-9) return [new Vector2(0, 0)];
  const total = ((k0 + k1) / 2) * Ls;
  const n = Math.max(2, Math.ceil(Math.abs(total) / PIECE_SWEEP));
  const points: Vector2[] = [];
  let prev = spiralPoint(k0, k1, Ls, 0);
  for (let i = 1; i <= n; i++) {
    const l0 = (Ls * (i - 1)) / n;
    const l1 = (Ls * i) / n;
    const cur = spiralPoint(k0, k1, Ls, l1);
    const d0 = new Vector2(Math.cos(prev.theta), Math.sin(prev.theta));
    const d1 = new Vector2(Math.cos(cur.theta), Math.sin(cur.theta));
    const sweep = cur.theta - prev.theta;
    // その区間の平均曲率の接触円として制御点を置く。円弧を 1 本の 3 次
    // ベジエで近似する標準の係数 (4/3)tan(Δ/4) をそのまま使うので、
    // 半径は僅かに大きい側 (= 曲率が小さい側) にしか外れない。
    const mean = k0 + ((k1 - k0) * ((l0 + l1) / 2)) / Math.max(Ls, 1e-9);
    const chord = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const handle =
      Math.abs(mean) > 1e-9 && Math.abs(sweep) > 1e-9
        ? ((4 / 3) * Math.tan(sweep / 4)) / mean
        : chord / 3;
    const p0 = new Vector2(prev.x, prev.y);
    const p1 = new Vector2(cur.x, cur.y);
    if (i === 1) points.push(p0);
    points.push(
      p0.clone().addScaledVector(d0, handle),
      p1.clone().addScaledVector(d1, -handle),
      p1,
    );
    prev = cur;
  }
  return points;
}

/** 円曲線を連結ベジエの制御点列にする (`start` から `theta` の向きへ)。 */
function arcPieces(start: Vector2, theta: number, kappa: number, Lc: number): Vector2[] {
  const sweep = kappa * Lc;
  if (Lc <= 1e-9) return [];
  const dir = new Vector2(Math.cos(theta), Math.sin(theta));
  if (Math.abs(sweep) < 1e-9) {
    const end = start.clone().addScaledVector(dir, Lc);
    const line = HorizontalCurve.straight(start, end);
    return [line.c0, line.c1, line.p1];
  }
  const center = start.clone().addScaledVector(perp(dir), 1 / kappa);
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_PIECE_SWEEP));
  const points: Vector2[] = [];
  let from = start.clone();
  for (let i = 1; i <= n; i++) {
    const piece = arcToBezier(center, from, sweep / n);
    points.push(piece.c0, piece.c1, piece.p1);
    from = piece.p1.clone();
  }
  return points;
}

/** 正規座標での終点と終端方向。 */
function endpointOf(
  k0: number,
  kappa: number,
  Ls: number,
  Lc: number,
): { x: number; y: number; theta: number } {
  const s = spiralPoint(k0, kappa, Ls, Ls);
  const { u, v } = arcOffset(kappa, Lc);
  const c = Math.cos(s.theta);
  const sn = Math.sin(s.theta);
  return { x: s.x + c * u - sn * v, y: s.y + sn * u + c * v, theta: s.theta + kappa * Lc };
}

/**
 * 始点 `a` とそこでの接線 `ta` に接し、終点 `b` を通る緩和曲線 + 円曲線。
 *
 * 規格の最小半径や到達距離の都合で `b` に届かないことがある。実際の終点は
 * `curve.p1`、届かなかった量は `gap` を見ること (`arcFromTangent` と同じ契約)。
 */
export function easementFromTangent(
  a: XZ,
  ta: XZ,
  b: XZ,
  options: EasementOptions,
): EasementResult {
  const dir = ta.clone().normalize();
  const right = perp(dir);
  const chord = new Vector2().subVectors(b, a);
  const X = chord.dot(dir);
  const Y = chord.dot(right);
  const chordLen = chord.length();
  const k0 = options.startCurvature ?? 0;

  const toWorld = (points: Vector2[]): HorizontalCurve =>
    new HorizontalCurve(
      points.map((p) =>
        new Vector2(a.x + dir.x * p.x + right.x * p.y, a.y + dir.y * p.x + right.y * p.y),
      ),
    );

  if (chordLen < 1e-4) {
    const end = a.clone().addScaledVector(dir, 1e-3);
    return {
      curve: HorizontalCurve.straight(a, end),
      radius: Infinity,
      endTangent: dir,
      endCurvature: 0,
      spiralLength: 0,
      gap: 0,
    };
  }

  // 曲率を引き継がず、指した点が接線の延長線上にあるなら、ただの直線。
  if (Math.abs(k0) < 1e-9 && Math.abs(Y) < 1e-7) {
    const endTangent = X >= 0 ? dir : chord.clone().normalize();
    return {
      curve: HorizontalCurve.straight(a, b),
      radius: Infinity,
      endTangent,
      endCurvature: 0,
      spiralLength: 0,
      gap: 0,
    };
  }

  let kMax = 1 / (options.minRadius * 1.02);
  let best: EasementResult | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const solved = solve(k0, X, Y, chordLen, kMax, options.designSpeed);
    const points = spiralPieces(k0, solved.kappa, solved.Ls);
    const tail = spiralPoint(k0, solved.kappa, solved.Ls, solved.Ls);
    points.push(...arcPieces(new Vector2(tail.x, tail.y), tail.theta, solved.kappa, solved.Lc));
    const curve = toWorld(points);
    const endTheta = tail.theta + solved.kappa * solved.Lc;
    const result: EasementResult = {
      curve,
      radius: Math.abs(solved.kappa) < 1e-9 ? Infinity : 1 / Math.abs(solved.kappa),
      endTangent: dir
        .clone()
        .multiplyScalar(Math.cos(endTheta))
        .addScaledVector(right, Math.sin(endTheta))
        .normalize(),
      endCurvature: solved.kappa,
      spiralLength: solved.Ls,
      gap: curve.p1.distanceTo(b),
    };
    best = result;

    // 実際に描かれる曲線を、規則が使うサンプラそのもので測る。ベジエ近似の
    // 誤差で規格を割っていたら、設計曲率を比のぶん縮めて引き直す。
    const measured = curve.extremeCurvature(48).minRadius;
    if (measured >= options.minRadius - 1e-6) break;
    kMax *= Math.max(0.5, measured / options.minRadius);
  }

  return best!;
}

/** ニュートン法で (終端曲率, 円曲線長) を解く。 */
function solve(
  k0: number,
  X: number,
  Y: number,
  chordLen: number,
  kMax: number,
  designSpeed: number,
): { kappa: number; Ls: number; Lc: number } {
  const lsFor = (k: number): number => spiralLengthFor(k0, k, designSpeed, chordLen);

  // 初期値は円曲線だけで解いた形から取る。緩和曲線による終点のずれは
  // cm 単位なので、ここから 2〜3 反復で収まる。
  const k1 = clamp((2 * Y) / (X * X + Y * Y), -kMax, kMax);
  const sweep = 2 * Math.atan2(Y, X);
  let kappa = Math.abs(k1) < 1e-9 ? 1e-9 * Math.sign(Y || 1) : k1;
  let Ls = lsFor(kappa);
  // 真後ろを指すと掃引角が 2π 近くになるので、円曲線の長さに頭を打たせる
  // (指した所まで届かない解になるが、敷設は届いた所で切る。
  //  `reachedAnchor` を参照)。
  const lcMax = Math.max(2 * chordLen, 50);
  let Lc = clamp((sweep - ((k0 + kappa) / 2) * Ls) / kappa, 0, lcMax);

  const residual = (kap: number, lc: number): [number, number] => {
    const e = endpointOf(k0, kap, lsFor(kap), clamp(lc, 0, lcMax));
    return [e.x - X, e.y - Y];
  };
  const norm = (r: [number, number]): number => Math.hypot(r[0], r[1]);

  let r = residual(kappa, Lc);
  for (let iter = 0; iter < 30 && norm(r) > 1e-3; iter++) {
    const h = Math.max(1e-7, 1e-4 * Math.abs(kappa));
    const rk1 = residual(kappa + h, Lc);
    const rk0 = residual(kappa - h, Lc);
    // Lc についての偏微分は終端の単位接線そのもの。
    const e = endpointOf(k0, kappa, lsFor(kappa), clamp(Lc, 0, lcMax));
    const j = [
      [(rk1[0] - rk0[0]) / (2 * h), Math.cos(e.theta)],
      [(rk1[1] - rk0[1]) / (2 * h), Math.sin(e.theta)],
    ];
    const det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const dk = (-r[0] * j[1][1] + j[0][1] * r[1]) / det;
    const dl = (-j[0][0] * r[1] + j[1][0] * r[0]) / det;

    let step = 1;
    let moved = false;
    for (let back = 0; back < 8; back++) {
      const nk = clamp(kappa + dk * step, -kMax, kMax);
      const nl = clamp(Lc + dl * step, 0, lcMax);
      const nr = residual(nk, nl);
      if (norm(nr) < norm(r)) {
        kappa = nk;
        Lc = nl;
        r = nr;
        moved = true;
        break;
      }
      step /= 2;
    }
    if (!moved) break;
  }

  Ls = lsFor(kappa);
  if (Lc <= 1e-6) {
    // 円曲線が残らない = 緩和曲線の途中で終わる線形。未知数を
    // (終端曲率, 緩和曲線長) に切り替えて解き直す。短い引きでは常態。
    return solveSpiralOnly(k0, X, Y, chordLen, kMax, designSpeed, kappa);
  }
  return { kappa, Ls, Lc };
}

/** 円曲線が入らない場合: (終端曲率, 緩和曲線長) を解く。 */
function solveSpiralOnly(
  k0: number,
  X: number,
  Y: number,
  chordLen: number,
  kMax: number,
  designSpeed: number,
  seedKappa: number,
): { kappa: number; Ls: number; Lc: number } {
  const lsMax = Math.max(1, Math.min(LS_MAX, 1.5 * chordLen));
  let kappa = clamp(seedKappa, -kMax, kMax);
  let Ls = clamp(spiralLengthFor(k0, kappa, designSpeed, chordLen), 1, lsMax);

  const residual = (kap: number, ls: number): [number, number] => {
    const e = spiralPoint(k0, kap, Math.max(1e-6, ls), Math.max(1e-6, ls));
    return [e.x - X, e.y - Y];
  };
  const norm = (r: [number, number]): number => Math.hypot(r[0], r[1]);
  let r = residual(kappa, Ls);

  for (let iter = 0; iter < 30 && norm(r) > 1e-3; iter++) {
    const hk = Math.max(1e-7, 1e-4 * Math.abs(kappa));
    const hl = Math.max(1e-5, 1e-4 * Ls);
    const rk = [residual(kappa + hk, Ls), residual(kappa - hk, Ls)];
    const rl = [residual(kappa, Ls + hl), residual(kappa, Ls - hl)];
    const j = [
      [(rk[0][0] - rk[1][0]) / (2 * hk), (rl[0][0] - rl[1][0]) / (2 * hl)],
      [(rk[0][1] - rk[1][1]) / (2 * hk), (rl[0][1] - rl[1][1]) / (2 * hl)],
    ];
    const det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const dk = (-r[0] * j[1][1] + j[0][1] * r[1]) / det;
    const dl = (-j[0][0] * r[1] + j[1][0] * r[0]) / det;

    let step = 1;
    let moved = false;
    for (let back = 0; back < 8; back++) {
      const nk = clamp(kappa + dk * step, -kMax, kMax);
      const nl = clamp(Ls + dl * step, 1, lsMax);
      const nr = residual(nk, nl);
      if (norm(nr) < norm(r)) {
        kappa = nk;
        Ls = nl;
        r = nr;
        moved = true;
        break;
      }
      step /= 2;
    }
    if (!moved) break;
  }
  return { kappa, Ls, Lc: 0 };
}
