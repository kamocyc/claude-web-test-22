import type { Meters, Radians } from '../units.ts';
import type { Turnout } from './turnout.ts';

/**
 * 行き違い設備（交換設備）の、**自列車が走っていないほうの線路**。
 *
 * 単線の路線で対向列車とすれ違えるのは交換設備の中だけである。そこには線路が
 * 2 本あり、片方を自列車が、もう片方を対向列車が通る。自列車の路線データは
 * 自分が通る側の線形しか持っていないので、もう 1 本がどこにあるかを
 * **距離程に対する横のずれ**として持つのがこの型である。
 *
 * ずれの形はまず分岐器の寸法で決まる。対向分岐器のリード曲線で振れ、護輪軌条部を
 * 直線で進み、戻し曲線で本線と平行になる — この 3 段で横へ寄る量が交換設備の線路中心
 * 間隔になる（#12・R350 なら 3.38m）。すなわち**交換設備の線路中心間隔は分岐器の番数が
 * 決めている**のであって、別に与える値ではない。
 *
 * 交換設備ではなく**複線区間**を表すときだけ、そこに拡幅（`widening`）が足される。
 * 複線の線路中心間隔を決めているのは分岐器ではなく建築限界だからで、分岐器で寄る
 * ぶんとの差を、分岐器の先の緩い S 字で埋める。
 */
export interface PassingLoop {
  readonly id: string;
  /** 2 本が 1 本になる側の端（入口の分岐器）の距離程 [m] */
  readonly entry: Meters;
  /** 2 本が 1 本になる側の端（出口の分岐器）の距離程 [m] */
  readonly exit: Meters;
  /** リード曲線の半径 [m] */
  readonly radius: Meters;
  /** クロッシング角 [rad] */
  readonly angle: Radians;
  /** 護輪軌条部（リード曲線と戻し曲線のあいだの直線）の長さ [m] */
  readonly tailLength: Meters;
  /** 分岐器 1 組で寄りきる量 [m]（拡幅前の線路中心間隔） */
  readonly spacing: Meters;
  /** 隣の線路が自列車から見てどちら側にあるか（+1 = 右） */
  readonly side: 1 | -1;
  /**
   * 分岐器で寄りきったあと、さらに離す量 [m]（0 なら分岐器の寸法のまま）。
   *
   * 交換設備なら分岐器 1 組ぶん（#12 で 3.38m）離れれば足りるが、**複線区間**の
   * 線路中心間隔は分岐器ではなく建築限界が決めていて、在来線の標準は 3.8m である
   * （車両限界 2900mm の両側に離隔を取った値。曲線では拡大する）。分岐器で寄る
   * ぶんでは 420mm 足りないので、その差を分岐器の先で埋める。
   */
  readonly widening: Meters;
  /** 拡幅に使う区間の長さ [m]（`widening` が 0 なら意味を持たない） */
  readonly wideningLength: Meters;
}

/**
 * 分岐器 1 組（リード曲線 → 護輪軌条部 → 戻し曲線）で横へ寄る量 [m]。
 *
 * 方位角 θ(d) を積分して求める。
 *
 * | 区間                    | 方位角        | 横のずれ |
 * | ----------------------- | ------------- | -------- |
 * | 0 ≤ d ≤ L（リード曲線） | d/R           | R(1 − cos(d/R)) |
 * | L ≤ d ≤ L+T（直線）     | α             | 前段 + (d−L) sinα |
 * | L+T ≤ d（戻し曲線）     | α − (d−L−T)/R | 前段 + R(cos(α−u/R) − cosα) |
 *
 * 戻し曲線が終わったところで方位角は 0 に戻り、そこから先は本線と平行に
 * `2R(1−cosα) + T sinα` だけ離れて進む。緩和曲線もカントも無いのがこの線形の
 * 要点で、分岐側を通る列車が受ける階段状の横 G はここから出る。
 */
export function turnoutBranchOffset(
  distance: Meters,
  radius: Meters,
  angle: Radians,
  tailLength: Meters,
): Meters {
  const lead = radius * angle;
  const d = Math.max(0, distance);
  if (d <= lead) return radius * (1 - Math.cos(d / radius));
  const afterLead = radius * (1 - Math.cos(angle));
  if (d <= lead + tailLength) return afterLead + (d - lead) * Math.sin(angle);
  const straight = afterLead + tailLength * Math.sin(angle);
  const u = Math.min(d - lead - tailLength, lead);
  return straight + radius * (Math.cos(angle - u / radius) - Math.cos(angle));
}

