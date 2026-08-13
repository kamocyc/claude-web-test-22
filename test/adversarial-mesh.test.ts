import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector3 } from 'three';
import { buildDemoNetwork } from '../src/app/demo';
import { applyRailBlend, computeRailBlend, type RailBlend } from '../src/build/crossing';
import { RAIL_TOP_TO_BALLAST, profileFor, profilePointAt } from '../src/build/surface';
import { earcutXZ } from '../src/core/meshbuilder';
import { SURFACE_LIFT, clamp } from '../src/core/units';
import { getClass } from '../src/network/classes';
import {
  anchorFromNode,
  computePlacement,
  placeSegment,
  type Anchor,
} from '../src/network/editing';
import { Network, type SegmentId } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';

/**
 * 敵対的検証: 高低差のあるところで「メッシュが離れる」「線路が埋まる」が
 * 起きないことを、具体的な数値の不変条件で確かめる。
 *
 * デモ配置だけでは踏まない組み合わせ (急勾配の取り付き、斜め踏切、
 * 分岐器と踏切の重なり、切土・盛土の斜面上の交差点) を自前の地形の上に
 * 作って追い込む。
 */

// =====================================================================
// 足場
// =====================================================================

interface Waypoint {
  x: number;
  z: number;
  y?: number;
}

/** demo.ts の draw() と同じ手順 (エクスポートされていないのでコピー)。 */
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

/** 地形を関数で与えて、ネットワークを組み、組み立てパイプライン全体を回す。 */
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
/** X 方向に一定勾配で登る斜面。 */
const rampX = (y0: number, slope: number) => (x: number) => y0 + slope * x;
/** Z 方向に一定勾配で登る斜面。 */
const rampZ = (y0: number, slope: number) => (_x: number, z: number) => y0 + slope * z;
/** x > 0 側だけが落ち込む崖 (橋の端を作る)。 */
const cliffX = (y0: number, drop: number, run: number) => (x: number) =>
  y0 - (clamp(x, 0, run) / run) * drop;

// =====================================================================
// 幾何のヘルパ
// =====================================================================

/**
 * 線路セグメントごとの踏切ブレンド。`WorldBuilder.collectRailBlends` と
 * 同じ組み立て (ノードを越えて隣のセグメントへ伝える分も含む)。
 *
 * ここが実装とずれると帯の高さを取り違えるので、`ribbonMatchesMesh` で
 * 実メッシュと突き合わせて裏を取っている。
 */
function railBlendsOf(scene: Scene): Map<SegmentId, RailBlend[]> {
  const network = scene.network;
  const map = new Map<SegmentId, RailBlend[]>();
  const add = (segment: SegmentId, blend: RailBlend): void => {
    const list = map.get(segment) ?? [];
    list.push(blend);
    map.set(segment, list);
  };
  const spills: { segment: SegmentId; blend: RailBlend }[] = [];

  for (const crossing of scene.world.crossings) {
    if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
    const blend = computeRailBlend(crossing, network.alignmentOf(crossing.road.segment));
    add(blend.segment, blend);

    const seg = network.segments.get(blend.segment);
    if (!seg) continue;
    const length = network.alignmentOf(blend.segment).length;
    const spill = (nodeId: number, distance: number): void => {
      if (distance >= blend.halfLength) return;
      const node = network.nodes.get(nodeId);
      if (!node) return;
      for (const otherId of node.segments) {
        if (otherId === blend.segment) continue;
        const other = network.segments.get(otherId);
        if (!other || network.classOf(other).kind !== 'rail') continue;
        const s =
          other.a === nodeId ? -distance : network.alignmentOf(otherId).length + distance;
        spills.push({
          segment: otherId,
          blend: { s, deltaY: blend.deltaY, halfLength: blend.halfLength },
        });
      }
    };
    spill(seg.a, blend.s);
    spill(seg.b, length - blend.s);
  }
  for (const { segment, blend } of spills) add(segment, blend);
  return map;
}

/** 描画に使われるサンプル (線路なら踏切ブレンド込み)。 */
function drawnSampleAt(scene: Scene, segment: SegmentId, s: number, blends = railBlendsOf(scene)) {
  const cls = scene.network.classOf(scene.network.getSegment(segment));
  const raw = scene.network.alignmentOf(segment).sampleAt(s);
  if (cls.kind !== 'rail') return raw;
  return applyRailBlend([raw], blends.get(segment) ?? [])[0];
}

/** セグメント帯の端 (トリム位置) の横断面をワールド展開する。 */
function ribbonEndSection(scene: Scene, segment: SegmentId, atStart: boolean): Vector3[] {
  const range = scene.result.ranges.get(segment)!;
  const cls = scene.network.classOf(scene.network.getSegment(segment));
  const sample = drawnSampleAt(scene, segment, atStart ? range.s0 : range.s1);
  return profileFor(cls).map((p) => profilePointAt(sample, p.offset, p.height, new Vector3()));
}

/**
 * 地表区間のサンプル列 (橋・トンネルを除く)。
 *
 * 既定で区間の端から 4 m を除く。橋台・坑口では整地の伝播が遮断されて
 * 地形が垂直に切り立つ仕様で、地形格子 (2 m) の線形補間により 1 セル分は
 * 路面より上に出るのが正常だから (world.test.ts の地表判定も同じ理由で
 * 4 m 内側を見ている)。
 */
function groundStations(scene: Scene, segment: SegmentId, step = 2, inset = 4): number[] {
  const out: number[] = [];
  for (const run of scene.result.structures.get(segment) ?? []) {
    if (run.mode !== 'ground') continue;
    for (let s = run.s0 + inset; s <= run.s1 - inset; s += step) out.push(s);
  }
  return out;
}

