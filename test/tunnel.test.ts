import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  buildScene,
  draw,
  drawBranch,
  hillX,
  insidePolygonXZ,
  junctionSurfaceRing,
  polygonSurfaceY,
  trianglesOf,
  verticesOf,
  type Scene,
} from './support/adversarial';

/**
 * トンネルの中の交差点と、トンネルの中での道の延伸。
 *
 * トンネル区間では地形を切らない (地山をそのまま残す) ので、交差点面を
 * そのまま置くと山の中に埋まる。交差点面の外周から覆工を立ち上げて
 * **地中の空洞**にし、枝のトンネルはそこへ開く (坑門は建てない)。
 *
 * 山は `hillX(20, 40, 90)` — 路面 (y=20) からの土被りは中央で 40 m、
 * |x| ≈ 75 m で 12 m (トンネルの閾値) を切って坑口になる。
 */

/** 山を貫く道路と、その中ほどから南へ出る枝。 */
function tunnelJunction(branchX = 0): Scene {
  const name = `トンネルの中の交差点 x=${branchX}`;
  return buildScene(name, hillX(20, 40, 90), (net, field) => {
    const blockers = draw(net, field, 'road_medium', [
      { x: -260, z: 0, y: 20 },
      { x: 260, z: 0, y: 20 },
    ], { straight: true });
    blockers.push(
      ...drawBranch(net, field, 'road_small', new Vector3(branchX, 20, 0), [
        { x: branchX, z: 120, y: 20 },
        { x: branchX, z: 240, y: 20 },
      ], { straight: true }),
    );
    return blockers;
  });
}

/** 交差点面のリングと、その上の構造物の頂点。 */
function aroundJunction(scene: Scene): {
  ring: Vector3[];
  /** 面からの高さ [m] (面の中にある構造物の頂点だけ)。 */
  heights: number[];
  /** 面の重心。 */
  centre: Vector3;
} {
  const junction = [...scene.world.junctions.values()].find(
    (j) => j.approaches.length >= 3 && junctionSurfaceRing(j.rings),
  );
  if (!junction) throw new Error('交差点が無い');
  const ring = junctionSurfaceRing(junction.rings)!;
  const pos = verticesOf(scene, 'structures');
  const heights: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.x(i);
    const z = pos.z(i);
    if (!insidePolygonXZ(ring, x, z)) continue;
    const surface = polygonSurfaceY(ring, x, z);
    if (surface === null) continue;
    heights.push(pos.y(i) - surface);
  }
  const centre = new Vector3();
  for (const p of ring) centre.add(p);
  centre.divideScalar(ring.length);
  return { ring, heights, centre };
}

/** 三角形の XZ 投影が点を含むか。 */
function coversXZ(tri: { a: Vector3; b: Vector3; c: Vector3 }, x: number, z: number): boolean {
  const sign = (p: Vector3, q: Vector3): number => (q.x - p.x) * (z - p.z) - (q.z - p.z) * (x - p.x);
  const d1 = sign(tri.a, tri.b);
  const d2 = sign(tri.b, tri.c);
  const d3 = sign(tri.c, tri.a);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

describe('トンネルの中の交差点', () => {
  it('土被りの深い所なら交差点を作れる', () => {
    const scene = tunnelJunction(0);
    expect(scene.blocked).toEqual([]);
    expect(scene.result.stats.intersections).toBe(1);
  });

  it('坑口にかかる交差点は作れない', () => {
    // |x| ≈ 75 m がトンネルと地表の境目。ここに交差点を作ると、
    // 坑門の柱が交差点の口に立つ。
    const scene = tunnelJunction(75);
    expect(scene.blocked.join('\n')).toContain('坑口');
    expect(scene.result.stats.intersections).toBe(0);
  });

  it('交差点の真ん中にも天井が張られる (空洞になっている)', () => {
    // 枝のトンネルは交差点の口までしか来ない。交差点の**真ん中**の上に
    // 面があるかどうかが、空洞になっているかどうかそのもの。
    const scene = tunnelJunction(0);
    const { ring, centre } = aroundJunction(scene);
    const surface = polygonSurfaceY(ring, centre.x, centre.z)!;
    let roof = Infinity;
    for (const tri of trianglesOf(scene, 'structures')) {
      if (!coversXZ(tri, centre.x, centre.z)) continue;
      const y = (tri.a.y + tri.b.y + tri.c.y) / 3;
      if (y > surface + 1 && y < roof) roof = y;
    }
    // 建築限界より上、トンネル断面の天端あたりに張られている。
    expect(roof - surface).toBeGreaterThan(4.5);
    expect(roof - surface).toBeLessThan(8);
  });

  it('枝の口に坑門の柱が立たない', () => {
    // 坑門の柱は路面の 2.5 m 下から立ち上がる。交差点の中に「面より
    // 大きく下へ伸びる構造物」があってはいけない (曲がってきた車が
    // ぶつかる)。トンネルの覆工そのものは 0.4 m しか下りない。
    const { heights } = aroundJunction(tunnelJunction(0));
    expect(heights.length).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeGreaterThan(-1);
  });

  it('トンネルの外の坑口には坑門が残る', () => {
    const scene = tunnelJunction(0);
    const pos = verticesOf(scene, 'structures');
    // 坑口 (|x| ≈ 75) のまわりに、路面より下へ伸びる坑門の柱がある。
    let found = false;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(Math.abs(pos.x(i)) - 75) > 12) continue;
      if (pos.y(i) < 20 - 1.5) found = true;
    }
    expect(found).toBe(true);
  });
});

