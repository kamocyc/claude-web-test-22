import { PointTable, type PointEntry } from '../math/table.ts';
import type { Meters, MetersPerSecond, Seconds } from '../units.ts';

/**
 * 踏切道。
 *
 * 踏切は「道路と線路が同じ高さで交わる場所」であって、線路の側から見ると
 * **舗装のために軌道が切れている区間**である。走っていて分かるのは 2 つで、
 *
 *  1. 踏切板（軌道内と軌道脇の舗装）の目地を踏む衝撃 — 踏切道の入口と出口で
 *     1 軸あたり 2 回。舗装とレールのあいだにはフランジが通る溝（フランジ
 *     ウェイ）が空いており、そこでレールの支持が変わる。
 *  2. 警報機の音 — 踏切そのものではなく**道路へ向けて**鳴っている音を、
 *     通りすがりに聞く。運転台へは近づくにつれて大きく高く、通り過ぎると
 *     小さく低くなって届く。
 *
 * 2 のドップラー効果は「それらしく」付けているのではなく、音源が線路脇に
 * 静止していて自分が動いているのだから必然的にそうなる。踏切の音が
 * 「カンカンカン…カーン」と下がって聞こえるのはこのためで、下がり幅は速度で決まる。
 */

/** 警報機の音の方式 */
export type CrossingBell =
  /** 電鐘式（電磁石でハンマーが鐘を叩く。旧式で、音程を持たない金属音） */
  | 'gong'
  /** 電子式（スピーカから 2 音の電子音。現在の標準） */
  | 'electronic';

/** 踏切道の舗装 */
export type CrossingSurface =
  /** ゴム敷（軌道内をゴム板で埋める。目地がやわらかく音も鈍い） */
  | 'rubber'
  /** コンクリート板（硬く、目地の音も硬い） */
  | 'concrete';

/** 踏切（コンパイル済み） */
export interface LevelCrossing {
  readonly id: string;
  readonly name: string;
  /** 踏切道の中心の距離程 [m] */
  readonly position: Meters;
  /** 道路の幅 [m]（踏切道の長さにあたる） */
  readonly roadWidth: Meters;
  readonly surface: CrossingSurface;
  readonly bell: CrossingBell;
  /**
   * 警報を開始する距離 [m]。
   *
   * 実物では踏切制御子（軌道回路や電子式の検知器）が線路のこの位置に置かれ、
   * 列車が踏むと警報が始まる。距離は「いちばん速い列車でも警報時間が
   * 確保できるように」決まるので、**警報時間 × その区間の最高速度**になる。
   * 遅い列車ほど鳴っている時間が長くなるのは、この決め方の当然の帰結である。
   */
  readonly warningDistance: Meters;
  /** 警報開始から遮断桿が下り始めるまで [s] */
  readonly barrierDelay: Seconds;
  /** 遮断桿が下りきるまでの時間 [s] */
  readonly barrierFall: Seconds;
  /** 遮断桿が上がりきるまでの時間 [s] */
  readonly barrierRise: Seconds;
}

/**
 * 警報時間 [s]。踏切保安設備の標準で、列車が踏切に達するまでに最低これだけ鳴らす。
 * 遮断桿が下りきってから列車が来るまでの余裕もこの中に含まれる。
 */
export const DEFAULT_WARNING_TIME: Seconds = 30;

/** 警報開始距離を求める（警報時間 × 制御する最高速度） */
export function warningDistanceOf(warningTime: Seconds, controlSpeed: MetersPerSecond): Meters {
  return warningTime * controlSpeed;
}

/** 踏切板の目地（軸が踏む点） */
export interface CrossingPanelEdge {
  readonly crossingId: string;
  /** 衝撃の相対的な強さ 0..1 */
  readonly strength: number;
  /** 踏切道へ入る側か（出る側なら false） */
  readonly entering: boolean;
}

/**
 * 舗装ごとの目地の衝撃の強さ。
 *
 * ゴム敷はレールとのあいだの隙間を弾性体が埋めているので、段差が吸われて鈍い。
 * コンクリート板は硬いので、レール継目に近い硬さの音が出る。
 */
