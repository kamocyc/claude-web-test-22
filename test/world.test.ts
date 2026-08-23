import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Vector2, Vector3 } from 'three';
import { Alignment } from '../src/core/alignment';
import { heightInTriangleXZ } from '../src/core/meshbuilder';
import { curveFromTangents } from '../src/core/curve';
import { VerticalProfile } from '../src/core/profile';
import { TERRAIN_CELL } from '../src/core/units';
import { checkPlacement } from '../src/network/rules';
import { buildDemoNetwork } from '../src/app/demo';
import { profileFor } from '../src/build/surface';
import { surfaceBlendAt, surfaceHeightScale } from '../src/build/crossing';
import { getClass } from '../src/network/classes';
import { anchorFromNode, computePlacement, placeSegment, type Anchor } from '../src/network/editing';
import { Network } from '../src/network/network';
import { findCrossings } from '../src/network/crossings';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { testField } from './support/field';

/**
 * 組み立てパイプライン全体を、描画なしで動かす。
 * three.js のジオメトリ生成は WebGL を必要としないので Node でも通る。
 */
function buildWorld(seed = DEFAULT_TERRAIN.seed) {
  const field = testField();
  generateTerrain(field, { ...DEFAULT_TERRAIN, seed });
  const network = new Network();
  buildDemoNetwork(network, field);
  const terrainMesh = new TerrainMesh(field, new MeshBasicMaterial());
  const world = new WorldBuilder(network, field, terrainMesh);
  return { field, network, world, result: world.rebuild() };
}

/** 建設ツールと同じ手順で線形を引く (経由点は絶対座標)。 */
function draw(network: Network, classId: string, points: Vector3[]): void {
  const cls = getClass(classId);
  const existing = network.findNodeNear(points[0], 3);
  let anchor: Anchor = existing
    ? anchorFromNode(network, existing, cls)
    : { pos: points[0].clone() };
  for (let i = 1; i < points.length; i++) {
    const preview = computePlacement(anchor, points[i], { straight: true, cls });
    const result = placeSegment(network, classId, anchor, { pos: points[i].clone() }, preview);
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


/**
 * 経由点を直線で繋ぐ (折れをなめらかにする処理を通さない)。
 * 折れ点そのものの形を見たいときに使う。
 */
function bend(network: Network, classId: string, points: Vector3[]): void {
  const nodes = points.map((p) => network.findNodeNear(p, 0.5) ?? network.addNode(p));
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1].pos;
    const b = nodes[i].pos;
    const p0 = new Vector2(a.x, a.z);
    const p1 = new Vector2(b.x, b.z);
    network.addSegment({
      classId,
      a: nodes[i - 1].id,
      b: nodes[i].id,
      ctrlA: p0.clone().lerp(p1, 1 / 3),
      ctrlB: p0.clone().lerp(p1, 2 / 3),
      gradeA: 0,
      gradeB: 0,
    });
  }
}

/** その XZ を覆う面のうち、いちばん高いものの高さ。覆われていなければ null。 */
function surfaceTopAt(mesh: Mesh, x: number, z: number): number | null {
  const position = mesh.geometry.attributes.position;
  const index = mesh.geometry.getIndex();
  if (!index) return null;
  let top: number | null = null;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(position, index.getX(i));
    b.fromBufferAttribute(position, index.getX(i + 1));
    c.fromBufferAttribute(position, index.getX(i + 2));
    const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
    const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
    if (u < -1e-9 || v < -1e-9 || 1 - u - v < -1e-9) continue;
    const y = u * a.y + v * b.y + (1 - u - v) * c.y;
    if (top === null || y > top) top = y;
  }
  return top;
}

/**
 * 面を格子に入れて、その XZ を覆う面の高さを引く索引。
 * メッシュ全体を毎回なめると遅いので、三角形を格子に振っておく。
 */