describe('トンネルの中での道の延伸', () => {
  /** 山の中で行き止まる道路を、さらに奥へ延ばす。 */
  function extend(): { blocked: string[]; segments: number } {
    let segments = 0;
    const scene = buildScene('トンネルの中の延伸', hillX(20, 40, 90), (net, field) => {
      const blockers = draw(net, field, 'road_medium', [
        { x: -260, z: 0, y: 20 },
        { x: -20, z: 0, y: 20 },
      ], { straight: true });
      // 行き止まり (山の中) から続きを引く。
      blockers.push(
        ...draw(net, field, 'road_medium', [
          { x: -20, z: 0, y: 20 },
          { x: 60, z: 0, y: 20 },
        ], { straight: true }),
      );
      segments = net.segments.size;
      return blockers;
    });
    return { blocked: scene.blocked, segments };
  }

  it('行き止まりから続きを引ける', () => {
    const { blocked, segments } = extend();
    expect(blocked).toEqual([]);
    expect(segments).toBeGreaterThan(1);
  });
});

/**
 * 中央が平らな台地。`flat` までは天端、そこから `fall` かけて裾へ落ちる。
 * 坑口の位置と土被りを別々に決められるので、下がトンネルかどうかと
 * 土被りが残るかどうかを切り分けて試せる。
 */
const plateauX =
  (y0: number, height: number, flat: number, fall: number) =>
  (x: number): number =>
    y0 + height * Math.max(0, Math.min(1, (flat + fall - Math.abs(x)) / fall));

describe('トンネルの上を越す線形', () => {
  /** 台地を貫く道路と、その上の地表を横切る線路。 */
  function overTunnel(
    terrain: (x: number) => number,
    railX: number,
    railY?: number,
  ): Scene {
    return buildScene(`トンネルの上 x=${railX}`, terrain, (net, field) => {
      const blockers = draw(net, field, 'road_medium', [
        { x: -380, z: 0, y: 10 },
        { x: -140, z: 0, y: 10 },
        { x: 100, z: 0, y: 10 },
        { x: 340, z: 0, y: 10 },
      ], { straight: true });
      blockers.push(
        ...draw(net, field, 'rail_single', [
          { x: railX, z: -300, y: railY },
          { x: railX, z: -150, y: railY },
          { x: railX, z: 0, y: railY },
          { x: railX, z: 150, y: railY },
          { x: railX, z: 300, y: railY },
        ], { straight: true }),
      );
      return blockers;
    });
  }

  /** 線路の区間に橋が含まれているか。 */
  function railHasBridge(scene: Scene): boolean {
    for (const seg of scene.network.segments.values()) {
      if (seg.classId !== 'rail_single') continue;
      for (const run of scene.world.structureRunsOf(seg.id)) {
        if (run.mode === 'bridge') return true;
      }
    }
    return false;
  }

  /** 道路の区間にトンネルが含まれているか。 */
  function roadHasTunnel(scene: Scene): boolean {
    for (const seg of scene.network.segments.values()) {
      if (seg.classId !== 'road_medium') continue;
      for (const run of scene.world.structureRunsOf(seg.id)) {
        if (run.mode === 'tunnel') return true;
      }
    }
    return false;
  }

  it('道路がトンネルなら、その上を通る線路は地表のまま', () => {
    // 天端 50 m の台地。y=10 の道路は土被り 40 m のトンネルになる。
    const scene = overTunnel(plateauX(10, 40, 150, 60), 0);
    expect(scene.blocked).toEqual([]);
    expect(roadHasTunnel(scene)).toBe(true);
    // 線路は自然地形の上をそのまま通る。
    expect(railHasBridge(scene)).toBe(false);
  });

  it('坑口にかかるところでは、今までどおり橋にする', () => {
    // 坑口は |x| ≈ 192 m。そこを跨ぐと、露出した道路が線路の盛土に埋まる。
    const scene = overTunnel(plateauX(10, 40, 150, 60), -186);
    expect(scene.blocked).toEqual([]);
    expect(railHasBridge(scene)).toBe(true);
  });

  it('土被りが残らないほど掘り下げた線路は、橋のままにする', () => {
    // 天端 30 m の台地 (土被り 20 m)。線路を y=20 まで下げると、
    // 整地したあとトンネルの上に 10 m しか残らない。
    const terrain = plateauX(10, 20, 150, 60);
    const deep = overTunnel(terrain, 0, 20);
    expect(deep.blocked).toEqual([]);
    expect(roadHasTunnel(deep)).toBe(true);
    expect(railHasBridge(deep)).toBe(true);

    // 同じ台地でも、浅い切土 (y=26) なら土被りが 16 m 残るので地表でよい。
    const shallow = overTunnel(terrain, 0, 26);
    expect(shallow.blocked).toEqual([]);
    expect(railHasBridge(shallow)).toBe(false);
  });
});
