import { Vector3 } from 'three';
import { clamp } from '../../core/units';
import {
  ZONE_CELL,
  ZONE_DEPTH,
  ZONE_MAX_DROP,
  ZONE_MAX_RISE,
  ZONE_SETBACK,
  positionHash,
  type BuildingLot,
  type ZoneType,
} from '../../network/zoning';
import { fbm } from '../hydro/grid';
import type { Heightfield } from '../heightfield';
import type { Town } from './site';

/**
 * 町の街路と敷地。
 *
 * **描くときも、実際の道路として敷くときも、同じ折れ線を使う。** そうしないと
 * 町に近づいた瞬間に街路が動く。だから決めごとはすべて位置と自然地形
 * (`baseHeightAt`) だけから引く — 整地後の地形を見ると、プレイヤーが近くを
 * 敷いただけで町の形が変わってしまう。
 *
 * 敷地は街区を割るのではなく、**街路沿いに 2 列**取る。既存の区画
 * (`src/network/zoning.ts`) がそうしているので、同じ規則にしておけば、
 * 描いた町と実際の道路になった町で建ち方が揃う。
 */

/** 街区の大きさ [m]。 */
const BLOCK_ALONG = 80;
const BLOCK_ACROSS = 55;
/** 街路の敷地幅 [m] (車道 + 歩道)。 */
const LOCAL_ROW = 8;
const COLLECTOR_ROW = 12;
/** 縁石まで [m]。車道はこのぶん内側。 */
const KERB = 1.5;
/** 格子の間隔 [m]。 */
const PITCH_U = BLOCK_ALONG + LOCAL_ROW;
const PITCH_V = BLOCK_ACROSS + COLLECTOR_ROW;
/** 1 本の街路として認める最小の長さ [m]。 */
const MIN_RUN = 60;
/** 格子を方眼紙に見せないための歪み [m] と、その波長 [m]。 */
const WARP = 6;
const WARP_SPAN = 360;
/** 街路として許す縦断勾配。road_small の規格 (18%) より十分緩く取る。 */
const MAX_STREET_GRADE = 0.1;
/** 市街地の広がり [m] (格ごと)。 */
const EXTENT: Record<Town['kind'], number> = { city: 420, town: 280, village: 150 };
/** 密度の重み。 */
const WEIGHT: Record<Town['kind'], number> = { city: 1, town: 0.62, village: 0.34 };
/** 敷地の数の上限 (格ごと)。中心から順に埋める。 */
const MAX_LOTS: Record<Town['kind'], number> = { city: 800, town: 400, village: 220 };

export interface TownStreet {
  /** 中心線 (地表高は入っていない)。 */
  points: Vector3[];
  /** 車道の半幅 [m]。 */
  halfWidth: number;
  kind: 'collector' | 'local';
}

/** 敷地の平面 (高さは描くときに地形から決める)。 */
export interface TownLot {
  zone: ZoneType;
  center: Vector3;
  along: Vector3;
  outward: Vector3;
  halfFrontage: number;
  depth: number;
}

