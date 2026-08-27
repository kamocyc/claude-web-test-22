import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector3 } from 'three';
import { buildDemoNetwork } from '../src/app/demo';
import {
  applySurfaceBlend,
  surfaceHeightScale,
  type SurfaceBlend,
} from '../src/build/crossing';
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
import type { Junction } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { testField } from './support/field';
import { TERRAIN_CELL } from '../src/core/units';

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
  const field = testField();
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
 * セグメントごとの踏切ブレンド。
 *
 * 踏切では**線路ではなく道路**が線路の高さ・勾配に合わせて動く。組み立て済み
 * のものが `BuildResult.blends` に入っている (ノードを越えて隣のセグメントへ
 * 伝わる分も含む) ので、そのまま使う。
 */
function blendsOf(scene: Scene): Map<SegmentId, SurfaceBlend[]> {
  return scene.result.blends;
}

/**
 * 描画に使われるサンプル。
 * 踏切のまわりでは道路が上下・傾斜し、線路の曲線ではカントが付く。
 */
function drawnSampleAt(scene: Scene, segment: SegmentId, s: number) {
  const raw = scene.network.alignmentOf(segment).sampleAt(s);
  const blended = applySurfaceBlend([raw], blendsOf(scene).get(segment) ?? [])[0];
  const cant = scene.world.cantAt(segment, s);
  return cant === 0 ? blended : { ...blended, roll: (blended.roll ?? 0) + cant };
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
/**
 * 地表区間の検査点。
 *
 * 区間の端 (坑口・橋台) では地形が垂直に切り立つので、格子の補間はその
 * 段差を 1 マスぶん引きずる。整地の目標そのものを見たいので、端から
 * 格子 2 マス分は避ける。
 */
function groundStations(
  scene: Scene,
  segment: SegmentId,
  step = 2,
  inset = Math.max(4, TERRAIN_CELL * 2),
): number[] {
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
 * その位置にいちばん近い道路について、中心線からの垂距と、そこでの
 * 舗装の路端 (断面のいちばん外側 = 歩道の外端) の描画高さを返す。
 * 中心線は 1 m 刻みの折れ線なので、垂距の誤差は曲線でも数 mm。
 */
function roadCoverAt(
  roads: ReturnType<typeof roadPolylines>,
  x: number,
  z: number,
): { lateral: number; halfWidth: number; edgeY: number } | null {
  let best: { lateral: number; halfWidth: number; edgeY: number } | null = null;
  let bestDist = Infinity;
  for (const road of roads) {
    const edgeHeight = profileFor(road.cls)[0].height;
    for (let i = 0; i < road.pts.length; i++) {
      const p = road.pts[i];
      const dx = x - p.x;
      const dz = z - p.z;
      const d = dx * dx + dz * dz;
      if (d >= bestDist) continue;
      bestDist = d;
      const r = road.rights[i];
      best = {
        lateral: Math.abs(dx * r.x + dz * r.z),
        halfWidth: road.cls.halfWidth,
        edgeY: p.y + edgeHeight + SURFACE_LIFT,
      };
    }
  }
  return best;
}

/**
 * その点で「地形がレール頭頂面より上にあってもよい量」。null は判定対象外。
 *
 * 舗装の下 (垂距 <= 半幅) はレールが隠れて当然なので外す。そのすぐ外側も、
 * 地形は舗装の路端と繋がらなければならない: 勾配のある道路が踏切を斜めに
 * 横切ると路端そのものが交点のレール高より高くなるので (実測: 交差角 55°
 * + 8% の踏切で、舗装の端の路端がレール頭頂面より 0.86 m 上)、路端の脇で
 * 地形がレールを覆うのは幾何的に避けられない。
 *
 * そこで「路端がレールより高い分」を、擦り付け距離 (worldBuilder の
 * CROSSING_SHOULDER_RAMP = 3 m) で 0 まで直線的に減らした値を許容量とする。
 * 3 m 離れれば地形は道床天端まで落ちている想定なので、それを超える埋没は
 * 不具合として扱う。
 */
function allowedRailCover(
  roads: ReturnType<typeof roadPolylines>,
  x: number,
  z: number,
  railTop: number,
): number | null {
  const cover = roadCoverAt(roads, x, z);
  if (!cover) return 0;
  if (cover.lateral <= cover.halfWidth) return null;
  const outside = cover.lateral - cover.halfWidth;
  if (outside >= 3) return 0;
  return Math.max(0, cover.edgeY - railTop) * (1 - outside / 3);
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
    // 断面の並び順は、2 本の向きが揃っているか逆かで変わる。カントが付くと
    // 断面は左右対称でなくなるので、どちら向きに突き合わせるかは世界座標で
    // 決める (添字をそのまま裏返すと、カントのぶんずれて見える)。
    const xz = (p: Vector3, q: Vector3): number => Math.hypot(p.x - q.x, p.z - q.z);
    const flipped = xz(a[0], b[0]) > xz(a[0], b[b.length - 1]);
    for (let i = 0; i < a.length; i++) {
      const mate = flipped ? b[b.length - 1 - i] : b[i];
      const dy = Math.abs(a[i].y - mate.y);
      if (dy > tolerance) {
        out.push({
          amount: dy,
          where: a[i],
          what: `帯どうしの段差: node=${id} kind=${junction.kind} ${a[i].y.toFixed(2)} vs ${mate.y.toFixed(2)}`,
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
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    if (cls.kind !== 'rail') continue;
    for (const s of groundStations(scene, seg.id, 1.5)) {
      const sample = drawnSampleAt(scene, seg.id, s);
      const railTop = sample.pos.y + SURFACE_LIFT;
      for (const offset of cls.tracks) {
        for (const d of [-0.72, 0, 0.72]) {
          const x = sample.pos.x + sample.right.x * (offset + d);
          const z = sample.pos.z + sample.right.z * (offset + d);
          const allowed = allowedRailCover(roads, x, z, railTop);
          if (allowed === null) continue; // 舗装の下
          const terrain = scene.field.heightAt(x, z);
          if (terrain - railTop > allowed + tolerance) {
            out.push({
              amount: terrain - railTop - allowed,
              where: new Vector3(x, terrain, z),
              what: `レールが埋まる: seg=${seg.id} s=${s.toFixed(1)} 頭頂面=${railTop.toFixed(2)} 地形=${terrain.toFixed(2)} 許容=${allowed.toFixed(2)}`,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * (3) 道床天端より上に地形が来ていないか。
 *
 * 踏切では、舗装の下 (垂距 <= 道路の半幅) で道床が隠れるのは仕様。その
 * 外側も、路端から道床天端へ擦り付ける 3 m (CROSSING_SHOULDER_RAMP) の
 * 間は天端より上に地形があってよい。そこで垂距が「半幅 + 3 m」以内の点は
 * 判定から外す。
 */
function ballastBuriedViolations(scene: Scene, tolerance = 0.05): Violation[] {
  const out: Violation[] = [];
  const roads = roadPolylines(scene);
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    if (cls.kind !== 'rail') continue;
    const top = Math.max(...cls.tracks.map(Math.abs)) + 1.7;
    for (const s of groundStations(scene, seg.id, 1.5)) {
      const sample = drawnSampleAt(scene, seg.id, s);
      const ballastTop = sample.pos.y - RAIL_TOP_TO_BALLAST + SURFACE_LIFT;
      for (const offset of [-top + 0.2, 0, top - 0.2]) {
        const x = sample.pos.x + sample.right.x * offset;
        const z = sample.pos.z + sample.right.z * offset;
        const cover = roadCoverAt(roads, x, z);
        if (cover && cover.lateral <= cover.halfWidth + 3) continue;
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
      // 踏切のまわりでは路面が線路に合わせて上下・傾斜する。
      const sample = drawnSampleAt(scene, seg.id, s);
      for (const offset of [-cw + 0.2, 0, cw - 0.2]) {
        const surfaceY = sample.pos.y + SURFACE_LIFT + offset * (sample.roll ?? 0);
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

  /**
   * 点 (x, y, z) にいちばん近い頂点の XZ。半径内に無ければ null。
   *
   * 高さでも絞るのが大事で、立体交差のように同じ XZ に別の面があると、
   * XZ だけで探すと関係のない面の頂点を掴んでしまう。
   */
  nearestVertexXZ(
    x: number,
    z: number,
    radius = 0.15,
    y?: number,
    radiusY = 0.1,
  ): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null;
    let bestD = radius * radius;
    const cx = Math.round(x / this.cell);
    const cz = Math.round(z / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          if (y !== undefined && Math.abs(list[i + 1] - y) > radiusY) continue;
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

  /** (x, z) のほぼ真上にある頂点の最高 Y (`ceiling` より上は無視)。 */
  highestAt(x: number, z: number, radius = 0.05, ceiling = Infinity): number | null {
    let best: number | null = null;
    const cx = Math.round(x / this.cell);
    const cz = Math.round(z / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          if (Math.abs(list[i] - x) > radius || Math.abs(list[i + 2] - z) > radius) continue;
          if (list[i + 1] > ceiling) continue;
          if (best === null || list[i + 1] > best) best = list[i + 1];
        }
      }
    }
    return best;
  }

  /**
   * (x, z) のほぼ真下にある頂点の最低 Y。`ceiling` を与えると、それより
   * 上の頂点は無視する (立体交差で上を通る面を拾わないため)。
   */
  lowestAt(x: number, z: number, radius = 0.05, ceiling = Infinity): number | null {
    let best: number | null = null;
    const cx = Math.round(x / this.cell);
    const cz = Math.round(z / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          if (Math.abs(list[i] - x) > radius || Math.abs(list[i + 2] - z) > radius) continue;
          if (list[i + 1] > ceiling) continue;
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
  const blends = blendsOf(scene);
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    const edge = profileFor(cls)[0];
    // 帯の頂点がどの弧長に置かれるかは実装 (サンプル間隔) 次第なので、
    // 細かく歩いて「メッシュの頂点がある所」だけを評価する。
    for (const s of groundStations(scene, seg.id, 0.5)) {
      const sample = drawnSampleAt(scene, seg.id, s);
      // 踏切の上では縁石・歩道の段差が潰れる。描画と同じ係数を掛ける。
      const scale = surfaceHeightScale(blends.get(seg.id) ?? [], s);
      for (const side of [-1, 1]) {
        const p = profilePointAt(
          sample,
          side * Math.abs(edge.offset),
          edge.height * scale,
          new Vector3(),
        );
        const vertex = floor.nearestVertexXZ(p.x, p.z, 0.15, p.y);
        if (!vertex) continue;
        const bottom = floor.lowestAt(vertex.x, vertex.z, 0.05, p.y + 0.05);
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
      const bottom = floor.lowestAt(p.x, p.z, 0.05, top + 0.05);
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
  const blends = blendsOf(scene);
  const roads = roadPolylines(scene);
  let compared = 0;
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    const edge = profileFor(cls)[0];
    for (const s of groundStations(scene, seg.id, 1)) {
      const sample = drawnSampleAt(scene, seg.id, s);
      // 踏切の上では縁石・歩道の段差が潰れる。描画と同じ係数を掛ける。
      const scale = surfaceHeightScale(blends.get(seg.id) ?? [], s);
      for (const side of [-1, 1]) {
        const p = profilePointAt(
          sample,
          side * Math.abs(edge.offset),
          edge.height * scale,
          new Vector3(),
        );
        // 踏切のように他の舗装に覆われている所は、いちばん高い頂点が
        // 相手の舗装になる。断面の外側の点 (線路なら道床の法尻) は舗装の
        // 下に潜るので、そこを比べても検査側のずれは分からない。路端の
        // すぐ外 (15 cm) も、頂点を探す半径 6 cm の中に相手の路端が入る。
        const cover = cls.kind === 'rail' ? roadCoverAt(roads, p.x, p.z) : null;
        if (cover && cover.lateral <= cover.halfWidth + 0.15) continue;
        const vertex = floor.nearestVertexXZ(p.x, p.z, 0.06, p.y, 0.5);
        if (!vertex) continue;
        const top = floor.highestAt(vertex.x, vertex.z, 0.05, p.y + 0.5);
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

/**
 * (8) 橋・トンネルの取り付き部が塞がっているか。
 *
 * 地表区間と橋・トンネル区間の境目では、整地の伝播が遮断されて地形が
 * 垂直に切り立つ (橋台・坑口の仕様)。その段差を橋台・坑門が覆っていないと、
 * 地面の断面が丸見えになり、桁の下に穴が抜ける。
 *
 * 判定: 境界の前後 4 m の地形の低い方まで構造物が下りていること、および
 * 構造物の上端が桁下 (路面 − 1.5 m) 以上まで来ていること。
 * 探索半径は「路面の半幅 + 2 m」。主桁は半幅の 0.78 倍、橋台は半幅 + 0.6 m
 * の位置にあり、中心線上には頂点が無いため。
 */
function structureJointViolations(scene: Scene): { violations: Violation[]; joints: number } {
  const out: Violation[] = [];
  let joints = 0;
  const mesh = scene.world.group.getObjectByName('structures') as
    | { geometry: { attributes: { position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } } }
    | undefined;
  const pos = mesh?.geometry.attributes.position;
  if (!pos) throw new Error('structures メッシュが見つからない');

  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    const al = scene.network.alignmentOf(seg.id);
    const runs = scene.result.structures.get(seg.id) ?? [];
    for (let i = 0; i + 1 < runs.length; i++) {
      if (runs[i].mode === runs[i + 1].mode) continue;
      joints++;
      const s = runs[i].s1;
      const p = al.sampleAt(s).pos;
      const inside = al.sampleAt(Math.max(0, s - 4)).pos;
      const outside = al.sampleAt(Math.min(al.length, s + 4)).pos;
      const lowest = Math.min(
        scene.field.heightAt(inside.x, inside.z),
        scene.field.heightAt(outside.x, outside.z),
      );
      const radius = cls.halfWidth + 2;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < pos.count; k++) {
        const dx = pos.getX(k) - p.x;
        const dz = pos.getZ(k) - p.z;
        if (dx * dx + dz * dz > radius * radius) continue;
        lo = Math.min(lo, pos.getY(k));
        hi = Math.max(hi, pos.getY(k));
      }
      const label = `${runs[i].mode}->${runs[i + 1].mode} seg=${seg.id}`;
      if (lo === Infinity) {
        out.push({ amount: Infinity, where: p, what: `取り付き部に構造物が無い: ${label}` });
        continue;
      }
      if (lo - lowest > 0.05) {
        out.push({
          amount: lo - lowest,
          where: p,
          what: `橋台・坑門が地形の段差を塞いでいない: ${label} 構造物の下端=${lo.toFixed(2)} 地形=${lowest.toFixed(2)}`,
        });
      }
      if (p.y - 1.5 - hi > 0.05) {
        out.push({
          amount: p.y - 1.5 - hi,
          where: p,
          what: `構造物が桁下まで届いていない: ${label} 上端=${hi.toFixed(2)} 路面=${p.y.toFixed(2)}`,
        });
      }
    }
  }
  return { violations: out, joints };
}

/** `surfaces` メッシュの三角形 (位置は実頂点そのまま)。 */
function surfaceTriangles(scene: Scene): { a: Vector3; b: Vector3; c: Vector3 }[] {
  const mesh = scene.world.group.getObjectByName('surfaces') as
    | {
        geometry: {
          index: { count: number; getX(i: number): number } | null;
          attributes: {
            position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number };
          };
        };
      }
    | undefined;
  const geometry = mesh?.geometry;
  const pos = geometry?.attributes.position;
  if (!geometry || !pos) throw new Error('surfaces メッシュが見つからない');
  const at = (i: number): Vector3 => new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
  const out: { a: Vector3; b: Vector3; c: Vector3 }[] = [];
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  for (let i = 0; i + 2 < count; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    out.push({ a: at(i0), b: at(i1), c: at(i2) });
  }
  return out;
}

/** 断面の高さを、指定した横オフセットで線形補間して返す。 */
function profileHeightAt(profile: { offset: number; height: number }[], offset: number): number {
  if (offset <= profile[0].offset) return profile[0].height;
  for (let i = 0; i + 1 < profile.length; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (offset <= b.offset) {
      if (b.offset - a.offset < 1e-9) return b.height;
      const t = (offset - a.offset) / (b.offset - a.offset);
      return a.height + (b.height - a.height) * t;
    }
  }
  return profile[profile.length - 1].height;
}

/** 交差点の「枝の口」(トリム位置の断面) の情報。 */
interface Mouth {
  origin: Vector3;
  forward: Vector3;
  right: Vector3;
  cls: ReturnType<Network['classOf']>;
  innerRing: Vector3[];
  /** その交差点に集まる全ての枝の、いちばん内側の面の高さ。 */
  levels: number[];
  label: string;
}

/** 枝のトリム位置における、いちばん内側の面 (車道面・道床天端) の高さ。 */
function mouthLevel(scene: Scene, ap: Junction['approaches'][number]): number {
  const profile = profileFor(ap.branch.cls);
  const levels = Math.max(1, profile.length >> 1);
  const range = scene.result.ranges.get(ap.branch.segment)!;
  const s = ap.branch.atStart ? range.s0 : range.s1;
  const sample = drawnSampleAt(scene, ap.branch.segment, s);
  return sample.pos.y + profile[Math.min(levels - 1, profile.length - 1)].height + SURFACE_LIFT;
}

function junctionMouths(scene: Scene): Mouth[] {
  const out: Mouth[] = [];
  for (const [id, junction] of scene.world.junctions) {
    if (junction.rings.length === 0) continue;
    const inner = junction.rings[junction.rings.length - 1];
    if (inner.length < 3) continue;
    const levels = junction.approaches.map((ap) => mouthLevel(scene, ap));
    for (const ap of junction.approaches) {
      const range = scene.result.ranges.get(ap.branch.segment)!;
      const s = ap.branch.atStart ? range.s0 : range.s1;
      const sample = drawnSampleAt(scene, ap.branch.segment, s);
      out.push({
        levels,
        origin: sample.pos.clone(),
        // 交差点から外を向く水平方向。
        forward: new Vector3(ap.dir.x, 0, ap.dir.y).normalize(),
        right: sample.right.clone(),
        cls: ap.branch.cls,
        innerRing: inner.map((p) => new Vector3(p.x, p.y + SURFACE_LIFT, p.z)),
        label: `node=${id} kind=${junction.kind} seg=${ap.branch.segment}`,
      });
    }
  }
  return out;
}

/**
 * (9) 枝の口を横切る立ち上がり面が残っていないか。
 *
 * 交差点面の歩道・縁石の帯や外周の垂れ壁が枝の口にも作られると、道路を
 * 横切る 15 cm の段差 (縁石) や垂れ壁ができてしまう。実メッシュの三角形を
 * 走査し、「口の断面上 (前後 0.35 m) にあり、車道の内側 (±0.85 × 車道半幅)
 * を通り、ほぼ垂直 (法線の Y 成分 < 0.35 = 傾き 70° 超)」な面を探す。
 *
 * 判定域を車道半幅の 0.85 倍までにしているのは、口の端 (±車道半幅) には
 * 隅丸めの帯や垂れ壁が正当に接するため。実測でも、口の断面上の垂直面は
 * すべて 0.85 倍より外側にある (デモ配置で 75 面、うち車道の内側は 0 面)。
 */
function mouthVerticalFaceViolations(scene: Scene): Violation[] {
  const out: Violation[] = [];
  const mouths = junctionMouths(scene);
  if (mouths.length === 0) return out;
  const tris = surfaceTriangles(scene);
  const ab = new Vector3();
  const ac = new Vector3();
  const normal = new Vector3();
  const centroid = new Vector3();

  for (const tri of tris) {
    centroid.copy(tri.a).add(tri.b).add(tri.c).divideScalar(3);
    ab.copy(tri.b).sub(tri.a);
    ac.copy(tri.c).sub(tri.a);
    normal.crossVectors(ab, ac);
    if (normal.lengthSq() < 1e-16) continue;
    normal.normalize();
    if (Math.abs(normal.y) >= 0.35) continue;

    for (const mouth of mouths) {
      const dx = centroid.x - mouth.origin.x;
      const dz = centroid.z - mouth.origin.z;
      const along = dx * mouth.forward.x + dz * mouth.forward.z;
      if (Math.abs(along) > 0.35) continue;
      const lat = dx * mouth.right.x + dz * mouth.right.z;
      if (Math.abs(lat) > mouth.cls.carriagewayHalfWidth * 0.85) continue;
      const expected =
        mouth.origin.y + profileHeightAt(profileFor(mouth.cls), lat) + SURFACE_LIFT;
      // 立体交差など、別の高さにある面は無関係。
      if (Math.abs(centroid.y - expected) > 3) continue;
      const span = Math.max(tri.a.y, tri.b.y, tri.c.y) - Math.min(tri.a.y, tri.b.y, tri.c.y);
      // 枝どうしの面の高さが違う交差点 (勾配の違う分岐器) では、交差点面は
      // その差をどこかで吸収しなければならない。差ぶんの立ち上がりは
      // 縁石の残りではないので見逃す。
      const levelSpan = Math.max(...mouth.levels) - Math.min(...mouth.levels);
      if (span <= levelSpan + 0.02) continue;
      out.push({
        amount: span,
        where: centroid.clone(),
        what: `枝の口に立ち上がり面が残っている: ${mouth.label} 高さ${span.toFixed(2)}m 法線Y=${normal.y.toFixed(2)}`,
      });
      break;
    }
  }
  return out;
}

/**
 * (10) 交差点の車道面が、枝の車道面と段差なく繋がっているか。
 *
 * 口から 5 cm だけ内側に入った点で、交差点面 (いちばん内側のリングを描画と
 * 同じ earcut で分割したもの) の高さを引き、**その交差点に集まる枝の面の
 * 高さの範囲**に収まっているかを見る。
 *
 * 枝どうしの勾配が違うと、トリム位置の面の高さは枝ごとに違う (分岐器で
 * 本線 3.1% と側線 1.8% が分かれると、23 m 先で 0.3 m の差になる)。
 * 交差点面はその間をつながなければならないので、口のすぐ内側でも隣の枝の
 * 高さへ向かって傾く。「どちらの面より下にも上にも出ない」ことが段差の
 * ない繋ぎ方の条件で、全ての枝が同じ高さなら「枝の高さと一致」に一致する。
 * 許容 0.03 m は、5 cm 内側に入る分の勾配 (12% で 0.006 m) と Float32 の
 * 丸めを見込んだ値。
 */
function mouthContinuityViolations(scene: Scene, tolerance = 0.03): Violation[] {
  const out: Violation[] = [];
  for (const mouth of junctionMouths(scene)) {
    const profile = profileFor(mouth.cls);
    // いちばん内側のリングに対応する断面の高さ (道路なら車道面、線路なら道床天端)。
    const levels = Math.max(1, profile.length >> 1);
    const innerHeight = profile[Math.min(levels - 1, profile.length - 1)].height;
    const half = mouth.cls.carriagewayHalfWidth;
    for (let i = -4; i <= 4; i++) {
      const lat = (half * 0.85 * i) / 4;
      const x = mouth.origin.x - mouth.forward.x * 0.05 + mouth.right.x * lat;
      const z = mouth.origin.z - mouth.forward.z * 0.05 + mouth.right.z * lat;
      const surfaceY = polygonSurfaceY(mouth.innerRing, x, z);
      if (surfaceY === null) continue;
      const expected = mouth.origin.y + innerHeight + SURFACE_LIFT;
      const low = Math.min(expected, ...mouth.levels);
      const high = Math.max(expected, ...mouth.levels);
      const gap = Math.max(low - surfaceY, surfaceY - high);
      if (gap > tolerance) {
        out.push({
          amount: gap,
          where: new Vector3(x, surfaceY, z),
          what: `枝の口で車道面に段差: ${mouth.label} 交差点面=${surfaceY.toFixed(3)} 枝=${expected.toFixed(3)}`,
        });
      }
    }
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
    draw(net, field, options.railClass ?? 'rail_single', [
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
    draw(net, field, 'rail_single', [
      { x: 0, z: -300, y: y0 - mg * 300 },
      { x: 0, z: 300, y: y0 + mg * 300 },
    ], { straight: true });
    const hit = net.findSegmentNear(new Vector3(0, 0, 0), 10)!;
    const node = net.splitSegment(hit.segment, hit.s);
    // 線路の分岐は本線の接線に沿ってしか作れないので、接線を引き継いで引く。
    draw(net, field, 'rail_yard', [
      { x: node.pos.x, z: node.pos.z, y: node.pos.y },
      { x: 20, z: node.pos.z + 120, y: node.pos.y + yg * 120 },
    ]);
    draw(net, field, 'rail_yard', [
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

/**
 * 曲線だけで組んだ配置。これまでのシナリオは全て直線だったので、
 * 曲率のある線形での断面の向き・隅丸め・踏切の扱いを別に見る。
 */
function curvedScene(grade = 0) {
  return buildScene(flat(20), (net, field) => {
    draw(net, field, 'rail_single', [
      { x: -220, z: -150, y: 20 },
      { x: -40, z: -60, y: 20 },
      { x: 140, z: 60, y: 20 },
    ]);
    // 曲線の道路が曲線の線路を横切る (踏切)。踏切を平面で成立させるため
    // 本線は水平にし、勾配は交差点から分かれる枝側に付ける。
    draw(net, field, 'road_medium', [
      { x: -150, z: 130, y: 20 },
      { x: -60, z: 20, y: 20 },
      { x: 40, z: -90, y: 20 },
    ]);
    // 曲線の道路の途中から枝を出して交差点にする。
    const hit = net.findSegmentNear(new Vector3(-110, 0, 70), 30);
    if (hit) {
      const node = net.splitSegment(hit.segment, hit.s);
      draw(net, field, 'road_small', [
        { x: node.pos.x, z: node.pos.z, y: node.pos.y },
        { x: node.pos.x + 90, z: node.pos.z + 60, y: node.pos.y + grade * 110 },
        { x: node.pos.x + 200, z: node.pos.z + 90, y: node.pos.y + grade * 230 },
      ]);
    }
  });
}

/** 起伏の激しい自然地形 (最大勾配 40% 程度) の上に置いた交差点と踏切。 */
function roughTerrainScene() {
  const rough = (x: number, z: number): number =>
    30 +
    9 * Math.sin(x / 55) +
    7 * Math.cos(z / 40) +
    4 * Math.sin((x + z) / 25);
  return buildScene(rough, (net, field) => {
    // 縦断は自然地形をならした高さ (demo.ts と同じ発想) にする。
    const smooth = (x: number, z: number): number => {
      let sum = 0;
      let n = 0;
      for (let dx = -30; dx <= 30; dx += 10) {
        for (let dz = -30; dz <= 30; dz += 10) {
          sum += field.baseHeightAt(x + dx, z + dz);
          n++;
        }
      }
      return sum / n;
    };
    const trunk: Waypoint[] = [];
    for (let x = -240; x <= 240; x += 60) trunk.push({ x, z: 0, y: smooth(x, 0) });
    draw(net, field, 'road_medium', trunk, { straight: true });

    const hit = net.findSegmentNear(new Vector3(0, 0, 0), 30)!;
    const node = net.splitSegment(hit.segment, hit.s);
    const branch: Waypoint[] = [{ x: node.pos.x, z: 0, y: node.pos.y }];
    for (let z = 60; z <= 240; z += 60) {
      branch.push({ x: node.pos.x, z, y: node.pos.y + (smooth(node.pos.x, z) - node.pos.y) * 0.6 });
    }
    draw(net, field, 'road_small', branch, { straight: true });
  });
}

/** デモ配置 (回帰の基準)。 */
function demoScene(): Scene {
  const field = testField();
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

  it('曲線の線形どうしの交差点・踏切で継ぎ目が開かない', () => {
    const scene = curvedScene(0.06);
    expect(scene.world.crossings.some((c) => c.kind === 'level')).toBe(true);
    expect(ringJunctionCount(scene)).toBeGreaterThan(0);
    expectNoViolation('継ぎ目 (曲線)', seamViolations(scene));
  });

  it('起伏の激しい地形の上の交差点で継ぎ目が開かない', () => {
    expectNoViolation('継ぎ目 (起伏地形)', seamViolations(roughTerrainScene()));
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

  it('曲線の線形で車道・レール・道床・交差点面が地形に埋まらない', () => {
    const scene = curvedScene(0.06);
    expectAllClean([
      ['車道', roadBuriedViolations(scene)],
      ['レール', railBuriedViolations(scene)],
      ['道床', ballastBuriedViolations(scene)],
      ['交差点面', junctionBuriedViolations(scene)],
    ]);
  });

  it('起伏の激しい地形の上で車道・交差点面が地形に埋まらない', () => {
    const scene = roughTerrainScene();
    expectAllClean([
      ['車道', roadBuriedViolations(scene)],
      ['交差点面', junctionBuriedViolations(scene)],
    ]);
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

describe('交差点の枝の口', () => {
  it('枝の口に縁石・歩道・垂れ壁の立ち上がりが残っていない', () => {
    const entries: [string, Violation[]][] = [];
    for (const [name, scene] of [
      ['T 字 (12%)', teeScene(0.12)],
      ['十字 large×small 45° (12%)', fourWayScene({ main: 'road_large', cross: 'road_small', deg: 45, crossGrade: 0.12 })],
      ['十字 highway×medium', fourWayScene({ main: 'road_highway', cross: 'road_medium', deg: 90 })],
      ['曲線', curvedScene(0.06)],
      ['デモ配置', demoScene()],
    ] as const) {
      // 判定が空振りしていないこと。
      expect(junctionMouths(scene).length).toBeGreaterThan(0);
      entries.push([`枝の口 (${name})`, mouthVerticalFaceViolations(scene)]);
    }
    expectAllClean(entries);
  }, 30000);

  it('交差点の車道面が枝の車道面と段差なく繋がっている', () => {
    const entries: [string, Violation[]][] = [];
    for (const [name, scene] of [
      ['T 字 (12%)', teeScene(0.12)],
      ['十字 large×small 45° (12%)', fourWayScene({ main: 'road_large', cross: 'road_small', deg: 45, crossGrade: 0.12 })],
      ['十字 30° 鋭角', fourWayScene({ main: 'road_large', cross: 'road_small', deg: 30 })],
      ['曲線', curvedScene(0.06)],
      ['起伏地形', roughTerrainScene()],
      ['デモ配置', demoScene()],
    ] as const) {
      entries.push([`車道面の連続 (${name})`, mouthContinuityViolations(scene)]);
    }
    expectAllClean(entries);
  }, 30000);
});

describe('橋・トンネルの取り付き部', () => {
  it('デモ配置で、整地が切れる段差を橋台・坑門が塞いでいる', () => {
    const scene = demoScene();
    const { violations, joints } = structureJointViolations(scene);
    // 判定が空振りしていないこと (地表と構造物の境目が実際にあること)。
    expect(joints).toBeGreaterThanOrEqual(4);
    expectNoViolation('取り付き部', violations);
  });

  it('起伏の激しい地形・崖ぎわの配置でも取り付き部が塞がっている', () => {
    expectAllClean([
      ['取り付き部 (崖ぎわ)', structureJointViolations(junctionNearBridgeScene()).violations],
      ['取り付き部 (起伏地形)', structureJointViolations(roughTerrainScene()).violations],
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

  it('曲線の線形・起伏の激しい地形で路端に穴が開かない', () => {
    const curved = curvedScene(0.06);
    const rough = roughTerrainScene();
    expectAllClean([
      ['路端 (曲線)', skirtGapViolations(curved)],
      ['交差点外周 (曲線)', junctionSkirtGapViolations(curved)],
      ['路端 (起伏地形)', skirtGapViolations(rough)],
      ['交差点外周 (起伏地形)', junctionSkirtGapViolations(rough)],
    ]);
  });

  it('デモ配置で路端・交差点外周に穴が開かない', () => {
    const scene = demoScene();
    expectAllClean([
      ['路端', skirtGapViolations(scene)],
      ['交差点外周', junctionSkirtGapViolations(scene)],
    ]);
  });
});
