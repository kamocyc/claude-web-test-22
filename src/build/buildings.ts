import { Vector3 } from 'three';
import type { MeshBuilder } from '../core/meshbuilder';
import type { Lot, ZoneType } from '../network/zoning';
import { addBox } from './primitives';
import type { RGB } from './surface';

/**
 * 区画に建つ建物と、区画そのものの表示。
 *
 * 建物は用途ごとに決まった組み立て方 (壁 → 屋根 → 付属) で作り、寸法と色は
 * 区画の位置から決めた擬似乱数で振る。同じ区画からは必ず同じ建物ができるので、
 * 道路を編集して作り直しても、関係ない所の街並みは変わらない。
 */

/** 区画の表示色 (用途ごと)。 */
export const ZONE_COLORS: Record<ZoneType, RGB> = {
  residential: [0.36, 0.72, 0.4],
  commercial: [0.32, 0.6, 0.92],
  industrial: [0.92, 0.7, 0.3],
};

/** 用途を塗っていない区画の表示色。 */
export const ZONE_EMPTY_COLOR: RGB = [0.72, 0.78, 0.86];

/** 建てられない区画 (斜面など) の表示色。 */
export const ZONE_BLOCKED_COLOR: RGB = [0.5, 0.3, 0.3];

/** 区画の縁に空ける隙間 [m]。マス目に見えるようにする。 */
const GRID_GAP = 0.45;

/** 区画の表示を地表から浮かせる量 [m]。 */
const GRID_LIFT = 0.06;

/** 道路側に空ける前庭の奥行き [m] (用途ごと)。 */
const FRONT_YARD: Record<ZoneType, number> = {
  residential: 3.4,
  commercial: 1.6,
  industrial: 2.6,
};

/** 隣地との離れ [m]。間口いっぱいには建てない。 */
const SIDE_GAP = 2.2;

/** 建物の奥に残す空き [m]。 */
const BACK_GAP = 2.0;

const ROOF_COLORS: RGB[] = [
  [0.32, 0.3, 0.34],
  [0.4, 0.24, 0.22],
  [0.24, 0.31, 0.4],
  [0.36, 0.36, 0.33],
];

const HOUSE_COLORS: RGB[] = [
  [0.86, 0.84, 0.78],
  [0.8, 0.78, 0.72],
  [0.74, 0.68, 0.6],
  [0.86, 0.8, 0.7],
  [0.7, 0.74, 0.72],
];

const OFFICE_COLORS: RGB[] = [
  [0.68, 0.72, 0.76],
  [0.58, 0.64, 0.7],
  [0.74, 0.72, 0.68],
  [0.6, 0.66, 0.62],
];

const GLASS: RGB = [0.28, 0.42, 0.5];
const CONCRETE: RGB = [0.62, 0.61, 0.58];
const STEEL: RGB = [0.55, 0.57, 0.58];
const FOUNDATION: RGB = [0.46, 0.45, 0.43];

/** 整地後の地形の高さを引く関数。 */
export type GroundQuery = (x: number, z: number) => number;

/**
 * 区画のマス目を地表に描く。
 *
 * 用途が塗ってあれば用途の色、空いていれば薄い色。区画ツールを使っている
 * 間だけ表示する。
 */
export function buildZoneGrid(mb: MeshBuilder, lots: Lot[], ground: GroundQuery): void {
  const up = new Vector3(0, 1, 0);
  for (const lot of lots) {
    const color = !lot.buildable
      ? ZONE_BLOCKED_COLOR
      : lot.zone
        ? ZONE_COLORS[lot.zone]
        : ZONE_EMPTY_COLOR;
    const halfAlong = lot.halfFrontage - GRID_GAP;
    const front = GRID_GAP;
    const back = lot.depth - GRID_GAP;
    const origin = lot.center.clone().addScaledVector(lot.outward, -lot.depth / 2);
    const corners = [
      offsetPoint(origin, lot, -halfAlong, front),
      offsetPoint(origin, lot, halfAlong, front),
      offsetPoint(origin, lot, halfAlong, back),
      offsetPoint(origin, lot, -halfAlong, back),
    ];
    const base = mb.vertexCount;
    for (const corner of corners) {
      corner.y = ground(corner.x, corner.z) + GRID_LIFT;
      mb.vertex(corner, up, 0, 0, color);
    }
    mb.quad(base, base + 1, base + 2, base + 3);
  }
}

function offsetPoint(origin: Vector3, lot: Lot, along: number, out: number): Vector3 {
  return origin.clone().addScaledVector(lot.along, along).addScaledVector(lot.outward, out);
}

/**
 * 区画に建物を建てる。
 *
 * 足元は footprint の四隅で地形がいちばん高い所に合わせ、そこから基礎を
 * 地面まで下ろす。傾いた土地でも建物が浮いたり埋まったりしない。
 */
