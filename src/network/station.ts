import { Vector2, Vector3 } from 'three';
import { Alignment, stationOf, type AlignmentSample } from '../core/alignment';
import { HorizontalCurve } from '../core/curve';
import { VerticalProfile } from '../core/profile';
import { clamp } from '../core/units';
import type { SegmentId } from './network';

export type StationId = number;
export type StationLength = 80 | 120 | 160 | 200;

export const STATION_LENGTHS: readonly StationLength[] = [80, 120, 160, 200];
export const STATION_TRACK_MIN = 1;
export const STATION_TRACK_MAX = 6;
export const PLATFORM_WIDTH = 5;
export const PLATFORM_HEIGHT = 1.05;
export const PLATFORM_CLEARANCE = 1.8;
export const STATION_TRACK_SPACING = 4.5;

export interface StationSpec {
  name: string;
  center: Vector3;
  /** Station-track direction in the XZ plane, in radians. */
  heading: number;
  length: StationLength;
  trackCount: number;
  platformCount: number;
  elevated: boolean;
}

export interface StationTrack {
  index: number;
  segment: SegmentId;
  /** 中心線からの横距 [m]。進行方向の**右手**が正 (`perp(forward)` の向き)。 */
  offset: number;
}

export interface StationPlatform {
  index: number;
  offset: number;
  width: number;
  /** Track indices served by this platform. */
  tracks: number[];
}

export interface Station {
  id: StationId;
  name: string;
  center: Vector3;
  heading: number;
  length: StationLength;
  trackCount: number;
  platformCount: number;
  elevated: boolean;
  tracks: StationTrack[];
  platforms: StationPlatform[];
  /** Occupied lateral range, including the station building. */
  minOffset: number;
  maxOffset: number;
  /**
   * 駅の中心線。
   *
   * 空き地に置いた駅では `center` を通る長さ `length` の直線、既設の線路に置いた
   * 駅ではその線路の線形を中心線までずらしたもの。ホーム・上屋・敷地・当たり判定は
   * すべてこの線に沿うので、曲線の途中の駅でもホームが線路に沿って曲がる。
   *
   * 横へずらすと弧長は変わる (曲線の内側は短く、外側は長い) ので、長さは `length`
   * ちょうどとは限らない。局所座標の `along` は中心線上で正規化して扱う
   * (`stationArcAt`)。`center` と `heading` はこの線の中央から導いた控え。
   */
  path: Alignment;
  /**
   * 既設の線路から取り込んだ番線 (空き地に置いた駅では null)。
   *
   * 撤去してもこの番線だけは**ただの線路として残す**。もともとそこにあった線路を
   * 駅と一緒に消してしまうと、路線に穴が空く。
   */
  adopted: number | null;
}

export interface PlannedStationLayout {
  tracks: Omit<StationTrack, 'segment'>[];
  platforms: StationPlatform[];
  minOffset: number;
  maxOffset: number;
}

type StripKind = 'track' | 'platform';

interface Candidate {
  strips: StripKind[];
  islands: number;
  width: number;
  balance: number;
}

/** Valid platform-count range for a station with `tracks` tracks. */
export function stationPlatformRange(tracks: number): { min: number; max: number } {
  const count = Math.max(STATION_TRACK_MIN, Math.min(STATION_TRACK_MAX, Math.round(tracks)));
  return { min: Math.ceil(count / 2), max: count + 1 };
}

/** Validate and normalise the user-visible station settings. */
export function validateStationSpec(spec: StationSpec): string[] {
  const errors: string[] = [];
  const name = spec.name.trim();
  if (name.length === 0) errors.push('駅名を入力してください');
  if (name.length > 40) errors.push('駅名は40文字以内にしてください');
  if (!Number.isInteger(spec.trackCount) || spec.trackCount < 1 || spec.trackCount > 6) {
    errors.push('線路数は1〜6本で指定してください');
  }
  const range = stationPlatformRange(spec.trackCount);
  if (
    !Number.isInteger(spec.platformCount) ||
    spec.platformCount < range.min ||
    spec.platformCount > range.max
  ) {
    errors.push(`ホーム数は${range.min}〜${range.max}本で指定してください`);
  }
  if (!STATION_LENGTHS.includes(spec.length)) errors.push('駅長はプリセットから選んでください');
  return errors;
}

/**
 * Build the narrowest deterministic cross-section that serves every track.
 * Island platforms are preferred, then total width and left/right balance.
 */
