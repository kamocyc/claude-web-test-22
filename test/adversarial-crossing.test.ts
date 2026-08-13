import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector3 } from 'three';
import { applySurfaceBlend } from '../src/build/crossing';
import { RAIL_GAUGE, SURFACE_LIFT, clamp } from '../src/core/units';
import { getClass } from '../src/network/classes';
import { checkPlacement } from '../src/network/rules';
import {
  anchorFromNode,
  computePlacement,
  placeSegment,
  type Anchor,
} from '../src/network/editing';
import { Network, type SegmentId } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';

/**
 * 敵対的検証 (踏切と分岐器)。
 *
 * 「踏切では線路が優先で、道路の方が線路の面に合わせる」という変更を、
 * **実際に生成されたメッシュ**の三角形・頂点から測って検査する。
 * 検査は実装の定数ではなくメッシュを正とし、検査側のモデルが実装と
 * ずれていないことを自己点検テストで別に確かめる。
 */

// =====================================================================
// 足場
// =====================================================================

interface Waypoint {
  x: number;
  z: number;
  y?: number;
}

/** demo.ts の draw() と同じ手順。 */
function draw(
  network: Network,
  field: Heightfield,
  classId: string,
  points: Waypoint[],
  options: { straight?: boolean } = {},
): void {
  const cls = getClass(classId);
  const toVec = (p: Waypoint): Vector3 =>
    new Vector3(p.x, p.y ?? field.baseHeightAt(p.x, p.z), p.z);

  const first = toVec(points[0]);
  const existing = network.findNodeNear(first, 3);
  let anchor: Anchor = existing ? anchorFromNode(network, existing, cls) : { pos: first };

  for (let i = 1; i < points.length; i++) {
    const target = toVec(points[i]);
    const preview = computePlacement(anchor, target, {
      straight: options.straight ?? false,
      cls,
    });
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
}

interface Scene {
  field: Heightfield;
  network: Network;
  world: WorldBuilder;
  result: ReturnType<WorldBuilder['rebuild']>;
}

function buildScene(
  terrain: (x: number, z: number) => number,
  place: (net: Network, field: Heightfield) => void,
): Scene {
  const field = new Heightfield();
  for (let iz = 0; iz <= field.cells; iz++) {
    for (let ix = 0; ix <= field.cells; ix++) {
      field.base[field.index(ix, iz)] = terrain(field.worldX(ix), field.worldZ(iz));
    }
  }
  field.resetWork();

  const network = new Network();
  place(network, field);

  const terrainMesh = new TerrainMesh(field, new MeshBasicMaterial());
  const world = new WorldBuilder(network, field, terrainMesh);
  const result = world.rebuild();
  return { field, network, world, result };
}

const flat = (y: number) => () => y;

// =====================================================================
// 実メッシュを測る道具
// =====================================================================

interface Tri {
  a: Vector3;
  b: Vector3;
  c: Vector3;
  /** 3 頂点の平均色 (帯の種別を見分けるのに使う)。 */
  color: [number, number, number];
}

function meshOf(scene: Scene, name: string) {
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
            color: { getX(i: number): number; getY(i: number): number; getZ(i: number): number };
          };
        };
      }
    | undefined;
  if (!mesh) throw new Error(`${name} メッシュが見つからない`);
  return mesh.geometry;
}

function trianglesOf(scene: Scene, name: string): Tri[] {
  const geometry = meshOf(scene, name);
  const pos = geometry.attributes.position;
  const col = geometry.attributes.color;
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const at = (i: number): Vector3 => new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
  const out: Tri[] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    out.push({
      a: at(i0),
      b: at(i1),
      c: at(i2),
      color: [
        (col.getX(i0) + col.getX(i1) + col.getX(i2)) / 3,
        (col.getY(i0) + col.getY(i1) + col.getY(i2)) / 3,
        (col.getZ(i0) + col.getZ(i1) + col.getZ(i2)) / 3,
      ],
    });
  }
  return out;
}

/**
 * 三角形を XZ 格子に索引した、面の高さを引くための構造。
 *
 * 「その XZ にある面の高さ」を実メッシュから直に引ける。垂直な面
 * (縁石・垂れ壁) は XZ 平面での面積が 0 なので自然に外れる。
 */
class SurfaceIndex {
  private readonly cell = 4;
  private readonly buckets = new Map<string, Tri[]>();
  readonly triangles: Tri[];

  constructor(scene: Scene, name = 'surfaces') {
    this.triangles = trianglesOf(scene, name);
    for (const tri of this.triangles) {
      const minX = Math.min(tri.a.x, tri.b.x, tri.c.x);
      const maxX = Math.max(tri.a.x, tri.b.x, tri.c.x);
      const minZ = Math.min(tri.a.z, tri.b.z, tri.c.z);
      const maxZ = Math.max(tri.a.z, tri.b.z, tri.c.z);
      for (let iz = Math.floor(minZ / this.cell); iz <= Math.floor(maxZ / this.cell); iz++) {
        for (let ix = Math.floor(minX / this.cell); ix <= Math.floor(maxX / this.cell); ix++) {
          const key = `${ix},${iz}`;
          const list = this.buckets.get(key);
          if (list) list.push(tri);
          else this.buckets.set(key, [tri]);
        }
      }
    }
  }

