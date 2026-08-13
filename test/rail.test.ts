import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Vector2, Vector3 } from 'three';
import { surfaceHeightAt } from '../src/build/surface';
import { trackConnectionAlignment } from '../src/build/rail';
import { SURFACE_LIFT } from '../src/core/units';
import { getClass } from '../src/network/classes';
import { anchorFromNode, computePlacement, placeSegment, type Anchor } from '../src/network/editing';
import { Network } from '../src/network/network';
import { solveJunctions, type Junction } from '../src/network/junction';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';

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

/** 直線のセグメントを 1 本足す (端点は近ければ既存ノードに繋ぐ)。 */
function addStraight(network: Network, classId: string, a: Vector3, b: Vector3): void {
  const na = network.findNodeNear(a, 0.5) ?? network.addNode(a);
  const nb = network.findNodeNear(b, 0.5) ?? network.addNode(b);
  const p0 = new Vector2(a.x, a.z);
  const p1 = new Vector2(b.x, b.z);
  network.addSegment({
    classId,
    a: na.id,
    b: nb.id,
    ctrlA: p0.clone().lerp(p1, 1 / 3),
    ctrlB: p0.clone().lerp(p1, 2 / 3),
    gradeA: 0,
    gradeB: 0,
  });
}

function makeWorld(build: (network: Network, field: Heightfield) => void) {
  const field = new Heightfield();
  generateTerrain(field, DEFAULT_TERRAIN);
  const network = new Network();
  build(network, field);
  const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
  const result = world.rebuild();
  const meshes = new Map<string, Mesh>();
  for (const child of world.group.children) {
    if ((child as Mesh).isMesh) meshes.set(child.name, child as Mesh);
  }
  return { field, network, world, result, meshes };
}

/** その XZ を覆う面のうち、いちばん高いものの高さ。無ければ null。 */
function surfaceTopAt(mesh: Mesh, x: number, z: number): number | null {
  const position = mesh.geometry.attributes.position;
  const index = mesh.geometry.getIndex();
  if (!index) return null;
  let top: number | null = null;
  const ax = new Vector3();
  const bx = new Vector3();
  const cx = new Vector3();
  for (let i = 0; i < index.count; i += 3) {
    ax.fromBufferAttribute(position, index.getX(i));
    bx.fromBufferAttribute(position, index.getX(i + 1));
    cx.fromBufferAttribute(position, index.getX(i + 2));
    const y = heightInTriangle(ax, bx, cx, x, z);
    if (y !== null && (top === null || y > top)) top = y;
  }
  return top;
}

function heightInTriangle(a: Vector3, b: Vector3, c: Vector3, x: number, z: number): number | null {
  const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(d) < 1e-12) return null;
  const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
  const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
  const w = 1 - u - v;
  if (u < 0 || v < 0 || w < 0) return null;
  return u * a.y + v * b.y + w * c.y;
}

/**
 * 半径 `radius` 以内でいちばん高い頂点。レール頭頂面を測るのに使う。
 * 架線・架線柱を拾わないよう、`ceiling` より上は無視する。
 */
function highestVertexNear(
  mesh: Mesh,
  x: number,
  z: number,
  radius: number,
  ceiling: number,
): { y: number; count: number } {
  const position = mesh.geometry.attributes.position;
  let top = -Infinity;
  let count = 0;
  for (let i = 0; i < position.count; i++) {
    const dx = position.getX(i) - x;
    const dz = position.getZ(i) - z;
    if (dx * dx + dz * dz > radius * radius) continue;
    const y = position.getY(i);
    if (y > ceiling) continue;
    count++;
    if (y > top) top = y;
  }
  return { y: top, count };
}

