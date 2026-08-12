import type { Alignment } from '../core/alignment';
import {
  BRIDGE_THRESHOLD,
  DECK_THICKNESS,
  MIN_STRUCTURE_RUN,
  TUNNEL_THRESHOLD,
} from '../core/units';
import type { Heightfield } from '../terrain/heightfield';

export type StructureMode = 'ground' | 'bridge' | 'tunnel';

/** 同じ構造形式が続く区間。 */
export interface StructureRun {
  mode: StructureMode;
  /** 弧長の開始・終了 [m]。 */
  s0: number;
  s1: number;
}

/**
 * 線形と自然地形を比べて、区間ごとに「地表・高架・トンネル」を決める。
 *
 * 判定には整地前の `base` を使う。整地は地表区間にだけ効くので、
 * 判定 → 整地 の順に依存が一方向に流れ、循環しない。
 */
export function computeStructureProfile(
  alignment: Alignment,
  field: Heightfield,
  range: { s0: number; s1: number },
  step = 2,
): StructureRun[] {
  const s0 = Math.max(0, range.s0);
  const s1 = Math.min(alignment.length, range.s1);
  if (s1 - s0 < 1e-3) return [];

  const count = Math.max(2, Math.ceil((s1 - s0) / step) + 1);
  const stations: number[] = [];
  const modes: StructureMode[] = [];
  for (let i = 0; i < count; i++) {
    const s = s0 + ((s1 - s0) * i) / (count - 1);
    const p = alignment.sampleAt(s).pos;
    stations.push(s);
    modes.push(classify(p.y, field.baseHeightAt(p.x, p.z)));
  }

  let runs = encodeRuns(stations, modes);
  runs = mergeShortRuns(runs);
  return runs;
}

export function classify(roadY: number, terrainY: number): StructureMode {
  if (roadY - DECK_THICKNESS - terrainY > BRIDGE_THRESHOLD) return 'bridge';
  if (terrainY - roadY > TUNNEL_THRESHOLD) return 'tunnel';
  return 'ground';
}

function encodeRuns(stations: number[], modes: StructureMode[]): StructureRun[] {
  const runs: StructureRun[] = [];
  let startS = stations[0];
  let curMode = modes[0];
  for (let i = 1; i < modes.length; i++) {
    if (modes[i] !== curMode) {
      // 境界はサンプル間の中点に置く。
      const mid = (stations[i - 1] + stations[i]) / 2;
      runs.push({ mode: curMode, s0: startS, s1: mid });
      startS = mid;
      curMode = modes[i];
    }
  }
  runs.push({ mode: curMode, s0: startS, s1: stations[stations.length - 1] });
  return runs;
}

/**
 * 短すぎる区間を隣に吸収する。数メートルだけの橋やトンネルが
 * 大量にできるのを防ぎ、構造物の見た目を落ち着かせる。
 */
export function mergeShortRuns(input: StructureRun[], minLength = MIN_STRUCTURE_RUN): StructureRun[] {
  let runs = input.map((r) => ({ ...r }));
  for (let guard = 0; guard < 64; guard++) {
    if (runs.length <= 1) break;
    let worst = -1;
    let worstLen = minLength;
    for (let i = 0; i < runs.length; i++) {
      const len = runs[i].s1 - runs[i].s0;
      if (len < worstLen) {
        worstLen = len;
        worst = i;
      }
    }
    if (worst < 0) break;

    const prev = runs[worst - 1];
    const next = runs[worst + 1];
    if (!prev && !next) break;
    let mode: StructureMode;
    if (!prev) mode = next.mode;
    else if (!next) mode = prev.mode;
    else mode = next.s1 - next.s0 >= prev.s1 - prev.s0 ? next.mode : prev.mode;
    runs[worst].mode = mode;
    runs = coalesce(runs);
  }
  return runs;
}

function coalesce(runs: StructureRun[]): StructureRun[] {
  const out: StructureRun[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.mode === r.mode) last.s1 = r.s1;
    else out.push({ ...r });
  }
  return out;
}