/** 分岐器 1 組で寄りきる量（= 線路中心間隔）[m] */
export function loopSpacingOf(radius: Meters, angle: Radians, tailLength: Meters): Meters {
  return turnoutBranchOffset(Infinity, radius, angle, tailLength);
}

/**
 * 分岐器の先で線路をさらに離す S 字（線増区間の拡幅）の横のずれ [m]。
 *
 * 実物の複線化区間でも、分岐器を出たところから本線と副本線がじわりと離れて所定の
 * 線路中心間隔になる。使うのは**同じ半径の円弧 2 つを背中合わせにした S 字**で、
 * 全長 L で W だけ寄せるなら半径は
 *
 * ```
 *   W = 2 × R(1 − cos(θ)) ≈ 2 × (L/2)²/(2R)  →  R ≈ L²/(4W)
 * ```
 *
 * になる。L = 120m・W = 0.42m なら R ≈ 8570m で、緩和曲線が無くても横 G は
 * 0.01m/s² に届かない（分岐器のリード曲線 R350 の 1/25 以下）。**乗っている側に
 * とっては直線と区別が付かない**のがこの寸法の狙いで、だからこそ複線区間の途中で
 * 線路が離れていっても運転士は何も感じない。
 */
function wideningOffset(distance: Meters, widening: Meters, length: Meters): Meters {
  if (widening <= 0 || length <= 0) return 0;
  const d = Math.max(0, Math.min(distance, length));
  const half = length / 2;
  // 前半は R の円弧（y = d²/2R）、後半はその鏡像。R = L²/(4W) を代入して整理すると
  // 係数が 2W/L² になる。
  const k = (2 * widening) / (length * length);
  return d <= half ? k * d * d : widening - k * (length - d) * (length - d);
}

/**
 * 分岐器の「2 本が 1 本になっている側」の端の距離程 [m]。
 *
 * 対向分岐器はトングレール先端の側、背向分岐器はその反対側で 1 本になる。
 * 隣の線路が現れる／消える点はここである。
 */
export function turnoutMergePoint(turnout: Turnout): Meters {
  return turnout.orientation === 'facing' ? turnout.position : turnout.position + turnout.length;
}

/**
 * 分岐器の端から距離 d だけ入ったところの、2 本の線路の中心間隔 [m]。
 *
 * 分岐器 1 組で寄りきってから拡幅の S 字が始まる。d について単調非減少なので、
 * 入口側と出口側で求めた値の**小さいほう**を採れば、設備の途中では所定の間隔、
 * 両端では分岐器の線形、という形がそのまま出る。
 */
function separationAt(loop: PassingLoop, d: Meters): Meters {
  const turnout = Math.min(
    turnoutBranchOffset(d, loop.radius, loop.angle, loop.tailLength),
    loop.spacing,
  );
  const run = 2 * loop.radius * loop.angle + loop.tailLength;
  return turnout + wideningOffset(d - run, loop.widening, loop.wideningLength);
}

/**
 * 路線に沿った「隣の線路」。
 *
 * 交換設備と複線区間にだけ存在し、それ以外の区間では**無い**（単線だから）。
 * 対向列車をこの上に置き、すれ違いの音と絵はここから出す。
 */
export class AdjacentTrack {
  readonly loops: readonly PassingLoop[];

  constructor(loops: readonly PassingLoop[]) {
    this.loops = [...loops].sort((a, b) => a.entry - b.entry);
  }

  get length(): number {
    return this.loops.length;
  }

  /** 距離程 s に隣の線路があるか */
  has(s: Meters): boolean {
    return this.loopAt(s) !== undefined;
  }

  loopAt(s: Meters): PassingLoop | undefined {
    for (const loop of this.loops) {
      if (s < loop.entry) return undefined;
      if (s <= loop.exit) return loop;
    }
    return undefined;
  }

  /**
   * 距離程 s における隣の線路の横のずれ [m]（正 = 進行方向右）。
   * 隣の線路が無い区間では 0 を返す。
   */
  offsetAt(s: Meters): Meters {
    const loop = this.loopAt(s);
    if (!loop) return 0;
    return (
      loop.side * Math.min(separationAt(loop, s - loop.entry), separationAt(loop, loop.exit - s))
    );
  }

  /** 距離程 s における線路中心間隔 [m]（隣の線路が無い区間では 0） */
  spacingAt(s: Meters): Meters {
    return Math.abs(this.offsetAt(s));
  }
}

/** 隣の線路を持たない路線用の空のテーブル */
export const NO_ADJACENT_TRACK = new AdjacentTrack([]);