  /** (x, z) を覆う面の高さを全て (上限 `ceiling` 以下)。 */
  heightsAt(x: number, z: number, ceiling = Infinity): number[] {
    const list = this.buckets.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`);
    if (!list) return [];
    const out: number[] = [];
    for (const tri of list) {
      const y = heightInTriangle(tri.a, tri.b, tri.c, x, z);
      if (y !== null && y <= ceiling) out.push(y);
    }
    return out;
  }

  /** (x, z) を覆う面のうち、いちばん高いもの。無ければ null。 */
  topAt(x: number, z: number, ceiling = Infinity): number | null {
    let best: number | null = null;
    for (const y of this.heightsAt(x, z, ceiling)) {
      if (best === null || y > best) best = y;
    }
    return best;
  }
}

function heightInTriangle(a: Vector3, b: Vector3, c: Vector3, x: number, z: number): number | null {
  const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(d) < 1e-12) return null;
  const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
  const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
  const w = 1 - u - v;
  if (u < -1e-9 || v < -1e-9 || w < -1e-9) return null;
  return u * a.y + v * b.y + w * c.y;
}

/** 構造物メッシュの頂点を XZ 格子に索引したもの (レール頭頂面の実測用)。 */
export class VertexIndex {
  private readonly cell = 2;
  private readonly buckets = new Map<string, number[]>();

  constructor(scene: Scene, name = 'structures') {
    const pos = meshOf(scene, name).attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const key = `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
      const list = this.buckets.get(key);
      if (list) list.push(x, y, z);
      else this.buckets.set(key, [x, y, z]);
    }
  }

  /**
   * (x, z) の半径 `radius` 以内で、`ceiling` より下にある最も高い頂点。
   * 架線・架線柱・電柱を拾わないよう、必ず高さで上限を切って使う。
   */
  highestNear(
    x: number,
    z: number,
    radius: number,
    ceiling: number,
  ): { y: number; count: number } {
    let top = -Infinity;
    let count = 0;
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const list = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const ddx = list[i] - x;
          const ddz = list[i + 2] - z;
          if (ddx * ddx + ddz * ddz > radius * radius) continue;
          const y = list[i + 1];
          if (y > ceiling) continue;
          count++;
          if (y > top) top = y;
        }
      }
    }
    return { y: top, count };
  }
}

// =====================================================================
// 違反の集計
// =====================================================================

interface Violation {
  amount: number;
  where: Vector3;
  what: string;
}

function summarize(name: string, list: Violation[]): string {
  if (list.length === 0) return `${name}: 違反なし`;
  const top = [...list].sort((a, b) => b.amount - a.amount).slice(0, 4);
  return (
    `${name}: ${list.length} 件, 最大 ${top[0].amount.toFixed(3)}\n` +
    top
      .map(
        (v) =>
          `    ${v.amount.toFixed(3)} @ (${v.where.x.toFixed(1)}, ${v.where.z.toFixed(1)}) ${v.what}`,
      )
      .join('\n')
  );
}

// 予備: 複数の検査結果をまとめて突き合わせる。
export function expectAllClean(entries: [string, Violation[]][]): void {
  const actual = entries.map(([name, list]) => summarize(name, list)).join('\n');
  const expected = entries.map(([name]) => `${name}: 違反なし`).join('\n');
  expect(actual).toBe(expected);
}


// =====================================================================
// 踏切の実測
// =====================================================================

/** 検査で使う踏切 1 箇所分の情報。 */
interface LevelCrossing {
  railSegment: SegmentId;
  roadSegment: SegmentId;
  sRail: number;
  sRoad: number;
  point: Vector3;
  railCls: ReturnType<Network['classOf']>;
  roadCls: ReturnType<Network['classOf']>;
  /** 交差角 [rad] (0 < angle <= PI/2)。 */
  angle: number;
}

function levelCrossings(scene: Scene): LevelCrossing[] {
  const out: LevelCrossing[] = [];
  for (const crossing of scene.world.crossings) {
    if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
    const sin = Math.abs(
      crossing.road.dir.x * crossing.rail.dir.y - crossing.road.dir.y * crossing.rail.dir.x,
    );
    out.push({
      railSegment: crossing.rail.segment,
      roadSegment: crossing.road.segment,
      sRail: crossing.rail.s,
      sRoad: crossing.road.s,
      point: crossing.point.clone(),
      railCls: crossing.rail.cls,
      roadCls: crossing.road.cls,
      angle: Math.asin(clamp(sin, 0, 1)),
    });
  }
  return out;
}

/**
 * 道路の中心線 (踏切の補正を含む描画高さ) を折れ線にしたもの。
 * 「その点が舗装のどこにあたるか」を引くのに使う。
 */
interface RoadTrack {
  cls: ReturnType<Network['classOf']>;
  pts: Vector3[];
  rights: Vector3[];
  ss: number[];
  segment: SegmentId;
}

function roadTracks(scene: Scene): RoadTrack[] {
  const out: RoadTrack[] = [];
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    if (cls.kind !== 'road') continue;
    const al = scene.network.alignmentOf(seg.id);
    const blends = scene.result.blends.get(seg.id) ?? [];
    const range = scene.result.ranges.get(seg.id)!;
    const n = Math.max(2, Math.ceil((range.s1 - range.s0) * 4));
    const pts: Vector3[] = [];
    const rights: Vector3[] = [];
    const ss: number[] = [];
    for (let i = 0; i <= n; i++) {
      const s = range.s0 + ((range.s1 - range.s0) * i) / n;
      const sample = applySurfaceBlend([al.sampleAt(s)], blends)[0];
      pts.push(sample.pos.clone());
      rights.push(sample.right.clone());
      ss.push(s);
    }
    out.push({ cls, pts, rights, ss, segment: seg.id });
  }
  return out;
}