export function planStationLayout(trackCount: number, platformCount: number): PlannedStationLayout {
  const range = stationPlatformRange(trackCount);
  if (
    !Number.isInteger(trackCount) ||
    trackCount < STATION_TRACK_MIN ||
    trackCount > STATION_TRACK_MAX ||
    !Number.isInteger(platformCount) ||
    platformCount < range.min ||
    platformCount > range.max
  ) {
    throw new Error('invalid station track/platform count');
  }

  const total = trackCount + platformCount;
  const candidates: Candidate[] = [];
  const strips: StripKind[] = [];
  const visit = (tracks: number, platforms: number): void => {
    if (strips.length === total) {
      if (tracks !== trackCount || platforms !== platformCount) return;
      if (!servesEveryTrack(strips)) return;
      const placed = placeStrips(strips);
      const islands = strips.reduce(
        (n, kind, i) =>
          n +
          (kind === 'platform' && strips[i - 1] === 'track' && strips[i + 1] === 'track' ? 1 : 0),
        0,
      );
      const balance = Math.abs(placed.reduce((sum, p) => sum + p.offset, 0));
      candidates.push({ strips: [...strips], islands, width: placed.width, balance });
      return;
    }
    if (tracks < trackCount) {
      strips.push('track');
      visit(tracks + 1, platforms);
      strips.pop();
    }
    if (platforms < platformCount && strips[strips.length - 1] !== 'platform') {
      strips.push('platform');
      visit(tracks, platforms + 1);
      strips.pop();
    }
  };
  visit(0, 0);
  candidates.sort(
    (a, b) =>
      b.islands - a.islands ||
      a.width - b.width ||
      a.balance - b.balance ||
      a.strips.join('').localeCompare(b.strips.join('')),
  );
  const best = candidates[0];
  if (!best) throw new Error('station layout could not be solved');

  const placed = placeStrips(best.strips);
  const tracks: Omit<StationTrack, 'segment'>[] = [];
  const platforms: StationPlatform[] = [];
  let trackIndex = 0;
  let platformIndex = 0;
  for (let i = 0; i < best.strips.length; i++) {
    const item = placed[i];
    if (best.strips[i] === 'track') {
      tracks.push({ index: trackIndex, offset: item.offset });
      trackIndex++;
      continue;
    }
    const served: number[] = [];
    let before = 0;
    for (let j = 0; j < i; j++) if (best.strips[j] === 'track') before++;
    if (best.strips[i - 1] === 'track') served.push(before - 1);
    if (best.strips[i + 1] === 'track') served.push(before);
    platforms.push({ index: platformIndex++, offset: item.offset, width: PLATFORM_WIDTH, tracks: served });
  }

  const stripMin = Math.min(
    ...placed.map((p, i) => p.offset - (best.strips[i] === 'platform' ? PLATFORM_WIDTH / 2 : 2.2)),
  );
  const stripMax = Math.max(
    ...placed.map((p, i) => p.offset + (best.strips[i] === 'platform' ? PLATFORM_WIDTH / 2 : 2.2)),
  );
  // The main station building and entrance sit on the negative-offset side.
  return { tracks, platforms, minOffset: stripMin - 11, maxOffset: stripMax + 2 };
}

function servesEveryTrack(strips: readonly StripKind[]): boolean {
  return strips.every(
    (kind, i) => kind !== 'track' || strips[i - 1] === 'platform' || strips[i + 1] === 'platform',
  );
}

function placeStrips(strips: readonly StripKind[]): ({ offset: number }[] & { width: number }) {
  const positions: number[] = [0];
  for (let i = 1; i < strips.length; i++) {
    const a = strips[i - 1];
    const b = strips[i];
    const gap =
      a === 'track' && b === 'track'
        ? STATION_TRACK_SPACING
        : PLATFORM_WIDTH / 2 + PLATFORM_CLEARANCE;
    positions.push(positions[i - 1] + gap);
  }
  const edges = positions.map((offset, i) => ({
    min: offset - (strips[i] === 'platform' ? PLATFORM_WIDTH / 2 : 2.2),
    max: offset + (strips[i] === 'platform' ? PLATFORM_WIDTH / 2 : 2.2),
  }));
  const min = Math.min(...edges.map((e) => e.min));
  const max = Math.max(...edges.map((e) => e.max));
  const center = (min + max) / 2;
  const out = positions.map((offset) => ({ offset: offset - center })) as ({ offset: number }[] & {
    width: number;
  });
  out.width = max - min;
  return out;
}

// ---------------------------------------------------------------- 局所座標

/**
 * 駅の中心線と局所座標。
 *
 * 局所座標は `along` (中心線に沿って、駅の中央が 0、範囲は `±length/2`) と
 * `across` (中心線からの横距、進行方向の右手が正)。曲線の駅では中心線・ホーム・
 * 線路の弧長が少しずつ違うので、**`along` は中心線上で正規化して**扱う。こうすると
 * `length` は今までどおり 80/120/160/200 の見出しの長さのままでよく、断面の設計
 * (`planStationLayout`) も形状生成も、直線の駅と同じ式で書ける。
 */
export type StationShape = Pick<Station, 'path' | 'length'>;

/** 横距の範囲まで含めた駅の形 (敷地の判定に使う)。 */
export type StationArea = StationShape & Pick<Station, 'minOffset' | 'maxOffset'>;