/** 道路の中心線を粗く折れ線化したもの (舗装に覆われているかの判定用)。 */
function roadPolylines(scene: Scene) {
  const out: { cls: ReturnType<Network['classOf']>; pts: Vector3[]; rights: Vector3[] }[] = [];
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    if (cls.kind !== 'road') continue;
    const al = scene.network.alignmentOf(seg.id);
    const range = scene.result.ranges.get(seg.id)!;
    const n = Math.max(2, Math.ceil((range.s1 - range.s0)));
    const pts: Vector3[] = [];
    const rights: Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const sample = al.sampleAt(range.s0 + ((range.s1 - range.s0) * i) / n);
      pts.push(sample.pos.clone());
      rights.push(sample.right.clone());
    }
    out.push({ cls, pts, rights });
  }
  return out;
}

/**
 * その位置が道路の舗装に覆われているか。覆っているなら舗装面の高さを返す。
 * 「レールが地形に埋まっている」判定から、踏切の舗装の下を外すのに使う
 * (舗装の下でレールが隠れるのは仕様)。
 */
function roadSurfaceAt(
  roads: ReturnType<typeof roadPolylines>,
  x: number,
  z: number,
): number | null {
  for (const road of roads) {
    for (let i = 0; i < road.pts.length; i++) {
      const p = road.pts[i];
      const dx = x - p.x;
      const dz = z - p.z;
      if (Math.abs(dx) > 60 || Math.abs(dz) > 60) continue;
      const r = road.rights[i];
      const lateral = Math.abs(dx * r.x + dz * r.z);
      const along = Math.abs(dx * -r.z + dz * r.x);
      if (lateral <= road.cls.halfWidth && along <= 1.0) return p.y + SURFACE_LIFT;
    }
  }
  return null;
}

/**
 * 多角形 (交差点の車道リング) を earcut で三角形分割し、点 (x, z) を含む
 * 三角形から面の高さを補間して返す。描画 (fillPolygon) と同じ分割なので、
 * 「実際に描かれている交差点面の高さ」がそのまま得られる。外なら null。
 */
function polygonSurfaceY(ring: Vector3[], x: number, z: number): number | null {
  if (ring.length < 3) return null;
  const flat: number[] = [];
  for (const p of ring) flat.push(p.x, p.z);
  const tris = earcutXZ(flat);
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

/** 交差点面 (リング) を持つノードの数。判定が空振りしていないかの確認に使う。 */
function ringJunctionCount(scene: Scene): number {
  let n = 0;
  for (const j of scene.world.junctions.values()) if (j.rings.length > 0) n++;
  return n;
}

interface Violation {
  amount: number;
  where: Vector3;
  what: string;
}

function summarize(name: string, list: Violation[]): string {
  if (list.length === 0) return `${name}: 違反なし`;
  const top = [...list].sort((a, b) => b.amount - a.amount).slice(0, 5);
  return (
    `${name}: ${list.length} 件, 最大 ${top[0].amount.toFixed(3)} m\n` +
    top
      .map(
        (v) =>
          `    ${v.amount.toFixed(3)} m @ (${v.where.x.toFixed(1)}, ${v.where.z.toFixed(1)}) ${v.what}`,
      )
      .join('\n')
  );
}

/** 違反があれば内容を添えて落とす。 */
function expectNoViolation(name: string, list: Violation[]): void {
  expectAllClean([[name, list]]);
}

/**
 * 複数の観点をまとめて判定する。1 つ目で止めずに全部出すので、
 * どのシナリオがどれだけずれているかが 1 回の実行で分かる。
 */
function expectAllClean(entries: [string, Violation[]][]): void {
  const actual = entries.map(([name, list]) => summarize(name, list)).join('\n');
  const expected = entries.map(([name]) => `${name}: 違反なし`).join('\n');
  expect(actual).toBe(expected);
}

// =====================================================================
// 不変条件
// =====================================================================

/**
 * (1) 交差点面とセグメント帯の継ぎ目。
 *
 * 交差点面はトリム位置の横断面を通るので、セグメント帯の端の断面点は
 * 交差点面のリング頂点と 1 点ずつ共有されているはず。1 cm 以上ずれて
 * いれば、そのぶん帯と面の間が開いて地面や空が見える。
 *
 * 交差点面がないノード (継ぎ目 = seam) では、両側の帯が直接突き合わさる。
 * seam は偏角 2° 未満を「一直線」とみなす仕様なので、水平方向には
 * 半幅 × 2° (数 cm) のくさび形の隙間が残りうる。それは仕様の範囲なので、
 * ここでは高さのずれだけを見る (断面は左右対称なので、片方の i 番目と
 * もう片方の末尾から i 番目が対応する)。
 */
function seamViolations(scene: Scene, tolerance = 0.01): Violation[] {
  const out: Violation[] = [];
  for (const [id, junction] of scene.world.junctions) {
    const ringPts: Vector3[] = [];
    for (const ring of junction.rings) {
      for (const p of ring) ringPts.push(new Vector3(p.x, p.y + SURFACE_LIFT, p.z));
    }
    const sections = junction.approaches.map((ap) =>
      ribbonEndSection(scene, ap.branch.segment, ap.branch.atStart),
    );

    if (ringPts.length > 0) {
      sections.forEach((section, i) => {
        for (const p of section) {
          let best = Infinity;
          for (const q of ringPts) best = Math.min(best, p.distanceTo(q));
          if (best > tolerance) {
            out.push({
              amount: best,
              where: p,
              what: `交差点面と帯: node=${id} kind=${junction.kind} seg=${junction.approaches[i].branch.segment}`,
            });
          }
        }
      });
      continue;
    }

    if (sections.length !== 2) continue;
    const [a, b] = sections;
    if (a.length !== b.length) continue;
    for (let i = 0; i < a.length; i++) {
      const dy = Math.abs(a[i].y - b[b.length - 1 - i].y);
      if (dy > tolerance) {
        out.push({
          amount: dy,
          where: a[i],
          what: `帯どうしの段差: node=${id} kind=${junction.kind} ${a[i].y.toFixed(2)} vs ${b[b.length - 1 - i].y.toFixed(2)}`,
        });
      }
    }
  }
  return out;
}

/**
 * (2) レール頭頂面より上に地形が来ていないか。
 *
 * 線形の Y はレール頭頂面で、描画高は Y + SURFACE_LIFT。舗装に覆われて
 * いる所 (踏切の中) はレールが隠れて当然なので除外する。
 */
function railBuriedViolations(scene: Scene, tolerance = 0.05): Violation[] {
  const out: Violation[] = [];
  const roads = roadPolylines(scene);
  const blends = railBlendsOf(scene);
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    if (cls.kind !== 'rail') continue;
    for (const s of groundStations(scene, seg.id, 1.5)) {
      const sample = drawnSampleAt(scene, seg.id, s, blends);
      const railTop = sample.pos.y + SURFACE_LIFT;
      for (const offset of cls.tracks) {
        for (const d of [-0.72, 0, 0.72]) {
          const x = sample.pos.x + sample.right.x * (offset + d);
          const z = sample.pos.z + sample.right.z * (offset + d);
          if (roadSurfaceAt(roads, x, z) !== null) continue;
          const terrain = scene.field.heightAt(x, z);
          if (terrain - railTop > tolerance) {
            out.push({
              amount: terrain - railTop,
              where: new Vector3(x, terrain, z),
              what: `レールが埋まる: seg=${seg.id} s=${s.toFixed(1)} 頭頂面=${railTop.toFixed(2)} 地形=${terrain.toFixed(2)}`,
            });
          }
        }
      }
    }
  }
  return out;
}

