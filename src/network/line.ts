import type { RGB } from '../build/surface';
import type { StationId } from './station';

/**
 * 路線 (どの駅にどの順で停まるか)。
 *
 * 路線が持つのは**停車駅の並びだけ**で、線路の上をどう通るかは持たない。
 * 経路は毎回、その時点の車線グラフから引き直す (`planLines`)。こうすると
 * 線路を敷き足したり付け替えたりしても路線はそのまま生き、繋がっていない
 * 区間があれば「繋がっていない」と分かる。
 *
 *   駅を選ぶ (ここ) → 経路を引く (sim/lineRoute) → 列車を走らせる (sim/traffic)
 */

export type LineId = number;

export interface TransitLine {
  id: LineId;
  name: string;
  color: RGB;
  /** 停車駅の並び (選んだ順)。 */
  stops: StationId[];
}

/**
 * 路線の色。隣り合う番号どうしが紛らわしくない並びにする。
 *
 * 値は他の描画と同じくリニア色空間 (画面に出るときに sRGB へ変換される)
 * なので、見た目より暗い数字になる。
 */
export const LINE_COLORS: RGB[] = [
  [0.8, 0.1, 0.02],
  [0.04, 0.27, 0.84],
  [0.04, 0.46, 0.1],
  [0.88, 0.52, 0.03],
  [0.36, 0.13, 0.76],
  [0.84, 0.08, 0.31],
];

/**
 * 路線の台帳。
 *
 * 区画 (`ZoneMap`) と同じく、ネットワークから導けない「利用者が決めたこと」
 * だけを持つ。駅が消えたら、その停車駅は落とす。
 */
export class LineMap {
  private readonly byId = new Map<LineId, TransitLine>();
  private nextId = 1;

  get size(): number {
    return this.byId.size;
  }

  /** 作った順。 */
  get all(): TransitLine[] {
    return [...this.byId.values()];
  }

  get(id: LineId): TransitLine | null {
    return this.byId.get(id) ?? null;
  }

  /** 空の路線を 1 本作る。 */
  create(): TransitLine {
    const id = this.nextId++;
    const line: TransitLine = {
      id,
      name: this.nextName(),
      color: LINE_COLORS[(id - 1) % LINE_COLORS.length],
      stops: [],
    };
    this.byId.set(id, line);
    return line;
  }

  /**
   * 停車駅を末尾に足す。同じ駅を続けて選んでも増やさない (二度押し)。
   * 実際に変わったら true。
   */
  addStop(id: LineId, station: StationId): boolean {
    const line = this.byId.get(id);
    if (!line) return false;
    if (line.stops[line.stops.length - 1] === station) return false;
    line.stops.push(station);
    return true;
  }

  /** 末尾の停車駅を取り消す。 */
  removeLastStop(id: LineId): boolean {
    const line = this.byId.get(id);
    if (!line || line.stops.length === 0) return false;
    line.stops.pop();
    return true;
  }

  remove(id: LineId): boolean {
    return this.byId.delete(id);
  }

  clear(): void {
    this.byId.clear();
    this.nextId = 1;
  }

  /** 無くなった駅を停車駅から落とす。落ちたら true。 */
  prune(existing: ReadonlySet<StationId>): boolean {
    let changed = false;
    for (const line of this.byId.values()) {
      const kept = line.stops.filter((station) => existing.has(station));
      if (kept.length === line.stops.length) continue;
      line.stops.splice(0, line.stops.length, ...kept);
      changed = true;
    }
    return changed;
  }

  private nextName(): string {
    const used = new Set([...this.byId.values()].map((line) => line.name));
    let index = this.byId.size + 1;
    while (used.has(`路線 ${index}`)) index++;
    return `路線 ${index}`;
  }
}