export function buildBuilding(mb: MeshBuilder, lot: Lot, ground: GroundQuery): void {
  if (!lot.zone || !lot.buildable) return;
  const rand = mulberry32(hashLot(lot));
  const zone = lot.zone;

  const halfAlong = Math.max(2, lot.halfFrontage - SIDE_GAP);
  const yard = FRONT_YARD[zone];
  const depth = Math.max(4, lot.depth - yard - BACK_GAP);
  const halfDepth = depth / 2;

  // 前庭のぶん奥に寄せた footprint の中心。
  const center = lot.center
    .clone()
    .addScaledVector(lot.outward, -lot.depth / 2 + yard + halfDepth);

  const corners = [
    footprintCorner(center, lot, -halfAlong, -halfDepth),
    footprintCorner(center, lot, halfAlong, -halfDepth),
    footprintCorner(center, lot, halfAlong, halfDepth),
    footprintCorner(center, lot, -halfAlong, halfDepth),
  ];
  let padY = -Infinity;
  let lowY = Infinity;
  for (const corner of corners) {
    const y = ground(corner.x, corner.z);
    if (y > padY) padY = y;
    if (y < lowY) lowY = y;
  }

  // 基礎。足元の高さから、いちばん低い隅の少し下まで。
  const footing = Math.max(0.35, padY - lowY + 0.4);
  addBox(
    mb,
    new Vector3(center.x, padY - footing / 2, center.z),
    lot.along,
    UP,
    lot.outward,
    { x: halfAlong + 0.25, y: footing / 2, z: halfDepth + 0.25 },
    FOUNDATION,
  );

  const base = new Vector3(center.x, padY, center.z);
  if (zone === 'residential') buildHouse(mb, lot, base, halfAlong, halfDepth, rand);
  else if (zone === 'commercial') buildShop(mb, lot, base, halfAlong, halfDepth, rand);
  else buildFactory(mb, lot, base, halfAlong, halfDepth, rand);
}

const UP = new Vector3(0, 1, 0);

function footprintCorner(center: Vector3, lot: Lot, along: number, out: number): Vector3 {
  return center.clone().addScaledVector(lot.along, along).addScaledVector(lot.outward, out);
}

/** 住宅。1〜2 階の切妻屋根で、道路側に玄関ポーチを付ける。 */
function buildHouse(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const floors = rand() < 0.45 ? 1 : 2;
  const wall = floors * 2.85;
  const wallColor = pick(HOUSE_COLORS, rand);
  const roofColor = pick(ROOF_COLORS, rand);
  // 間口いっぱいには建てず、庭を残す。
  const hx = halfAlong * (0.72 + rand() * 0.18);
  const hz = halfDepth * (0.78 + rand() * 0.16);

  addBox(
    mb,
    base.clone().addScaledVector(UP, wall / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: wall / 2, z: hz },
    wallColor,
  );
  addGableRoof(
    mb,
    base.clone().addScaledVector(UP, wall),
    lot,
    hx + 0.45,
    hz + 0.45,
    1.6 + rand() * 0.8,
    roofColor,
  );

  // 玄関ポーチ (道路側)。小さくても向きが分かる。
  const porchDepth = 1.1;
  addBox(
    mb,
    base
      .clone()
      .addScaledVector(UP, 1.15)
      .addScaledVector(lot.outward, -(hz + porchDepth / 2))
      .addScaledVector(lot.along, hx * (rand() < 0.5 ? -0.4 : 0.4)),
    lot.along,
    UP,
    lot.outward,
    { x: 1.2, y: 1.15, z: porchDepth / 2 },
    wallColor,
  );
}

/** 商業。低層の店舗ビル。1 階は間口いっぱいの店先、上に事務所が載る。 */
function buildShop(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const floors = 2 + Math.floor(rand() * 3);
  const floorHeight = 3.5;
  const shop = 3.9;
  const upper = (floors - 1) * floorHeight;
  const wallColor = pick(OFFICE_COLORS, rand);
  const hx = halfAlong * (0.9 + rand() * 0.08);
  const hz = halfDepth * (0.86 + rand() * 0.12);

  // 1 階 (店先)。ガラス張りに見えるよう暗い色にする。
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: shop / 2, z: hz },
    GLASS,
  );
  // 店先の上の看板帯。
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop + 0.35).addScaledVector(lot.outward, -hz),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: 0.55, z: 0.22 },
    pick(ZONE_COLOR_LIST, rand),
  );
  // 上階。
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop + upper / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.98, y: upper / 2, z: hz * 0.98 },
    wallColor,
  );
  // パラペットと塔屋。
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop + upper + 0.3),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: 0.3, z: hz },
    CONCRETE,
  );
  addBox(
    mb,
    base.clone().addScaledVector(UP, shop + upper + 1.6),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.3, y: 1.3, z: hz * 0.3 },
    CONCRETE,
  );
}