class SurfaceIndex {
  private readonly cells = new Map<string, number[]>();
  private readonly tris: Vector3[][] = [];
  constructor(mesh: Mesh, private readonly cell = 8) {
    const position = mesh.geometry.attributes.position;
    const index = mesh.geometry.getIndex();
    if (!index) return;
    for (let i = 0; i < index.count; i += 3) {
      const tri = [0, 1, 2].map((k) => {
        const j = index.getX(i + k);
        return new Vector3(position.getX(j), position.getY(j), position.getZ(j));
      });
      const id = this.tris.push(tri) - 1;
      const xs = tri.map((p) => p.x);
      const zs = tri.map((p) => p.z);
      for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x++) {
        for (let z = Math.floor(Math.min(...zs) / cell); z <= Math.floor(Math.max(...zs) / cell); z++) {
          const key = `${x},${z}`;
          const list = this.cells.get(key) ?? [];
          list.push(id);
          this.cells.set(key, list);
        }
      }
    }
  }

  /** `y` から `window` [m] 以内にある面のうち、いちばん高いもの。 */
  topNear(x: number, z: number, y: number, window: number): number | null {
    const list = this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`);
    if (!list) return null;
    let top: number | null = null;
    for (const id of list) {
      const [a, b, c] = this.tris[id];
      const height = heightInTriangleXZ(a, b, c, x, z);
      if (height === null || Math.abs(height - y) > window) continue;
      if (top === null || height > top) top = height;
    }
    return top;
  }
}

describe('立体交差の上の交差点', () => {
  it('床版と橋脚が付き、路面だけが宙に浮かない', () => {
    const field = testField();
    generateTerrain(field, DEFAULT_TERRAIN);
    const network = new Network();
    const y = field.baseHeightAt(0, 0) + 14;
    draw(network, 'road_medium', [new Vector3(-120, y, 0), new Vector3(120, y, 0)]);
    draw(network, 'road_small', [new Vector3(0, y, -120), new Vector3(0, y, 120)]);

    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = world.rebuild();
    expect(result.stats.intersections).toBe(1);

    let junction = null;
    for (const [, j] of world.junctions) if (j.kind === 'intersection') junction = j;
    expect(junction).not.toBeNull();
    const node = network.getNode(junction!.node).pos;
    expect(node.y - field.baseHeightAt(node.x, node.z)).toBeGreaterThan(8);

    // 交差点の下に構造物 (桁・橋脚) の頂点があること。
    const structures = world.group.children.find((o) => o.name === 'structures') as Mesh;
    const position = structures.geometry.attributes.position;
    let under = 0;
    for (let i = 0; i < position.count; i++) {
      const near = Math.hypot(position.getX(i) - node.x, position.getZ(i) - node.z) < 12;
      if (near && position.getY(i) < node.y) under++;
    }
    expect(under).toBeGreaterThan(0);
  });
});

describe('橋の下', () => {
  /** 桁より下にある構造物 (橋脚・フーチング) の頂点。 */
  function pierPoints(world: WorldBuilder, deckY: number): Vector3[] {
    const structures = world.group.children.find((o) => o.name === 'structures') as Mesh;
    const position = structures.geometry.attributes.position;
    const out: Vector3[] = [];
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      if (y > deckY - 4) continue;
      out.push(new Vector3(position.getX(i), y, position.getZ(i)));
    }
    return out;
  }

  it('橋脚が下を通る道路の車道の上に建たない', () => {
    const field = testField();
    const network = new Network();
    // 桁下 13 m の高架。橋脚が何本も入る長さにする。
    draw(network, 'road_medium', [new Vector3(-200, 14, 0), new Vector3(200, 14, 0)]);
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    world.rebuild();

    // 橋脚が建つ位置をまず調べ、そのど真ん中を通る道路を足す。
    const before = pierPoints(world, 14);
    expect(before.length).toBeGreaterThan(0);
    const target = before.reduce((best, p) => (Math.abs(p.x) < Math.abs(best.x) ? p : best)).x;
    draw(network, 'road_small', [new Vector3(target, 0, -160), new Vector3(target, 0, 160)]);
    world.rebuild();

    const cls = getClass('road_small');
    let piers = 0;
    for (const p of pierPoints(world, 14)) {
      piers++;
      // 下の道路の車道の中に、橋脚の頂点が 1 つも無いこと。
      expect(Math.abs(p.x - target)).toBeGreaterThan(cls.carriagewayHalfWidth);
    }
    // 橋脚そのものは建っている (全部あきらめて逃げていない)。
    expect(piers).toBeGreaterThan(0);
  });

  it('地形が桁の上に被さらない (掘割の中で橋にした所)', () => {
    const field = testField();
    const network = new Network();
    // 平らな地形 (高さ 0) を 1 m 掘った所を通る道路。下をくぐる道路の
    // ために強制的に橋になるので、整地が遮断されて地形が残る。
    draw(network, 'road_medium', [new Vector3(-200, -1, 0), new Vector3(200, -1, 0)]);
    draw(network, 'road_small', [new Vector3(0, -7, -160), new Vector3(0, -7, 160)]);
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = world.rebuild();

    const upper = [...network.segments.values()].find(
      (s) => Math.abs(network.alignmentOf(s.id).sampleAt(0).pos.y + 1) < 0.5,
    )!;
    const alignment = network.alignmentOf(upper.id);
    const runs = result.structures.get(upper.id) ?? [];
    expect(runs.some((r) => r.mode === 'bridge')).toBe(true);

    let checked = 0;
    for (const run of runs) {
      if (run.mode !== 'bridge') continue;
      for (let s = run.s0; s <= run.s1; s += 2) {
        const p = alignment.sampleAt(s).pos;
        // 路面より上に地形が出ていたら、道路が地形に埋まって見える。
        expect(field.heightAt(p.x, p.z)).toBeLessThan(p.y);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('サンプルネットワーク', () => {
  it('交差点・分岐器・踏切・立体交差・橋・トンネルが一通りできる', () => {
    const { result, network } = buildWorld();

    expect(result.stats.segments).toBeGreaterThan(10);
    expect(result.stats.intersections).toBeGreaterThanOrEqual(1);
    expect(result.stats.turnouts).toBeGreaterThanOrEqual(1);
    // 複線を渡る所は、交点が 2 つあっても踏切としては 1 か所にまとめる。
    expect(result.stats.levelCrossings).toBe(1);
    expect(findCrossings(network).filter((c) => c.kind === 'level')).toHaveLength(2);
    expect(result.stats.bridgeLength).toBeGreaterThan(20);
    expect(result.stats.tunnelLength).toBeGreaterThan(20);

    const crossings = findCrossings(network);
    expect(crossings.some((c) => c.kind === 'separated')).toBe(true);
  });

  it('規格違反や不正な交差の警告が出ない', () => {
    const { result } = buildWorld();
    const bad = result.warnings.filter((w) => w.severity !== 'info');
    expect(bad.map((w) => w.message)).toEqual([]);
  });

  it('地表区間では地形が路端の高さにぴったり合う', () => {
    const { field, network, result } = buildWorld();

    // 踏切の内側は舗装が道床の代わりになるので、線路の断面とは高さが違う。
    const crossingZones = new Map<number, { s0: number; s1: number }[]>();
    for (const crossing of findCrossings(network)) {
      if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
      const span = crossing.road.cls.halfWidth + 8;
      const list = crossingZones.get(crossing.rail.segment) ?? [];
      list.push({ s0: crossing.rail.s - span, s1: crossing.rail.s + span });
      crossingZones.set(crossing.rail.segment, list);
    }

    let checked = 0;
    for (const seg of network.segments.values()) {
      const cls = network.classOf(seg);
      const zones = crossingZones.get(seg.id) ?? [];
      // 断面のいちばん外側 (歩道の外端、道床の法尻) に地形が接するのが正。
      const edgeHeight = profileFor(cls)[0].height;
      const alignment = network.alignmentOf(seg.id);
      for (const run of result.structures.get(seg.id) ?? []) {
        if (run.mode !== 'ground') continue;
        // 区間の端は橋台・坑口との境界なので少し内側だけを見る。
        for (let s = run.s0 + 4; s < run.s1 - 4; s += 4) {
          if (zones.some((zone) => s >= zone.s0 && s <= zone.s1)) continue;
          const sample = alignment.sampleAt(s);
          const terrain = field.heightAt(sample.pos.x, sample.pos.z);
          // 踏切のまわりでは、道路が線路に合わせて上下し断面も平らになる。
          // 描画に使ったのと同じ高さを期待値にする。
          const blends = result.blends.get(seg.id) ?? [];
          const { dy } = surfaceBlendAt(blends, s, sample.pos.y);
          const scale = surfaceHeightScale(blends, s);
          const expected = sample.pos.y + dy + edgeHeight * scale;
          // 埋まる (地形が上に出る) ことも、浮く (地形が下に離れる) こともない。
          // 地形は格子の間を線形補間するので、ずれはセル長に比例する。
          expect(Math.abs(terrain - expected)).toBeLessThan(TERRAIN_CELL * 0.25);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('橋・トンネル区間では地形が自然のまま残る', () => {
    const { field, network, result, world } = buildWorld();

    // 他の線形の地表区間は、橋の下・トンネルの上でも当然整地される。
    // 判定対象から外すため、地表区間の位置を集めておく。交差点面は
    // どのセグメントの区間にも属さないので、リングの点も足す。
    const groundPoints: { x: number; z: number }[] = [];
    for (const junction of world.junctions.values()) {
      for (const p of junction.ring) groundPoints.push({ x: p.x, z: p.z });
    }
    for (const seg of network.segments.values()) {
      const alignment = network.alignmentOf(seg.id);
      for (const run of result.structures.get(seg.id) ?? []) {
        if (run.mode !== 'ground') continue;
        for (let s = run.s0; s <= run.s1; s += 4) {
          const p = alignment.sampleAt(s).pos;
          groundPoints.push({ x: p.x, z: p.z });
        }
      }
    }
    const nearGround = (x: number, z: number): boolean =>
      groundPoints.some((g) => Math.hypot(g.x - x, g.z - z) < 40);

    let structural = 0;
    for (const seg of network.segments.values()) {
      const alignment = network.alignmentOf(seg.id);
      for (const run of result.structures.get(seg.id) ?? []) {
        if (run.mode === 'ground') continue;
        for (let s = run.s0 + 4; s < run.s1 - 4; s += 5) {
          const p = alignment.sampleAt(s).pos;
          if (nearGround(p.x, p.z)) continue;
          expect(field.heightAt(p.x, p.z)).toBeCloseTo(field.baseHeightAt(p.x, p.z), 3);
          structural++;
        }
      }
    }
    expect(structural).toBeGreaterThan(20);
  });

  it('車・列車が路面の下を通らない', () => {
    const { world } = buildWorld();
    const surfaces = world.group.children.find((o) => o.name === 'surfaces') as Mesh;
    const index = new SurfaceIndex(surfaces);

    let checked = 0;
    for (const lane of world.laneGraph.lanes) {
      const steps = Math.max(2, Math.ceil(lane.path.length / 2));
      for (let i = 0; i <= steps; i++) {
        const pose = lane.path.poseAt((i / steps) * lane.path.length);
        // 立体交差では当然「上の道路」に覆われるので、自分と同じ高さに
        // ある面 (自分が走っている舗装) だけを見る。
        const top = index.topNear(pose.pos.x, pose.pos.z, pose.pos.y, 3);
        if (top === null) continue;
        checked++;
        // 路面より下を通っていない (踏切の上下・交差点面の反りを含む)。
        expect(top - pose.pos.y).toBeLessThan(0.05);
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('踏切のまわりでレールが地形に埋まらない', () => {
    const { field, network, world } = buildWorld();

    // 舗装の下でレールが隠れるのは仕様なので、道路の幅の外だけを見る。
    for (const crossing of world.crossings) {
      if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
      const alignment = network.alignmentOf(crossing.rail.segment);
      const skip = crossing.road.cls.halfWidth + 1.5;
      let checked = 0;
      for (let d = -40; d <= 40; d += 1) {
        if (Math.abs(d) <= skip) continue;
        const s = crossing.rail.s + d;
        if (s < 0 || s > alignment.length) continue;
        const railhead = alignment.sampleAt(s).pos;
        // レール頭頂面より地形が上に来てはいけない。
        expect(field.heightAt(railhead.x, railhead.z)).toBeLessThan(railhead.y);
        checked++;
      }
      expect(checked).toBeGreaterThan(20);
    }
  });

  it('地形を作り直しても同じシードなら同じ結果になる', () => {
    const a = buildWorld(1234);
    const b = buildWorld(1234);
    expect(b.result.stats).toEqual(a.result.stats);
  });

  it('ネットワークを空にすると地形が元に戻る', () => {
    const { field, network, world } = buildWorld();
    const modified = field.work.slice();
    network.clear();
    world.rebuild();

    let maxDelta = 0;
    for (let i = 0; i < field.work.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(field.work[i] - field.base[i]));
    }
    expect(maxDelta).toBeCloseTo(0, 5);
    // 整地前後で確かに地形が動いていたことも確認する。
    let changed = 0;
    for (let i = 0; i < modified.length; i++) {
      if (Math.abs(modified[i] - field.base[i]) > 0.05) changed++;
    }
    expect(changed).toBeGreaterThan(100);
  });
});

describe('折れ点 (2 枝のノード)', () => {
  /**
   * 道路が折れる所では、2 本の帯と交差点面を合わせて隙間なく覆われて
   * いなければならない。断面の外側 (路端) だけを見て頂点をまとめると、
   * 車道の縁ではずれている点まで落ちてしまい、隅が切れて舗装に穴が開く。
   */
  it('折れ点のまわりに舗装の空きができない', () => {
    const problems: string[] = [];
    let probes = 0;
    for (const classId of ['road_small', 'road_medium', 'road_large']) {
      for (const bendDeg of [8, 14, 25, 40, 60]) {
        const field = testField();
        field.base.fill(40);
        field.resetWork();
        const network = new Network();
        const rad = (bendDeg * Math.PI) / 180;
        // 折れをそのまま残したいので、なめらか化を通さずに直接 2 本繋ぐ。
        bend(network, classId, [
          new Vector3(0, 40, -200),
          new Vector3(0, 40, 0),
          new Vector3(Math.sin(rad) * 200, 40, Math.cos(rad) * 200),
        ]);
        const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
        world.rebuild();
        const surfaces = world.group.children.find((o) => o.name === 'surfaces') as Mesh;
        const cls = getClass(classId);
        // 路端そのものは帯の境界なので、少しだけ内側を見る。
        const reach = cls.halfWidth - 0.2;
        for (let x = -reach; x <= reach; x += 0.25) {
          for (let z = -6; z <= 6; z += 0.25) {
            const onA = z <= 0 && Math.abs(x) <= reach;
            const along = x * Math.sin(rad) + z * Math.cos(rad);
            const across = -x * Math.cos(rad) + z * Math.sin(rad);
            const onB = along >= 0 && Math.abs(across) <= reach;
            if (!onA && !onB) continue;
            probes++;
            if (surfaceTopAt(surfaces, x, z) === null) {
              problems.push(`${classId} ${bendDeg}°: (${x.toFixed(2)}, ${z.toFixed(2)}) に舗装がない`);
            }
          }
        }
      }
    }
    expect(probes).toBeGreaterThan(5000);
    expect(problems.slice(0, 5)).toEqual([]);
  }, 60000);
});

describe('敷設の制限', () => {
  it('サンプルネットワークは敷設規則を全て満たしている', () => {
    const { network } = buildWorld();

    // 既存の各セグメントを「今から引く線形」として評価し直す。
    // サンプルが規則違反を含んでいると、同じものを手で引けないことになる。
    const violations: string[] = [];
    for (const seg of network.segments.values()) {
      const cls = network.classOf(seg);
      const alignment = network.alignmentOf(seg.id);
      const check = checkPlacement({
        network,
        cls,
        alignment,
        start: { pos: network.getNode(seg.a).pos.clone(), node: seg.a },
        end: { pos: network.getNode(seg.b).pos.clone(), node: seg.b },
        ignore: seg.id,
      });
      for (const blocker of check.blockers) violations.push(`seg${seg.id}: ${blocker}`);
    }
    expect(violations).toEqual([]);
  });

  it('規格を外れた線形・建築限界不足は敷設できない', () => {
    const field = testField();
    field.base.fill(20);
    field.resetWork();
    const network = new Network();
    draw(network, 'road_medium', [new Vector3(-150, 20, 0), new Vector3(150, 20, 0)]);

    const cls = getClass('road_medium');
    // 桁下が足りない高さで既存道路を跨ぐ線形。
    const low = straightAlignment(new Vector3(0, 22, -80), new Vector3(0, 22, 80));
    const blocked = checkPlacement({
      network,
      cls,
      alignment: low,
      start: { pos: new Vector3(0, 22, -80) },
      end: { pos: new Vector3(0, 22, 80) },
    });
    expect(blocked.blockers.join(' ')).toContain('建築限界');

    // 十分高ければ通る。
    const high = straightAlignment(new Vector3(0, 26, -80), new Vector3(0, 26, 80));
    const allowed = checkPlacement({
      network,
      cls,
      alignment: high,
      start: { pos: new Vector3(0, 26, -80) },
      end: { pos: new Vector3(0, 26, 80) },
    });
    expect(allowed.blockers).toEqual([]);
  });
});

/** 2 点を結ぶ直線の線形 (テスト用)。 */
function straightAlignment(a: Vector3, b: Vector3): Alignment {
  const from = new Vector2(a.x, a.z);
  const to = new Vector2(b.x, b.z);
  const dir = to.clone().sub(from).normalize();
  const horizontal = curveFromTangents(from, dir, to, dir);
  return new Alignment(horizontal, VerticalProfile.linear(a.y, b.y, horizontal.length));
}