export interface TownPlan {
  town: Town;
  streets: TownStreet[];
  lots: TownLot[];
  /** 市街地の広がり [m]。 */
  extent: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** 町 1 つぶんの街路と敷地を組む。位置と自然地形だけから決まる。 */
export function planTown(town: Town, field: Heightfield): TownPlan {
  const extent = EXTENT[town.kind] * (0.8 + 0.4 * town.development);
  const angle = streetAngle(town, field);
  const ux = Math.cos(angle);
  const uz = Math.sin(angle);
  const seed = positionHash(town.x, town.z);

  /** 格子座標 → ワールド座標。歪みはワールド座標だけの関数なので、
   *  縦横の線は必ず同じ格子点で交わる。 */
  const place = (u: number, v: number, out = new Vector3()): Vector3 => {
    const x = town.x + ux * u - uz * v;
    const z = town.z + uz * u + ux * v;
    const wx = fbm(x / WARP_SPAN, z / WARP_SPAN, seed + 4021, 2) * WARP;
    const wz = fbm(x / WARP_SPAN, z / WARP_SPAN, seed + 4099, 2) * WARP;
    return out.set(x + wx, 0, z + wz);
  };

  const intensityAt = (u: number, v: number): number => {
    const d = Math.hypot(u, v);
    const fill = clamp(Math.pow(clamp(1 - d / extent, 0, 1) / 0.55, 1.35), 0, 1);
    return fill * WEIGHT[town.kind];
  };
  /** 密度が薄い所は線を間引く。 */
  const stepFor = (intensity: number): number => (intensity >= 0.75 ? 1 : intensity >= 0.34 ? 2 : 3);

  const halfU = Math.ceil(extent / PITCH_U);
  const halfV = Math.ceil(extent / PITCH_V);
  const streets: TownStreet[] = [];

  // 格子点をちょうど踏むよう、間隔の半分ずつ標本を採る。縦横の線が
  // 同じ点を共有するので、実際の道路として敷いたときに交差点になる。
  collectRuns(streets, field, halfV, halfU, PITCH_V, PITCH_U, COLLECTOR_ROW, 'collector', place, intensityAt, stepFor, true);
  collectRuns(streets, field, halfU, halfV, PITCH_U, PITCH_V, LOCAL_ROW, 'local', place, intensityAt, stepFor, false);

  const lots = planLots(town, streets, field, intensityAt, seed);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const street of streets) {
    for (const p of street.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  if (minX > maxX) {
    minX = maxX = town.x;
    minZ = maxZ = town.z;
  }
  return { town, streets, lots, extent, bounds: { minX, maxX, minZ, maxZ } };
}

/**
 * 街路の向き。
 *
 * 等高線に沿わせる。斜面を横切る街路は切土・盛土が深くなり、実際の道路に
 * したときに町ごと段々畑になる。傾きが無い所では町ごとの位置ハッシュに戻す。
 */
function streetAngle(town: Town, field: Heightfield): number {
  const d = 40;
  const gx = field.baseHeightAt(town.x + d, town.z) - field.baseHeightAt(town.x - d, town.z);
  const gz = field.baseHeightAt(town.x, town.z + d) - field.baseHeightAt(town.x, town.z - d);
  if (Math.hypot(gx, gz) < 0.5) return town.angle;
  return Math.atan2(gx, -gz);
}

/** 1 方向の格子線を走査して、生きている連続部分を街路にする。 */
function collectRuns(
  out: TownStreet[],
  field: Heightfield,
  lineHalf: number,
  spanHalf: number,
  linePitch: number,
  spanPitch: number,
  row: number,
  kind: 'collector' | 'local',
  place: (u: number, v: number, out?: Vector3) => Vector3,
  intensityAt: (u: number, v: number) => number,
  stepFor: (intensity: number) => number,
  alongU: boolean,
): void {
  const halfWidth = (row - 2 * KERB) / 2;
  const step = spanPitch / 2;
  for (let line = -lineHalf; line <= lineHalf; line++) {
    const lineOffset = line * linePitch;
    // 線そのものを間引く。中心ほど細かい。
    if (line % stepFor(intensityAt(alongU ? 0 : lineOffset, alongU ? lineOffset : 0)) !== 0) continue;
    let run: Vector3[] = [];
    const flush = (): void => {
      if (run.length >= 2 && runLength(run) >= MIN_RUN) {
        out.push({ points: run, halfWidth, kind });
      }
      run = [];
    };
    let previous: Vector3 | null = null;
    for (let k = -spanHalf * 2; k <= spanHalf * 2; k++) {
      const span = k * step;
      const u = alongU ? span : lineOffset;
      const v = alongU ? lineOffset : span;
      if (intensityAt(u, v) <= 0.1) {
        flush();
        previous = null;
        continue;
      }
      const p = place(u, v);
      if (!buildableAt(field, p) || (previous && !gentleBetween(field, previous, p))) {
        flush();
        previous = null;
        continue;
      }
      // 折れ線に残すのは格子点だけ。間の点は通れるかを見るためだけに採る。
      // こうすると縦横の街路が必ず同じ点を共有し、実際の道路として敷いた
      // ときにそこが交差点になる。
      if (k % 2 === 0) run.push(p);
      previous = p;
    }
    flush();
  }
}

function runLength(points: Vector3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return total;
}

/** 街路を通せる地面か。水の上と盤外は通さない。 */
function buildableAt(field: Heightfield, p: Vector3): boolean {
  if (!field.contains(p.x, p.z)) return false;
  // 盤の縁ぎりぎりだと敷地が外へはみ出す。
  if (Math.min(p.x - field.worldMin, field.worldMax - p.x) < 40) return false;
  if (Math.min(p.z - field.worldMin, field.worldMax - p.z) < 40) return false;
  if (field.water?.isWater(p.x, p.z)) return false;
  return true;
}

/** 2 点の間が街路として通せる勾配か。 */
function gentleBetween(field: Heightfield, a: Vector3, b: Vector3): boolean {
  const run = Math.hypot(b.x - a.x, b.z - a.z);
  if (run < 1e-6) return true;
  const rise = Math.abs(field.baseHeightAt(b.x, b.z) - field.baseHeightAt(a.x, a.z));
  return rise / run <= MAX_STREET_GRADE;
}

/**
 * 街路沿いに敷地を並べる。
 *
 * 既存の区画と同じ規則 — 街路の縁から `ZONE_SETBACK` 空けて、奥行き
 * `ZONE_DEPTH` の帯を左右に 1 列ずつ。間口は 2〜3 マス。
 */
function planLots(
  town: Town,
  streets: TownStreet[],
  field: Heightfield,
  intensityAt: (u: number, v: number) => number,
  seed: number,
): TownLot[] {
  const budget = MAX_LOTS[town.kind];
  const candidates: { lot: TownLot; distance: number }[] = [];
  const along = new Vector3();
  const outward = new Vector3();

  for (const street of streets) {
    const points = street.points;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      if (span < ZONE_CELL) continue;
      along.set(b.x - a.x, 0, b.z - a.z).normalize();
      const count = Math.floor(span / ZONE_CELL);
      for (let k = 0; k < count; k++) {
        // 間口は 2 マス (16 m) か 3 マス (24 m)。
        const wide = 2 + (positionHash(a.x + along.x * k * ZONE_CELL, a.z + along.z * k * ZONE_CELL) % 2);
        if (k + wide > count) continue;
        const t = (k + wide / 2) * ZONE_CELL;
        const frontX = a.x + along.x * t;
        const frontZ = a.z + along.z * t;
        for (const side of [1, -1] as const) {
          outward.set(-along.z * side, 0, along.x * side);
          const depth = ZONE_DEPTH;
          const offset = street.halfWidth + ZONE_SETBACK + depth / 2;
          const cx = frontX + outward.x * offset;
          const cz = frontZ + outward.z * offset;
          const lot: TownLot = {
            zone: zoneAt(cx, cz, town, intensityAt, seed),
            center: new Vector3(cx, 0, cz),
            along: along.clone(),
            outward: outward.clone(),
            halfFrontage: (wide * ZONE_CELL) / 2,
            depth,
          };
          if (!lotFits(lot, field, streets)) continue;
          candidates.push({ lot, distance: Math.hypot(cx - town.x, cz - town.z) });
        }
        k += wide - 1;
      }
    }
  }
  // 中心から順に埋める。上限で切っても町の縁が欠けるだけで、芯は残る。
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, budget).map((c) => c.lot);
}