/** その点にいちばん近い道路の中心線からの垂距など。 */
function roadCoverAt(
  roads: RoadTrack[],
  x: number,
  z: number,
): { lateral: number; road: RoadTrack; index: number } | null {
  let best: { lateral: number; road: RoadTrack; index: number } | null = null;
  let bestDist = Infinity;
  for (const road of roads) {
    for (let i = 0; i < road.pts.length; i++) {
      const p = road.pts[i];
      const dx = x - p.x;
      const dz = z - p.z;
      const d = dx * dx + dz * dz;
      if (d >= bestDist) continue;
      bestDist = d;
      const r = road.rights[i];
      best = { lateral: Math.abs(dx * r.x + dz * r.z), road, index: i };
    }
  }
  return best;
}

/**
 * (1)(2) 踏切のレールと舗装の上下関係を、実メッシュから測る。
 *
 * 線路は動かないので、レール頭頂面は線形の Y + SURFACE_LIFT。これが
 * 実メッシュ (`structures`) の頂点と一致することは自己点検で確かめている。
 * 舗装は `surfaces` の三角形をその XZ で切った高さ。
 *
 * レールに沿って 0.25 m 刻みで歩き、道路の footprint を跨ぐ範囲を全て見る。
 * 判定は 2 つ:
 *   - レール頭頂面が舗装より上にあること (列車が走れる)
 *   - 舗装がレールから離れすぎていないこと (乗り上げる段差にならない)
 */
function railProudViolations(
  scene: Scene,
  options: { minProud?: number; maxProud?: number } = {},
): { violations: Violation[]; checked: number; onRoad: number; minProud: number; maxProud: number } {
  const minProud = options.minProud ?? 0.005;
  const maxProud = options.maxProud ?? 0.2;
  const surfaces = new SurfaceIndex(scene);
  const roads = roadTracks(scene);
  const out: Violation[] = [];
  let checked = 0;
  let onRoad = 0;
  let observedMin = Infinity;
  let observedMax = -Infinity;

  for (const crossing of levelCrossings(scene)) {
    const al = scene.network.alignmentOf(crossing.railSegment);
    const cls = crossing.railCls;
    // 舗装の半幅を斜めに横切る分だけ、線路の弧長で余分に必要になる。
    const reach = crossing.roadCls.halfWidth / Math.max(0.25, Math.sin(crossing.angle)) + 6;
    const tracks = cls.tracks.length > 0 ? cls.tracks : [0];
    for (let u = -reach; u <= reach + 1e-6; u += 0.25) {
      const s = crossing.sRail + u;
      if (s < 0 || s > al.length) continue;
      const sample = al.sampleAt(s);
      const railTop = sample.pos.y + SURFACE_LIFT;
      for (const track of tracks) {
        for (const side of [-RAIL_GAUGE / 2, RAIL_GAUGE / 2]) {
          const o = track + side;
          const x = sample.pos.x + sample.right.x * o;
          const z = sample.pos.z + sample.right.z * o;
          // 立体交差の上を通る面を拾わないよう、天井を切る。
          const pavement = surfaces.topAt(x, z, railTop + 1.5);
          if (pavement === null) continue;
          checked++;
          const proud = railTop - pavement;
          const cover = roadCoverAt(roads, x, z);
          // 舗装の上かどうか。路端ちょうどは帯の境界なので少し内側を見る。
          const covered = cover !== null && cover.lateral <= cover.road.cls.halfWidth - 0.3;
          if (!covered) continue;
          onRoad++;
          observedMin = Math.min(observedMin, proud);
          observedMax = Math.max(observedMax, proud);
          if (proud < minProud) {
            out.push({
              amount: minProud - proud,
              where: new Vector3(x, railTop, z),
              what: `レールが舗装の ${(-proud).toFixed(3)} m 下: 線路 s=${s.toFixed(1)} 軌道${o.toFixed(2)} 頭頂面=${railTop.toFixed(3)} 舗装=${pavement.toFixed(3)} 垂距=${cover!.lateral.toFixed(1)}`,
            });
          } else if (proud > maxProud) {
            out.push({
              amount: proud - maxProud,
              where: new Vector3(x, railTop, z),
              what: `舗装がレールの ${proud.toFixed(3)} m 下 (段差): 線路 s=${s.toFixed(1)} 軌道${o.toFixed(2)} 頭頂面=${railTop.toFixed(3)} 舗装=${pavement.toFixed(3)} 垂距=${cover!.lateral.toFixed(1)}`,
            });
          }
        }
      }
    }
  }
  return { violations: out, checked, onRoad, minProud: observedMin, maxProud: observedMax };
}

/**
 * (3) 路面標示・踏切パネル・フランジ溝が、路面の上に正しく載っているか。
 *
 * `markings` メッシュの頂点は色で種別が分かる (MeshBuilder が頂点カラーを
 * 持っている)。フランジ溝は暗い灰、踏切パネルは中間の灰、区画線は白/黄。
 * 各頂点の真下に舗装があり、浮き上がりが所定の範囲に収まっていることを、
 * 実メッシュどうしの比較で確かめる。
 */
