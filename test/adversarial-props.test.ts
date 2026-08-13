import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector3 } from 'three';
import { buildDemoNetwork } from '../src/app/demo';
import { buildCatenary } from '../src/build/rail';
import {
  buildPowerLine,
  planUtilityPoles,
  type PolePlan,
  type PowerSpan,
} from '../src/build/streetside';
import { profileFor } from '../src/build/surface';
import { MeshBuilder } from '../src/core/meshbuilder';
import { SURFACE_LIFT } from '../src/core/units';
import { getClass, type NetworkClass } from '../src/network/classes';
import {
  anchorFromNode,
  computePlacement,
  placeSegment,
  type Anchor,
} from '../src/network/editing';
import { solveJunctions, type Junction } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { Occupancy } from '../src/network/occupancy';
import {
  WorldBuilder,
  type BuildResult,
  type PropPlacement,
} from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';

/**
 * 小物 (信号機・一時停止標識・遮断機・架線柱・電柱) の配置に対する敵対的検証。
 *
 * 「信号機や架線柱が道路の真ん中に設置される」という報告の再現を目的に、
 * デモ配置だけでなく、鋭角の交差点・幅の違う道路の交差・踏切のすぐ脇の
 * 交差点・立体交差・急カーブ・高架といった意地の悪い配置を組み立てて、
 * `world.rebuild()` が返す `props` の足元位置を幾何的に検査する。
 *
 * 許容値の考え方は各検査のコメントに書いた。偽陽性を出さないため、
 *  - 「道路の上」の判定は歩道を含む `halfWidth` ではなく車道部
 *    (`carriagewayHalfWidth`) を既定にする。電柱・架線柱は自分の線形の
 *    路肩・歩道に立つのが正しく、同じ道路が交差点で分割された隣の
 *    セグメントから見るとその歩道は「相手の halfWidth の内側」になるため。
 *  - 地形は既定で平坦 (標高 0) にして、起伏由来のノイズを排除する。
 */

// ---------------------------------------------------------------- 足場

interface Waypoint {
  x: number;
  z: number;
  /** 絶対高さ。省略時は自然地形の高さ。 */
  y?: number;
}

/** src/app/demo.ts の draw() と同じ手順 (エクスポートされていないので複製)。 */
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
  name: string;
  field: Heightfield;
  network: Network;
  world: WorldBuilder;
  result: BuildResult;
}

function buildScene(
  name: string,
  build: (network: Network, field: Heightfield) => void,
  seed?: number,
  terrain?: (f: Heightfield) => void,
): Scene {
  const field = new Heightfield();
  if (seed !== undefined) generateTerrain(field, { ...DEFAULT_TERRAIN, seed });
  if (terrain) terrain(field);
  const network = new Network();
  build(network, field);
  const terrainMesh = new TerrainMesh(field, new MeshBasicMaterial());
  const world = new WorldBuilder(network, field, terrainMesh);
  return { name, field, network, world, result: world.rebuild() };
}

// ------------------------------------------------------------ 幾何ユーティリティ

interface Poly {
  segment: SegmentId;
  cls: NetworkClass;
  pts: { x: number; z: number; y: number; s: number }[];
}

function samplePoly(
  network: Network,
  id: SegmentId,
  s0: number,
  s1: number,
  step = 0.5,
): Poly | null {
  const cls = network.classOf(network.getSegment(id));
  const al = network.alignmentOf(id);
  const a = Math.max(0, s0);
  const b = Math.min(al.length, s1);
  if (b - a < 1e-3) return null;
  const n = Math.max(1, Math.ceil((b - a) / step));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const st = a + ((b - a) * i) / n;
    const p = al.sampleAt(st).pos;
    pts.push({ x: p.x, z: p.z, y: p.y, s: st });
  }
  return { segment: id, cls, pts };
}

/** 実際に描画された弧長範囲 (交差点でトリムしたあと) の中心線。 */
const drawnCache = new Map<Scene, Poly[]>();

function drawnCenterlines(s: Scene): Poly[] {
  const cached = drawnCache.get(s);
  if (cached) return cached;
  const built = computeDrawnCenterlines(s);
  drawnCache.set(s, built);
  return built;
}

function computeDrawnCenterlines(s: Scene): Poly[] {
  const out: Poly[] = [];
  for (const seg of s.network.segments.values()) {
    const al = s.network.alignmentOf(seg.id);
    const range = s.result.ranges.get(seg.id) ?? { s0: 0, s1: al.length };
    const poly = samplePoly(s.network, seg.id, range.s0, range.s1);
    if (poly) out.push(poly);
  }
  return out;
}

/** 交差点にトリムされて消えた区間の中心線 (= 交差点面の内側を通る)。 */
function trimmedCenterlines(s: Scene): Poly[] {
  const out: Poly[] = [];
  for (const seg of s.network.segments.values()) {
    const al = s.network.alignmentOf(seg.id);
    const range = s.result.ranges.get(seg.id) ?? { s0: 0, s1: al.length };
    if (range.s0 > 0.2) {
      const p = samplePoly(s.network, seg.id, 0, range.s0);
      if (p) out.push(p);
    }
    if (range.s1 < al.length - 0.2) {
      const p = samplePoly(s.network, seg.id, range.s1, al.length);
      if (p) out.push(p);
    }
  }
  return out;
}

function fullCenterline(s: Scene, id: SegmentId): Poly {
  return samplePoly(s.network, id, 0, s.network.alignmentOf(id).length)!;
}

interface Nearest {
  dist: number;
  s: number;
  y: number;
}