describe('踏切', () => {
  /**
   * 勾配のある線路を道路が横切る踏切。
   *
   * 線路が優先なので、舗装の方が線路の面に合わせて上下・傾斜する。舗装の
   * どこを取ってもレール頭頂面が上に出ていなければ、列車は走れない。
   */
  for (const [label, skew] of [
    ['直角', 0],
    ['斜め 30°', 30],
    ['斜め 45°', 45],
  ] as const) {
    it(`勾配 3% の線路を ${label} に横切っても、レールが舗装の上に出ている`, () => {
      const grade = 0.03;
      const railY = (x: number): number => 40 + grade * x;
      const angle = (skew * Math.PI) / 180;
      const scene = makeWorld((network) => {
        draw(network, 'rail_single', [
          new Vector3(-200, railY(-200), 0),
          new Vector3(200, railY(200), 0),
        ]);
        // 交点は原点。道路は線路と同じ高さで通す (踏切になる条件)。
        const dir = new Vector3(Math.sin(angle), 0, Math.cos(angle));
        draw(network, 'road_medium', [
          new Vector3(-dir.x * 120, railY(0), -dir.z * 120),
          new Vector3(dir.x * 120, railY(0), dir.z * 120),
        ]);
      });

      const level = scene.result.stats.levelCrossings;
      expect(level).toBe(1);

      const surfaces = scene.meshes.get('surfaces')!;
      const structures = scene.meshes.get('structures')!;
      const cls = getClass('road_medium');

      // 線路に沿って、道路の footprint を跨ぐ範囲を見る。
      let checked = 0;
      const problems: string[] = [];
      // 路端ぴったりは帯の境界なので、少し内側までを対象にする。
      const reach = cls.halfWidth - 0.3;
      for (let t = -reach; t <= reach + 1e-6; t += 0.5) {
        // 斜め踏切では、道路の幅を横切るのに線路の弧長がより必要になる。
        const along = t / Math.max(0.2, Math.cos(angle));
        const pavement = surfaceTopAt(surfaces, along, 0);
        if (pavement === null) continue;
        // レール頭頂面より上にある構造物 (架線・電柱) は見ない。
        const rail = highestVertexNear(structures, along, 0, 1.1, railY(along) + 0.1);
        if (rail.count === 0) continue;
        checked++;
        const proud = rail.y - pavement;
        if (proud < 0.005) {
          problems.push(`x=${along.toFixed(1)} でレールが舗装より ${(-proud).toFixed(3)} m 下`);
        }
        // 逆に出過ぎていると、路面から段差として飛び出してしまう。
        if (proud > 0.3) {
          problems.push(`x=${along.toFixed(1)} でレールが舗装より ${proud.toFixed(3)} m 上`);
        }
      }
      expect(checked).toBeGreaterThan(20);
      expect(problems).toEqual([]);
    });
  }

  it('踏切のまわりでは縁石の段差が消え、レールが歩道の帯に潜らない', () => {
    const scene = makeWorld((network) => {
      draw(network, 'rail_single', [new Vector3(-200, 40, 0), new Vector3(200, 40, 0)]);
      draw(network, 'road_small', [new Vector3(0, 40, -120), new Vector3(0, 40, 120)]);
    });
    expect(scene.result.stats.levelCrossings).toBe(1);

    const surfaces = scene.meshes.get('surfaces')!;
    const cls = getClass('road_small');
    // 踏切の中心の断面: 中心も路端もレール頭頂面のすぐ下に揃っていること。
    const railY = 40 + SURFACE_LIFT;
    for (const offset of [0, cls.carriagewayHalfWidth - 0.2, cls.halfWidth - 0.2]) {
      const y = surfaceTopAt(surfaces, offset, 0);
      expect(y).not.toBeNull();
      expect(y!).toBeLessThan(railY - 0.005);
      expect(y!).toBeGreaterThan(railY - 0.3);
    }

    // 踏切から 30 m 離れれば、縁石の段差 (0.15 m) が戻っている。
    const far = 30;
    const carriageway = surfaceTopAt(surfaces, 0, far)!;
    const sidewalk = surfaceTopAt(surfaces, cls.halfWidth - 0.2, far)!;
    expect(sidewalk - carriageway).toBeGreaterThan(cls.curbHeight * 0.8);
  });
});