/** 踏切で「舗装に譲る」範囲 (worldBuilder の CrossingZone と同じ計算)。 */
function crossingZonesOf(scene: Scene): Map<SegmentId, { s: number; inner: number; shoulder: number }[]> {
  const map = new Map<SegmentId, { s: number; inner: number; shoulder: number }[]>();
  for (const crossing of scene.world.crossings) {
    if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
    const rail = crossing.rail;
    const road = crossing.road;
    const sinTheta = Math.abs(road.dir.x * rail.dir.y - road.dir.y * rail.dir.x);
    const skew = 1 / Math.max(0.26, sinTheta);
    // worldBuilder の CrossingZone と同じ値にしておく (舗装 + 1 m が inner、
    // そこから 3 m = CROSSING_SHOULDER_RAMP で道床天端まで擦り付ける)。
    const inner = (road.cls.halfWidth + 1) * skew;
    const list = map.get(rail.segment) ?? [];
    list.push({ s: rail.s, inner, shoulder: inner + 3 });
    map.set(rail.segment, list);
  }
  return map;
}

/**
 * (3) 道床天端より上に地形が来ていないか。
 * 踏切の舗装とその擦り付け区間は、道床が隠れる仕様なので除外する。
 */
function ballastBuriedViolations(scene: Scene, tolerance = 0.05): Violation[] {
  const out: Violation[] = [];
  const zones = crossingZonesOf(scene);
  const blends = railBlendsOf(scene);
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    if (cls.kind !== 'rail') continue;
    const top = Math.max(...cls.tracks.map(Math.abs)) + 1.7;
    const list = zones.get(seg.id) ?? [];
    for (const s of groundStations(scene, seg.id, 1.5)) {
      if (list.some((z) => Math.abs(s - z.s) <= z.shoulder)) continue;
      const sample = drawnSampleAt(scene, seg.id, s, blends);
      const ballastTop = sample.pos.y - RAIL_TOP_TO_BALLAST + SURFACE_LIFT;
      for (const offset of [-top + 0.2, 0, top - 0.2]) {
        const x = sample.pos.x + sample.right.x * offset;
        const z = sample.pos.z + sample.right.z * offset;
        const terrain = scene.field.heightAt(x, z);
        if (terrain - ballastTop > tolerance) {
          out.push({
            amount: terrain - ballastTop,
            where: new Vector3(x, terrain, z),
            what: `道床が埋まる: seg=${seg.id} s=${s.toFixed(1)} 天端=${ballastTop.toFixed(2)} 地形=${terrain.toFixed(2)}`,
          });
        }
      }
    }
  }
  return out;
}

