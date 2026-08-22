import { MeshBasicMaterial, Vector3 } from 'three';
import { applySurfaceBlend, surfaceHeightScale, type SurfaceBlend } from '../../src/build/crossing';
import { Alignment } from '../../src/core/alignment';
import { VerticalProfile } from '../../src/core/profile';
import { profileFor, profilePointAt } from '../../src/build/surface';
import { earcutXZ } from '../../src/core/meshbuilder';
import { SURFACE_LIFT } from '../../src/core/units';
import { getClass } from '../../src/network/classes';
import {
  anchorFromNode,
  computePlacement,
  placeSegment,
  type Anchor,
} from '../../src/network/editing';
import { Network, type SegmentId } from '../../src/network/network';
import { checkPlacement } from '../../src/network/rules';
import { WorldBuilder } from '../../src/render/worldBuilder';
import { Heightfield } from '../../src/terrain/heightfield';
import { TerrainMesh } from '../../src/terrain/terrainMesh';

/**
 * 敵対的検証の足場 (組み立てと計測)。
 *
 * 検証は「敷設ツールで実際に置ける配置」だけを対象にする。置けない配置は
 * `checkPlacement` が理由を返して弾くので、シーンの側では *置けたかどうか*
 * も記録し、「壊れた形が出るなら、直すか置けなくする」を測れるようにする。
 */

export interface Waypoint {
  x: number;
  z: number;
  y?: number;
}

export interface DrawOptions {
  straight?: boolean;
  /** 敷設ツールと同じ規則で弾く (既定)。false にすると規則を無視して置く。 */
  enforceRules?: boolean;
}

/** 敷設できなかった理由。空なら全て置けた。 */
export type Blockers = string[];

/**
 * 経由点を順に繋いで線形を引く (敷設ツールと同じ手順)。
 *
 * 既定では `checkPlacement` を通し、置けない区間は置かずに理由を返す。
 */
export function draw(
  network: Network,
  field: Heightfield,
  classId: string,
  points: Waypoint[],
  options: DrawOptions = {},
): Blockers {
  const cls = getClass(classId);
  const enforce = options.enforceRules ?? true;
  const toVec = (p: Waypoint): Vector3 =>
    new Vector3(p.x, p.y ?? field.baseHeightAt(p.x, p.z), p.z);

  const first = toVec(points[0]);
  const existing = network.findNodeNear(first, 3);
  let anchor: Anchor = existing ? anchorFromNode(network, existing, cls) : { pos: first };
  const blockers: Blockers = [];

  for (let i = 1; i < points.length; i++) {
    const target = toVec(points[i]);
    const preview = computePlacement(anchor, target, {
      straight: options.straight ?? false,
      cls,
    });
    if (enforce) {
      const alignment = new Alignment(
        preview.horizontal,
        new VerticalProfile(
          anchor.pos.y,
          preview.end.y,
          preview.startGrade,
          preview.endGrade,
          preview.horizontal.length,
        ),
      );
      const check = checkPlacement({
        network,
        cls,
        alignment,
        start: anchor,
        end: { pos: target },
        field,
      });
      if (check.blockers.length > 0) {
        blockers.push(...check.blockers);
        break;
      }
    }
    const result = placeSegment(network, classId, anchor, { pos: target }, preview);
    const endNode = network.nodes.get(result.endNode);
    if (!endNode) break;
    anchor = {
      pos: endNode.pos.clone(),
      node: endNode.id,
      tangent: preview.endTangent.clone(),
      grade: preview.endGrade,
    };
  }
  return blockers;
}

/** 既存の線形の途中に取り付く枝を引く。取り付き点のノードを返す。 */
export function drawBranch(
  network: Network,
  field: Heightfield,
  classId: string,
  at: Vector3,
  points: Waypoint[],
  options: DrawOptions = {},
): Blockers {
  const hit = network.findSegmentNear(at, 20);
  if (!hit) return ['取り付く線形が見つからない'];
  const node = network.splitSegment(hit.segment, hit.s);
  return draw(
    network,
    field,
    classId,
    [{ x: node.pos.x, z: node.pos.z, y: node.pos.y }, ...points],
    options,
  );
}

