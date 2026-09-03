/**
 * 排水木から、源流から河口まで続く河道の曲線を切り出す。
 *
 * 水文格子の排水木は 8 近傍のラスタなので、川はセルの中心を 45 度刻みで
 * 結んだ折れ線になる。マスクからそのまま経路を取ると合流のたびに切れ、
 * 継ぎ目が折れる。ここで連続した曲線に直し、その曲線を**地形と水面の
 * 両方の唯一の基準**にする。
 *
 * 移植元 `src/river/network.ts` の移植 (1 単位 = 1 m に読み替え)。
 */
import { clamp, hash2 } from '../hydro/grid';
import type { HydroWorld } from '../hydro/types';
import { catmullRom, limitCurvature, resamplePath, type PathPoint } from './path';

export interface RiverPoint {
  x: number;
  z: number;
  widthM: number;
  depthM: number;
  /** 水面の高さ [m]。下流へ向かって単調に下がる。 */
  waterY: number;
}

export interface RiverStem {
  points: RiverPoint[];
  /** 0 = 海か盤外へ抜ける本流、1 = 支流。 */
  order: number;
}

export interface RiverNetwork {
  stems: RiverStem[];
  maxWidthM: number;
}

const SAMPLE_M = 15;
/** 実際の蛇行は川幅のおよそ 11 倍で 1 波、振れ幅は 2〜3 川幅。 */
const MEANDER_WAVELENGTH = 11;
const MEANDER_AMPLITUDE = 2.2;
/** 支流の河口を本流へ吸い付ける距離 [m]。 */
const SNAP_RADIUS = 160;

export function buildRiverNetwork(world: HydroWorld, relief: number, seaY = 0): RiverNetwork {
  const cellStems = traceStems(world);
  const stems: RiverStem[] = [];
  const finished = new Map<number, RiverPoint[]>();
  const bucketOf = (x: number, z: number): number =>
    Math.round(x / SNAP_RADIUS) * 65536 + Math.round(z / SNAP_RADIUS);
  let maxWidthM = 0;

  // 本流から。支流は親の**仕上がった**曲線に吸い付けるので、親が先に要る。
  for (const stem of cellStems.sort((a, b) => a.order - b.order)) {
    const points = shapeStem(world, stem.cells, relief, seaY, (x, z) =>
      nearbyPoints(finished, bucketOf, x, z),
    );
    if (points.length < 2) continue;
    for (const point of points) {
      if (point.widthM > maxWidthM) maxWidthM = point.widthM;
      const key = bucketOf(point.x, point.z);
      const bucket = finished.get(key);
      if (bucket) bucket.push(point);
      else finished.set(key, [point]);
    }
    stems.push({ points, order: stem.order });
  }
  return { stems, maxWidthM };
}

function nearbyPoints(
  finished: Map<number, RiverPoint[]>,
  bucketOf: (x: number, z: number) => number,
  x: number,
  z: number,
): RiverPoint[] {
  const out: RiverPoint[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = finished.get(bucketOf(x + dx * SNAP_RADIUS, z + dz * SNAP_RADIUS));
      if (bucket) out.push(...bucket);
    }
  }
  return out;
}

interface CellStem {
  cells: number[];
  order: number;
}

/**
 * 排水木を連続した流れに開く。河口から出発して常に流量の大きい枝へ登ると
 * 源流から河口までの本流が取れ、余りが支流になる。支流は既に取られた流れに
 * 合流するセルでちょうど終わる。
 */