/** (4) 車道面より上に地形が来ていないか。 */
function roadBuriedViolations(scene: Scene, tolerance = 0.05): Violation[] {
  const out: Violation[] = [];
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    if (cls.kind !== 'road') continue;
    const cw = cls.carriagewayHalfWidth;
    for (const s of groundStations(scene, seg.id, 2)) {
      const sample = scene.network.alignmentOf(seg.id).sampleAt(s);
      const surfaceY = sample.pos.y + SURFACE_LIFT;
      for (const offset of [-cw + 0.2, 0, cw - 0.2]) {
        const x = sample.pos.x + sample.right.x * offset;
        const z = sample.pos.z + sample.right.z * offset;
        const terrain = scene.field.heightAt(x, z);
        if (terrain - surfaceY > tolerance) {
          out.push({
            amount: terrain - surfaceY,
            where: new Vector3(x, terrain, z),
            what: `車道が埋まる: seg=${seg.id} s=${s.toFixed(1)} 路面=${surfaceY.toFixed(2)} 地形=${terrain.toFixed(2)}`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * (5) 交差点面より上に地形が来ていないか。
 *
 * 面の高さは描画と同じ earcut 分割から補間するので、「実際に描かれている
 * 交差点面」との比較になる。多角形の外に出た点は評価しない。
 *
 * 評価するのは**地形の格子点そのもの**。格子点の値は整地の焼き込み結果
 * そのままなので、格子 (2 m) の補間誤差が混ざらず、整地の目標高さが
 * 間違っている場合だけを捉えられる。
 * (格子点の間では、勾配のきつい交差点で最大 0.2 m 程度は面より上に出うる。
 *  これは高さ場の解像度による量子化で、整地の目標が正しくても避けられない。)
 */
function junctionBuriedViolations(scene: Scene, tolerance = 0.05): Violation[] {
  const out: Violation[] = [];
  const f = scene.field;
  for (const junction of scene.world.junctions.values()) {
    const inner = junction.rings[junction.rings.length - 1];
    if (!inner || inner.length < 3) continue;
    const lifted = inner.map((p) => new Vector3(p.x, p.y + SURFACE_LIFT, p.z));
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of lifted) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const ix0 = Math.max(0, Math.ceil(f.toGridX(minX)));
    const ix1 = Math.min(f.cells, Math.floor(f.toGridX(maxX)));
    const iz0 = Math.max(0, Math.ceil(f.toGridZ(minZ)));
    const iz1 = Math.min(f.cells, Math.floor(f.toGridZ(maxZ)));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = f.worldX(ix);
        const z = f.worldZ(iz);
        const surfaceY = polygonSurfaceY(lifted, x, z);
        if (surfaceY === null) continue;
        const terrain = f.work[f.index(ix, iz)];
        if (terrain - surfaceY > tolerance) {
          out.push({
            amount: terrain - surfaceY,
            where: new Vector3(x, terrain, z),
            what: `交差点面が埋まる: node=${junction.node} kind=${junction.kind} 面=${surfaceY.toFixed(2)} 地形=${terrain.toFixed(2)}`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * 実際に描かれた路面メッシュ (`world.group` の `surfaces`) から、指定した
 * XZ にある頂点の最も低い Y を引く索引。
 *
 * 垂れ壁の下端がどこまで伸びているかを、実装の定数 (SURFACE_SKIRT など) に
 * 依存せずに測るために使う。垂れ壁は路端の真下に押し出されるので、路端と
 * 同じ XZ にある頂点のうち最も低いものが下端になる。
 */
class SurfaceFloor {
  private readonly buckets = new Map<string, number[]>();
  private readonly cell = 0.25;

  constructor(scene: Scene) {
    const mesh = scene.world.group.getObjectByName('surfaces') as
      | { geometry: { attributes: { position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } } }
      | undefined;
    const pos = mesh?.geometry.attributes.position;
    if (!pos) throw new Error('surfaces メッシュが見つからない');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const key = `${Math.round(x / this.cell)},${Math.round(z / this.cell)}`;
      const list = this.buckets.get(key);
      if (list) list.push(x, y, z);
      else this.buckets.set(key, [x, y, z]);
    }
  }

  /** (x, z) にいちばん近い頂点の XZ。半径内に無ければ null。 */
  nearestVertexXZ(x: number, z: number, radius = 0.15): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bestD = radius * radius;
    const cx = Math.round(x / this.cell);
    const cz = Math.round(z / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const d = (list[i] - x) ** 2 + (list[i + 2] - z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = { x: list[i], z: list[i + 2] };
          }
        }
      }
    }
    return best;
  }

  /** (x, z) のほぼ真上にある頂点の最高 Y。見つからなければ null。 */
  highestAt(x: number, z: number, radius = 0.05): number | null {
    let best: number | null = null;
    const cx = Math.round(x / this.cell);
    const cz = Math.round(z / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          if (Math.abs(list[i] - x) > radius || Math.abs(list[i + 2] - z) > radius) continue;
          if (best === null || list[i + 1] > best) best = list[i + 1];
        }
      }
    }
    return best;
  }

  /** (x, z) のほぼ真下にある頂点の最低 Y。見つからなければ null。 */
  lowestAt(x: number, z: number, radius = 0.05): number | null {
    let best: number | null = null;
    const cx = Math.round(x / this.cell);
    const cz = Math.round(z / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          if (Math.abs(list[i] - x) > radius || Math.abs(list[i + 2] - z) > radius) continue;
          if (best === null || list[i + 1] < best) best = list[i + 1];
        }
      }
    }
    return best;
  }
}

/**
 * (6) 路端の下に、地形まで届く面があるか。
 *
 * 路面の縁からは垂れ壁が下りている。その下端 (実メッシュの頂点から取る) が
 * 整地後の地形より上にあると、路肩の下に隙間が抜けて見える。
 * 判定は「下端 − 地形 > 許容値」。許容値 0.05 m は、頂点が Float32 で
 * 丸められることと、地形が格子 (2 m) の線形補間であることの余裕。
 */
function skirtGapViolations(scene: Scene, tolerance = 0.05): Violation[] {
  const out: Violation[] = [];
  const floor = new SurfaceFloor(scene);
  const blends = railBlendsOf(scene);
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    const edge = profileFor(cls)[0];
    // 帯の頂点がどの弧長に置かれるかは実装 (サンプル間隔) 次第なので、
    // 細かく歩いて「メッシュの頂点がある所」だけを評価する。
    for (const s of groundStations(scene, seg.id, 0.5)) {
      const sample = drawnSampleAt(scene, seg.id, s, blends);
      for (const side of [-1, 1]) {
        const p = profilePointAt(sample, side * Math.abs(edge.offset), edge.height, new Vector3());
        const vertex = floor.nearestVertexXZ(p.x, p.z);
        if (!vertex) continue;
        const bottom = floor.lowestAt(vertex.x, vertex.z);
        if (bottom === null) continue;
        const terrain = scene.field.heightAt(vertex.x, vertex.z);
        if (bottom - terrain > tolerance) {
          out.push({
            amount: bottom - terrain,
            where: new Vector3(p.x, terrain, p.z),
            what: `路端に穴: seg=${seg.id} s=${s.toFixed(1)} 路端=${p.y.toFixed(2)} 垂れ壁下端=${bottom.toFixed(2)} 地形=${terrain.toFixed(2)}`,
          });
        }
      }
    }
  }
  return out;
}

/** (7) 交差点の外周でも、垂れ壁の下端が地形に届いているか。 */
function junctionSkirtGapViolations(scene: Scene, tolerance = 0.05): Violation[] {
  const out: Violation[] = [];
  const floor = new SurfaceFloor(scene);
  for (const junction of scene.world.junctions.values()) {
    const ring = junction.ring;
    if (ring.length < 3) continue;
    const node = scene.network.getNode(junction.node);
    // 橋・トンネルの上の交差点は地形を切らない (遮断する) 仕様なので除く。
    if (Math.abs(node.pos.y - scene.field.baseHeightAt(node.pos.x, node.pos.z)) > 6) continue;
    for (const p of ring) {
      const top = p.y + SURFACE_LIFT;
      const bottom = floor.lowestAt(p.x, p.z);
      if (bottom === null) continue;
      const terrain = scene.field.heightAt(p.x, p.z);
      if (bottom - terrain > tolerance) {
        out.push({
          amount: bottom - terrain,
          where: new Vector3(p.x, terrain, p.z),
          what: `交差点外周に穴: node=${junction.node} kind=${junction.kind} 外周=${top.toFixed(2)} 垂れ壁下端=${bottom.toFixed(2)} 地形=${terrain.toFixed(2)}`,
        });
      }
    }
  }
  return out;
}

/**
 * (0) 検査コードの自己点検。
 *
 * この検査群は「帯の高さ」を線形 + 断面 + 踏切のレール高補正から自分で
 * 計算している。その計算が実装とずれると、実際には無い段差を報告して
 * しまう (実際に一度やった: 補正のノード越しの伝播を写していなかった)。
 * そこで、計算した帯の縁の高さが**実メッシュの頂点**と一致することを
 * 確かめる。
 *
 * 許容 0.03 m の根拠: 頂点は 2.5 m 間隔なので、細かく歩いて最寄りの頂点に
 * スナップすると弧長で最大 0.25 m ずれる。その間の高さの変化は、勾配 3% で
 * 0.008 m、踏切のレール高補正の傾き (0.27 m / 9 m) でも 0.008 m 程度。
 */
function harnessDriftViolations(scene: Scene, tolerance = 0.03): Violation[] {
  const out: Violation[] = [];
  const floor = new SurfaceFloor(scene);
  const blends = railBlendsOf(scene);
  let compared = 0;
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    const edge = profileFor(cls)[0];
    for (const s of groundStations(scene, seg.id, 1)) {
      const sample = drawnSampleAt(scene, seg.id, s, blends);
      for (const side of [-1, 1]) {
        const p = profilePointAt(sample, side * Math.abs(edge.offset), edge.height, new Vector3());
        const vertex = floor.nearestVertexXZ(p.x, p.z, 0.06);
        if (!vertex) continue;
        const top = floor.highestAt(vertex.x, vertex.z);
        if (top === null) continue;
        compared++;
        if (Math.abs(top - p.y) > tolerance) {
          out.push({
            amount: Math.abs(top - p.y),
            where: p,
            what: `検査側の帯の高さが実メッシュとずれている: seg=${seg.id} s=${s.toFixed(1)} 計算=${p.y.toFixed(3)} メッシュ=${top.toFixed(3)}`,
          });
        }
      }
    }
  }
  // 1 点も突き合わせできていなければ、この点検自体が空振りしている。
  if (compared < 20) {
    out.push({
      amount: compared,
      where: new Vector3(),
      what: `突き合わせできた点が ${compared} 個しかない (点検が空振り)`,
    });
  }
  return out;
}