export interface Scene {
  name: string;
  field: Heightfield;
  network: Network;
  world: WorldBuilder;
  result: ReturnType<WorldBuilder['rebuild']>;
  /** 敷設規則が弾いた理由 (空なら配置は全て置けた)。 */
  blocked: Blockers;
}

/** 地形を関数で与えて、ネットワークを組み、組み立てパイプライン全体を回す。 */
export function buildScene(
  name: string,
  terrain: (x: number, z: number) => number,
  place: (net: Network, field: Heightfield) => Blockers | void,
): Scene {
  const field = new Heightfield();
  for (let iz = 0; iz <= field.cells; iz++) {
    for (let ix = 0; ix <= field.cells; ix++) {
      field.base[field.index(ix, iz)] = terrain(field.worldX(ix), field.worldZ(iz));
    }
  }
  field.resetWork();

  const network = new Network();
  const blocked = place(network, field) ?? [];

  const terrainMesh = new TerrainMesh(field, new MeshBasicMaterial());
  const world = new WorldBuilder(network, field, terrainMesh);
  const result = world.rebuild();
  return { name, field, network, world, result, blocked };
}

// ------------------------------------------------------------------ 地形

export const flat = (y: number) => () => y;
/** X 方向に一定勾配で登る斜面。 */
export const rampX = (y0: number, slope: number) => (x: number) => y0 + slope * x;
/** 起伏の激しい自然地形。 */
export const rough = (amp = 1) => (x: number, z: number): number =>
  30 + amp * (9 * Math.sin(x / 55) + 7 * Math.cos(z / 40) + 4 * Math.sin((x + z) / 25));
/** x 方向に山があり、真ん中がトンネルになる地形。 */
export const hillX = (y0: number, height: number, halfWidth: number) => (x: number): number =>
  y0 + height * Math.max(0, 1 - (x / halfWidth) ** 2);
/** x > 0 側が落ち込む崖。 */
export const cliffX = (y0: number, drop: number, run: number) => (x: number) =>
  y0 - (Math.min(Math.max(x, 0), run) / run) * drop;

// ------------------------------------------------------------------ 計測

export interface Violation {
  scene: string;
  amount: number;
  where: Vector3;
  what: string;
}

export function summarize(name: string, list: Violation[]): string {
  if (list.length === 0) return `${name}: 違反なし`;
  const top = [...list].sort((a, b) => b.amount - a.amount).slice(0, 6);
  return (
    `${name}: ${list.length} 件, 最大 ${top[0].amount.toFixed(3)}\n` +
    top
      .map(
        (v) =>
          `    ${v.amount.toFixed(3)} @ (${v.where.x.toFixed(1)}, ${v.where.z.toFixed(1)}) [${v.scene}] ${v.what}`,
      )
      .join('\n')
  );
}

/** 複数の観点をまとめて判定する (1 つ目で止めない)。 */
export function expectAllClean(
  entries: [string, Violation[]][],
  expectFn: (actual: string) => { toBe(expected: string): void },
): void {
  const actual = entries.map(([n, list]) => summarize(n, list)).join('\n');
  const expected = entries.map(([n]) => `${n}: 違反なし`).join('\n');
  expectFn(actual).toBe(expected);
}

/** 描画に使われるサンプル (踏切のまわりでは道路が上下・傾斜する)。 */
export function drawnSampleAt(scene: Scene, segment: SegmentId, s: number) {
  const raw = scene.network.alignmentOf(segment).sampleAt(s);
  const blended = applySurfaceBlend([raw], scene.result.blends.get(segment) ?? [])[0];
  // 線路のカントも描画に効いている。
  const cant = scene.world.cantAt(segment, s);
  return cant === 0 ? blended : { ...blended, roll: (blended.roll ?? 0) + cant };
}