function overlayViolations(
  scene: Scene,
  limits: { minLift?: number; maxLift?: number } = {},
): { violations: Violation[]; counts: Record<string, number>; lift: Record<string, [number, number]> } {
  const minLift = limits.minLift ?? 0;
  const maxLift = limits.maxLift ?? 0.06;
  const surfaces = new SurfaceIndex(scene);
  const out: Violation[] = [];
  const counts: Record<string, number> = { 区画線: 0, パネル: 0, 溝: 0 };
  const lift: Record<string, [number, number]> = {
    区画線: [Infinity, -Infinity],
    パネル: [Infinity, -Infinity],
    溝: [Infinity, -Infinity],
  };

  for (const tri of trianglesOf(scene, 'markings')) {
    const [r, g, b] = tri.color;
    let kind: string | null = null;
    if (r > 0.8 && g > 0.6) kind = '区画線';
    else if (Math.abs(r - 0.44) < 0.02 && Math.abs(b - 0.45) < 0.02) kind = 'パネル';
    else if (r < 0.2 && g < 0.2) kind = '溝';
    if (!kind) continue;
    for (const p of [tri.a, tri.b, tri.c]) {
      // 真下の舗装。立体交差の別の面を拾わないよう、近傍だけ見る。
      const pavement = surfaces.topAt(p.x, p.z, p.y + 0.02);
      counts[kind]++;
      if (pavement === null) {
        out.push({
          amount: 1,
          where: p.clone(),
          what: `${kind}の下に舗装が無い (路面からはみ出している) y=${p.y.toFixed(3)}`,
        });
        continue;
      }
      const d = p.y - pavement;
      lift[kind][0] = Math.min(lift[kind][0], d);
      lift[kind][1] = Math.max(lift[kind][1], d);
      if (d < minLift || d > maxLift) {
        out.push({
          amount: Math.abs(d - clamp(d, minLift, maxLift)),
          where: p.clone(),
          what: `${kind}が路面から ${d.toFixed(3)} m 浮いている (許容 ${minLift}〜${maxLift})`,
        });
      }
    }
  }
  return { violations: out, counts, lift };
}

/**
 * (3) 踏切の前後の路面を、実メッシュから縦断として測る。
 *
 * 道路の中心線 (踏切の補正込み) に沿って舗装面の高さを引き、
 *   - 舗装が途切れていないか (穴)
 *   - 段差 (0.5 m の間の高低差) が無いか
 *   - 実際の勾配がどこまできつくなっているか
 * を見る。線形の値ではなく描かれた面を測るので、補正が路面に効いて
 * いなければそのまま出る。
 */
function roadProfileThroughCrossings(
  scene: Scene,
  options: { reach?: number; maxStep?: number; maxGrade?: number } = {},
): { violations: Violation[]; stations: number; maxGrade: number; maxStep: number } {
  const reach = options.reach ?? 60;
  const maxStep = options.maxStep ?? 0.04;
  const maxGrade = options.maxGrade ?? 0.2;
  const surfaces = new SurfaceIndex(scene);
  const out: Violation[] = [];
  let stations = 0;
  let worstGrade = 0;
  let worstStep = 0;

  for (const crossing of levelCrossings(scene)) {
    const al = scene.network.alignmentOf(crossing.roadSegment);
    const blends = scene.result.blends.get(crossing.roadSegment) ?? [];
    const range = scene.result.ranges.get(crossing.roadSegment)!;
    const step = 0.5;
    let prev: { s: number; y: number } | null = null;
    for (let d = -reach; d <= reach + 1e-6; d += step) {
      const s = crossing.sRoad + d;
      if (s < range.s0 + 0.2 || s > range.s1 - 0.2) continue;
      const sample = applySurfaceBlend([al.sampleAt(s)], blends)[0];
      const top = surfaces.topAt(sample.pos.x, sample.pos.z, sample.pos.y + 1.5);
      if (top === null) {
        out.push({
          amount: 1,
          where: sample.pos.clone(),
          what: `踏切前後の路面が途切れている: 道路 s=${s.toFixed(1)}`,
        });
        prev = null;
        continue;
      }
      stations++;
      if (prev) {
        const dy = top - prev.y;
        const grade = Math.abs(dy) / step;
        worstStep = Math.max(worstStep, Math.abs(dy));
        worstGrade = Math.max(worstGrade, grade);
        if (Math.abs(dy) > maxStep) {
          out.push({
            amount: Math.abs(dy),
            where: sample.pos.clone(),
            what: `路面に段差: 道路 s=${s.toFixed(1)} で ${(dy * 100).toFixed(1)} cm (${step} m の間)`,
          });
        } else if (grade > maxGrade) {
          out.push({
            amount: grade,
            where: sample.pos.clone(),
            what: `路面の勾配が ${(grade * 100).toFixed(1)}%: 道路 s=${s.toFixed(1)}`,
          });
        }
      }
      prev = { s, y: top };
    }
  }
  return { violations: out, stations, maxGrade: worstGrade, maxStep: worstStep };
}

// =====================================================================
// シナリオ
// =====================================================================

/**
 * 踏切 1 箇所。
 *
 * `angle` は線路と道路のなす角 [deg]、`railGrade` は線路の勾配、
 * `roadGrade` は道路の勾配。道路は交点で線路と同じ高さを通る
 * (`dy` を与えるとその分だけずらす = 踏切と判定される限界を突く)。
 */