// =====================================================================
// シナリオ
// =====================================================================

/** 平坦な幹線に、勾配 `grade` で降りてくる生活道路が突き当たる T 字。 */
function teeScene(grade: number, main = 'road_medium') {
  return buildScene(flat(20), (net, field) => {
    draw(net, field, main, [
      { x: -200, z: 0, y: 20 },
      { x: 200, z: 0, y: 20 },
    ], { straight: true });
    const hit = net.findSegmentNear(new Vector3(0, 0, 0), 10)!;
    const node = net.splitSegment(hit.segment, hit.s);
    draw(net, field, 'road_small', [
      { x: node.pos.x, z: 0, y: node.pos.y },
      { x: node.pos.x, z: 80, y: node.pos.y + grade * 80 },
      { x: node.pos.x, z: 160, y: node.pos.y + grade * 160 },
      { x: node.pos.x, z: 240, y: node.pos.y + grade * 240 },
    ], { straight: true });
  });
}

/** 4 叉路。`main` を東西に、`cross` を角度 `deg` で通し、自動交差点にまとめる。 */
function fourWayScene(options: {
  main: string;
  cross: string;
  deg: number;
  crossGrade?: number;
  terrain?: (x: number, z: number) => number;
  y?: number;
}) {
  const y = options.y ?? 20;
  const grade = options.crossGrade ?? 0;
  const rad = (options.deg * Math.PI) / 180;
  return buildScene(options.terrain ?? flat(y), (net, field) => {
    draw(net, field, options.main, [
      { x: -220, z: 0, y },
      { x: 220, z: 0, y },
    ], { straight: true });
    const pts: Waypoint[] = [];
    for (const d of [-220, -110, 110, 220]) {
      pts.push({ x: Math.cos(rad) * d, z: Math.sin(rad) * d, y: y + grade * d });
    }
    draw(net, field, options.cross, pts, { straight: true });
  });
}

/**
 * 踏切。
 *
 * `angle` は**線路と道路のなす角**  (90 = 直交、30〜60 = 斜め踏切)。
 * `rotate` はシーン全体をワールドで回す角度で、地形格子 (軸に平行) に対して
 * 斜めに置いたときの量子化の影響を見るために分けてある。
 * `roadGrade` を与えると、交点をちょうど線路高で通る勾配のある道路になる。
 */
