import { PointTable, type PointEntry } from '../math/table.ts';
import type { Meters, MetersPerSecond, Radians } from '../units.ts';

/** 分岐の向き（列車の進行方向から見て、分岐側がどちらへ出るか） */
export type TurnoutSide = 'left' | 'right';

/**
 * 分岐器の向き。
 *
 * - `facing`（対向） — トングレール側から進入する。開通方向によって進路が分かれる。
 * - `trailing`（背向） — クロッシング側から進入する。合流にあたる。
 */
export type TurnoutOrientation = 'facing' | 'trailing';

/** 開通方向（この列車が通る側） */
export type TurnoutRoute = 'through' | 'diverging';

/** 分岐器の構造上の要素。軸が踏むたびに衝撃と音が出る。 */
export type TurnoutFeatureKind = 'points' | 'crossing';

/** 分岐器（コンパイル済み） */
export interface Turnout {
  readonly id: string;
  /** 列車が進入する側の端（分岐器の始端）の距離程 [m] */
  readonly position: Meters;
  /** 分岐器の全長 [m] */
  readonly length: Meters;
  /** 番数 N（クロッシング角 α は tan α = 1/N） */
  readonly number: number;
  /** クロッシング角 [rad] */
  readonly crossingAngle: Radians;
  /** リード曲線（分岐側）の半径 [m] */
  readonly radius: Meters;
  /** トングレール先端からクロッシングのノーズまでの距離 [m] */
  readonly leadLength: Meters;
  readonly side: TurnoutSide;
  readonly orientation: TurnoutOrientation;
  /** 開通方向。列車がどちら側を通るかを表す。 */
  readonly route: TurnoutRoute;
  /**
   * 渡り線（片渡り）の分岐器か。
   *
   * 分岐側が**隣の線路へつながっている**ことを表す。分岐側の線形が、離れていく枝
   * ではなく「リード曲線 → 護輪軌条部 → 戻し曲線」で隣の線路に乗り移る形になり、
   * 反対側の端にはもう 1 基の分岐器が背中合わせに据わる。複線区間で上下線を
   * 移るための設備で、単独の側線分岐器とは線形そのものが違う。
   */
  readonly crossover: boolean;
  /**
   * 可動ノーズクロッシングか。
   * 固定クロッシングにはノーズと翼レールのあいだに欠線（レールの途切れ）があり、
   * 車輪はそこを一瞬落ちて渡る。可動ノーズはこの欠線が無いので衝撃が小さい。
   */
  readonly swingNose: boolean;
  /** 分岐側の制限速度 [m/s] */
  readonly divergingSpeed: MetersPerSecond;
  /** トングレール先端の距離程 [m] */
  readonly pointsPosition: Meters;
  /** クロッシング（ノーズ）の距離程 [m] */
  readonly crossingPosition: Meters;
}

/** 分岐器の 1 要素（軸が踏む点） */
export interface TurnoutFeature {
  readonly turnoutId: string;
  readonly kind: TurnoutFeatureKind;
  /** 衝撃の相対的な強さ 0..1（基準速度で 1 になる） */
  readonly strength: number;
  /** 分岐側を通っているか（音色を変えるのに使う） */
  readonly diverging: boolean;
}

/**
 * 番数ごとの標準的なリード曲線半径 [m]（在来線の代表値）。
 *
 * 番数 N はクロッシング角 α の cot（tan α = 1/N）であり、リード長がおよそ N に
 * 比例することから、リード半径は N² にほぼ比例して伸びる。表の外側はその比で外挿する。
 */
const STANDARD_LEAD_RADIUS: ReadonlyArray<readonly [number, number]> = [
  [8, 145],
  [10, 245],
  [12, 350],
  [14, 480],
  [16, 560],
  [18, 700],
  [20, 900],
];

/** クロッシング角 [rad]。番数 N に対し tan α = 1/N。 */
export function crossingAngle(number: number): Radians {
  return Math.atan(1 / Math.max(1e-6, number));
}