function crossingScene(options: {
  angle?: number;
  rotate?: number;
  railGrade?: number;
  roadGrade?: number;
  railClass?: string;
  roadClass?: string;
  dy?: number;
  terrain?: (x: number, z: number) => number;
  railY?: number;
  /** 線路の縦断に曲率を持たせる (交点で頂部・底部になる)。 */
  railCrest?: number;
  /** 道路の縦断に曲率を持たせる。 */
  roadCrest?: number;
}) {
  const y0 = options.railY ?? 40;
  const rg = options.railGrade ?? 0;
  const dg = options.roadGrade ?? 0;
  const rot = ((options.rotate ?? 0) * Math.PI) / 180;
  const angle = ((options.angle ?? 90) * Math.PI) / 180;
  const railDir = { x: Math.sin(rot), z: Math.cos(rot) };
  const roadDir = { x: Math.sin(rot + angle), z: Math.cos(rot + angle) };
  const crest = options.railCrest ?? 0;
  const roadCrest = options.roadCrest ?? 0;
  return buildScene(options.terrain ?? flat(y0), (net, field) => {
    const railPts: Waypoint[] = [];
    for (const d of [-260, -130, 0, 130, 260]) {
      railPts.push({
        x: railDir.x * d,
        z: railDir.z * d,
        y: y0 + rg * d - crest * (d / 130) ** 2,
      });
    }
    draw(net, field, options.railClass ?? 'rail_double', railPts, { straight: true });

    const roadPts: Waypoint[] = [];
    for (const d of [-240, -120, -45, 45, 120, 240]) {
      roadPts.push({
        x: roadDir.x * d,
        z: roadDir.z * d,
        y: y0 + (options.dy ?? 0) + dg * d - roadCrest * (d / 120) ** 2,
      });
    }
    draw(net, field, options.roadClass ?? 'road_medium', roadPts, { straight: true });
  });
}

/**
 * 平行な 2 本の線路を 1 本の道路が続けて渡る配置。
 *
 * 道路に勾配があると、2 つの踏切のレール高は `gap * 勾配` だけ違う。
 * 補正が互いに干渉すると、どちらの線路にも合わない高さになる。
 */
function twinCrossingScene(options: {
  gap: number;
  roadGrade: number;
  roadClass?: string;
  railClass?: string;
}) {
  const y0 = 40;
  const g = options.roadGrade;
  const half = options.gap / 2;
  return buildScene(flat(y0), (net, field) => {
    for (const zc of [-half, half]) {
      draw(net, field, options.railClass ?? 'rail_single', [
        { x: -260, z: zc, y: y0 + g * zc },
        { x: 260, z: zc, y: y0 + g * zc },
      ], { straight: true });
    }
    const pts: Waypoint[] = [];
    for (const d of [-200, -100, -half - 20, half + 20, 100, 200]) {
      pts.push({ x: 0, z: d, y: y0 + g * d });
    }
    draw(net, field, options.roadClass ?? 'road_medium', pts, { straight: true });
  });
}

/**
 * 道路のノード (折れ点) が踏切の上・すぐ脇にある配置。
 *
 * 道路は水平のまま平面で折れる。高さで踏切の成立条件を外さないよう、
 * 勾配は付けない (勾配付きは別のシナリオで見る)。
 */
function nodeCrossingScene(distance: number, bendDeg = 14) {
  const y0 = 40;
  const rad = (bendDeg * Math.PI) / 180;
  return buildScene(flat(y0), (net, field) => {
    draw(net, field, 'rail_double', [
      { x: -260, z: 0, y: y0 },
      { x: 260, z: 0, y: y0 },
    ], { straight: true });
    // 踏切から `distance` 離れた所で道路が平面で折れる (= ノードができる)。
    const bend = { x: 0, z: -distance };
    draw(net, field, 'road_medium', [
      { x: 0, z: -distance - 200, y: y0 },
      { x: bend.x, z: bend.z, y: y0 },
      { x: bend.x + Math.sin(rad) * 200, z: bend.z + Math.cos(rad) * 200, y: y0 },
    ], { straight: true });
  });
}

/** 線路のノード (折れ点) が踏切の上・すぐ脇にある配置。 */
function railNodeCrossingScene(distance: number) {
  const y0 = 40;
  return buildScene(flat(y0), (net, field) => {
    draw(net, field, 'rail_single', [
      { x: -260, z: 0, y: y0 },
      { x: distance, z: 0, y: y0 },
      { x: 260, z: 14, y: y0 },
    ], { straight: true });
    draw(net, field, 'road_medium', [
      { x: 0, z: -200, y: y0 },
      { x: 0, z: 200, y: y0 },
    ], { straight: true });
  });
}

/** 交差点のすぐ先 (`distance` m) に踏切がある配置。 */
function junctionCrossingScene(distance: number) {
  const y0 = 40;
  return buildScene(flat(y0), (net, field) => {
    draw(net, field, 'rail_double', [
      { x: -260, z: 0, y: y0 },
      { x: 260, z: 0, y: y0 },
    ], { straight: true });
    // 線路と平行に走る幹線。踏切から distance の所で枝が突き当たる。
    draw(net, field, 'road_medium', [
      { x: -200, z: -distance, y: y0 },
      { x: 200, z: -distance, y: y0 },
    ], { straight: true });
    const hit = net.findSegmentNear(new Vector3(0, y0, -distance), 12)!;
    const node = net.splitSegment(hit.segment, hit.s);
    draw(net, field, 'road_small', [
      { x: node.pos.x, z: node.pos.z, y: node.pos.y },
      { x: node.pos.x, z: 120, y: y0 },
      { x: node.pos.x, z: 220, y: y0 },
    ], { straight: true });
  });
}

/**
 * 曲線の道路が曲線の線路を渡る踏切。
 *
 * 線路に勾配を付ける場合は、交点 (原点付近) がちょうど y0 になるように
 * 経由点の高さを決める。そうしないと高低差 0.25 m を超えて踏切にならない。
 */
function curvedCrossingScene(railGrade: number) {
  const y0 = 40;
  // 経由点 (-40,-60) から交点 (およそ原点) までの水平距離。
  const toCross = Math.hypot(40, 60);
  return buildScene(flat(y0), (net, field) => {
    draw(net, field, 'rail_single', [
      { x: -240, z: -170, y: y0 - railGrade * (toCross + 230) },
      { x: -40, z: -60, y: y0 - railGrade * toCross },
      { x: 160, z: 60, y: y0 + railGrade * 160 },
    ]);
    draw(net, field, 'road_medium', [
      { x: -170, z: 150, y: y0 },
      { x: -70, z: 30, y: y0 },
      { x: 40, z: -80, y: y0 },
    ]);
  });
}