function traceStems(world: HydroWorld): CellStem[] {
  const len = world.grid.len;
  const children: number[][] = [];
  const isRiver = (i: number): boolean => world.rivers[i] === 1 && !world.sea[i] && !world.lake[i];
  for (let i = 0; i < len; i++) {
    if (!isRiver(i)) continue;
    const parent = world.parent[i];
    if (parent < 0 || !isRiver(parent)) continue;
    (children[parent] ??= []).push(i);
  }

  const claimed = new Uint8Array(len);
  const stems: CellStem[] = [];

  /** `start` から源流まで、いつも大きい枝を採って登る。 */
  const climb = (start: number): number[] => {
    const up: number[] = [start];
    let current = start;
    for (;;) {
      const kids = children[current];
      if (!kids || !kids.length) break;
      let best = -1;
      let bestFlow = -1;
      for (const kid of kids) {
        if (claimed[kid]) continue;
        if (world.accumulation[kid] > bestFlow) {
          bestFlow = world.accumulation[kid];
          best = kid;
        }
      }
      if (best < 0) break;
      up.push(best);
      current = best;
    }
    return up.reverse();
  };

  // 河口は、水へ注ぐ川のセルか、盤外へ出るセル。Priority-Flood が
  // parent === -1 を書くのは海のセルと外周だけ。
  const mouths: number[] = [];
  for (let i = 0; i < len; i++) {
    if (!isRiver(i)) continue;
    const parent = world.parent[i];
    if (parent < 0 || world.sea[parent] || world.lake[parent]) mouths.push(i);
  }
  mouths.sort((a, b) => world.accumulation[b] - world.accumulation[a]);
  for (const mouth of mouths) {
    if (claimed[mouth]) continue;
    const cells = climb(mouth);
    for (const cell of cells) claimed[cell] = 1;
    if (cells.length >= 2) stems.push({ cells, order: 0 });
  }

  // 残りは支流。大きい順に採らないと、大きな枝が小さな枝にぶら下がる。
  const rest: number[] = [];
  for (let i = 0; i < len; i++) if (isRiver(i) && !claimed[i]) rest.push(i);
  rest.sort((a, b) => world.accumulation[b] - world.accumulation[a]);
  for (const seed of rest) {
    if (claimed[seed]) continue;
    const cells = climb(seed);
    for (const cell of cells) claimed[cell] = 1;
    // 合流点まで 1 セル伸ばして、注ぎ先に実際に届かせる。
    const parent = world.parent[cells[cells.length - 1]];
    if (parent >= 0 && isRiver(parent)) cells.push(parent);
    if (cells.length >= 2) stems.push({ cells, order: 1 });
  }
  return stems;
}

function shapeStem(
  world: HydroWorld,
  cells: number[],
  relief: number,
  seaY: number,
  nearby: (x: number, z: number) => RiverPoint[],
): RiverPoint[] {
  const { grid } = world;
  const n = grid.n;
  const threshold = world.riverThreshold;
  const flowAt = (i: number): number =>
    Number.isFinite(threshold) && threshold > 0
      ? clamp(Math.log1p(world.accumulation[i] / threshold) / 3.4)
      : 0;

  // 川幅の下限 14 m は「細すぎる河道は格子の間に落ちて刻まれず、水が地面に
  // 埋まる」ため。川と判定されるのは流量上位の数 % なので、いちばん小さい川が
  // 14 m というのは無理のない下限になる。
  const raw: PathPoint[] = cells.map((i) => ({
    x: grid.worldAt(i % n),
    z: grid.worldAt((i / n) | 0),
    w: 14 + flowAt(i) * 62,
  }));
  const depths = cells.map((i) => 2 + flowAt(i) * 5);
  // world.terrain と world.filled は同じ配列なので、これは素の地面の高さ。
  // 河道はこの下に刻む (上に浮かせるのではない)。
  const levels = cells.map((i) => Math.max(seaY, (world.filled[i] - world.seaLevel) * relief));

  const base = catmullRom(resamplePath(raw, SAMPLE_M), SAMPLE_M);
  if (base.length < 3) return [];

  // 再標本化で点の数が変わるので、水深と水面は弧長の割合で持ち越す。
  const attr = alignAttributes(raw, base, depths, levels);
  const gates = meanderGate(world, base);
  const meandered = applyMeander(base, gates, world.params.seed);
  const smoothed = catmullRom(limitCurvature(meandered, medianWidth(meandered) * 1.5, 48), SAMPLE_M);

  const points: RiverPoint[] = [];
  for (let k = 0; k < smoothed.length; k++) {
    const t = smoothed.length === 1 ? 0 : k / (smoothed.length - 1);
    const source = Math.min(attr.depth.length - 1, Math.round(t * (attr.depth.length - 1)));
    points.push({
      x: smoothed[k].x,
      z: smoothed[k].z,
      widthM: smoothed[k].w,
      depthM: attr.depth[source],
      waterY: attr.level[source],
    });
  }
  smoothLevels(points);
  snapToParent(points, nearby);
  // 吸い付けで河口は合流先に固定されたので、そこが動かせない高さになる。
  // それより下がってしまった上流を持ち上げる (合流点を引き下げない)。
  for (let k = points.length - 2; k >= 0; k--) {
    points[k].waterY = Math.max(points[k].waterY, points[k + 1].waterY);
  }
  return points;
}