/** 番数から標準的なリード曲線半径 [m] を求める */
export function standardLeadRadius(number: number): Meters {
  const table = STANDARD_LEAD_RADIUS;
  const first = table[0]!;
  const last = table[table.length - 1]!;
  if (number <= first[0]) return (first[1] * number * number) / (first[0] * first[0]);
  if (number >= last[0]) return (last[1] * number * number) / (last[0] * last[0]);
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1]!;
    const b = table[i]!;
    if (number <= b[0]) {
      const t = (number - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return last[1];
}

/**
 * リード長 [m]。トングレール先端からクロッシングのノーズまでの弧長 `R α` にあたる。
 * #12・R350 なら 29m 前後になり、実際の分岐器の寸法とおおむね一致する。
 */
export function leadLengthOf(radius: Meters, angle: Radians): Meters {
  return radius * angle;
}

/**
 * 分岐器の全長 [m]。
 * クロッシングの先にも翼レールと護輪軌条が続くので、リード長より 4 割ほど長い。
 */
export function turnoutLengthOf(leadLength: Meters): Meters {
  return leadLength * 1.4;
}

/** 分岐側が右へ出るなら +1 */
const sideSign = (side: TurnoutSide): number => (side === 'right' ? 1 : -1);

/**
 * 欠線を踏む側 [+1 = 右のレール]。
 *
 * クロッシングは分岐側と本線側のレールが交わる 1 点なので、欠線は**片方のレールにしか
 * 無い**。片開き分岐器を直進すれば分岐側へ出ていくレール（＝分岐の側）を、分岐側を
 * 通れば本線から離れていくレール（＝分岐と反対の側）を踏む。落ちるのが片側だけなので、
 * この衝撃は上下動だけでなく**水準狂い**として車体をロールさせる。
 */
const gapSign = (turnout: Turnout): number =>
  sideSign(turnout.side) * (turnout.route === 'through' ? 1 : -1);

/** トングレール部の衝撃の強さ（分岐側は車輪がトングに乗り上げて曲げられるので強い） */
const pointsStrength = (turnout: Turnout): number => (turnout.route === 'diverging' ? 0.7 : 0.3);

/** クロッシング部の衝撃の強さ（可動ノーズなら欠線が無いので小さい） */
const crossingStrength = (turnout: Turnout): number => (turnout.swingNose ? 0.25 : 1);

/** 余弦の山（|u| <= 1 で 1 → 0、外側は 0）。局所的な狂いの形として使う。 */
function bump(s: number, centre: number, halfWidth: number): number {
  const u = (s - centre) / halfWidth;
  if (u <= -1 || u >= 1) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * u));
}

/** 欠線の落ち込みの深さ [m] */
const CROSSING_DROP = 0.005;
/** 欠線の長さの半分 [m]（車輪が渡りきるまで） */
const CROSSING_HALF_WIDTH = 0.55;
/** トングレール部の落ち込みの深さ [m] */
const POINTS_DROP = 0.002;
/** トングレール部の半幅 [m] */
const POINTS_HALF_WIDTH = 1.4;
/** トングレールでの横のふらつき [m]（フランジウェイの遊間ぶん） */
const POINTS_KICK = 0.004;
/** 護輪軌条が輪軸を押し戻す量 [m] */
const GUARD_KICK = 0.003;

/**
 * 路線上の分岐器の集まり。
 *
 * 分岐器は**距離程の関数としての局所的な軌道狂い**として扱う。軌道狂いと同じ扱いに
 * することで、車体動揺の側には手を入れずに「そこを通ると揺れる」が出る。同じ場所を
 * 何度通っても同じ揺れ方をするのも軌道狂いと同じである。
 *
 * - トングレール先端 — 車輪がトングに乗り移るときの横のふらつきと、わずかな落ち込み
 * - クロッシング — 欠線を踏む落ち込み。片側のレールだけなので水準狂いになり、
 *   護輪軌条が輪軸を反対側へ押し戻す
 *
 * 分岐側を通るときの**大きな横揺れ**はここには入っていない。それは緩和曲線もカントも
 * 無いリード曲線へ突然入ることによるもので、線形（`Alignment`）の側から出てくる。
 */
