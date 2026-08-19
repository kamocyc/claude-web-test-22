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
  /** 路面と自然地形の高低差 (正 = 路面が上)。 */
  const rise: number[] = [];
  for (let i = 0; i < count; i++) {
    const s = s0 + ((s1 - s0) * i) / (count - 1);
    const p = alignment.sampleAt(s).pos;
    const terrain = field.baseHeightAt(p.x, p.z);
    stations.push(s);
    modes.push(classify(p.y, terrain));
    rise.push(p.y - terrain);
  }

  /**
   * 短くても地表に戻してはいけない区間か。
   *
   * 高低差が大きい所を地表にすると、盛土・切土で処理するしかなくなる。
   * 路端の垂れ壁は 8 m しか下りないし、隣に別の線形があると法面を作る
   * 場所も無いので、路面の下に穴が開く。深い所は短くても橋・トンネルの
   * ままにする。
   */
  const strong = (run: StructureRun): boolean => {
    if (run.mode === 'ground') return false;
    let extreme = 0;
    for (let i = 0; i < stations.length; i++) {
      if (stations[i] < run.s0 - 1e-6 || stations[i] > run.s1 + 1e-6) continue;
      extreme = Math.max(extreme, run.mode === 'bridge' ? rise[i] : -rise[i]);
    }
    const limit = run.mode === 'bridge' ? BRIDGE_THRESHOLD : TUNNEL_THRESHOLD;
    return extreme > limit + DEEP_MARGIN;
  };

  return mergeShortRuns(encodeRuns(stations, modes), MIN_STRUCTURE_RUN, strong);
}

/** 短い区間でも構造物のままにする高低差の余裕 [m]。 */
const DEEP_MARGIN = 2;

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
export function mergeShortRuns(
  input: StructureRun[],
  minLength = MIN_STRUCTURE_RUN,
  /** true を返した区間は、短くても吸収しない。 */
  keep?: (run: StructureRun) => boolean,
): StructureRun[] {
  let runs = input.map((r) => ({ ...r }));
  for (let guard = 0; guard < 64; guard++) {
    if (runs.length <= 1) break;
    let worst = -1;
    let worstLen = minLength;
    for (let i = 0; i < runs.length; i++) {
      const len = runs[i].s1 - runs[i].s0;
      if (len < worstLen && !keep?.(runs[i])) {
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
 * 交差点の口に坑門・橋台が食い込まないようにする。
 *
 * 短い区間の吸収 (`mergeShortRuns`) は、交差点の手前に残った数十 m の
 * 地表区間をトンネル・橋に飲み込むことがある。飲み込まれた区間の端は
 * 交差点の口そのものなので、そこに坑門を建てると柱が交差点の中に立ち、
 * 曲がってきた車が壁にぶつかる。
 *
 * そこで、交差点に接する端から内側へ「地形の上では地表」の区間が続く
 * 限り、その分を地表に戻す。戻せる分が無い (本当にトンネルの中に交差点が
 * ある) 配置は敷設規則の側で止める。
 */
export function clearStructureAtJunction(
  alignment: Alignment,
  field: Heightfield,
  runs: StructureRun[],
  range: { s0: number; s1: number },
  ends: { start: boolean; end: boolean },
  reach = MIN_STRUCTURE_RUN,
  step = 1,
): StructureRun[] {
  let out = runs;
  /** 端から内側へ、地表のまま進める距離。 */
  const groundRun = (from: number, direction: 1 | -1): number => {
    let distance = 0;
    for (let d = 0; d <= reach; d += step) {
      const s = from + direction * d;
      if (s < range.s0 - 1e-6 || s > range.s1 + 1e-6) break;
      const p = alignment.sampleAt(s).pos;
      if (classify(p.y, field.baseHeightAt(p.x, p.z)) !== 'ground') break;
      distance = d;
    }
    return distance;
  };

  if (ends.start && modeAt(out, range.s0) !== 'ground') {
    const length = groundRun(range.s0, 1);
    if (length > 0.5) out = forceRunMode(out, range.s0, range.s0 + length, 'ground');
  }
  if (ends.end && modeAt(out, range.s1) !== 'ground') {
    const length = groundRun(range.s1, -1);
    if (length > 0.5) out = forceRunMode(out, range.s1 - length, range.s1, 'ground');
  }
  return out;
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
