import { Vector3 } from 'three';
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
  /** Offset from the station centre line; positive is heading-left. */
  offset: number;
  /** Whether the segment runs in the station heading direction. */
  forward: boolean;
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
      tracks.push({ index: trackIndex, offset: item.offset, forward: trackIndex % 2 === 0 });
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