/** 工業。平屋の大きな建屋に、屋根の越屋根と煙突を載せる。 */
function buildFactory(
  mb: MeshBuilder,
  lot: Lot,
  base: Vector3,
  halfAlong: number,
  halfDepth: number,
  rand: () => number,
): void {
  const height = 6.5 + rand() * 2.5;
  const hx = halfAlong * (0.94 + rand() * 0.05);
  const hz = halfDepth * (0.9 + rand() * 0.08);
  const wallColor: RGB = [0.62, 0.63, 0.6];

  addBox(
    mb,
    base.clone().addScaledVector(UP, height / 2),
    lot.along,
    UP,
    lot.outward,
    { x: hx, y: height / 2, z: hz },
    wallColor,
  );
  // 越屋根 (明かり取り)。
  addBox(
    mb,
    base.clone().addScaledVector(UP, height + 0.8),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.7, y: 0.8, z: hz * 0.45 },
    STEEL,
  );
  // シャッター (道路側)。
  addBox(
    mb,
    base.clone().addScaledVector(UP, 2.1).addScaledVector(lot.outward, -hz),
    lot.along,
    UP,
    lot.outward,
    { x: hx * 0.35, y: 2.1, z: 0.18 },
    [0.4, 0.42, 0.44],
  );
  // 煙突。
  addBox(
    mb,
    base
      .clone()
      .addScaledVector(UP, height * 0.75)
      .addScaledVector(lot.along, hx * 0.82)
      .addScaledVector(lot.outward, hz * 0.7),
    lot.along,
    UP,
    lot.outward,
    { x: 0.55, y: height * 0.75, z: 0.55 },
    CONCRETE,
  );
}

const ZONE_COLOR_LIST: RGB[] = [
  [0.82, 0.36, 0.3],
  [0.3, 0.52, 0.78],
  [0.86, 0.68, 0.28],
  [0.36, 0.62, 0.44],
];

/**
 * 切妻屋根。棟は道路と平行に通す。
 *
 * 面ごとに法線を求めて張るので、傾いた面でも陰影が正しく出る。
 */
function addGableRoof(
  mb: MeshBuilder,
  eaves: Vector3,
  lot: Lot,
  halfAlong: number,
  halfDepth: number,
  height: number,
  color: RGB,
): void {
  const corner = (along: number, out: number): Vector3 =>
    eaves.clone().addScaledVector(lot.along, along).addScaledVector(lot.outward, out);
  const b0 = corner(-halfAlong, -halfDepth);
  const b1 = corner(halfAlong, -halfDepth);
  const b2 = corner(halfAlong, halfDepth);
  const b3 = corner(-halfAlong, halfDepth);
  const r0 = corner(-halfAlong, 0).addScaledVector(UP, height);
  const r1 = corner(halfAlong, 0).addScaledVector(UP, height);
  const inside = eaves.clone().addScaledVector(UP, height * 0.4);

  addFace(mb, [b0, b1, r1, r0], color, inside);
  addFace(mb, [b2, b3, r0, r1], color, inside);
  addFace(mb, [b0, r0, b3], color, inside);
  addFace(mb, [b1, b2, r1], color, inside);
}

/**
 * 多角形の面を 1 枚張る。
 *
 * 法線は 3 点から求め、面の中心が `inside` から見て外を向くように整える。
 * 表裏を取り違えると、屋根が暗く落ち込んで見える。
 */
function addFace(mb: MeshBuilder, points: Vector3[], color: RGB, inside: Vector3): void {
  if (points.length < 3) return;
  const normal = new Vector3()
    .subVectors(points[1], points[0])
    .cross(new Vector3().subVectors(points[2], points[0]));
  if (normal.lengthSq() < 1e-12) return;
  normal.normalize();
  const centre = new Vector3();
  for (const p of points) centre.add(p);
  centre.divideScalar(points.length);
  const ordered = normal.dot(centre.clone().sub(inside)) < 0 ? [...points].reverse() : points;
  if (ordered !== points) normal.negate();

  const base = mb.vertexCount;
  for (const p of ordered) mb.vertex(p, normal, 0, 0, color);
  for (let i = 2; i < ordered.length; i++) mb.triangle(base, base + i - 1, base + i);
}

function pick<T>(list: T[], rand: () => number): T {
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

/** 区画の位置から決まる種。同じ区画からは必ず同じ建物ができる。 */
function hashLot(lot: Lot): number {
  // 位置そのものから作る。道路を引き直して番号が変わっても、同じ場所には
  // 同じ建物が建つ。
  const x = Math.round(lot.center.x * 4);
  const z = Math.round(lot.center.z * 4);
  let h = (x * 0x9e3779b1) ^ (z * 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 決定論的な擬似乱数 (mulberry32)。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