const SURFACE_STRENGTH: Readonly<Record<CrossingSurface, number>> = {
  rubber: 0.45,
  concrete: 0.7,
};

/** 踏切板の縁が舗装との段差を持つ量 [m]（実測でも 2〜3mm 程度は必ずある） */
const PANEL_STEP = 0.0025;
/** 段差の効く範囲の半幅 [m] */
const PANEL_HALF_WIDTH = 0.8;

/** 余弦の山（`turnout.ts` と同じ形。局所的な狂いを表す） */
function bump(s: number, centre: number, halfWidth: number): number {
  const u = (s - centre) / halfWidth;
  if (u <= -1 || u >= 1) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * u));
}

/** 踏切道の入口・出口の距離程 [m] */
export function crossingEdges(crossing: LevelCrossing): readonly [Meters, Meters] {
  const half = crossing.roadWidth / 2;
  return [crossing.position - half, crossing.position + half];
}

/**
 * 路線上の踏切の集まり。
 *
 * 分岐器（`TurnoutTrack`）と同じ作りにしてある。踏切道の目地は軸が踏む点として
 * 持ち、舗装の段差は距離程の関数としての局所的な軌道狂いとして持つ。こうすると
 * 車体動揺の側には手を入れずに「踏切を渡ると小さく突き上げる」が出る。
 */
export class LevelCrossingTrack {
  readonly crossings: readonly LevelCrossing[];
  private readonly edges: PointTable<CrossingPanelEdge>;
  private readonly byId = new Map<string, LevelCrossing>();

  constructor(crossings: readonly LevelCrossing[]) {
    this.crossings = [...crossings].sort((a, b) => a.position - b.position);
    const entries: PointEntry<CrossingPanelEdge>[] = [];
    for (const crossing of this.crossings) {
      this.byId.set(crossing.id, crossing);
      const [entry, exit] = crossingEdges(crossing);
      const strength = SURFACE_STRENGTH[crossing.surface];
      entries.push({ s: entry, value: { crossingId: crossing.id, strength, entering: true } });
      entries.push({ s: exit, value: { crossingId: crossing.id, strength, entering: false } });
    }
    this.edges = new PointTable(entries);
  }

  get length(): number {
    return this.crossings.length;
  }

  get(id: string): LevelCrossing | undefined {
    return this.byId.get(id);
  }

  /** 区間 (sFrom, sTo] で踏んだ踏切板の目地（軸ごとに呼ぶ） */
  crossing(sFrom: Meters, sTo: Meters): ReadonlyArray<PointEntry<CrossingPanelEdge>> {
    return this.edges.crossing(sFrom, sTo);
  }

  /** 距離程 s を含む踏切道 */
  at(s: Meters): LevelCrossing | undefined {
    for (const crossing of this.crossings) {
      const [entry, exit] = crossingEdges(crossing);
      if (s < entry) return undefined;
      if (s <= exit) return crossing;
    }
    return undefined;
  }

  /** 距離程 s にいちばん近い踏切 */
  nearest(s: Meters): LevelCrossing | undefined {
    let best: LevelCrossing | undefined;
    let bestDistance = Infinity;
    for (const crossing of this.crossings) {
      const d = Math.abs(crossing.position - s);
      if (d < bestDistance) {
        bestDistance = d;
        best = crossing;
      }
    }
    return best;
  }

  /** 高低狂い [m]（踏切板と舗装の段差） */
  verticalAt(s: Meters): Meters {
    let sum = 0;
    for (const crossing of this.crossings) {
      const [entry, exit] = crossingEdges(crossing);
      if (s < entry - PANEL_HALF_WIDTH) break;
      if (s > exit + PANEL_HALF_WIDTH) continue;
      const strength = SURFACE_STRENGTH[crossing.surface];
      sum -=
        strength *
        PANEL_STEP *
        (bump(s, entry, PANEL_HALF_WIDTH) + bump(s, exit, PANEL_HALF_WIDTH));
    }
    return sum;
  }
}

/** 踏切を持たない路線用の空のテーブル */
export const NO_LEVEL_CROSSINGS = new LevelCrossingTrack([]);