function crossingScene(options: {
  angle?: number;
  rotate?: number;
  roadGrade?: number;
  railClass?: string;
  roadClass?: string;
  terrain?: (x: number, z: number) => number;
  railY?: number;
}) {
  const railY = options.railY ?? 20;
  const grade = options.roadGrade ?? 0;
  const rot = ((options.rotate ?? 0) * Math.PI) / 180;
  const angle = ((options.angle ?? 90) * Math.PI) / 180;
  const rail = { x: Math.sin(rot), z: Math.cos(rot) };
  const road = { x: Math.sin(rot + angle), z: Math.cos(rot + angle) };
  return buildScene(options.terrain ?? flat(railY), (net, field) => {
    draw(net, field, options.railClass ?? 'rail_double', [
      { x: -rail.x * 260, z: -rail.z * 260, y: railY },
      { x: rail.x * 260, z: rail.z * 260, y: railY },
    ], { straight: true });
    const pts: Waypoint[] = [];
    for (const d of [-240, -120, -50, 50, 120, 240]) {
      pts.push({ x: road.x * d, z: road.z * d, y: railY + grade * d });
    }
    draw(net, field, options.roadClass ?? 'road_medium', pts, { straight: true });
  });
}

/**
 * 本線から側線へ分岐する分岐器。`crossingAt` を与えると、分岐ノードから
 * その Z だけ離れた所に踏切を作る (踏切のレール高補正と分岐器の干渉を見る)。
 */
function turnoutScene(options: {
  mainGrade?: number;
  yardGrade?: number;
  crossingAt?: number;
  crossingDy?: number;
}) {
  const y0 = 30;
  const mg = options.mainGrade ?? 0;
  const yg = options.yardGrade ?? 0;
  return buildScene(flat(y0), (net, field) => {
    draw(net, field, 'rail_double', [
      { x: 0, z: -300, y: y0 - mg * 300 },
      { x: 0, z: 300, y: y0 + mg * 300 },
    ], { straight: true });
    const hit = net.findSegmentNear(new Vector3(0, 0, 0), 10)!;
    const node = net.splitSegment(hit.segment, hit.s);
    draw(net, field, 'rail_yard', [
      { x: node.pos.x, z: node.pos.z, y: node.pos.y },
      { x: 20, z: node.pos.z + 120, y: node.pos.y + yg * 120 },
      { x: 70, z: node.pos.z + 240, y: node.pos.y + yg * 240 },
    ]);
    if (options.crossingAt !== undefined) {
      const railSample = net.findSegmentNear(new Vector3(0, 0, options.crossingAt), 20)!;
      const roadY = railSample.pos.y + (options.crossingDy ?? 0);
      draw(net, field, 'road_medium', [
        { x: -160, z: options.crossingAt, y: roadY },
        { x: 160, z: options.crossingAt, y: roadY },
      ], { straight: true });
    }
  });
}

/** 線路の継ぎ目 (ノード) のすぐ脇に踏切がある配置。 */
function seamNearCrossingScene(distance: number, dy = 0.2) {
  return buildScene(flat(30), (net, field) => {
    // 折れ点にして継ぎ目ノードを作る (完全な直線だと 1 本のままになる)。
    draw(net, field, 'rail_single', [
      { x: 0, z: -300, y: 30 },
      { x: 0, z: 0, y: 30 },
      { x: 6, z: 300, y: 30 },
    ], { straight: true });
    draw(net, field, 'road_medium', [
      { x: -160, z: distance, y: 30 + dy },
      { x: 160, z: distance, y: 30 + dy },
    ], { straight: true });
  });
}

/** 橋の取り付き (崖の縁) のすぐ手前に交差点がある配置。 */
function junctionNearBridgeScene() {
  return buildScene(cliffX(40, 34, 45), (net, field) => {
    draw(net, field, 'road_medium', [
      { x: -220, z: 0, y: 40 },
      { x: 220, z: 0, y: 40 },
    ], { straight: true });
    const hit = net.findSegmentNear(new Vector3(-8, 0, 0), 12)!;
    const node = net.splitSegment(hit.segment, hit.s);
    draw(net, field, 'road_small', [
      { x: node.pos.x, z: 0, y: node.pos.y },
      { x: node.pos.x - 20, z: 120, y: node.pos.y },
      { x: node.pos.x - 40, z: 240, y: node.pos.y },
    ], { straight: true });
  });
}

/** デモ配置 (回帰の基準)。 */
function demoScene(): Scene {
  const field = new Heightfield();
  generateTerrain(field, DEFAULT_TERRAIN);
  const network = new Network();
  buildDemoNetwork(network, field);
  const terrainMesh = new TerrainMesh(field, new MeshBasicMaterial());
  const world = new WorldBuilder(network, field, terrainMesh);
  return { field, network, world, result: world.rebuild() };
}

// =====================================================================
// テスト
// =====================================================================

describe('検査コードの自己点検', () => {
  it('検査側が計算する帯の高さが、実際のメッシュの頂点と一致する', () => {
    expectAllClean([
      ['T 字 (12%)', harnessDriftViolations(teeScene(0.12))],
      ['直交踏切', harnessDriftViolations(crossingScene({}))],
      ['斜め踏切 (30°)', harnessDriftViolations(crossingScene({ angle: 30 }))],
      [
        '踏切の脇の継ぎ目',
        harnessDriftViolations(seamNearCrossingScene(4)),
      ],
      ['分岐器 + 踏切', harnessDriftViolations(turnoutScene({ crossingAt: 35, crossingDy: 0.2 }))],
      ['デモ配置', harnessDriftViolations(demoScene())],
    ]);
  }, 30000);
});