describe('線路の分岐', () => {
  /** 本線を引き、その中ほどのノードから浅い角度で分岐させる。 */
  function switchScene(mainGrade: number, branchGrade: number) {
    return makeWorld((network) => {
      draw(network, 'rail_single', [
        new Vector3(-260, 40, 0),
        new Vector3(0, 40 + mainGrade * 260, 0),
        new Vector3(260, 40 + mainGrade * 520, 0),
      ]);
      const node = network.findNodeNear(new Vector3(0, 40 + mainGrade * 260, 0), 5);
      if (!node) throw new Error('分岐元のノードが見つかりません');
      draw(network, 'rail_yard', [
        node.pos.clone(),
        new Vector3(240, node.pos.y + branchGrade * 250, 70),
      ]);
    });
  }

  function switchJunctions(scene: ReturnType<typeof switchScene>): Junction[] {
    return [...scene.world.junctions.values()].filter(
      (j) => j.kind === 'railSwitch' && j.approaches.length >= 3,
    );
  }

  it('分岐器の中の軌道が、枝の勾配をそのまま引き継ぐ', () => {
    const scene = switchScene(0.02, -0.015);
    const junctions = switchJunctions(scene);
    expect(junctions.length).toBe(1);

    let checked = 0;
    for (const junction of junctions) {
      for (const conn of junction.connections) {
        const from = junction.approaches.find((a) => a.branch.segment === conn.from)!;
        const to = junction.approaches.find((a) => a.branch.segment === conn.to)!;
        const alignment = trackConnectionAlignment(from, to);
        expect(alignment).not.toBeNull();
        checked++;
        // 接続曲線は from の外向きと逆に進むので、始点の勾配は符号が反転する。
        expect(alignment!.vertical.gradeAt(0)).toBeCloseTo(-from.outwardGrade, 6);
        expect(alignment!.vertical.gradeAt(alignment!.length)).toBeCloseTo(to.outwardGrade, 6);
        // 枝の勾配は、実際の線形から測ったものと一致していること。
        const branchAlignment = scene.network.alignmentOf(from.branch.segment);
        const s = from.branch.atStart
          ? from.trim
          : branchAlignment.length - from.trim;
        const grade = branchAlignment.sampleAt(s).grade;
        expect(from.outwardGrade).toBeCloseTo(from.branch.atStart ? grade : -grade, 6);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('分岐器の中の曲線が、規格の最小半径を大きく下回らない', () => {
    const scene = switchScene(0.01, -0.01);
    const junctions = switchJunctions(scene);
    expect(junctions.length).toBe(1);

    for (const junction of junctions) {
      for (const conn of junction.connections) {
        const from = junction.approaches.find((a) => a.branch.segment === conn.from)!;
        const to = junction.approaches.find((a) => a.branch.segment === conn.to)!;
        const alignment = trackConnectionAlignment(from, to)!;
        const { minRadius } = alignment.horizontal.extremeCurvature(48);
        const required = Math.min(from.branch.cls.minRadius, to.branch.cls.minRadius);
        expect(minRadius).toBeGreaterThan(required * 0.8);
      }
    }
  });

  it('高低差のある分岐でも、レールが交差点の道床に埋まらない', () => {
    for (const [mainGrade, branchGrade] of [
      [0.02, -0.015],
      [-0.025, 0.015],
      [0.03, 0.02],
    ]) {
      const scene = switchScene(mainGrade, branchGrade);
      const junctions = switchJunctions(scene);
      expect(junctions.length).toBe(1);
      const structures = scene.meshes.get('structures')!;

      for (const junction of junctions) {
        const ballast = junction.rings[junction.rings.length - 1];
        expect(ballast.length).toBeGreaterThan(3);
        let checked = 0;
        const problems: string[] = [];
        for (const conn of junction.connections) {
          const from = junction.approaches.find((a) => a.branch.segment === conn.from)!;
          const to = junction.approaches.find((a) => a.branch.segment === conn.to)!;
          const alignment = trackConnectionAlignment(from, to)!;
          for (let i = 1; i < 20; i++) {
            const sample = alignment.sampleAt((alignment.length * i) / 20);
            const surface = surfaceHeightAt(ballast, sample.pos.x, sample.pos.z);
            if (surface === null) continue;
            const rail = highestVertexNear(
              structures,
              sample.pos.x,
              sample.pos.z,
              1.1,
              sample.pos.y + 1,
            );
            if (rail.count === 0) continue;
            checked++;
            // レールは道床の上に出ていること (レール高 0.15 m の半分以上)。
            if (rail.y < surface + 0.1) {
              problems.push(
                `${mainGrade}/${branchGrade}: レール頭頂面が道床の ${(
                  surface - rail.y
                ).toFixed(3)} m 下`,
              );
            }
          }
        }
        expect(checked).toBeGreaterThan(20);
        expect(problems).toEqual([]);
      }
    }
  });

  /**
   * 分岐器の道床は、通り抜ける軌道と同じように曲がっていなければならない。
   *
   * 両端の断面を弦で結んだだけの形にすると、曲線のふくらみの分だけ道床が
   * 外へ張り出し、線路が道床の真ん中から外れて見える。
   */
  it('分岐器の道床が軌道に沿って曲がる (弦で結んだ形にならない)', () => {
    const scene = switchScene(0, 0);
    const junctions = switchJunctions(scene);
    expect(junctions.length).toBe(1);
    const junction = junctions[0];

    // 交差点の中を通る全ての軌道と、取り付く枝の中心線。
    const paths: { points: Vector3[]; halfWidth: number }[] = [];
    for (const conn of junction.connections) {
      const from = junction.approaches.find((a) => a.branch.segment === conn.from)!;
      const to = junction.approaches.find((a) => a.branch.segment === conn.to)!;
      const alignment = trackConnectionAlignment(from, to)!;
      const points: Vector3[] = [];
      for (let i = 0; i <= 60; i++) points.push(alignment.sampleAt((alignment.length * i) / 60).pos);
      paths.push({
        points,
        halfWidth: Math.max(from.branch.cls.halfWidth, to.branch.cls.halfWidth),
      });
    }
    expect(paths.length).toBeGreaterThanOrEqual(2);

    /** その点から、いちばん近い軌道の路端までの距離 (中に入っていれば負)。 */
    const beyondTrack = (x: number, z: number): number => {
      let best = Infinity;
      for (const path of paths) {
        for (const p of path.points) {
          best = Math.min(best, Math.hypot(p.x - x, p.z - z) - path.halfWidth);
        }
      }
      return best;
    };

    const ballast = junction.rings[junction.rings.length - 1];
    let inside = 0;
    let worst = 0;
    let worstAt = '';
    const bounds = ballast.reduce(
      (b, p) => ({
        minX: Math.min(b.minX, p.x),
        maxX: Math.max(b.maxX, p.x),
        minZ: Math.min(b.minZ, p.z),
        maxZ: Math.max(b.maxZ, p.z),
      }),
      { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
    );
    for (let x = bounds.minX; x <= bounds.maxX; x += 0.35) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z += 0.35) {
        if (surfaceHeightAt(ballast, x, z) === null) continue;
        inside++;
        const beyond = beyondTrack(x, z);
        if (beyond > worst) {
          worst = beyond;
          worstAt = `(${x.toFixed(1)}, ${z.toFixed(1)})`;
        }
      }
    }
    expect(inside).toBeGreaterThan(500);
    // 軌道の路端から 1.5 m 以上外まで道床が張り出していたら、それは
    // 曲線を無視して弦で結んでいる (直前の実装では 4 m 近く出ていた)。
    expect(`${worst.toFixed(2)} m @ ${worstAt}`).toBe(`${Math.min(worst, 1.5).toFixed(2)} m @ ${worstAt}`);
  });

  /**
   * どんな分岐でも、交差点を通る進路は必ず道床の上を通っていなければ
   * ならない。弦で結んだ道床では、分岐角が 30° を超えると曲線が道床から
   * はみ出して、線路が宙に浮いていた。
   */
  it('どの分岐角・規格でも、進路が道床から外れない', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const [main, branch] of [
      ['rail_single', 'rail_yard'],
      ['rail_double', 'rail_yard'],
      ['rail_double', 'rail_double'],
      ['rail_yard', 'rail_double'],
    ]) {
      for (const deg of [8, 15, 20, 25, 30, 40, 55, 70, 90]) {
        for (const [la, lb, lc] of [
          [200, 200, 200],
          [60, 60, 60],
          [200, 40, 40],
        ]) {
          const network = new Network();
          const rad = (deg * Math.PI) / 180;
          addStraight(network, main, new Vector3(-la, 40, 0), new Vector3(0, 40, 0));
          addStraight(network, main, new Vector3(0, 40, 0), new Vector3(lb, 40, 0));
          addStraight(
            network,
            branch,
            new Vector3(0, 40, 0),
            new Vector3(Math.cos(rad) * lc, 40, Math.sin(rad) * lc),
          );

          for (const junction of solveJunctions(network).junctions.values()) {
            if (junction.approaches.length < 3) continue;
            const ballast = junction.rings[junction.rings.length - 1];
            // 帯を組むには、どのリングも同じ点数でなければならない。
            expect(new Set(junction.rings.map((r) => r.length)).size).toBe(1);
            for (const conn of junction.connections) {
              const from = junction.approaches.find((a) => a.branch.segment === conn.from)!;
              const to = junction.approaches.find((a) => a.branch.segment === conn.to)!;
              const alignment = trackConnectionAlignment(from, to);
              if (!alignment) continue;
              for (let i = 0; i <= 24; i++) {
                const p = alignment.sampleAt((alignment.length * i) / 24).pos;
                checked++;
                if (ballast.length < 3 || surfaceHeightAt(ballast, p.x, p.z) === null) {
                  problems.push(
                    `${main}/${branch} ${deg}° L=${la},${lb},${lc}: (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) に道床がない`,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
    expect(problems.slice(0, 5)).toEqual([]);
  }, 30000);

  /**
   * 交差点の道床は、セグメントの道床と同じ色でなければならない。
   * 種別の代表色をそのまま使うと、断面の道床色とわずかに食い違って
   * 分岐器の所だけ色が変わって見える。
   */
  it('分岐器の道床の色が、線路の道床の色と同じ', () => {
    const scene = switchScene(0, 0);
    const junction = switchJunctions(scene)[0];
    const node = scene.network.getNode(junction.node).pos;
    const surfaces = scene.meshes.get('surfaces')!;
    const position = surfaces.geometry.attributes.position;
    const normal = surfaces.geometry.attributes.normal;
    const color = surfaces.geometry.attributes.color;

    const tones = new Set<string>();
    let counted = 0;
    for (let i = 0; i < position.count; i++) {
      // 道床の天端 (上向きの面) だけを見る。法面は別の色でよい。
      if (normal.getY(i) < 0.9) continue;
      const dx = position.getX(i) - node.x;
      const dz = position.getZ(i) - node.z;
      if (dx * dx + dz * dz > 25 * 25) continue;
      counted++;
      tones.add(
        [color.getX(i), color.getY(i), color.getZ(i)].map((v) => v.toFixed(3)).join(','),
      );
    }
    expect(counted).toBeGreaterThan(10);
    expect([...tones]).toHaveLength(1);
  });
});