/** 用途。中心ほど商業、外れに少し工業。 */
function zoneAt(
  x: number,
  z: number,
  town: Town,
  intensityAt: (u: number, v: number) => number,
  seed: number,
): ZoneType {
  const d = Math.hypot(x - town.x, z - town.z);
  const intensity = intensityAt(d, 0);
  const roll = (positionHash(x, z) ^ seed) % 100;
  if (intensity >= 0.7) return 'commercial';
  if (intensity >= 0.34) return roll < 30 ? 'commercial' : 'residential';
  return roll < 10 ? 'industrial' : 'residential';
}

/** 敷地が置けるか。水・急な起伏・他の街路と重なる所は落とす。 */
function lotFits(lot: TownLot, field: Heightfield, streets: TownStreet[]): boolean {
  let lowY = Infinity;
  let highY = -Infinity;
  let frontY = -Infinity;
  for (const dAlong of [-1, 0, 1] as const) {
    for (const dOut of [-1, 1] as const) {
      const x = lot.center.x + lot.along.x * dAlong * lot.halfFrontage + lot.outward.x * (dOut * lot.depth) / 2;
      const z = lot.center.z + lot.along.z * dAlong * lot.halfFrontage + lot.outward.z * (dOut * lot.depth) / 2;
      if (!field.contains(x, z) || field.water?.isWater(x, z)) return false;
      const y = field.baseHeightAt(x, z);
      if (y < lowY) lowY = y;
      if (y > highY) highY = y;
      // 街路側の縁 (outward の逆) がいちばん高い所を床にする。
      if (dOut === -1 && y > frontY) frontY = y;
    }
  }
  if (highY - frontY > ZONE_MAX_RISE || frontY - lowY > ZONE_MAX_DROP) return false;
  // 別の街路に食い込んでいないか。自分が面している街路とは
  // `halfWidth + setback + depth/2` 離れているので、これには掛からない。
  for (const street of streets) {
    const limit = street.halfWidth + ZONE_SETBACK;
    for (let i = 0; i + 1 < street.points.length; i++) {
      if (distanceToSegment(lot.center, street.points[i], street.points[i + 1]) < limit) return false;
    }
  }
  return true;
}