/** 局所座標の `along` を中心線の弧長に写す。 */
export function stationArcAt(station: StationShape, along: number): number {
  return (along / station.length + 0.5) * station.path.length;
}

/** 中心線の弧長を局所座標の `along` に写す。 */
export function stationAlongAt(station: StationShape, s: number): number {
  return (s / station.path.length - 0.5) * station.length;
}

/**
 * 中心線上の 1 点。
 *
 * 駅の外 (`|along| > length/2`) を指したときは、端の接線に沿って伸ばした点を返す。
 * 敷地の余裕 (`margin`) を取った外周も、この延長で素直に作れる。
 */
export function stationSampleAt(station: StationShape, along: number): AlignmentSample {
  const s = stationArcAt(station, along);
  return station.path.sampleAt(clamp(s, 0, station.path.length));
}

/** 局所座標をワールド座標に。`lift` は中心線からの高さ [m]。 */
export function stationPointOn(
  station: StationShape,
  along: number,
  across: number,
  lift = 0,
): Vector3 {
  const s = stationArcAt(station, along);
  const clamped = clamp(s, 0, station.path.length);
  const sample = station.path.sampleAt(clamped);
  // はみ出した分は端の接線に沿って伸ばす。
  const over = s - clamped;
  return new Vector3(
    sample.pos.x + sample.forwardXZ.x * over + sample.right.x * across,
    sample.pos.y + lift,
    sample.pos.z + sample.forwardXZ.y * over + sample.right.z * across,
  );
}

/** ワールド座標を局所座標に。駅の外なら `along` が範囲外の値で返る。 */
export function stationLocal(
  station: StationShape,
  x: number,
  z: number,
): { along: number; across: number } {
  const s = stationOf(station.path, x, z);
  const sample = station.path.sampleAt(s);
  const dx = x - sample.pos.x;
  const dz = z - sample.pos.z;
  // 端に貼り付いた投影 (駅の前後を指したとき) は、接線方向のはみ出しを足す。
  const over = dx * sample.forwardXZ.x + dz * sample.forwardXZ.y;
  return {
    along: stationAlongAt(station, s) + over,
    across: dx * sample.right.x + dz * sample.right.z,
  };
}

/**
 * 敷地の外周 (中心線に沿った多角形)。
 *
 * 整地・プレビュー・当たり判定が使う。直線の駅では 4 隅の矩形と同じ形になる。
 * `drop` は中心線から下げる量で、`0` なら路面と同じ高さ。
 */
export function stationOutline(station: StationArea, margin = 0, drop = 0): Vector3[] {
  const half = station.length / 2 + margin;
  const steps = Math.max(1, Math.ceil(station.path.length / OUTLINE_STEP));
  const left: Vector3[] = [];
  const right: Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const along = -half + (i / steps) * half * 2;
    left.push(stationPointOn(station, along, station.minOffset - margin, -drop));
    right.push(stationPointOn(station, along, station.maxOffset + margin, -drop));
  }
  return [...left, ...right.reverse()];
}

/** 外周を刻む間隔 [m]。曲線の駅でも敷地の縁が折れて見えない程度に細かく。 */
const OUTLINE_STEP = 10;

/**
 * その地点を覆っている駅。
 *
 * 駅は線路・ホーム・駅舎をまとめた 1 つの敷地 (`length` × `minOffset`〜
 * `maxOffset`) なので、ホームを指してもその外の構内を指しても同じ駅が返る。
 * 高さは見ない (高架駅ではカーソルが下の地面に当たるため)。重なっていたら
 * 中心にいちばん近いものを返す。
 */
export function stationAt(
  stations: Iterable<Station>,
  x: number,
  z: number,
  margin = 0,
): Station | null {
  let best: Station | null = null;
  let bestScore = Infinity;
  for (const station of stations) {
    const { along, across } = stationLocal(station, x, z);
    const half = station.length / 2 + margin;
    if (Math.abs(along) > half) continue;
    if (across < station.minOffset - margin || across > station.maxOffset + margin) continue;
    const score = Math.abs(along) / half + Math.abs(across);
    if (score < bestScore) {
      bestScore = score;
      best = station;
    }
  }
  return best;
}

/**
 * 空き地に置く駅の中心線。`center` を通る、長さ `length` の水平な直線。
 *
 * 既設の線路に置く駅の中心線は `network/stationRetrofit.ts` が線路から作る。
 */
export function straightStationPath(
  spec: Pick<StationSpec, 'center' | 'heading' | 'length'>,
): Alignment {
  const forward = new Vector2(Math.cos(spec.heading), Math.sin(spec.heading));
  const mid = new Vector2(spec.center.x, spec.center.z);
  const a = mid.clone().addScaledVector(forward, -spec.length / 2);
  const b = mid.clone().addScaledVector(forward, spec.length / 2);
  return new Alignment(
    HorizontalCurve.straight(a, b),
    new VerticalProfile(spec.center.y, spec.center.y, 0, 0, spec.length),
  );
}