describe('交差点面とセグメント帯の継ぎ目 (高低差あり)', () => {
  it('急勾配の枝が平坦な幹線に突き当たる T 字で、帯の断面点が交差点面と共有される', () => {
    const scene = teeScene(0.12);
    // 判定が空振りしていないこと (交差点面が実際にできていること)。
    expect(ringJunctionCount(scene)).toBeGreaterThan(0);
    expectNoViolation('継ぎ目 (12% の枝)', seamViolations(scene));
  });

  it('幅の違う道路の十字 (鋭角・鈍角) で継ぎ目が開かない', () => {
    expectAllClean(
      [30, 55, 90, 125].map((deg) => {
        const scene = fourWayScene({ main: 'road_large', cross: 'road_small', deg });
        expect(ringJunctionCount(scene)).toBeGreaterThan(0);
        return [`継ぎ目 (large×small ${deg}°)`, seamViolations(scene)] as [string, Violation[]];
      }),
    );
  });

  it('歩道の有無が違う道路 (highway×medium) の十字で継ぎ目が開かない', () => {
    expectAllClean(
      [90, 40].map((deg) => [
        `継ぎ目 (highway×medium ${deg}°)`,
        seamViolations(fourWayScene({ main: 'road_highway', cross: 'road_medium', deg })),
      ]),
    );
  });

  it('片側だけ急勾配 (12%) の十字で継ぎ目が開かない', () => {
    expectAllClean(
      [45, 60, 90].map((deg) => [
        `継ぎ目 (${deg}°, 12%)`,
        seamViolations(
          fourWayScene({ main: 'road_large', cross: 'road_small', deg, crossGrade: 0.12 }),
        ),
      ]),
    );
  });

  it('切土斜面の上の交差点で継ぎ目が開かない', () => {
    expectAllClean(
      [0.25, -0.25].map((slope) => [
        `継ぎ目 (斜面 ${slope})`,
        seamViolations(
          fourWayScene({
            main: 'road_medium',
            cross: 'road_small',
            deg: 90,
            terrain: rampX(20, slope),
          }),
        ),
      ]),
    );
  });

  it('橋の取り付きのすぐ手前にある交差点で継ぎ目が開かない', () => {
    expectNoViolation('継ぎ目', seamViolations(junctionNearBridgeScene()));
  });

  it('分岐器 (rail_yard への分岐) で継ぎ目が開かない', () => {
    expect(
      [...turnoutScene({}).world.junctions.values()].some((j) => j.kind === 'railSwitch'),
    ).toBe(true);
    expectAllClean([
      ['継ぎ目 (平坦)', seamViolations(turnoutScene({}))],
      [
        '継ぎ目 (本線 3% / 側線 2%)',
        seamViolations(turnoutScene({ mainGrade: 0.03, yardGrade: 0.02 })),
      ],
    ]);
  });

  it('踏切の近くに分岐器があっても継ぎ目が開かない', () => {
    // 踏切のレール高補正 (applyRailBlend, 前後 9 m) は帯にだけ効く。
    // 分岐器のトリム位置が踏切から 9 m 以内に入ると、面と帯の高さがずれる。
    const scenes = [30, 35, 40].map((at) => {
      const scene = turnoutScene({ crossingAt: at, crossingDy: 0.2 });
      expect(scene.world.crossings.some((c) => c.kind === 'level')).toBe(true);
      return [`継ぎ目 (踏切 z=${at})`, seamViolations(scene)] as [string, Violation[]];
    });
    expectAllClean(scenes);
  });

  it('踏切のすぐ脇に線路の継ぎ目があっても帯どうしが噛み合う', () => {
    const scenes = [4, 8].map((at) => {
      const scene = seamNearCrossingScene(at);
      expect(scene.world.crossings.some((c) => c.kind === 'level')).toBe(true);
      return [`継ぎ目 (踏切 z=${at})`, seamViolations(scene)] as [string, Violation[]];
    });
    expectAllClean(scenes);
  });

  it('デモ配置で継ぎ目が開かない', () => {
    expectNoViolation('継ぎ目', seamViolations(demoScene()));
  });
});