function distanceToSegment(p: Vector3, a: Vector3, b: Vector3): number {
  const ex = b.x - a.x;
  const ez = b.z - a.z;
  const lengthSq = ex * ex + ez * ez;
  const t = lengthSq < 1e-9 ? 0 : clamp(((p.x - a.x) * ex + (p.z - a.z) * ez) / lengthSq, 0, 1);
  return Math.hypot(a.x + ex * t - p.x, a.z + ez * t - p.z);
}

/**
 * 平面の敷地に高さを入れて、建物を建てられる形にする。
 *
 * 高さだけは**描くときの地形** (`heightAt`) から採る。整地で地面が動いたら
 * 建物もそれに乗る。平面の側は自然地形だけで決まっているので動かない。
 */
export function toBuildingLot(lot: TownLot, ground: (x: number, z: number) => number): BuildingLot {
  let lowY = Infinity;
  let padY = -Infinity;
  for (const dAlong of [-1, 0, 1] as const) {
    for (const dOut of [-1, 0, 1] as const) {
      const x = lot.center.x + lot.along.x * dAlong * lot.halfFrontage + (lot.outward.x * dOut * lot.depth) / 2;
      const z = lot.center.z + lot.along.z * dAlong * lot.halfFrontage + (lot.outward.z * dOut * lot.depth) / 2;
      const y = ground(x, z);
      if (y < lowY) lowY = y;
      if (dOut === -1 && y > padY) padY = y;
    }
  }
  return {
    zone: lot.zone,
    center: new Vector3(lot.center.x, padY, lot.center.z),
    along: lot.along,
    outward: lot.outward,
    halfFrontage: lot.halfFrontage,
    depth: lot.depth,
    padY,
    lowY,
  };
}