// =====================================================================
// テスト
// =====================================================================

describe('探索', () => {
  it('計測できている', () => {
    const cases: [string, Parameters<typeof crossingScene>[0]][] = [];
    for (const angle of [20, 30, 45, 60, 90]) cases.push([`angle=${angle}`, { angle }]);
    for (const railGrade of [0.01, 0.02, 0.03]) cases.push([`railGrade=${railGrade}`, { railGrade }]);
    for (const angle of [20, 30, 45]) {
      cases.push([`angle=${angle} railGrade=0.03`, { angle, railGrade: 0.03 }]);
    }
    for (const roadGrade of [0.04, 0.08, 0.12]) {
      cases.push([`roadGrade=${roadGrade}`, { roadGrade, roadClass: 'road_small' }]);
      cases.push([`roadGrade=${roadGrade} angle=30`, { roadGrade, angle: 30, roadClass: 'road_small' }]);
    }
    for (const dy of [0.2, -0.2]) cases.push([`dy=${dy}`, { dy }]);
    for (const rc of ['road_small', 'road_medium', 'road_large', 'road_highway']) {
      cases.push([`${rc} angle=20`, { roadClass: rc, angle: 20 }]);
      cases.push([`${rc} angle=20 rail3%`, { roadClass: rc, angle: 20, railGrade: 0.03 }]);
    }
    for (const crest of [0.6, -0.6, 1.5]) cases.push([`railCrest=${crest}`, { railCrest: crest }]);
    for (const crest of [1, -1, 3]) cases.push([`roadCrest=${crest}`, { roadCrest: crest }]);
    for (const rot of [17, 43]) cases.push([`rotate=${rot}`, { rotate: rot }]);
    for (const railClass of ['rail_single', 'rail_yard']) cases.push([railClass, { railClass }]);

    for (const [name, opts] of cases) {
      const scene = crossingScene(opts);
      const n = levelCrossings(scene).length;
      const r = railProudViolations(scene);
      console.log(
        `${name}: 踏切${n} 検査${r.onRoad} proud=[${r.minProud.toFixed(3)}, ${r.maxProud.toFixed(3)}] 違反${r.violations.length}`,
      );
      if (r.violations.length > 0) console.log(summarize('  ', r.violations));
    }
    expect(true).toBe(true);
  }, 120000);

  it('配置の探索', () => {
    const scenes: [string, Scene][] = [
      ['複数踏切 40m 平坦', twinCrossingScene({ gap: 40, roadGrade: 0 })],
      ['複数踏切 40m 道路8%', twinCrossingScene({ gap: 40, roadGrade: 0.08 })],
      ['複数踏切 24m 道路8%', twinCrossingScene({ gap: 24, roadGrade: 0.08 })],
      ['複数踏切 16m 道路8%', twinCrossingScene({ gap: 16, roadGrade: 0.08 })],
      ['複数踏切 12m 道路12%', twinCrossingScene({ gap: 12, roadGrade: 0.12, roadClass: 'road_small' })],
      ['複数踏切 30m 道路12%', twinCrossingScene({ gap: 30, roadGrade: 0.12, roadClass: 'road_small' })],
      ['踏切がノード上', nodeCrossingScene(0)],
      ['踏切がノードの 3m 脇', nodeCrossingScene(3)],
      ['踏切がノードの 10m 脇', nodeCrossingScene(10)],
      ['線路ノードが踏切上', railNodeCrossingScene(0)],
      ['線路ノードが踏切の 5m 脇', railNodeCrossingScene(5)],
      ['交差点の 12m 先に踏切', junctionCrossingScene(12)],
      ['交差点の 20m 先に踏切', junctionCrossingScene(20)],
      ['交差点の 30m 先に踏切', junctionCrossingScene(30)],
      ['曲線の踏切', curvedCrossingScene(0)],
      ['曲線の踏切 (線路 2%)', curvedCrossingScene(0.02)],
    ];
    for (const [name, scene] of scenes) {
      const r = railProudViolations(scene);
      console.log(
        `${name}: 踏切${levelCrossings(scene).length} 検査${r.onRoad} proud=[${r.minProud.toFixed(3)}, ${r.maxProud.toFixed(3)}] 違反${r.violations.length}`,
      );
      if (r.violations.length > 0) console.log(summarize('  ', r.violations));
    }
    expect(true).toBe(true);
  }, 120000);

  it('縦断の探索', () => {
    const scenes: [string, Scene][] = [
      ['直交踏切', crossingScene({})],
      ['直交 dy=0.24', crossingScene({ dy: 0.24 })],
      ['直交 dy=-0.24', crossingScene({ dy: -0.24 })],
      ['道路 8%', crossingScene({ roadGrade: 0.08, roadClass: 'road_small' })],
      ['道路 12%', crossingScene({ roadGrade: 0.12, roadClass: 'road_small' })],
      ['道路 12% + 線路 3%', crossingScene({ roadGrade: 0.12, railGrade: 0.03, roadClass: 'road_small' })],
      ['斜め 20° large 3%', crossingScene({ angle: 20, roadClass: 'road_large', railGrade: 0.03 })],
      ['複数踏切 16m 8%', twinCrossingScene({ gap: 16, roadGrade: 0.08 })],
      ['複数踏切 30m 12%', twinCrossingScene({ gap: 30, roadGrade: 0.12, roadClass: 'road_small' })],
      ['交差点の 20m 先', junctionCrossingScene(20)],
      ['交差点の 12m 先', junctionCrossingScene(12)],
      ['曲線', curvedCrossingScene(0)],
      ['ノードの 3m 脇', nodeCrossingScene(3)],
    ];
    for (const [name, scene] of scenes) {
      const r = roadProfileThroughCrossings(scene);
      console.log(
        `${name}: 検査${r.stations} 最大勾配${(r.maxGrade * 100).toFixed(1)}% 最大段差${(r.maxStep * 100).toFixed(1)}cm 違反${r.violations.length}`,
      );
      if (r.violations.length > 0) console.log(summarize('  ', r.violations));
    }
    expect(true).toBe(true);
  }, 120000);

  it('標示の探索', () => {
    const scenes: [string, Scene][] = [
      ['直交踏切', crossingScene({})],
      ['斜め 30° 線路3%', crossingScene({ angle: 30, railGrade: 0.03 })],
      ['斜め 20° large 3%', crossingScene({ angle: 20, roadClass: 'road_large', railGrade: 0.03 })],
      ['道路 8%', crossingScene({ roadGrade: 0.08, roadClass: 'road_small' })],
      ['曲線', curvedCrossingScene(0)],
      ['交差点の 20m 先', junctionCrossingScene(20)],
      ['複数踏切 16m 8%', twinCrossingScene({ gap: 16, roadGrade: 0.08 })],
      ['ノード上', nodeCrossingScene(0)],
      ['歩道なし (highway)', crossingScene({ roadClass: 'road_highway' })],
    ];
    for (const [name, scene] of scenes) {
      const r = overlayViolations(scene);
      console.log(
        `${name}: 頂点 ${JSON.stringify(r.counts)} 浮き ${Object.entries(r.lift)
          .map(([k, v]) => `${k}[${v[0].toFixed(3)},${v[1].toFixed(3)}]`)
          .join(' ')} 違反${r.violations.length}`,
      );
      if (r.violations.length > 0) console.log(summarize('  ', r.violations));
    }
    expect(true).toBe(true);
  }, 120000);

  it('穴の診断', () => {
    for (const [name, scene] of [
      ['踏切あり', nodeCrossingScene(0)],
      ['踏切なし', buildScene(flat(40), (net, field) => {
        const rad = (14 * Math.PI) / 180;
        draw(net, field, 'road_medium', [
          { x: 0, z: -200, y: 40 },
          { x: 0, z: 0, y: 40 },
          { x: Math.sin(rad) * 200, z: Math.cos(rad) * 200, y: 40 },
        ], { straight: true });
      })],
    ] as [string, Scene][]) {
      console.log('===', name);
      for (const [id, j] of scene.world.junctions) {
        console.log(' junction', id, j.kind, 'rings', j.rings.length, j.ring.length,
          'trims', j.approaches.map((a) => a.trim.toFixed(2)).join(','),
          'openEdge', j.openEdge.map((b) => (b ? 1 : 0)).join(''));
      }
      for (const [id, r] of scene.result.ranges) {
        console.log(' range', id, r.s0.toFixed(2), r.s1.toFixed(2), 'len', scene.network.alignmentOf(id).length.toFixed(2));
      }
      const idx = new SurfaceIndex(scene);
      // 車道の中を細かく走査し、路面 (39.9 以上) が無い所を数える。
      let missing = 0;
      let total = 0;
      const holes: string[] = [];
      for (let z = -6; z <= 6; z += 0.1) {
        for (let x = -6.3; x <= 6.3; x += 0.1) {
          const hs = idx.heightsAt(x, z, 45).filter((v) => v > 39.9);
          total++;
          if (hs.length === 0) {
            missing++;
            if (holes.length < 12) holes.push(`(${x.toFixed(1)}, ${z.toFixed(1)})`);
          }
        }
      }
      console.log(` 路面のない点 ${missing}/${total}`, holes.join(' '));
      console.log(' (6.0,-0.9) の全高さ', idx.heightsAt(6.0, -0.9, 60).map((v) => v.toFixed(3)).join(' '));
      console.log(' (6.0,-0.9) 地形', scene.field.heightAt(6.0, -0.9).toFixed(3));
      let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
      for (let z = -8; z <= 8; z += 0.1) {
        for (let x = -7; x <= 7; x += 0.1) {
          if (idx.heightsAt(x, z, 45).filter((v) => v > 39.9).length > 0) continue;
          bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
          bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
        }
      }
      console.log(` 穴の範囲 x[${bx0.toFixed(1)}, ${bx1.toFixed(1)}] z[${bz0.toFixed(1)}, ${bz1.toFixed(1)}]`);
      for (const j of scene.world.junctions.values()) {
        if (j.rings.length === 0) continue;
        j.rings.forEach((ring, k) =>
          console.log(`  ring${k}`, ring.map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(2)},${p.z.toFixed(1)})`).join(' ')),
        );
      }
      for (let z = 3; z >= -2; z -= 0.4) {
        let row = '';
        for (let x = -10; x <= 10; x += 0.4) {
          row += idx.heightsAt(x, z, 45).filter((v) => v > 39.9).length > 0 ? '#' : '.';
        }
        console.log(`  ${z.toFixed(1).padStart(5)} ${row}`);
      }
    }
    expect(true).toBe(true);
  }, 60000);

  it('境界の探索', () => {
    const cases: [string, Parameters<typeof crossingScene>[0]][] = [];
    for (const angle of [20, 22, 25, 30, 35]) {
      for (const railGrade of [0, 0.015, 0.03]) {
        cases.push([
          `large ${angle}° rail${railGrade}`,
          { roadClass: 'road_large', angle, railGrade },
        ]);
      }
    }
    cases.push(['large 20° single 3%', { roadClass: 'road_large', angle: 20, railGrade: 0.03, railClass: 'rail_single' }]);
    cases.push(['large 20° yard 2%', { roadClass: 'road_large', angle: 20, railGrade: 0.02, railClass: 'rail_yard' }]);
    cases.push(['medium 20° 3% dy0.24', { roadClass: 'road_medium', angle: 20, railGrade: 0.03, dy: 0.24 }]);
    cases.push(['large 20° 3% + road 7%', { roadClass: 'road_large', angle: 20, railGrade: 0.03, roadGrade: 0.07 }]);
    for (const [name, opts] of cases) {
      const scene = crossingScene(opts);
      const r = railProudViolations(scene);
      console.log(
        `${name}: 検査${r.onRoad} proud=[${r.minProud.toFixed(3)}, ${r.maxProud.toFixed(3)}] 違反${r.violations.length}`,
      );
    }
    expect(true).toBe(true);
  }, 120000);
});

/**
 * その配置が「建設ツールで実際に引けるもの」か。
 *
 * 交差角が浅い・道路の勾配が急な踏切は、路面を線路の面に合わせるのに
 * 何十 m もの平坦部が要るので `rules.ts` が禁止している。禁止されている
 * 配置でレールが埋まるのは仕様どおりなので、検査の対象から外す。
 */
function buildableBlockers(scene: Scene): string[] {
  const out: string[] = [];
  for (const seg of scene.network.segments.values()) {
    const check = checkPlacement({
      network: scene.network,
      cls: scene.network.classOf(seg),
      alignment: scene.network.alignmentOf(seg.id),
      start: { pos: scene.network.getNode(seg.a).pos.clone(), node: seg.a },
      end: { pos: scene.network.getNode(seg.b).pos.clone(), node: seg.b },
      ignore: seg.id,
    });
    for (const blocker of check.blockers) out.push(`seg#${seg.id}: ${blocker}`);
  }
  return out;
}

describe('踏切でレールが舗装の上に出ている', () => {
  /**
   * 「敷設できる踏切なら、レールは必ず舗装の上に出ている」ことを、
   * 角度・勾配・種別・配置を振って確かめる。敷設できない配置 (規則が
   * 止めるもの) は、止まっていること自体を確かめる。
   */
  it('引ける配置ではレールが必ず舗装の上に出ており、引けない配置は規則が止める', () => {
    const cases: [string, Scene][] = [];
    for (const angle of [20, 30, 45, 60, 90]) {
      cases.push([`angle=${angle}`, crossingScene({ angle })]);
      cases.push([`angle=${angle} rail3%`, crossingScene({ angle, railGrade: 0.03 })]);
    }
    for (const roadGrade of [0.04, 0.08, 0.12]) {
      cases.push([`road=${roadGrade}`, crossingScene({ roadGrade, roadClass: 'road_small' })]);
      cases.push([
        `road=${roadGrade} angle=30`,
        crossingScene({ roadGrade, angle: 30, roadClass: 'road_small' }),
      ]);
    }
    for (const rc of ['road_small', 'road_medium', 'road_large', 'road_highway']) {
      cases.push([`${rc} rail3%`, crossingScene({ roadClass: rc, railGrade: 0.03 })]);
    }
    for (const dy of [0.2, -0.2]) cases.push([`dy=${dy}`, crossingScene({ dy })]);
    for (const crest of [0.6, -0.6]) cases.push([`railCrest=${crest}`, crossingScene({ railCrest: crest })]);
    for (const crest of [1, -1]) cases.push([`roadCrest=${crest}`, crossingScene({ roadCrest: crest })]);
    for (const rot of [17, 43]) cases.push([`rotate=${rot}`, crossingScene({ rotate: rot })]);
    for (const railClass of ['rail_single', 'rail_yard']) {
      cases.push([railClass, crossingScene({ railClass })]);
    }
    cases.push(['複数踏切 40m', twinCrossingScene({ gap: 40, roadGrade: 0 })]);
    cases.push(['複数踏切 16m', twinCrossingScene({ gap: 16, roadGrade: 0 })]);
    cases.push(['踏切がノード上', nodeCrossingScene(0)]);
    cases.push(['踏切がノードの 3m 脇', nodeCrossingScene(3)]);
    cases.push(['線路ノードが踏切上', railNodeCrossingScene(0)]);
    cases.push(['交差点の 20m 先に踏切', junctionCrossingScene(20)]);
    cases.push(['曲線の踏切', curvedCrossingScene(0)]);

    const problems: string[] = [];
    let buildable = 0;
    let blocked = 0;
    let checked = 0;
    for (const [name, scene] of cases) {
      expect(levelCrossings(scene).length, `${name}: 踏切ができていない`).toBeGreaterThan(0);
      const blockers = buildableBlockers(scene);
      if (blockers.length > 0) {
        blocked++;
        continue;
      }
      buildable++;
      const r = railProudViolations(scene);
      checked += r.onRoad;
      if (r.violations.length > 0) problems.push(summarize(name, r.violations));
    }
    // 空振り防止: 引ける配置が十分あり、実際に測れていること。
    expect(buildable, '引ける配置が少なすぎる').toBeGreaterThan(20);
    expect(blocked, '規則が止める配置が 1 つもない (規則が効いていない)').toBeGreaterThan(2);
    expect(checked, '舗装の上の検査点が少なすぎる').toBeGreaterThan(2000);
    expect(problems.join('\n')).toBe('');
  }, 300000);
});