describe('整地した地形が路面・線路より上に来ない', () => {
  it('平坦地: 車道面・交差点面が地形に埋まらない', () => {
    const scene = teeScene(0);
    expectAllClean([
      ['車道', roadBuriedViolations(scene)],
      ['交差点面', junctionBuriedViolations(scene)],
    ]);
  });

  it('急勾配の枝が突き当たる T 字で、車道・交差点面が地形に埋まらない', () => {
    const scene = teeScene(0.12);
    expectAllClean([
      ['車道', roadBuriedViolations(scene)],
      ['交差点面', junctionBuriedViolations(scene)],
    ]);
  });

  it('片側だけ急勾配 (12%) の十字で、車道・交差点面が地形に埋まらない', () => {
    const entries: [string, Violation[]][] = [];
    for (const deg of [45, 60, 90]) {
      const scene = fourWayScene({
        main: 'road_large',
        cross: 'road_small',
        deg,
        crossGrade: 0.12,
      });
      entries.push([`車道 (${deg}°)`, roadBuriedViolations(scene)]);
      entries.push([`交差点面 (${deg}°)`, junctionBuriedViolations(scene)]);
    }
    expectAllClean(entries);
  });

  it('切土・盛土の斜面上の交差点で、車道・交差点面が地形に埋まらない', () => {
    const entries: [string, Violation[]][] = [];
    for (const slope of [0.25, -0.25]) {
      const scene = fourWayScene({
        main: 'road_medium',
        cross: 'road_small',
        deg: 90,
        terrain: rampX(20, slope),
      });
      entries.push([`車道 (斜面 ${slope})`, roadBuriedViolations(scene)]);
      entries.push([`交差点面 (斜面 ${slope})`, junctionBuriedViolations(scene)]);
    }
    expectAllClean(entries);
  });

  it('直交踏切でレール・道床・車道が地形に埋まらない', () => {
    const scene = crossingScene({});
    expectAllClean([
      ['レール', railBuriedViolations(scene)],
      ['道床', ballastBuriedViolations(scene)],
      ['車道', roadBuriedViolations(scene)],
    ]);
  });

  it('斜め踏切 (30〜60°) でレール・道床が地形に埋まらない', () => {
    const entries: [string, Violation[]][] = [];
    for (const angle of [30, 45, 60]) {
      const scene = crossingScene({ angle });
      expect(scene.world.crossings.some((c) => c.kind === 'level')).toBe(true);
      entries.push([`レール (交差角 ${angle}°)`, railBuriedViolations(scene)]);
      entries.push([`道床 (交差角 ${angle}°)`, ballastBuriedViolations(scene)]);
    }
    expectAllClean(entries);
  });

  it('地形格子に対して斜めに置いた踏切でレール・道床が地形に埋まらない', () => {
    // 高さ場は軸に平行な 2 m 格子なので、線形が格子と斜めに交わると
    // 焼き込みの端が格子点に乗らない。直交踏切のまま向きだけ変えて見る。
    const entries: [string, Violation[]][] = [];
    for (const rotate of [15, 30, 60]) {
      const scene = crossingScene({ rotate });
      entries.push([`レール (回転 ${rotate}°)`, railBuriedViolations(scene)]);
      entries.push([`道床 (回転 ${rotate}°)`, ballastBuriedViolations(scene)]);
    }
    expectAllClean(entries);
  });

  it('勾配のある道路が水平な線路を横切る踏切で、レール・道床が地形に埋まらない', () => {
    const entries: [string, Violation[]][] = [];
    for (const angle of [90, 55]) {
      const scene = crossingScene({ angle, roadGrade: 0.08 });
      expect(scene.world.crossings.some((c) => c.kind === 'level')).toBe(true);
      entries.push([`レール (交差角 ${angle}°, 8%)`, railBuriedViolations(scene)]);
      entries.push([`道床 (交差角 ${angle}°, 8%)`, ballastBuriedViolations(scene)]);
    }
    expectAllClean(entries);
  });

  it('切土・盛土の中にある踏切で、レール・道床が地形に埋まらない', () => {
    const entries: [string, Violation[]][] = [];
    for (const [name, terrain] of [
      ['線路に沿った切土', rampX(20, 0.1)],
      ['道路に沿った切土', rampZ(20, 0.08)],
      ['道路に沿った盛土', rampZ(20, -0.08)],
    ] as const) {
      const scene = crossingScene({ terrain });
      entries.push([`レール (${name})`, railBuriedViolations(scene)]);
      entries.push([`道床 (${name})`, ballastBuriedViolations(scene)]);
    }
    expectAllClean(entries);
  });

  it('分岐器のまわりでレール・道床が地形に埋まらない', () => {
    const entries: [string, Violation[]][] = [];
    for (const [name, scene] of [
      ['平坦', turnoutScene({})],
      ['本線 3% / 側線 2%', turnoutScene({ mainGrade: 0.03, yardGrade: 0.02 })],
      ['踏切が近い', turnoutScene({ crossingAt: 35, crossingDy: 0.2 })],
    ] as const) {
      entries.push([`レール (${name})`, railBuriedViolations(scene)]);
      entries.push([`道床 (${name})`, ballastBuriedViolations(scene)]);
    }
    expectAllClean(entries);
  });

  it('デモ配置で車道・レール・道床・交差点面が地形に埋まらない', () => {
    const scene = demoScene();
    expectAllClean([
      ['車道', roadBuriedViolations(scene)],
      ['レール', railBuriedViolations(scene)],
      ['道床', ballastBuriedViolations(scene)],
      ['交差点面', junctionBuriedViolations(scene)],
    ]);
  });
});

describe('路端と地形の間に穴が開かない', () => {
  it('平坦地では路端・交差点外周の垂れ壁が地形に届く', () => {
    const scene = teeScene(0);
    expectAllClean([
      ['路端', skirtGapViolations(scene)],
      ['交差点外周', junctionSkirtGapViolations(scene)],
    ]);
  });

  it('急勾配 (12%) の取り付きがある交差点で路端に穴が開かない', () => {
    const entries: [string, Violation[]][] = [];
    for (const deg of [45, 60, 90]) {
      const scene = fourWayScene({
        main: 'road_large',
        cross: 'road_small',
        deg,
        crossGrade: 0.12,
      });
      entries.push([`路端 (${deg}°)`, skirtGapViolations(scene)]);
      entries.push([`交差点外周 (${deg}°)`, junctionSkirtGapViolations(scene)]);
    }
    expectAllClean(entries);
  });

  it('直交・斜めの踏切まわりで路端に穴が開かない', () => {
    expectAllClean(
      [90, 55, 35].map((angle) => [
        `路端 (交差角 ${angle}°)`,
        skirtGapViolations(crossingScene({ angle })),
      ]),
    );
  });

  it('勾配のある道路が横切る踏切まわりで路端に穴が開かない', () => {
    expectAllClean(
      [90, 55].map((angle) => [
        `路端 (交差角 ${angle}°, 8%)`,
        skirtGapViolations(crossingScene({ angle, roadGrade: 0.08 })),
      ]),
    );
  });

  it('分岐器のすぐ先に踏切があるとき、踏切まわりの路端に穴が開かない', () => {
    expectAllClean(
      [15, 40].map((at) => [
        `路端 (踏切 z=${at})`,
        skirtGapViolations(turnoutScene({ crossingAt: at, crossingDy: 0.2 })),
      ]),
    );
  });

  it('勾配の違う本線と側線が並ぶ分岐器で路端に穴が開かない', () => {
    expectNoViolation('路端', skirtGapViolations(turnoutScene({ mainGrade: 0.03, yardGrade: 0.02 })));
  });

  it('デモ配置で路端・交差点外周に穴が開かない', () => {
    const scene = demoScene();
    expectAllClean([
      ['路端', skirtGapViolations(scene)],
      ['交差点外周', junctionSkirtGapViolations(scene)],
    ]);
  });
});