export class TurnoutTrack {
  readonly turnouts: readonly Turnout[];
  private readonly features: PointTable<TurnoutFeature>;
  private readonly byId = new Map<string, Turnout>();
  /** 影響範囲の判定用（要素の半幅ぶん外へ広げてある） */
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  constructor(turnouts: readonly Turnout[]) {
    this.turnouts = [...turnouts].sort((a, b) => a.position - b.position);
    const features: PointEntry<TurnoutFeature>[] = [];
    for (const t of this.turnouts) {
      this.byId.set(t.id, t);
      this.starts.push(t.position - POINTS_HALF_WIDTH);
      this.ends.push(t.position + t.length + POINTS_HALF_WIDTH);
      features.push({
        s: t.pointsPosition,
        value: {
          turnoutId: t.id,
          kind: 'points',
          strength: pointsStrength(t),
          diverging: t.route === 'diverging',
        },
      });
      features.push({
        s: t.crossingPosition,
        value: {
          turnoutId: t.id,
          kind: 'crossing',
          strength: crossingStrength(t),
          diverging: t.route === 'diverging',
        },
      });
    }
    this.features = new PointTable(features);
  }

  get length(): number {
    return this.turnouts.length;
  }

  /** 区間 (sFrom, sTo] で踏んだ要素（軸ごとに呼ぶ） */
  crossing(sFrom: Meters, sTo: Meters): ReadonlyArray<PointEntry<TurnoutFeature>> {
    return this.features.crossing(sFrom, sTo);
  }

  get(id: string): Turnout | undefined {
    return this.byId.get(id);
  }

  /** 距離程 s を含む分岐器 */
  at(s: Meters): Turnout | undefined {
    for (let i = 0; i < this.turnouts.length; i++) {
      const t = this.turnouts[i]!;
      if (s < t.position) return undefined;
      if (s < t.position + t.length) return t;
    }
    return undefined;
  }

  /** s より先にある最初の分岐器 */
  next(s: Meters): Turnout | undefined {
    for (const t of this.turnouts) {
      if (t.position + t.length > s) return t;
    }
    return undefined;
  }

  /** 高低狂い [m]（欠線とトングレールの落ち込み） */
  verticalAt(s: Meters): Meters {
    let sum = 0;
    for (let i = 0; i < this.turnouts.length; i++) {
      if (s < this.starts[i]!) break;
      if (s > this.ends[i]!) continue;
      const t = this.turnouts[i]!;
      // 欠線を踏むのは片側の車輪だけなので、車体の上下動へは半分だけ効く
      sum -=
        crossingStrength(t) *
          CROSSING_DROP *
          0.5 *
          bump(s, t.crossingPosition, CROSSING_HALF_WIDTH) +
        POINTS_DROP * bump(s, t.pointsPosition, POINTS_HALF_WIDTH);
    }
    return sum;
  }

  /** 通り狂い [m]（トングレールでのふらつきと護輪軌条の押し戻し） */
  lateralAt(s: Meters): Meters {
    let sum = 0;
    for (let i = 0; i < this.turnouts.length; i++) {
      if (s < this.starts[i]!) break;
      if (s > this.ends[i]!) continue;
      const t = this.turnouts[i]!;
      const toDiverging = sideSign(t.side) * (t.route === 'diverging' ? 1 : 0.4);
      sum +=
        toDiverging * POINTS_KICK * bump(s, t.pointsPosition, POINTS_HALF_WIDTH) -
        gapSign(t) *
          crossingStrength(t) *
          GUARD_KICK *
          bump(s, t.crossingPosition, CROSSING_HALF_WIDTH);
    }
    return sum;
  }

  /** 水準狂い [m]（欠線は片側のレールにしかないので車体はロールする） */
  crossLevelAt(s: Meters): Meters {
    let sum = 0;
    for (let i = 0; i < this.turnouts.length; i++) {
      if (s < this.starts[i]!) break;
      if (s > this.ends[i]!) continue;
      const t = this.turnouts[i]!;
      sum +=
        gapSign(t) *
        crossingStrength(t) *
        CROSSING_DROP *
        bump(s, t.crossingPosition, CROSSING_HALF_WIDTH);
    }
    return sum;
  }
}

/** 分岐器を持たない路線用の空のテーブル */
export const NO_TURNOUTS = new TurnoutTrack([]);
