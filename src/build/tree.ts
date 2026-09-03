import { Vector3 } from 'three';
import type { MeshBuilder } from '../core/meshbuilder';
import { hash2 } from '../terrain/hydro/grid';
import type { Tree } from '../terrain/vegetation';
import { addAxisBox, addTube } from './primitives';
import type { RGB } from './surface';

/**
 * 木の形。
 *
 * 近景は幹と樹冠を持つ立体、遠景は十字に組んだ 2 枚の板にする。木は 1 枚の
 * メッシュに何千本もまとめるので、1 本あたりの頂点数がそのまま常駐頂点数に
 * 効く — 近景 50 頂点・遠景 8 頂点で見積もってある。
 *
 * 色は位置から決める (`buildBuilding` と同じ考え方)。同じ木は何度組んでも
 * 同じ色になり、隣の木とは違う色になる。
 */

/** 樹冠の色。針葉樹は暗い青緑、広葉樹は明るい黄緑、低木は灰緑。 */
const CANOPY: readonly RGB[] = [
  [0.13, 0.26, 0.16],
  [0.24, 0.4, 0.16],
  [0.28, 0.36, 0.22],
];

/** 幹の色。 */
const TRUNK: RGB = [0.24, 0.19, 0.14];

/** 樹冠の断面の頂点数。5 で錐面 5 枚。増やすほど丸くなるが頂点も増える。 */
const SIDES = 5;

/** 幹の太さ (樹高に対する比)。 */
const TRUNK_RATIO = 0.035;

/** 遠景の樹冠の断面の頂点数。4 で 8 頂点。 */
const FAR_SIDES = 4;

export type TreeLod = 'full' | 'far';

/**
 * 木 1 本を積む。
 *
 * `y` は根元の地面の高さ。地面から生えているように見せるため、幹は少し
 * 地面へ埋めてある (地形は 4 m 格子なので、根元の地面の高さは実際の面と
 * 数十 cm ずれる)。
 */
export function addTree(mb: MeshBuilder, tree: Tree, lod: TreeLod): void {
  const tint = hash2(Math.round(tree.x), Math.round(tree.z), 5501);
  const base = CANOPY[tree.species];
  // 同じ樹種でも明るさを ±12% 振る。並んだときに 1 枚の板に見えない。
  const shade = 0.88 + tint * 0.24;
  const canopy: RGB = [base[0] * shade, base[1] * shade, base[2] * shade];
  if (lod === 'far') addFarTree(mb, tree, canopy);
  else addFullTree(mb, tree, canopy);
}

/** 近景の木。幹 + 2 段の錐面。 */
function addFullTree(mb: MeshBuilder, tree: Tree, canopy: RGB): void {
  const trunkR = Math.max(0.12, tree.height * TRUNK_RATIO);
  // 樹冠が始まる高さ。針葉樹は低い所から枝を張り、広葉樹は幹を伸ばす。
  const crownBase = tree.species === 0 ? tree.height * 0.22 : tree.height * 0.42;
  const trunkTop = crownBase + 0.4;

  addAxisBox(
    mb,
    new Vector3(tree.x, tree.y + (trunkTop - 0.6) / 2, tree.z),
    { x: trunkR, y: (trunkTop + 0.6) / 2, z: trunkR },
    TRUNK,
  );

  // 下・中・上の 3 リング。中を膨らませると丸い樹冠、細くすると円錐になる。
  const mid = tree.species === 0 ? 0.72 : 1.0;
  const rings = [
    ring(tree, crownBase, tree.radius * 0.55),
    ring(tree, crownBase + (tree.height - crownBase) * 0.42, tree.radius * mid),
    ring(tree, tree.height, tree.radius * 0.06),
  ];
  addTube(mb, rings, canopy, true);
}

/** 樹冠の断面 1 枚 (根元からの高さで指定)。 */
function ring(tree: Tree, height: number, radius: number): Vector3[] {
  return flatRing(tree, tree.y + height, radius, SIDES);
}

/** 水平な多角形のリング (ワールドの高さで指定)。 */
function flatRing(tree: Tree, y: number, radius: number, sides: number): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < sides; i++) {
    const a = tree.angle + (i / sides) * Math.PI * 2;
    out.push(new Vector3(tree.x + Math.cos(a) * radius, y, tree.z + Math.sin(a) * radius));
  }
  return out;
}

/**
 * 遠景の木。幹を省いた 4 角錐 1 つ (8 頂点)。
 *
 * **板を十字に組む形にはしない**。この地図は見下ろす視点なので、垂直な板は
 * ほとんど真横から見ることになり、緑の衝立が並んでいるように見える。錐なら
 * 上から見ても横から見ても塊に見え、頂点数は板 2 枚と同じで済む。
 */
function addFarTree(mb: MeshBuilder, tree: Tree, canopy: RGB): void {
  const base = tree.y + tree.height * 0.28;
  addTube(
    mb,
    [
      flatRing(tree, base, tree.radius, FAR_SIDES),
      flatRing(tree, tree.y + tree.height, tree.radius * 0.05, FAR_SIDES),
    ],
    canopy,
    true,
  );
}
