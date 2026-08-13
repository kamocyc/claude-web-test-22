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

/** 平行に並んだ線形 1 本ぶんの、区間を揃えるための情報。 */
export interface ParallelRuns {
  alignment: Alignment;
  runs: StructureRun[];
  range: { s0: number; s1: number };
}

/** 強い構造形式が勝つ (並んだ線のどれかが橋なら、みんな橋にする)。 */
const MODE_RANK: Record<StructureMode, number> = { ground: 0, bridge: 1, tunnel: 2 };

/**
 * 平行に並んだ線形の構造形式を揃える。
 *
 * 並んだ線はそれぞれ独立に地形と比べて区間を決めるので、同じ谷を渡って
 * いても橋の始まりが数 m ずれる。実物の複線ではありえない見え方なので、
 * **同じ断面の所は同じ構造形式**になるよう、いちばん強い形式に揃える。
 * 揃えた結果、桁・坑門が横に並んで 1 つの構造物に見える。
 */
export function unifyParallelRuns(
  members: ParallelRuns[],
  step = 2,
): StructureRun[][] {
  if (members.length < 2) return members.map((m) => m.runs);

  // 相手の弧長を引くための折れ線。曲線でも数 cm の精度で足りる。
  const traces = members.map((member) => {
    const points: { s: number; x: number; z: number }[] = [];
    const n = Math.max(1, Math.ceil((member.range.s1 - member.range.s0) / step));
    for (let i = 0; i <= n; i++) {
      const s = member.range.s0 + ((member.range.s1 - member.range.s0) * i) / n;
      const p = member.alignment.sampleAt(s).pos;
      points.push({ s, x: p.x, z: p.z });
    }
    return points;
  });

  return members.map((member, index) => {
    const stations: number[] = [];
    const modes: StructureMode[] = [];
    for (const point of traces[index]) {
      let mode = modeAt(member.runs, point.s);
      for (let other = 0; other < members.length; other++) {
        if (other === index) continue;
        const near = nearest(traces[other], point.x, point.z);
        // 相手が並んでいない所 (端の外) までは揃えない。
        if (!near) continue;
        const theirs = modeAt(members[other].runs, near);
        if (MODE_RANK[theirs] > MODE_RANK[mode]) mode = theirs;
      }
      stations.push(point.s);
      modes.push(mode);
    }
    if (stations.length < 2) return member.runs;
    return mergeShortRuns(encodeRuns(stations, modes));
  });
}

/** 折れ線上でいちばん近い点の弧長。端で折り返していれば null。 */
function nearest(
  points: { s: number; x: number; z: number }[],
  x: number,
  z: number,
): number | null {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i].x - x) ** 2 + (points[i].z - z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  if (best < 0) return null;
  if (best === 0 || best === points.length - 1) {
    // 端の点がいちばん近いのは、そこから先は並んでいないという意味。
    // 真横にある (並んでいる) ときだけ採る。
    const neighbour = points[best === 0 ? 1 : points.length - 2];
    const dx = points[best].x - x;
    const dz = points[best].z - z;
    const ux = neighbour.x - points[best].x;
    const uz = neighbour.z - points[best].z;
    const len = Math.hypot(ux, uz);
    if (len > 1e-6 && Math.abs((dx * ux + dz * uz) / len) > 2) return null;
  }
  return points[best].s;
}

/** その弧長がどの構造形式の区間に入るか。区間の外は地表とみなす。 */
export function modeAt(runs: StructureRun[], s: number): StructureMode {
  for (const run of runs) {
    if (s >= run.s0 && s <= run.s1) return run.mode;
  }
  return 'ground';
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

/**
 * 指定した弧長の範囲を、強制的にある構造形式にする。
 *
 * 立体交差の上側は、盛土の高さに満たなくても橋にしないと、下をくぐる
 * 線形が盛土に埋まってしまう。そうした「地形との高低差では決まらない」
 * 事情を後から反映するために使う。
 */
export function forceRunMode(
  runs: StructureRun[],
  s0: number,
  s1: number,
  mode: StructureMode,
): StructureRun[] {
  if (s1 <= s0) return runs;
  const out: StructureRun[] = [];
  for (const run of runs) {
    if (run.s1 <= s0 || run.s0 >= s1) {
      out.push({ ...run });
      continue;
    }
    if (run.s0 < s0) out.push({ mode: run.mode, s0: run.s0, s1: s0 });
    out.push({ mode, s0: Math.max(run.s0, s0), s1: Math.min(run.s1, s1) });
    if (run.s1 > s1) out.push({ mode: run.mode, s0: s1, s1: run.s1 });
  }
  return coalesce(out).filter((r) => r.s1 - r.s0 > 1e-6);
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