/** 再標本化で点の数が変わるので、セルごとの値を弧長の割合で運ぶ。 */
function alignAttributes(
  raw: PathPoint[],
  base: PathPoint[],
  depths: number[],
  levels: number[],
): { depth: number[]; level: number[] } {
  const depth: number[] = [];
  const level: number[] = [];
  for (let k = 0; k < base.length; k++) {
    const t = base.length === 1 ? 0 : k / (base.length - 1);
    const index = Math.min(raw.length - 1, Math.round(t * (raw.length - 1)));
    depth.push(depths[index]);
    level.push(levels[index]);
  }
  return { depth, level };
}

const medianWidth = (points: PathPoint[]): number => {
  const widths = points.map((p) => p.w).sort((a, b) => a - b);
  return widths[widths.length >> 1] || 10;
};

/**
 * 川が振れるのは、振れる余地のある所だけ。氾濫原では開き、急な谷では閉じ、
 * 両端では 0 に落として合流点を動かさない。
 */
function meanderGate(world: HydroWorld, points: PathPoint[]): number[] {
  const { grid } = world;
  const n = grid.n;
  const gates: number[] = [];
  for (const point of points) {
    const x = Math.min(n - 1, Math.max(0, Math.round(grid.cellAt(point.x))));
    const y = Math.min(n - 1, Math.max(0, Math.round(grid.cellAt(point.z))));
    const i = y * n + x;
    const flat = clamp(1 - world.slope[i] / 0.014);
    const lf = world.landform[i];
    const plain = lf === 1 || lf === 3 ? 1 : lf === 2 ? 0.6 : 0.35;
    gates.push(flat * plain);
  }
  const taper = Math.min(12, Math.floor(gates.length / 3));
  for (let k = 0; k < taper; k++) {
    const ramp = k / taper;
    gates[k] *= ramp;
    gates[gates.length - 1 - k] *= ramp;
  }
  return gates;
}

function applyMeander(points: PathPoint[], gates: number[], seed: number): PathPoint[] {
  const phase = hash2(Math.round(points[0].x), Math.round(points[0].z), seed + 9311) * Math.PI * 2;
  const phase2 = hash2(Math.round(points[0].z), Math.round(points[0].x), seed + 9319) * Math.PI * 2;
  const out: PathPoint[] = [];
  let arc = 0;
  for (let k = 0; k < points.length; k++) {
    const point = points[k];
    if (k > 0) arc += Math.hypot(point.x - points[k - 1].x, point.z - points[k - 1].z);
    const previous = points[Math.max(0, k - 1)];
    const next = points[Math.min(points.length - 1, k + 1)];
    let tx = next.x - previous.x;
    let tz = next.z - previous.z;
    const length = Math.hypot(tx, tz) || 1;
    tx /= length;
    tz /= length;
    const width = Math.max(point.w, 8);
    const swing =
      MEANDER_AMPLITUDE * Math.sin((arc / (MEANDER_WAVELENGTH * width)) * Math.PI * 2 + phase) +
      0.7 * Math.sin((arc / (4.5 * width)) * Math.PI * 2 + phase2);
    const offset = gates[k] * width * swing;
    out.push({ x: point.x + -tz * offset, z: point.z + tx * offset, w: point.w });
  }
  return out;
}

/** 水面は滑らかで、下流に向かって登らない。 */
function smoothLevels(points: RiverPoint[]): void {
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 1; k < points.length - 1; k++) {
      points[k].waterY = (points[k - 1].waterY + points[k].waterY * 2 + points[k + 1].waterY) * 0.25;
    }
  }
  for (let k = 1; k < points.length; k++) {
    points[k].waterY = Math.min(points[k].waterY, points[k - 1].waterY);
  }
}

/**
 * 本流は蛇行で動いたので、もとのラスタで作った支流はそのままだと宙に浮く。
 * 末尾をいちばん近い仕上がりの曲線へ引き寄せ、その補正を上流へ薄めながら返す。
 */
function snapToParent(points: RiverPoint[], nearby: (x: number, z: number) => RiverPoint[]): void {
  const tail = points[points.length - 1];
  let best: RiverPoint | null = null;
  let bestDistance = Infinity;
  for (const candidate of nearby(tail.x, tail.z)) {
    const d = Math.hypot(candidate.x - tail.x, candidate.z - tail.z);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  if (!best || bestDistance > SNAP_RADIUS) return;
  const dx = best.x - tail.x;
  const dz = best.z - tail.z;
  const reach = Math.min(points.length, 24);
  for (let k = 0; k < reach; k++) {
    const index = points.length - 1 - k;
    const weight = 1 - k / reach;
    points[index].x += dx * weight;
    points[index].z += dz * weight;
  }
  tail.waterY = best.waterY;
}