function nearestOnPoly(x: number, z: number, poly: Poly): Nearest {
  let best: Nearest = { dist: Infinity, s: 0, y: 0 };
  for (let i = 0; i + 1 < poly.pts.length; i++) {
    const a = poly.pts[i];
    const b = poly.pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = 0;
    if (len2 > 1e-12) {
      t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best.dist) {
      best = { dist: d, s: a.s + (b.s - a.s) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return best;
}

/**
 * 「車道 (軌道) の上」とみなす、中心線からの半幅 [m]。
 *
 * 道路は車道部 (歩道を除く)。線路は軌道中心 ±1.5 m とする。枕木の半長が
 * 1.25 m、`buildTrack` のレール位置が ±0.72 m なので、1.5 m あれば
 * 「軌道の上」と言い切れる。架線柱は `halfWidth - 0.6` に建つ規則なので、
 * rail_double では 3.7 m > 2.1 + 1.5 = 3.6 m と、正しい配置なら必ず外れる。
 */
function travelledHalfWidth(cls: NetworkClass): number {
  if (cls.kind === 'rail') return Math.max(...cls.tracks.map(Math.abs), 0) + 1.5;
  return cls.carriagewayHalfWidth;
}

/**
 * 平面で重なっていても、高さが離れていれば干渉ではない。
 *
 * 立体交差では、桁の上の支柱と桁下の線形が XZ では重なる。足元の高さが
 * 相手の路面から 2 m 以上離れていれば「相手の上に立っている」とは言えない
 * ので、判定から外す。2 m は縁石・道床・橋の床版厚 (1.1 m) を飲み込み、
 * かつ建築限界 (道路 4.5 m / 線路 5.7 m) よりは十分小さい値。
 */
const VERTICAL_GATE = 2.0;

function separatedVertically(propY: number, surfaceY: number): boolean {
  return Math.abs(propY - surfaceY) > VERTICAL_GATE;
}

function pointInRing(x: number, z: number, ring: Vector3[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) return false;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function ringDepth(x: number, z: number, ring: Vector3[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    let t = 0;
    if (len2 > 1e-12) {
      t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best === Infinity ? 0 : best;
}

/** 隣接しない辺どうしが交わっていれば true (= 点内包判定が信用できない)。 */
function selfIntersects(ring: Vector3[]): boolean {
  const n = ring.length;
  if (n < 4 || ring.some((p) => !p)) return false;
  const cross = (
    ax: number, az: number, bx: number, bz: number,
    cx: number, cz: number, dx: number, dz: number,
  ): boolean => {
    const rx = bx - ax;
    const rz = bz - az;
    const sx = dx - cx;
    const sz = dz - cz;
    const den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((cx - ax) * sz - (cz - az) * sx) / den;
    const u = ((cx - ax) * rz - (cz - az) * rx) / den;
    return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
  };
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      if (cross(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z)) return true;
    }
  }
  return false;
}

/** 断面上の横オフセットにおける路面高さ (線形 Y からのオフセット)。 */
function profileHeightAt(cls: NetworkClass, offset: number): number {
  const profile = profileFor(cls);
  const o = Math.abs(offset);
  let best = profile[0].height;
  let bestD = Infinity;
  for (const p of profile) {
    const d = Math.abs(Math.abs(p.offset) - o);
    if (d < bestD) {
      bestD = d;
      best = p.height;
    }
  }
  return best;
}

/** セグメント同士がノードを共有しているか (同じ道路の続き)。 */
function shareNode(network: Network, a: SegmentId, b: SegmentId): boolean {
  const sa = network.getSegment(a);
  const sb = network.getSegment(b);
  return sa.a === sb.a || sa.a === sb.b || sa.b === sb.a || sa.b === sb.b;
}


// ------------------------------------------------- 配電線 (実メッシュで見る)

/** `buildPowerLine` が作った形状の頂点をそのまま取り出す。 */
function powerVertices(poles: PolePlan[], spans: PowerSpan[]): Vector3[] {
  const mb = new MeshBuilder();
  buildPowerLine(mb, poles, spans);
  const pos = mb.build().getAttribute('position');
  const out: Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    out.push(new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return out;
}

function horizontalDistance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function nearestPoleDistance(v: Vector3, poles: PolePlan[]): number {
  let best = Infinity;
  for (const p of poles) best = Math.min(best, horizontalDistance(v, p.base));
  return best;
}

/**
 * 柱まわりの金物 (腕金・碍子・変圧器・引き下げ管・ハンドホール) が収まる
 * 水平半径 [m]。定数を決め打ちせず、「線を 1 本も張らない形状」と
 * 「全径間を地中にした形状」を実際に作って測る。これより遠い頂点は
 * 架空線のものだと言い切れる。
 */
function poleHardwareRadius(poles: PolePlan[], spans: PowerSpan[]): number {
  let r = 0;
  const bare = powerVertices(poles, []);
  const risers = powerVertices(poles, spans.map((sp) => ({ ...sp, underground: true })));
  for (const v of bare) r = Math.max(r, nearestPoleDistance(v, poles));
  for (const v of risers) r = Math.max(r, nearestPoleDistance(v, poles));
  return r;
}

interface PowerMesh {
  poles: PolePlan[];
  spans: PowerSpan[];
  /** 柱の金物から離れた頂点 = 架空線の途中。 */
  wireVertices: Vector3[];
  radius: number;
  /** 足元にハンドホール (引き下げ管) が見える柱。 */
  risers: Set<PolePlan>;
}

/**
 * 足元の点検口の有無で「引き下げ管が付いているか」を見分ける。
 *
 * 柱の幹は半径 0.3 m に収まり、腕金・電線は遥か上にあるので、
 * 「足元の高さで、幹から 0.3〜2.0 m 離れた頂点」があるのは点検口だけ。
 * 判別できていることは、線を張らない形状 (0 本) と全径間地中の形状
 * (全端点) で毎回確かめる。
 */
function hasHandhole(vertices: Vector3[], pole: PolePlan): boolean {
  for (const v of vertices) {
    if (Math.abs(v.y - pole.base.y) > 0.5) continue;
    const d = horizontalDistance(v, pole.base);
    if (d > 0.3 && d < 2.0) return true;
  }
  return false;
}

const meshCache = new Map<Scene, PowerMesh>();

function powerMesh(s: Scene): PowerMesh {
  const cached = meshCache.get(s);
  if (cached) return cached;
  const built = computePowerMesh(s);
  meshCache.set(s, built);
  return built;
}

function computePowerMesh(s: Scene): PowerMesh {
  const { poles, spans } = s.result.power;
  const radius = poles.length ? poleHardwareRadius(poles, spans) : 0;
  const vertices = powerVertices(poles, spans);
  const risers = new Set<PolePlan>();
  for (const pole of poles) {
    if (hasHandhole(vertices, pole)) risers.add(pole);
  }
  return {
    poles,
    spans,
    radius,
    wireVertices: vertices.filter((v) => nearestPoleDistance(v, poles) > radius + 1e-6),
    risers,
  };
}

/**
 * その径間だけを組み立てて、増えた頂点を取り出す。
 *
 * 全体のメッシュから位置で切り出そうとすると、隣の径間の線を拾ってしまう。
 * 同じ 2 本の柱で「径間あり」と「径間なし」を作り、その差を取れば、その
 * 径間が作った形状 (架空線 or 引き下げ管) だけが確実に得られる。
 */
function spanGeometry(span: PowerSpan): Vector3[] {
  const two = [span.a, span.b];
  const withSpan = powerVertices(two, [span]);
  const without = powerVertices(two, []);
  const bag = new Map<string, number>();
  const key = (v: Vector3): string => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
  for (const v of without) bag.set(key(v), (bag.get(key(v)) ?? 0) + 1);
  const out: Vector3[] = [];
  for (const v of withSpan) {
    const k = key(v);
    const n = bag.get(k) ?? 0;
    if (n > 0) bag.set(k, n - 1);
    else out.push(v);
  }
  return out;
}

/** その径間に架空線が張られているか (柱の金物から離れた頂点があるか)。 */
const wireCache = new Map<PowerSpan, Vector3[]>();

function spanWireVertices(span: PowerSpan, radius: number): Vector3[] {
  const cached = wireCache.get(span);
  if (cached) return cached;
  const two = [span.a, span.b];
  const result = spanGeometry(span).filter((v) => nearestPoleDistance(v, two) > radius + 1e-6);
  wireCache.set(span, result);
  return result;
}

/** 電柱が属するセグメント。 */
function poleSegmentOf(s: Scene, pole: PolePlan): SegmentId | undefined {
  for (const prop of s.result.props) {
    if (prop.kind !== 'utilityPole') continue;
    if (prop.position.distanceToSquared(pole.base) < 1e-8) return prop.segment;
  }
  return undefined;
}

/** 径間を 1 m 刻みで辿る。 */
function sampleSpan(span: PowerSpan): { x: number; z: number; y: number }[] {
  const a = span.a.base;
  const b = span.b.base;
  const steps = Math.max(2, Math.ceil(a.distanceTo(b)));
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      y: a.y + (b.y - a.y) * t,
    });
  }
  return out;
}

/** その地点を覆う線形と、そこでの構造形式。 */
function coverAt(s: Scene, x: number, z: number): { poly: Poly; near: Nearest; mode: string }[] {
  const out: { poly: Poly; near: Nearest; mode: string }[] = [];
  for (const poly of drawnCenterlines(s)) {
    const near = nearestOnPoly(x, z, poly);
    if (near.dist > poly.cls.halfWidth) continue;
    const mode =
      s.result.structures.get(poly.segment)?.find((r) => near.s >= r.s0 && near.s <= r.s1)?.mode ??
      'ground';
    out.push({ poly, near, mode });
  }
  return out;
}

// -------------------------------------------------------------------- 違反

interface Violation {
  scene: string;
  rule: string;
  kind: string;
  /** 何 m 食い込んでいるか (高さの検査では何 m 浮いているか)。 */
  amount: number;
  x: number;
  z: number;
  detail: string;
}

function fmt(v: Violation): string {
  return (
    `[${v.scene}] ${v.rule}: ${v.kind} が ${v.amount.toFixed(2)} m ` +
    `@ (${v.x.toFixed(1)}, ${v.z.toFixed(1)}) — ${v.detail}`
  );
}

function report(violations: Violation[], limit = 12): string {
  const sorted = [...violations].sort((a, b) => b.amount - a.amount);
  const head = sorted.slice(0, limit).map(fmt);
  if (sorted.length > limit) head.push(`... 他 ${sorted.length - limit} 件`);
  return `\n${head.join('\n')}\n`;
}

// -------------------------------------------------------------------- 検査

/**
 * 不変条件 1: 自分以外の線形の車道・軌道の上に立っていない。
 *
 * 判定は「実際に描画された範囲」の中心線に対して行う。トリムされて
 * 消えた区間 (交差点の内側) は不変条件 2 で別に見る。
 */
function checkOnOtherTravelway(s: Scene): Violation[] {
  const polys = drawnCenterlines(s);
  const out: Violation[] = [];
  for (const prop of s.result.props) {
    for (const poly of polys) {
      if (poly.segment === prop.segment) continue;
      const limit = travelledHalfWidth(poly.cls);
      const near = nearestOnPoly(prop.position.x, prop.position.z, poly);
      if (near.dist >= limit) continue;
      if (separatedVertically(prop.position.y, near.y)) continue;
      out.push({
        scene: s.name,
        rule: '他の線形の車道・軌道の上',
        kind: prop.kind,
        amount: limit - near.dist,
        x: prop.position.x,
        z: prop.position.z,
        detail: `seg#${poly.segment} (${poly.cls.id}) の中心線から ${near.dist.toFixed(2)} m (車道半幅 ${limit.toFixed(2)} m)`,
      });
    }
  }
  return out;
}

/**
 * 不変条件 1 (緩い版): 自分以外の線形の舗装 (歩道を含む `halfWidth`) の上に
 * 立っていない。ただし自分のセグメントとノードを共有する線形 —
 * 交差点で分割された同じ道路の続き — は除く。そちらの歩道に立つのは正しい。
 */
function checkOnOtherPavement(s: Scene): Violation[] {
  const polys = drawnCenterlines(s);
  const out: Violation[] = [];
  for (const prop of s.result.props) {
    for (const poly of polys) {
      if (poly.segment === prop.segment) continue;
      if (
        prop.segment !== undefined &&
        s.network.segments.has(prop.segment) &&
        shareNode(s.network, prop.segment, poly.segment)
      ) {
        continue;
      }
      const near = nearestOnPoly(prop.position.x, prop.position.z, poly);
      if (near.dist >= poly.cls.halfWidth) continue;
      if (separatedVertically(prop.position.y, near.y)) continue;
      out.push({
        scene: s.name,
        rule: '他の線形の舗装の上',
        kind: prop.kind,
        amount: poly.cls.halfWidth - near.dist,
        x: prop.position.x,
        z: prop.position.z,
        detail: `seg#${poly.segment} (${poly.cls.id}) の中心線から ${near.dist.toFixed(2)} m (半幅 ${poly.cls.halfWidth.toFixed(2)} m)`,
      });
    }
  }
  return out;
}

/**
 * 不変条件 2: 交差点面の内側に立っていない。
 *
 * 2 通りで見る。
 *  (a) `Junction.ring` の内側かどうか (仕様どおりの判定)。
 *  (b) 交差点でトリムされて消えた区間の車道幅の内側かどうか。
 *      リングは鋭角の交差点で自己交差することがあり、その場合 (a) の
 *      点内包判定は当てにならない。トリムされた区間は定義上すべて
 *      交差点面なので、こちらの方が堅い。自分自身のセグメントの
 *      トリム区間は「自分の路肩」でもあるので、車道幅で見る。
 */
function checkInsideJunction(s: Scene): Violation[] {
  const out: Violation[] = [];
  for (const prop of s.result.props) {
    for (const junction of s.world.junctions.values()) {
      const ring = junction.ring;
      if (ring.length < 3 || ring.some((p) => !p)) continue;
      if (!pointInRing(prop.position.x, prop.position.z, ring)) continue;
      const ringY = ring.reduce((acc, p) => acc + p.y, 0) / ring.length;
      if (separatedVertically(prop.position.y, ringY)) continue;
      out.push({
        scene: s.name,
        rule: '交差点面 (ring) の内側',
        kind: prop.kind,
        amount: ringDepth(prop.position.x, prop.position.z, ring),
        x: prop.position.x,
        z: prop.position.z,
        detail: `node#${junction.node} (${junction.kind})`,
      });
    }
  }

  for (const poly of trimmedCenterlines(s)) {
    const limit = travelledHalfWidth(poly.cls);
    for (const prop of s.result.props) {
      const near = nearestOnPoly(prop.position.x, prop.position.z, poly);
      if (near.dist >= limit) continue;
      if (separatedVertically(prop.position.y, near.y)) continue;
      out.push({
        scene: s.name,
        rule: '交差点の車道・軌道の上 (トリム区間)',
        kind: prop.kind,
        amount: limit - near.dist,
        x: prop.position.x,
        z: prop.position.z,
        detail:
          `seg#${poly.segment} (${poly.cls.id}) のトリム区間 s=${near.s.toFixed(1)} から ` +
          `${near.dist.toFixed(2)} m (車道半幅 ${limit.toFixed(2)} m)` +
          (prop.segment === poly.segment ? ' [自分自身の区間]' : ''),
      });
    }
  }
  return out;
}

/**
 * 不変条件 1 (自分の線形版): どの小物も、自分が属する線形の車道・軌道の
 * 上には立たない。
 *
 * 信号機・一時停止標識・遮断機はすべて路側 (`halfWidth` の外か歩道の上) に
 * 立てる規則なので、自分の車道に入っていたら明確な不具合。報告された
 * 「道路の真ん中に設置される」を、相手の線形だけでなく自分の線形でも見る。
 */
function checkOwnCarriageway(s: Scene): Violation[] {
  const out: Violation[] = [];
  for (const prop of s.result.props) {
    if (prop.segment === undefined || !s.network.segments.has(prop.segment)) continue;
    if (prop.kind === 'utilityPole' || prop.kind === 'catenaryPole') continue; // 3/4 で別に見る
    const poly = fullCenterline(s, prop.segment);
    const limit = travelledHalfWidth(poly.cls);
    const d = nearestOnPoly(prop.position.x, prop.position.z, poly).dist;
    if (d >= limit - 0.05) continue;
    out.push({
      scene: s.name,
      rule: '自分の線形の車道・軌道の上',
      kind: prop.kind,
      amount: limit - d,
      x: prop.position.x,
      z: prop.position.z,
      detail: `seg#${prop.segment} (${poly.cls.id}) の中心線から ${d.toFixed(2)} m (車道半幅 ${limit.toFixed(2)} m)`,
    });
  }
  return out;
}

/**
 * 不変条件 3/4: 自分の線形の断面上での横位置。
 *  - 電柱は歩道の上 (`carriagewayHalfWidth` 以上 `halfWidth` 以下)。
 *  - 架線柱は軌道 (中心 ±1.5 m) の外。
 * 中心線を 0.5 m 刻みの折れ線で近似しているので、0.05 m の余裕を見る。
 */
function checkOwnLateral(s: Scene): Violation[] {
  const out: Violation[] = [];
  for (const prop of s.result.props) {
    if (prop.segment === undefined) continue;
    if (prop.kind !== 'utilityPole' && prop.kind !== 'catenaryPole') continue;
    const poly = fullCenterline(s, prop.segment);
    const cls = poly.cls;
    const d = nearestOnPoly(prop.position.x, prop.position.z, poly).dist;
    const push = (rule: string, amount: number): void => {
      out.push({
        scene: s.name,
        rule,
        kind: prop.kind,
        amount,
        x: prop.position.x,
        z: prop.position.z,
        detail: `seg#${prop.segment} (${cls.id}) の中心線から ${d.toFixed(2)} m`,
      });
    };
    if (prop.kind === 'utilityPole') {
      if (d < cls.carriagewayHalfWidth - 0.05) push('電柱が自分の車道の上', cls.carriagewayHalfWidth - d);
      else if (d > cls.halfWidth + 0.05) push('電柱が歩道の外', d - cls.halfWidth);
    } else {
      const limit = travelledHalfWidth(cls);
      if (d < limit - 0.05) push('架線柱が自分の軌道の上', limit - d);
    }
  }
  return out;
}

/**
 * 不変条件 5: 足元が浮いていない・埋まっていない。
 *
 * その地点に「実際にある面」= 整地後の地形と、その地点を覆う路面 (自分の
 * 断面高さで評価) の高い方を支持面とする。橋の上なら桁面が、歩道の上なら
 * 縁石高さが支持面になるので、橋・高架・道床でも同じ規則で見られる。
 */
interface FootReport {
  prop: PropPlacement;
  terrain: number;
  pavement: number | null;
  pavementSegment: SegmentId | null;
  support: number;
}

function footReports(s: Scene): FootReport[] {
  const polys = drawnCenterlines(s);
  const out: FootReport[] = [];
  for (const prop of s.result.props) {
    const x = prop.position.x;
    const z = prop.position.z;
    let pavement: number | null = null;
    let pavementSegment: SegmentId | null = null;
    for (const poly of polys) {
      const near = nearestOnPoly(x, z, poly);
      if (near.dist > poly.cls.halfWidth) continue;
      const y = near.y + profileHeightAt(poly.cls, near.dist) + SURFACE_LIFT;
      if (pavement === null || y > pavement) {
        pavement = y;
        pavementSegment = poly.segment;
      }
    }
    // 交差点面も支持面になりうる。
    for (const junction of s.world.junctions.values()) {
      const ring = junction.ring;
      if (ring.length < 3 || ring.some((p) => !p)) continue;
      if (!pointInRing(x, z, ring)) continue;
      const y = ring.reduce((acc, p) => Math.max(acc, p.y), -Infinity) + SURFACE_LIFT;
      if (pavement === null || y > pavement) {
        pavement = y;
        pavementSegment = null;
      }
    }
    const terrain = s.field.heightAt(x, z);
    out.push({
      prop,
      terrain,
      pavement,
      pavementSegment,
      support: Math.max(terrain, pavement ?? -Infinity),
    });
  }
  return out;
}

/**
 * 浮きの許容量 [m]。
 *
 * 整地は 2 m 格子への焼き込みなので、路端から少し外れた所では目標高さと
 * 補間値が数 cm ずれる。路面の外周には 0.45 m の垂れ壁 (SURFACE_SKIRT) が
 * 付いていて多少の段差は隠れる。両方を飲み込んでなお「浮いて見える」
 * 水準として 0.35 m を採る。
 */
const FLOAT_TOLERANCE = 0.35;
/** 埋まりの許容量 [m]。小物は意図的に 0.05〜0.15 m 埋めて置かれる。 */
const SINK_TOLERANCE = 0.4;

function checkFootHeight(s: Scene): Violation[] {
  const out: Violation[] = [];
  for (const r of footReports(s)) {
    const y = r.prop.position.y;
    const detail =
      `地形 ${r.terrain.toFixed(2)} m / 路面 ` +
      `${r.pavement === null ? 'なし' : `${r.pavement.toFixed(2)} m (seg#${r.pavementSegment})`}` +
      ` に対して足元 ${y.toFixed(2)} m`;
    if (y - r.support > FLOAT_TOLERANCE) {
      out.push({
        scene: s.name,
        rule: '足元が浮いている',
        kind: r.prop.kind,
        amount: y - r.support,
        x: r.prop.position.x,
        z: r.prop.position.z,
        detail,
      });
    } else if (r.terrain - y > SINK_TOLERANCE) {
      out.push({
        scene: s.name,
        rule: '足元が埋まっている',
        kind: r.prop.kind,
        amount: r.terrain - y,
        x: r.prop.position.x,
        z: r.prop.position.z,
        detail,
      });
    }
  }
  return out;
}

/**
 * 追加の不変条件: 小物は自分の線形の路面の近くに立つ。
 *
 * 足元が「どこかの地面や路面に接している」だけでは足りない。信号機が
 * トンネルの真上の丘の上や、桁の遥か下の谷底に立っていても、地面には
 * 接しているので浮き沈みの検査は通ってしまう。自分の線形の断面高さから
 * 大きく離れていないことを別に見る。
 *
 * 許容 3.0 m の根拠: 縁石 0.15 m、道床の法尻まで 0.87 m、盛土の路肩で
 * 地形が路面より下がる分を足しても 1.5 m には収まる。倍の余裕を取っても
 * 「別の高さに飛んでいる」ものだけが引っかかる。
 */
const OWN_SURFACE_TOLERANCE = 3.0;

function checkFootNearOwnSurface(s: Scene): Violation[] {
  const out: Violation[] = [];
  for (const prop of s.result.props) {
    if (prop.segment === undefined || !s.network.segments.has(prop.segment)) continue;
    const poly = fullCenterline(s, prop.segment);
    const near = nearestOnPoly(prop.position.x, prop.position.z, poly);
    const surface = near.y + profileHeightAt(poly.cls, near.dist);
    const delta = prop.position.y - surface;
    if (Math.abs(delta) <= OWN_SURFACE_TOLERANCE) continue;
    out.push({
      scene: s.name,
      rule: '自分の線形の路面から離れた高さに立っている',
      kind: prop.kind,
      amount: Math.abs(delta),
      x: prop.position.x,
      z: prop.position.z,
      detail: `seg#${prop.segment} (${poly.cls.id}) の路面 ${surface.toFixed(2)} m に対して足元 ${prop.position.y.toFixed(2)} m (差 ${delta.toFixed(2)} m)`,
    });
  }
  return out;
}

/**
 * 不変条件 6: 電線が張られる柱の組と、その弦の位置。
 *
 * `buildUtilityPoles` / `buildCatenary` は「弧長がピッチ 1 つ分だけ離れた、
 * 隣り合う柱」だけを結ぶ。柱が飛ばされた所では線を張らない実装なので、
 * ピッチ 1 つ分の組だけを電線ありとみなして弦の位置を検査する。
 */
interface WireSpan {
  segment: SegmentId;
  kind: 'utilityPole' | 'catenaryPole';
  /** 弦上での、自分の中心線からの最小横距離 [m]。 */
  minLateral: number;
  /** 柱の位置での横距離 [m]。 */
  poleLateral: number;
  mid: Vector3;
}

function wireSpans(s: Scene): WireSpan[] {
  const out: WireSpan[] = [];

  // 電柱の径間は `result.power.spans` にそのまま入っている (実データ)。
  // 架空線が張られているものだけを見る。
  const mesh = powerMesh(s);
  for (const span of mesh.spans) {
    if (span.underground) continue;
    if (spanWireVertices(span, mesh.radius).length === 0) continue;
    const segment = poleSegmentOf(s, span.a);
    if (segment === undefined) continue;
    const poly = fullCenterline(s, segment);
    let minLateral = Infinity;
    for (const p of sampleSpan(span)) {
      minLateral = Math.min(minLateral, nearestOnPoly(p.x, p.z, poly).dist);
    }
    out.push({
      segment,
      kind: 'utilityPole',
      minLateral,
      poleLateral: nearestOnPoly(span.a.base.x, span.a.base.z, poly).dist,
      mid: new Vector3().addVectors(span.a.base, span.b.base).multiplyScalar(0.5),
    });
  }

  // 架線は従来どおり「ピッチ 1 つ分だけ離れた隣り合う柱」で見る。
  const bySegment = new Map<SegmentId, { prop: PropPlacement; s: number }[]>();
  for (const prop of s.result.props) {
    if (prop.kind !== 'catenaryPole') continue;
    if (prop.segment === undefined) continue;
    const poly = fullCenterline(s, prop.segment);
    const list = bySegment.get(prop.segment) ?? [];
    list.push({ prop, s: nearestOnPoly(prop.position.x, prop.position.z, poly).s });
    bySegment.set(prop.segment, list);
  }
  for (const [segment, list] of bySegment) {
    list.sort((a, b) => a.s - b.s);
    const poly = fullCenterline(s, segment);
    for (let i = 0; i + 1 < list.length; i++) {
      const pitch = 45;
      if (Math.abs(list[i + 1].s - list[i].s - pitch) > 1.0) continue;
      const a = list[i].prop.position;
      const b = list[i + 1].prop.position;
      let minLateral = Infinity;
      for (let k = 0; k <= 20; k++) {
        const t = k / 20;
        minLateral = Math.min(
          minLateral,
          nearestOnPoly(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, poly).dist,
        );
      }
      out.push({
        segment,
        kind: list[i].prop.kind as 'utilityPole' | 'catenaryPole',
        minLateral,
        poleLateral: nearestOnPoly(a.x, a.z, poly).dist,
        mid: new Vector3().addVectors(a, b).multiplyScalar(0.5),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ シナリオ

interface Scenario {
  name: string;
  build: (n: Network, f: Heightfield) => void;
  seed?: number;
  /** 線形を引く前に自然地形を作る (谷・丘を作って橋・トンネルを誘発する)。 */
  terrain?: (f: Heightfield) => void;
}

/** `height(x, z)` で自然地形を作る。`work` も同じ内容に初期化する。 */
function shapeTerrain(f: Heightfield, height: (x: number, z: number) => number): void {
  for (let iz = 0; iz <= f.cells; iz++) {
    for (let ix = 0; ix <= f.cells; ix++) {
      f.base[f.index(ix, iz)] = height(f.worldX(ix), f.worldZ(iz));
    }
  }
  f.resetWork();
}

/** なだらかな谷・丘を作る (幅 `width` で深さ/高さ `depth`)。 */
function ridge(center: number, width: number, depth: number): (x: number) => number {
  return (x: number) => {
    const t = Math.min(1, Math.abs(x - center) / width);
    return depth * (1 - smoothstep01(t));
  };
}

function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** 2 本の線形を指定角度で交差させる。`span` を小さくすると交点の近くにノードができる。 */
function crossing(
  aId: string,
  bId: string,
  deg: number,
  options: { span?: number; y?: number } = {},
): (n: Network, f: Heightfield) => void {
  return (n, f) => {
    draw(n, f, aId, [
      { x: -300, z: 0, y: options.y },
      { x: 300, z: 0, y: options.y },
    ], { straight: true });
    const a = (deg * Math.PI) / 180;
    const pts: Waypoint[] = [];
    const span = options.span ?? 600;
    for (let t = -300; t <= 300; t += span) {
      pts.push({ x: t * Math.cos(a), z: t * Math.sin(a), y: options.y });
    }
    if (pts[pts.length - 1].x !== 300 * Math.cos(a)) {
      pts.push({ x: 300 * Math.cos(a), z: 300 * Math.sin(a), y: options.y });
    }
    draw(n, f, bId, pts, { straight: true });
  };
}

const SCENARIOS: Scenario[] = [
  { name: 'デモ配置', build: (n, f) => buildDemoNetwork(n, f), seed: DEFAULT_TERRAIN.seed },
  { name: '幅の違う直交交差点 (大通り x 生活道路)', build: crossing('road_large', 'road_small', 90) },
  { name: '鋭角 30 度の交差点 (幹線 x 生活道路)', build: crossing('road_medium', 'road_small', 30) },
  { name: '鋭角 20 度の交差点 (大通り同士)', build: crossing('road_large', 'road_large', 20) },
  {
    name: '交点の 20 m 手前にノードがある鋭角交差点',
    build: crossing('road_large', 'road_small', 25, { span: 140 }),
  },
  {
    name: '交点の 30 m 手前にノードがある鋭角交差点',
    build: crossing('road_large', 'road_small', 10, { span: 90 }),
  },
  {
    name: '5 叉路',
    build: (n, f) => {
      draw(n, f, 'road_medium', [{ x: -200, z: 0 }, { x: 200, z: 0 }], { straight: true });
      draw(n, f, 'road_medium', [{ x: 0, z: -200 }, { x: 0, z: 200 }], { straight: true });
      const a = (35 * Math.PI) / 180;
      draw(n, f, 'road_small', [
        { x: 0, z: 0 },
        { x: 200 * Math.cos(a), z: 200 * Math.sin(a) },
      ], { straight: true });
    },
  },
  {
    name: '生活道路だけの 4 叉路 (一時停止標識)',
    build: crossing('road_small', 'road_small', 90),
  },
  {
    name: '踏切のすぐ脇 (15 m) に交差点',
    build: (n, f) => {
      draw(n, f, 'rail_double', [{ x: 0, z: -300 }, { x: 0, z: 300 }], { straight: true });
      draw(n, f, 'road_medium', [{ x: -250, z: 0 }, { x: 250, z: 0 }], { straight: true });
      draw(n, f, 'road_small', [{ x: 15, z: -150 }, { x: 15, z: 150 }], { straight: true });
    },
  },
  {
    name: '線路のすぐ横を並走する道路',
    build: (n, f) => {
      draw(n, f, 'rail_double', [{ x: 0, z: -300 }, { x: 0, z: 300 }], { straight: true });
      draw(n, f, 'road_medium', [{ x: 14, z: -300 }, { x: 14, z: 300 }], { straight: true });
    },
  },
  { name: '斜め 30 度の踏切', build: crossing('rail_double', 'road_medium', 30) },
  { name: '直交する踏切', build: crossing('rail_double', 'road_medium', 90) },
  {
    name: '跨線橋の直下 (立体交差)',
    build: (n, f) => {
      draw(n, f, 'rail_double', [{ x: 0, z: -300 }, { x: 0, z: 300 }], { straight: true });
      draw(n, f, 'road_small', [
        { x: -150, z: 0, y: 9 },
        { x: 0, z: 0, y: 9 },
        { x: 150, z: 0, y: 9 },
      ], { straight: true });
    },
  },
  {
    name: '電柱間隔 (38 m) と交差点間隔 (40 m) が近い',
    build: (n, f) => {
      draw(n, f, 'road_medium', [{ x: -300, z: 0 }, { x: 300, z: 0 }], { straight: true });
      for (const x of [-120, -80, -40, 0, 40, 80, 120]) {
        draw(n, f, 'road_small', [{ x, z: -60 }, { x, z: 60 }], { straight: true });
      }
    },
  },
  {
    name: '高架上の信号交差点',
    build: crossing('road_medium', 'road_medium', 90, { y: 14 }),
  },
  {
    // road_highway は歩道がないので halfWidth == carriagewayHalfWidth。
    // 橋の上の支柱を「高欄の内側 (halfWidth - 0.6)」に寄せる規則と噛み合うか。
    name: '高架上の交差点 (歩道なしの自動車専用道を含む)',
    build: (n, f) => {
      draw(n, f, 'road_medium', [
        { x: -300, z: 0, y: 14 },
        { x: 300, z: 0, y: 14 },
      ], { straight: true });
      draw(n, f, 'road_highway', [
        { x: 0, z: -300, y: 14 },
        { x: 0, z: 300, y: 14 },
      ], { straight: true });
    },
  },
  {
    name: '地上の交差点 (歩道なしの自動車専用道を含む)',
    build: (n, f) => {
      draw(n, f, 'road_medium', [{ x: -300, z: 0 }, { x: 300, z: 0 }], { straight: true });
      draw(n, f, 'road_highway', [{ x: 0, z: -300 }, { x: 0, z: 300 }], { straight: true });
    },
  },
  {
    // 桁の上の支柱は occupancy.isFree を通さない。真下を別の線形が通る配置で
    // 「通さなくてよい」ことを確かめる (高さが 14 m 離れているので干渉しない)。
    name: '高架交差点の真下を線路が通る',
    build: (n, f) => {
      draw(n, f, 'road_medium', [
        { x: -300, z: 0, y: 14 },
        { x: 300, z: 0, y: 14 },
      ], { straight: true });
      draw(n, f, 'road_medium', [
        { x: 0, z: -300, y: 14 },
        { x: 0, z: 300, y: 14 },
      ], { straight: true });
      // 交差点の隅 (支柱の立つ辺り) を通るように、斜めに線路を通す。
      draw(n, f, 'rail_double', [
        { x: -300, z: -300 + 22 },
        { x: 300, z: 300 + 22 },
      ], { straight: true });
    },
  },
  {
    // 同じ高さの別の高架道路が、交差点のすぐ横を並走する (接続しない)。
    // 支柱は相手の車道の上に出ないか。
    name: '高架交差点のすぐ横を同じ高さの高架道路が並走',
    build: (n, f) => {
      draw(n, f, 'road_medium', [
        { x: -300, z: 0, y: 14 },
        { x: 300, z: 0, y: 14 },
      ], { straight: true });
      draw(n, f, 'road_medium', [
        { x: 0, z: -300, y: 14 },
        { x: 0, z: 300, y: 14 },
      ], { straight: true });
      // 北の枝の支柱は実測で (-8.3, 10.9)。そこを舗装で覆う位置
      // (中心 -12 m、半幅 4.6 m → -7.4〜-16.6 m) に、交点を作らずに並走させる
      // (ランプが交差点の脇に寄り添って取り付く、という配置)。
      draw(n, f, 'road_small', [
        { x: -12, z: 5, y: 14 },
        { x: -12, z: 300, y: 14 },
      ], { straight: true });
    },
  },
  {
    // 桁の上を線路が同じ高さで横切る (橋の上の踏切)。
    name: '高架交差点の枝を同じ高さの線路が横切る',
    build: (n, f) => {
      draw(n, f, 'road_medium', [
        { x: -300, z: 0, y: 14 },
        { x: 300, z: 0, y: 14 },
      ], { straight: true });
      draw(n, f, 'road_medium', [
        { x: 0, z: -300, y: 14 },
        { x: 0, z: 300, y: 14 },
      ], { straight: true });
      draw(n, f, 'rail_double', [
        { x: -300, z: 26, y: 14 },
        { x: 300, z: 26, y: 14 },
      ], { straight: true });
    },
  },
  {
    name: '高架交差点に別の高架道路が斜めに取り付く (6 叉路)',
    build: (n, f) => {
      draw(n, f, 'road_medium', [
        { x: -300, z: 0, y: 14 },
        { x: 300, z: 0, y: 14 },
      ], { straight: true });
      draw(n, f, 'road_medium', [
        { x: 0, z: -300, y: 14 },
        { x: 0, z: 300, y: 14 },
      ], { straight: true });
      for (const deg of [40, 220]) {
        const a = (deg * Math.PI) / 180;
        draw(n, f, 'road_small', [
          { x: 0, z: 0, y: 14 },
          { x: 250 * Math.cos(a), z: 250 * Math.sin(a), y: 14 },
        ], { straight: true });
      }
    },
  },
  {
    // 谷を跨ぐので、道路は 地表 → 橋 → 地表 になる。電柱は地表区間にだけ
    // 建つので、橋台のきわで浮かないかを見る。
    name: '谷を跨ぐ橋の前後 (電柱と橋台の境界)',
    terrain: (f) => {
      const valley = ridge(0, 90, -22);
      shapeTerrain(f, (x) => valley(x));
    },
    build: (n, f) => {
      draw(n, f, 'road_medium', [
        { x: -300, z: 0, y: 0 },
        { x: 300, z: 0, y: 0 },
      ], { straight: true });
    },
  },
  {
    // 丘を貫くのでトンネルになる。坑口のきわの電柱と、トンネル区間に
    // 小物が湧いていないかを見る。
    name: '丘を貫くトンネルの前後',
    terrain: (f) => {
      const hill = ridge(0, 90, 26);
      shapeTerrain(f, (x) => hill(x));
    },
    build: (n, f) => {
      draw(n, f, 'road_medium', [
        { x: -300, z: 0, y: 0 },
        { x: 300, z: 0, y: 0 },
      ], { straight: true });
    },
  },
  {
    // 丘の下 (トンネルの中) に交差点。信号の足元が丘の表面に飛ばないか。
    name: 'トンネルの中の交差点',
    terrain: (f) => {
      const hill = ridge(0, 120, 26);
      shapeTerrain(f, (x, z) => Math.min(hill(x), hill(z)) + 0);
    },
    build: (n, f) => {
      draw(n, f, 'road_medium', [
        { x: -300, z: 0, y: 0 },
        { x: 300, z: 0, y: 0 },
      ], { straight: true });
      draw(n, f, 'road_medium', [
        { x: 0, z: -300, y: 0 },
        { x: 0, z: 300, y: 0 },
      ], { straight: true });
    },
  },
  {
    name: '極端に短いセグメントの連なり (4 m 刻み)',
    build: (n, f) => {
      const pts: Waypoint[] = [];
      for (let x = -120; x <= 120; x += 4) pts.push({ x, z: 0 });
      draw(n, f, 'road_medium', pts, { straight: true });
      draw(n, f, 'road_small', [{ x: 0, z: -120 }, { x: 0, z: 120 }], { straight: true });
    },
  },
  {
    name: '7 叉路',
    build: (n, f) => {
      draw(n, f, 'road_medium', [{ x: -250, z: 0 }, { x: 250, z: 0 }], { straight: true });
      draw(n, f, 'road_medium', [{ x: 0, z: -250 }, { x: 0, z: 250 }], { straight: true });
      for (const deg of [30, 70, 200]) {
        const a = (deg * Math.PI) / 180;
        draw(n, f, 'road_small', [
          { x: 0, z: 0 },
          { x: 220 * Math.cos(a), z: 220 * Math.sin(a) },
        ], { straight: true });
      }
    },
  },
  {
    name: '踏切が 2 箇所 (25 m 間隔) に並ぶ',
    build: (n, f) => {
      draw(n, f, 'rail_double', [{ x: 0, z: -300 }, { x: 0, z: 300 }], { straight: true });
      draw(n, f, 'rail_double', [{ x: 25, z: -300 }, { x: 25, z: 300 }], { straight: true });
      draw(n, f, 'road_medium', [{ x: -250, z: 0 }, { x: 250, z: 0 }], { straight: true });
    },
  },
  {
    name: 'カーブと勾配',
    build: (n, f) => {
      draw(n, f, 'road_medium', [
        { x: -200, z: 0, y: 0 },
        { x: -100, z: 0, y: 4 },
        { x: -40, z: 40, y: 8 },
        { x: 20, z: 90, y: 10 },
        { x: 120, z: 100, y: 6 },
        { x: 200, z: 60, y: 0 },
      ]);
      draw(n, f, 'rail_double', [
        { x: -200, z: 200, y: 0 },
        { x: -60, z: 190, y: 2 },
        { x: 60, z: 150, y: 4 },
        { x: 180, z: 190, y: 6 },
      ]);
    },
  },
  {
    name: '急カーブ (半径 120 m) の道路',
    build: (n, f) => {
      draw(n, f, 'road_small', [{ x: 0, z: -30 }, { x: 0, z: 0 }, { x: -120, z: 120 }]);
    },
  },
];

interface Built {
  scenes: Scene[];
  failed: { name: string; error: Error }[];
}

let cache: Built | null = null;

/** シナリオを一度だけ組み立てて共有する (rebuild が重いため)。 */
function built(): Built {
  if (cache) return cache;
  const scenes: Scene[] = [];
  const failed: { name: string; error: Error }[] = [];
  for (const scenario of SCENARIOS) {
    try {
      scenes.push(buildScene(scenario.name, scenario.build, scenario.seed, scenario.terrain));
    } catch (e) {
      failed.push({ name: scenario.name, error: e as Error });
    }
  }
  cache = { scenes, failed };
  return cache;
}

function collect(check: (s: Scene) => Violation[]): Violation[] {
  return built().scenes.flatMap(check);
}

// ------------------------------------------------------------------ ファズ

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ROAD_IDS = ['road_small', 'road_medium', 'road_large', 'road_highway'];
const RAIL_IDS = ['rail_single', 'rail_double', 'rail_yard'];

/** 道路・線路をでたらめに何本か引く。T 字の取り付きも混ぜる。 */
function fuzzBuild(n: Network, f: Heightfield, seed: number): void {
  const r = rng(seed);
  const count = 2 + Math.floor(r() * 4);
  for (let i = 0; i < count; i++) {
    if (i > 0 && r() < 0.3) {
      const ids = [...n.segments.keys()];
      const target = ids[Math.floor(r() * ids.length)];
      const al = n.alignmentOf(target);
      const st = al.length * (0.3 + r() * 0.4);
      const base = al.sampleAt(st).pos;
      const cls = n.classOf(n.getSegment(target));
      const id =
        cls.kind === 'rail'
          ? RAIL_IDS[Math.floor(r() * RAIL_IDS.length)]
          : ROAD_IDS[Math.floor(r() * ROAD_IDS.length)];
      const a = r() * Math.PI * 2;
      n.splitSegment(target, st);
      draw(n, f, id, [
        { x: base.x, z: base.z, y: base.y },
        { x: base.x + Math.cos(a) * 90, z: base.z + Math.sin(a) * 90, y: base.y },
        { x: base.x + Math.cos(a) * 180, z: base.z + Math.sin(a) * 180, y: base.y },
      ], { straight: true });
      continue;
    }
    const isRail = r() < 0.35;
    const id = isRail
      ? RAIL_IDS[Math.floor(r() * RAIL_IDS.length)]
      : ROAD_IDS[Math.floor(r() * ROAD_IDS.length)];
    const angle = r() * Math.PI * 2;
    const cx = (r() - 0.5) * 120;
    const cz = (r() - 0.5) * 120;
    const half = 120 + r() * 180;
    const y = r() < 0.25 ? (r() - 0.5) * 20 : 0;
    const pts: Waypoint[] = [];
    const steps = 2 + Math.floor(r() * 3);
    for (let k = 0; k <= steps; k++) {
      const t = -half + (2 * half * k) / steps;
      const bend = (r() - 0.5) * 60;
      pts.push({
        x: cx + Math.cos(angle) * t - Math.sin(angle) * bend,
        z: cz + Math.sin(angle) * t + Math.cos(angle) * bend,
        y,
      });
    }
    draw(n, f, id, pts, { straight: r() < 0.6 });
  }
}

const FUZZ_SEEDS = 80;

/** 交差角を変えた 2 本の交差を総当たりし、できた交差点を列挙する。 */
function scanJunctions(): { name: string; junction: Junction }[] {
  const out: { name: string; junction: Junction }[] = [];
  for (const [a, b] of [
    ['road_small', 'road_small'],
    ['road_medium', 'road_small'],
    ['road_large', 'road_small'],
    ['road_large', 'road_medium'],
    ['road_large', 'road_large'],
    ['rail_double', 'rail_double'],
  ]) {
    for (let deg = 5; deg <= 90; deg += 5) {
      for (const span of [140, 600]) {
        const f = new Heightfield();
        const n = new Network();
        crossing(a, b, deg, { span })(n, f);
        for (const junction of solveJunctions(n).junctions.values()) {
          if (junction.ring.length < 3) continue;
          out.push({ name: `${a} x ${b} @ ${deg}deg (span=${span})`, junction });
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ テスト

describe('小物の配置 (敵対的検証)', () => {
  it('シナリオが一通り組み立てられ、小物が実際に置かれている', () => {
    const { scenes } = built();
    const counts: Record<string, number> = {};
    for (const s of scenes) {
      for (const p of s.result.props) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
    }
    // 検査が空振りしていないことの確認 (5 種類すべてを踏むシナリオ集であること)。
    for (const kind of ['signal', 'stopSign', 'crossingGate', 'catenaryPole', 'utilityPole']) {
      expect(counts[kind] ?? 0, `${kind} を置くシナリオがない: ${JSON.stringify(counts)}`).toBeGreaterThan(0);
    }
    // 全シナリオの rebuild をここでまとめて走らせるので既定の 5 秒では足りない。
  }, 60000);

  it('鋭角・短区間の交差点でも rebuild が例外を投げない', () => {
    const { failed } = built();
    // 交差角と、交点近くのノード位置を変えて総当たりする。
    const extra: { name: string; error: Error }[] = [];
    for (const [a, b] of [
      ['road_medium', 'road_medium'],
      ['road_large', 'road_medium'],
      ['road_large', 'road_small'],
    ]) {
      for (const deg of [20, 30, 45, 60, 75, 90]) {
        for (const span of [90, 140, 600]) {
          try {
            buildScene(`${a} x ${b} @ ${deg}deg (span=${span})`, crossing(a, b, deg, { span }));
          } catch (e) {
            extra.push({ name: `${a} x ${b} @ ${deg}deg (span=${span})`, error: e as Error });
          }
        }
      }
    }
    const all = [...failed, ...extra];
    expect(
      all.map((f) => `${f.name}: ${f.error.message}`),
      `world.rebuild() が例外で落ちる配置がある`,
    ).toEqual([]);
    // 総当たりは 54 通り x 約 125 ms。既定の 5 秒では足りないので伸ばす。
  }, 60000);

  it('交差点リングは全レベルで同じ点数になる (欠番がない)', () => {
    // `buildRings` は断面の高さレベルごとにリングを作り、`dedupeRings` は
    // 最外リングで残す点を決めて全リングに同じ添字を適用する。内側リングの
    // 点数が足りないと `undefined` が混ざり、交差点面の生成が落ちる。
    const broken: string[] = [];
    for (const j of scanJunctions()) {
      const holes = j.junction.rings.reduce((acc, r) => acc + r.filter((p) => !p).length, 0);
      if (holes === 0) continue;
      broken.push(
        `${j.name} node#${j.junction.node}: 点数 ${JSON.stringify(j.junction.rings.map((r) => r.length))} のうち欠番 ${holes} 個 ` +
          `(枝 ${j.junction.approaches.map((ap) => `${ap.branch.cls.id}/trim=${ap.trim.toFixed(1)}`).join(' ')})`,
      );
    }
    expect(broken, `\n${broken.slice(0, 12).join('\n')}\n`).toEqual([]);
  });

  /**
   * 交差点リングの自己交差について。
   *
   * 鋭角の交差点では枝の断面どうしが重なり、リングがねじれる。実測すると
   * ねじれ始める角度は「必要なトリム量が maxTrim = min(L*0.45, 40) m で
   * 頭打ちになる角度」とぴったり一致する (同幅どうしなら 2*atan(halfWidth/40))。
   *
   *   rail_single x rail_single   1〜6°    (halfWidth 2.2 m)
   *   rail_double x rail_double   1〜12°   (4.3 m)
   *   road_small  x road_small    1〜13°   (4.6 m)
   *   road_medium x road_small    1〜13°
   *   road_highway x road_medium  1〜22°
   *   road_large  x road_small    1〜24°
   *   road_medium x road_medium   1〜25°   (8.9 m)
   *   road_large  x road_medium   1〜30°
   *   road_large  x road_large    1〜36°   (13.2 m)
   *
   * つまり「交差点の長さが 40 m を超える配置」= 現実には交差点として成立して
   * いない配置でだけ起きる。幾何的に正しく解こうとすると交差点が数百 m に
   * なるので、形を諦めて警告する現状の方針は妥当と判断する。そこでテストは
   * 「単純多角形であること」ではなく、
   *   (a) ねじれたら必ず利用者に警告が出ること
   *   (b) ねじれるのは必ずトリムが頭打ちになった場合だけであること
   * を契約にする。広い交差角で突然ねじれ出したら (b) が破れて検出できる。
   */
  it('リングがねじれるのは trim 頭打ちのときだけで、必ず警告が出る', () => {
    const bad: string[] = [];
    for (const [a, b] of [
      ['rail_single', 'rail_single'],
      ['rail_double', 'rail_double'],
      ['road_small', 'road_small'],
      ['road_medium', 'road_small'],
      ['road_highway', 'road_medium'],
      ['road_large', 'road_small'],
      ['road_medium', 'road_medium'],
      ['road_large', 'road_medium'],
      ['road_large', 'road_large'],
    ]) {
      for (const span of [140, 600]) {
        for (let deg = 1; deg <= 90; deg += 1) {
          const f = new Heightfield();
          const n = new Network();
          crossing(a, b, deg, { span })(n, f);
          for (const j of solveJunctions(n).junctions.values()) {
            if (j.ring.length < 4 || !selfIntersects(j.ring)) continue;
            const where = `${a} x ${b} @ ${deg}deg (span=${span}) node#${j.node}`;
            const clamped = j.approaches.some((ap) => {
              const L = n.alignmentOf(ap.branch.segment).length;
              return Math.abs(ap.trim - Math.min(L * 0.45, 40)) < 0.01;
            });
            if (!clamped) {
              bad.push(
                `${where}: トリムが頭打ちでないのにリングがねじれた ` +
                  `(枝 ${j.approaches.map((ap) => `${ap.branch.cls.id}/trim=${ap.trim.toFixed(1)}`).join(' ')})`,
              );
            }
            if (!j.warnings.some((w) => w.includes('鋭すぎ'))) {
              bad.push(`${where}: リングがねじれているのに警告が出ていない`);
            }
          }
        }
      }
    }
    expect(bad, `\n${bad.slice(0, 12).join('\n')}\n`).toEqual([]);
  }, 120000);

  it('Occupancy が舗装面 (交差点面を含む) を取りこぼさない', () => {
    // 小物の可否判定は全部この索引に乗っている。索引が「空いている」と
    // 答えた所に小物が立つので、取りこぼしはそのまま配置不具合になる。
    const misses: string[] = [];
    for (const s of built().scenes) {
      const occ = new Occupancy(s.network, { junctions: s.world.junctions });
      const probe = (x: number, z: number, what: string): void => {
        if (occ.at(x, z) === null) misses.push(`[${s.name}] ${what} @ (${x.toFixed(1)}, ${z.toFixed(1)})`);
      };
      for (const poly of drawnCenterlines(s)) {
        for (let i = 0; i < poly.pts.length; i += 8) {
          const p = poly.pts[i];
          probe(p.x, p.z, `seg#${poly.segment} の中心線`);
        }
      }
      // トリム区間は定義上すべて交差点面。中心線と、車道半幅の 7 割まで
      // 横に寄った所を見る (隅丸めで削られるのは路端付近だけなので、
      // 7 割までなら必ず舗装されている)。
      for (const poly of trimmedCenterlines(s)) {
        const lateral = travelledHalfWidth(poly.cls) * 0.7;
        for (let i = 0; i < poly.pts.length; i += 4) {
          const p = poly.pts[i];
          const j = Math.min(poly.pts.length - 1, i + 1);
          const dx = poly.pts[j].x - p.x;
          const dz = poly.pts[j].z - p.z;
          const len = Math.hypot(dx, dz) || 1;
          for (const sign of [0, 1, -1]) {
            probe(
              p.x + (-dz / len) * lateral * sign,
              p.z + (dx / len) * lateral * sign,
              `seg#${poly.segment} のトリム区間 (交差点面のはず) s=${p.s.toFixed(1)} 横 ${(lateral * sign).toFixed(1)} m`,
            );
          }
        }
      }
    }
    expect(misses, `\n${misses.slice(0, 12).join('\n')}\n... 計 ${misses.length} 点\n`).toEqual([]);
  });

  it('小物が他の線形の車道・軌道の上に立たない', () => {
    const v = collect(checkOnOtherTravelway);
    expect(v.map(fmt), report(v)).toEqual([]);
  });

  it('小物が自分の線形の車道・軌道の上に立たない', () => {
    const v = collect(checkOwnCarriageway);
    expect(v.map(fmt), report(v)).toEqual([]);
  });

  it('小物が他の線形の舗装 (歩道を含む) の上に立たない', () => {
    const v = collect(checkOnOtherPavement);
    expect(v.map(fmt), report(v)).toEqual([]);
  });

  it('小物が交差点面の中に立たない', () => {
    const v = collect(checkInsideJunction);
    expect(v.map(fmt), report(v)).toEqual([]);
  });

  it('電柱は自分の道路の歩道の上に立つ (車道の上に立たない)', () => {
    const v = collect(checkOwnLateral).filter((x) => x.kind === 'utilityPole');
    expect(v.map(fmt), report(v)).toEqual([]);
  });

  it('架線柱は自分の軌道を外して立つ', () => {
    const v = collect(checkOwnLateral).filter((x) => x.kind === 'catenaryPole');
    expect(v.map(fmt), report(v)).toEqual([]);
  });

  it('小物の足元が地面・路面から浮かない/埋まらない', () => {
    const v = collect(checkFootHeight);
    expect(v.map(fmt), report(v)).toEqual([]);
  });

  it('小物が自分の線形の路面の近くに立つ', () => {
    const v = collect(checkFootNearOwnSurface);
    expect(v.map(fmt), report(v)).toEqual([]);
  });


  it('1 つの道路網の電柱が 1 つの電力系統に繋がる', () => {
    // 地中区間も辺として数える。橋・トンネルや交差点を跨いでも、行き来
    // できる道路の上の電柱は 1 系統でなければならない。
    const bad: string[] = [];
    let checked = 0;
    for (const s of built().scenes) {
      const { poles, spans } = s.result.power;
      if (poles.length === 0) continue;
      const parent = new Map<PolePlan, PolePlan>();
      const find = (p: PolePlan): PolePlan => {
        let root = p;
        while (parent.get(root) !== root) root = parent.get(root)!;
        return root;
      };
      for (const p of poles) parent.set(p, p);
      for (const span of spans) {
        const ra = find(span.a);
        const rb = find(span.b);
        if (ra !== rb) parent.set(ra, rb);
      }

      // 電柱を、その柱が立つ道路の連結成分ごとにまとめる。
      const byComponent = new Map<number, PolePlan[]>();
      const segmentOfPole = new Map<PolePlan, SegmentId>();
      for (const prop of s.result.props) {
        if (prop.kind !== 'utilityPole' || prop.segment === undefined) continue;
        const pole = poles.find(
          (p) => p.base.distanceToSquared(prop.position) < 1e-8,
        );
        if (pole) segmentOfPole.set(pole, prop.segment);
      }
      for (const pole of poles) {
        const segment = segmentOfPole.get(pole);
        if (segment === undefined) continue;
        const component = s.result.connectivity.componentOf.get(segment);
        if (component === undefined) continue;
        const list = byComponent.get(component) ?? [];
        list.push(pole);
        byComponent.set(component, list);
      }

      for (const [component, list] of byComponent) {
        const roots = new Set(list.map((p) => find(p)));
        checked++;
        if (roots.size <= 1) continue;
        // どこで切れているか分かるよう、系統ごとの代表位置を出す。
        const groups = new Map<PolePlan, PolePlan[]>();
        for (const p of list) {
          const r = find(p);
          groups.set(r, [...(groups.get(r) ?? []), p]);
        }
        const detail = [...groups.values()]
          .map((g) => `${g.length} 本 (例 ${g[0].base.x.toFixed(0)}, ${g[0].base.z.toFixed(0)})`)
          .join(' / ');
        bad.push(
          `[${s.name}] 道路網 #${component} の電柱 ${list.length} 本が ${roots.size} 系統に分断: ${detail}`,
        );
      }
    }
    expect(bad, `\n${bad.slice(0, 12).join('\n')}\n`).toEqual([]);
    expect(checked, '電柱のある道路網が 1 つもない (検査が空振り)').toBeGreaterThan(10);
  }, 60000);

  it('架空線は地中区間には張られず、地中区間だけに引き下げ管が付く', () => {
    // 判定は実メッシュ。径間の中ほどに線の頂点があるかどうかで見る。
    const bad: string[] = [];
    let overhead = 0;
    let underground = 0;
    for (const s of built().scenes) {
      const mesh = powerMesh(s);
      if (mesh.poles.length === 0) continue;

      // 見分け方が効いていることの確認 (線なし = 0 本、全地中 = 全端点)。
      const bare = powerVertices(mesh.poles, []);
      const allUnder = powerVertices(
        mesh.poles,
        mesh.spans.map((sp) => ({ ...sp, underground: true })),
      );
      const endpoints = new Set<PolePlan>();
      for (const sp of mesh.spans) {
        endpoints.add(sp.a);
        endpoints.add(sp.b);
      }
      for (const pole of mesh.poles) {
        if (hasHandhole(bare, pole)) {
          bad.push(`[${s.name}] 判別失敗: 線を張らない形状にも点検口が見える`);
          break;
        }
        if (endpoints.has(pole) && !hasHandhole(allUnder, pole)) {
          bad.push(`[${s.name}] 判別失敗: 全地中の形状で点検口が見えない`);
          break;
        }
      }

      for (const span of mesh.spans) {
        const wires = spanWireVertices(span, mesh.radius).length;
        const where = `(${span.a.base.x.toFixed(0)}, ${span.a.base.z.toFixed(0)})〜(${span.b.base.x.toFixed(0)}, ${span.b.base.z.toFixed(0)})`;
        if (span.underground) {
          underground++;
          if (wires > 0) {
            bad.push(`[${s.name}] 地中区間 ${where} に架空線の頂点が ${wires} 個ある`);
          }
        } else {
          overhead++;
          if (wires === 0) {
            bad.push(`[${s.name}] 架空区間 ${where} に架空線がない`);
          }
        }
      }

      for (const pole of mesh.poles) {
        const shouldHave = mesh.spans.some(
          (sp) => sp.underground && (sp.a === pole || sp.b === pole),
        );
        const has = mesh.risers.has(pole);
        if (shouldHave === has) continue;
        bad.push(
          `[${s.name}] 引き下げ管が${has ? '余計に付いている' : '足りない'}: ` +
            `柱 (${pole.base.x.toFixed(1)}, ${pole.base.z.toFixed(1)})`,
        );
      }
    }
    expect(bad, `\n${bad.slice(0, 12).join('\n')}\n`).toEqual([]);
    expect(overhead, '架空区間が 1 つもない (検査が空振り)').toBeGreaterThan(20);
    expect(underground, '地中区間が 1 つもない (検査が空振り)').toBeGreaterThan(0);
  }, 60000);

  it('架空線が線路の架線と干渉しない', () => {
    // 架空配電線が軌道の上を通ってよいのは、架線 (トロリ線) より高い所だけ。
    // 判定に使う高さは、線路側の断面ではなく架線柱の実際の頭の高さから測る。
    const bad: string[] = [];
    let sampled = 0;
    for (const s of built().scenes) {
      const mesh = powerMesh(s);
      // その線路に架線柱が建っているか (建っていなければ架線もない)。
      const catenaryTop = new Map<SegmentId, number>();
      for (const prop of s.result.props) {
        if (prop.kind !== 'catenaryPole' || prop.segment === undefined) continue;
        catenaryTop.set(
          prop.segment,
          Math.max(catenaryTop.get(prop.segment) ?? -Infinity, prop.position.y),
        );
      }
      for (const span of mesh.spans) {
        if (span.underground) continue;
        const wires = spanWireVertices(span, mesh.radius);
        if (wires.length === 0) continue;
        const lowest = Math.min(...wires.map((v) => v.y));
        for (const p of sampleSpan(span)) {
          sampled++;
          for (const cover of coverAt(s, p.x, p.z)) {
            if (cover.poly.cls.kind !== 'rail') continue;
            const top = catenaryTop.get(cover.poly.segment);
            if (top === undefined) continue; // 架線のない側線
            // 架線柱の足元 (道床天端) からの高さ 5 m 前後にトロリ線が来る。
            const contactWire = top + 5;
            if (lowest > contactWire) continue;
            bad.push(
              `[${s.name}] 架空配電線が軌道 seg#${cover.poly.segment} の上を ` +
                `架線より低く通る @ (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) ` +
                `中心線から ${cover.near.dist.toFixed(2)} m / 電線 ${lowest.toFixed(2)} m ` +
                `vs 架線 ${contactWire.toFixed(2)} m`,
            );
          }
        }
      }
    }
    const unique = [...new Set(bad)];
    expect(unique, `\n${unique.slice(0, 12).join('\n')}\n`).toEqual([]);
    expect(sampled, '架空線が 1 本もない (検査が空振り)').toBeGreaterThan(500);
  }, 120000);

  it('架空線が橋・トンネルの区間を跨がない', () => {
    // 橋・トンネルには柱が建たないので、その区間は地中で繋ぐのが仕様。
    // 「径間のうち何 m が構造物の上か」も測って出す。
    const bad: string[] = [];
    let checked = 0;
    for (const s of built().scenes) {
      const mesh = powerMesh(s);
      for (const span of mesh.spans) {
        if (span.underground) continue;
        if (spanWireVertices(span, mesh.radius).length === 0) continue;
        checked++;
        const points = sampleSpan(span);
        let over = 0;
        const modes = new Set<string>();
        const segments = new Set<SegmentId>();
        for (const p of points) {
          let hit = false;
          for (const cover of coverAt(s, p.x, p.z)) {
            if (cover.poly.cls.kind === 'rail' || cover.mode === 'ground') continue;
            hit = true;
            modes.add(cover.mode);
            segments.add(cover.poly.segment);
          }
          if (hit) over++;
        }
        if (over === 0) continue;
        const length = span.a.base.distanceTo(span.b.base);
        bad.push(
          `[${s.name}] 架空線が ${[...modes].join('/')} 区間 ` +
            `seg#${[...segments].join(',')} の上を通る: 径間 ${length.toFixed(1)} m のうち ` +
            `${((over / points.length) * length).toFixed(1)} m ` +
            `(${((over / points.length) * 100).toFixed(0)}%) が構造物の上`,
        );
      }
    }
    const unique = [...new Set(bad)];
    expect(unique, `\n${unique.slice(0, 12).join('\n')}\n`).toEqual([]);
    expect(checked, '架空区間が 1 つもない (検査が空振り)').toBeGreaterThan(20);
  }, 120000);

  it('柱が飛ばされた区間には電線を張らない', () => {
    // 途中を塞いだ状態で直接組み立て、塞いだ帯の中に一切の形状 (= 電線) が
    // 出てこないことを見る。柱そのものは塞いだ帯には建たない。
    for (const which of ['catenary', 'utility'] as const) {
      const f = new Heightfield();
      const n = new Network();
      const id = which === 'catenary' ? 'rail_double' : 'road_medium';
      draw(n, f, id, [{ x: -150, z: 0 }, { x: 150, z: 0 }], { straight: true });
      const segId = [...n.segments.keys()][0];
      const cls = n.classOf(n.getSegment(segId));
      const samples = n.alignmentOf(segId).sample(2.5);
      const mb = new MeshBuilder();
      const blocked = (x: number): boolean => Math.abs(x) < 30;
      if (which === 'catenary') {
        buildCatenary(mb, samples, cls, { canPlace: (x) => !blocked(x) });
      } else {
        // 電柱は「位置を決める」→「線を張る」の 2 段階。塞いだ帯には柱が
        // 建たず、その前後の径間は地中に潜る (架空線を張らない)。
        const poles = planUtilityPoles(samples, cls, {
          canPlace: (x) => !blocked(x),
          groundY: (_x: number, _z: number, y: number) => y,
        });
        const spans = poles.slice(1).map((b, i) => ({
          a: poles[i],
          b,
          underground: b.index !== poles[i].index + 1,
        }));
        buildPowerLine(mb, poles, spans);
      }
      const pos = mb.build().getAttribute('position');
      // 検査が空振りしていないこと (帯の外には柱が建っていること)。
      expect(pos.count, `${which}: 柱が 1 本も建っていない`).toBeGreaterThan(0);
      const inside: string[] = [];
      for (let i = 0; i < pos.count; i++) {
        if (blocked(pos.getX(i))) {
          inside.push(`(${pos.getX(i).toFixed(1)}, ${pos.getY(i).toFixed(1)}, ${pos.getZ(i).toFixed(1)})`);
        }
      }
      expect(inside.slice(0, 5), `${which}: 立てられなかった帯 |x|<30 に形状がある`).toEqual([]);
    }
  });

  it('電線が自分の道路・線路の外へはみ出さない', () => {
    // 曲線区間では柱を結ぶ弦が内側に寄る。反対側の路端を越えるようだと
    // 「道路を斜めに横切る電線」になるので、自分の断面幅に収まることを見る。
    const bad: string[] = [];
    let total = 0;
    for (const s of built().scenes) {
      for (const w of wireSpans(s)) {
        total++;
        const cls = s.network.classOf(s.network.getSegment(w.segment));
        if (w.minLateral >= -1e-9 && w.minLateral <= cls.halfWidth) continue;
        bad.push(
          `[${s.name}] ${w.kind} の電線 (seg#${w.segment}, ${cls.id}) が中心線から ` +
            `${w.minLateral.toFixed(2)} m まで寄る (柱は ${w.poleLateral.toFixed(2)} m, 半幅 ${cls.halfWidth.toFixed(2)} m)`,
        );
      }
    }
    expect(bad, `\n${bad.join('\n')}\n`).toEqual([]);
    // 検査が空振りしていないこと。
    expect(total, '電線が 1 本も張られていない').toBeGreaterThan(10);
  });

  it('ランダムな配置でも不変条件が保たれる (ファズ)', () => {
    const violations: Violation[] = [];
    const crashes: string[] = [];
    for (let seed = 1; seed <= FUZZ_SEEDS; seed++) {
      let s: Scene;
      try {
        s = buildScene(`fuzz#${seed}`, (n, f) => fuzzBuild(n, f, seed));
      } catch (e) {
        crashes.push(`fuzz#${seed}: ${(e as Error).message}`);
        continue;
      }
      violations.push(
        ...checkOnOtherTravelway(s),
        ...checkOnOtherPavement(s),
        ...checkInsideJunction(s),
        ...checkOwnCarriageway(s),
        ...checkOwnLateral(s),
        ...checkFootNearOwnSurface(s),
      );
    }
    const messages = [
      ...crashes.map((c) => `rebuild が落ちた: ${c}`),
      ...[...violations].sort((a, b) => b.amount - a.amount).map(fmt),
    ];
    expect(
      messages,
      `\nrebuild が落ちた種: ${crashes.length}/${FUZZ_SEEDS}, 配置違反 ${violations.length} 件\n` +
        `${messages.slice(0, 12).join('\n')}\n`,
    ).toEqual([]);
  }, 120000);
});