/**
 * セグメント帯の端 (トリム位置) の横断面をワールド展開する。
 *
 * 踏切の近くでは縁石・歩道の段差が潰れる (`surfaceHeightScale`)。描画と
 * 同じ係数を掛けないと、実際には無い段差を報告してしまう。
 */
export function ribbonEndSection(scene: Scene, segment: SegmentId, atStart: boolean): Vector3[] {
  const range = scene.result.ranges.get(segment)!;
  const cls = scene.network.classOf(scene.network.getSegment(segment));
  const s = atStart ? range.s0 : range.s1;
  const sample = drawnSampleAt(scene, segment, s);
  const scale = surfaceHeightScale(scene.result.blends.get(segment) ?? [], s);
  return profileFor(cls).map((p) =>
    profilePointAt(sample, p.offset, p.height * scale, new Vector3()),
  );
}

/**
 * 多角形 (交差点のリング) を描画と同じ earcut で分割し、点 (x, z) の面の
 * 高さを返す。外なら null。
 */
export function polygonSurfaceY(ring: Vector3[], x: number, z: number): number | null {
  if (ring.length < 3) return null;
  const flatXZ: number[] = [];
  for (const p of ring) flatXZ.push(p.x, p.z);
  const tris = earcutXZ(flatXZ);
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const a = ring[tris[i]];
    const b = ring[tris[i + 1]];
    const c = ring[tris[i + 2]];
    const area = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
    if (Math.abs(area) < 1e-12) continue;
    const w0 = ((b.x - x) * (c.z - z) - (c.x - x) * (b.z - z)) / area;
    const w1 = ((c.x - x) * (a.z - z) - (a.x - x) * (c.z - z)) / area;
    const w2 = 1 - w0 - w1;
    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
    return w0 * a.y + w1 * b.y + w2 * c.y;
  }
  return null;
}

/** 交差点の内側リング (車道面) を SURFACE_LIFT 込みで返す。 */
export function junctionSurfaceRing(rings: Vector3[][]): Vector3[] | null {
  const inner = rings[rings.length - 1];
  if (!inner || inner.length < 3) return null;
  return inner.map((p) => new Vector3(p.x, p.y + SURFACE_LIFT, p.z));
}

export interface MeshVertices {
  count: number;
  x(i: number): number;
  y(i: number): number;
  z(i: number): number;
}

/** 名前付きメッシュの頂点。 */
export function verticesOf(scene: Scene, name: string): MeshVertices {
  const mesh = scene.world.group.getObjectByName(name) as
    | {
        geometry: {
          attributes: {
            position: {
              count: number;
              getX(i: number): number;
              getY(i: number): number;
              getZ(i: number): number;
            };
          };
        };
      }
    | undefined;
  const pos = mesh?.geometry.attributes.position;
  if (!pos) throw new Error(`${name} メッシュが見つからない`);
  return {
    count: pos.count,
    x: (i) => pos.getX(i),
    y: (i) => pos.getY(i),
    z: (i) => pos.getZ(i),
  };
}

/** 名前付きメッシュの三角形。 */
export function trianglesOf(scene: Scene, name: string): { a: Vector3; b: Vector3; c: Vector3 }[] {
  const mesh = scene.world.group.getObjectByName(name) as
    | {
        geometry: {
          index: { count: number; getX(i: number): number } | null;
          attributes: {
            position: {
              count: number;
              getX(i: number): number;
              getY(i: number): number;
              getZ(i: number): number;
            };
          };
        };
      }
    | undefined;
  const geometry = mesh?.geometry;
  const pos = geometry?.attributes.position;
  if (!geometry || !pos) throw new Error(`${name} メッシュが見つからない`);
  const at = (i: number): Vector3 => new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const out: { a: Vector3; b: Vector3; c: Vector3 }[] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    out.push({ a: at(i0), b: at(i1), c: at(i2) });
  }
  return out;
}

/** 点が多角形 (XZ) の内側か。 */
export function insidePolygonXZ(ring: { x: number; z: number }[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export type Blend = SurfaceBlend;
