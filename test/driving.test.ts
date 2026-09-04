import { describe, expect, it } from 'vitest';
import { computeCant } from '../src/build/cant';
import { Driving, longestRailStart, walkForward } from '../src/app/driving';
import { buildDrivingDemo } from '../src/app/drivingDemo';
import { findCrossings } from '../src/network/crossings';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { computeStructureProfile, type StructureRun } from '../src/network/structure';
import { buildLaneGraph, type LaneGraph } from '../src/sim/lanegraph';
import { Traffic } from '../src/sim/traffic';
import { Heightfield } from '../src/terrain/heightfield';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { TERRAIN_CELL } from '../src/core/units';

/**
 * 運転モードと運転デモ路線。
 *
 * ここで「運転できる」に到達する。数で押さえるのは次の 3 つ。
 *
 * 1. デモ路線に、運転して確かめたいもの (直線・勾配・制限のかかる曲線・駅) が
 *    一通り出てくること
 * 2. ノッチで加速し、常用ブレーキで駅に止まれること
 * 3. 運転している列車が他の車両から先行車として見えていること
 */

interface World {
  network: Network;
  graph: LaneGraph;
  structures: Map<SegmentId, StructureRun[]>;
  traffic: Traffic;
}

/**
 * デモ路線が収まる広さの起伏のある地形。
 *
 * `test/support/field` の高さ場は 2048 m 四方で平坦なので、4.4 km の路線が
 * はみ出すうえ勾配も出ない。ここでは本番と同じ生成器で 5120 m 四方を作る。
 */
function demoField(): Heightfield {
  const field = new Heightfield(5120 / TERRAIN_CELL, TERRAIN_CELL);
  generateTerrain(field, { ...DEFAULT_TERRAIN, seed: 4231 });
  return field;
}

/**
 * デモ路線の世界。
 *
 * 地形の生成と敷設で 1 秒近くかかるので、**1 度だけ組んで使い回す**。
 * 線路と車線グラフは運転しても変わらない (運転が触るのは `Traffic` だけ) ので、
 * 検定ごとに `Traffic` だけ新しくすれば互いに干渉しない。
 */
let cached: (World & { stations: number[]; warnings: string[] }) | null = null;

function demoWorld(): World & { stations: number[]; warnings: string[] } {
  const base = (cached ??= buildDemoWorld());
  return { ...base, traffic: new Traffic(base.graph) };
}

function buildDemoWorld(): World & { stations: number[]; warnings: string[] } {
  const network = new Network();
  const field = demoField();
  const { stations, warnings } = buildDrivingDemo(network, field);

  const { junctions, trims } = solveJunctions(network);
  const ranges = new Map<SegmentId, { s0: number; s1: number }>();
  const structures = new Map<SegmentId, StructureRun[]>();
  for (const seg of network.segments.values()) {
    const trim = trims.get(seg.id)!;
    const alignment = network.alignmentOf(seg.id);
    const range = { s0: trim.a, s1: Math.max(trim.a + 0.5, alignment.length - trim.b) };
    ranges.set(seg.id, range);
    structures.set(seg.id, computeStructureProfile(alignment, field, range));
  }
  const cant = computeCant(network, findCrossings(network));
  const graph = buildLaneGraph(network, junctions, ranges, {
    surface: (segment, s) => ({ dy: 0, roll: cant.get(segment)?.(s) ?? 0 }),
  });
  return { network, graph, structures, traffic: new Traffic(graph), stations, warnings };
}

/** その世界で、いちばん長く走れる線路に列車を置く。 */
function driveOn(world: World): Driving {
  const start = longestRailStart(world.graph);
  expect(start).not.toBeNull();
  const driving = Driving.start(world.graph, world.traffic, start!, {
    stations: world.network.stations,
    structures: world.structures,
  });
  expect(driving).not.toBeNull();
  return driving!;
}

describe('運転デモ路線', () => {
  it('4〜5 km の線路が 1 本通り、駅が 3 つ載る', () => {
    const world = demoWorld();
    expect(world.warnings).toEqual([]);
    expect(world.stations.length).toBe(3);
    // 端から端まで走れる長さ。線路の総延長ではない (待避線とのどが乗る)。
    expect(driveOn(world).route.length).toBeGreaterThan(4000);
    expect(driveOn(world).route.length).toBeLessThan(5000);
  });

  it('橋とトンネルが出てくる (地形をならした縦断の副産物)', () => {
    const world = demoWorld();
    let bridge = 0;
    let tunnel = 0;
    for (const runs of world.structures.values()) {
      for (const run of runs) {
        if (run.mode === 'bridge') bridge += run.s1 - run.s0;
        if (run.mode === 'tunnel') tunnel += run.s1 - run.s0;
      }
    }
    expect(bridge).toBeGreaterThan(200);
    expect(tunnel).toBeGreaterThan(50);
  });

  it('途中駅には待避線がある (行き違いができる)', () => {
    const world = demoWorld();
    const counts = [...world.network.stations.values()].map((s) => s.trackCount);
    expect(counts).toContain(2);
    // 待避線は本線に分岐器で取り付く
    const throats = [...world.network.segments.values()].filter(
      (seg) => seg.stationThroat !== undefined,
    );
    expect(throats.length).toBeGreaterThan(0);
  });

  it('直線・勾配・制限のかかる曲線が、この順に出てくる', () => {
    const world = demoWorld();
    const driving = driveOn(world);
    const route = driving.route;
    const limit = (s: number) => route.compiled.speedLimits.at(s);
    const line = route.compiled.maxSpeed;

    // 前半に、加速し切れるだけの制限のない直線がある
    let straight = 0;
    for (let s = 0; s < route.length * 0.35; s += 5) {
      straight = limit(s) >= line ? straight + 5 : 0;
      if (straight > 800) break;
    }
    expect(straight).toBeGreaterThan(800);

    // 勾配がある。何‰ になるかは地形しだい (種を変えれば変わる) なので、
    // 「平坦なだけの線路にはならない」ことだけを見る。この地形では 8‰ 前後で、
    // 4 両編成が惰行すれば 0.3 km/h/s ほど落ちる。
    let steepest = 0;
    for (let s = 0; s <= route.length; s += 10) {
      steepest = Math.max(steepest, Math.abs(route.compiled.alignment.gradeAt(s)));
    }
    expect(steepest).toBeGreaterThan(0.005);

    // 後半に、線区最高速度を割る曲線がある
    let restricted = 0;
    for (let s = route.length * 0.5; s <= route.length; s += 5) {
      if (limit(s) < line) restricted += 5;
    }
    expect(restricted).toBeGreaterThan(100);
  });
});

describe('運転', () => {
  it('力行すれば加速し、常用ブレーキで止まる', () => {
    const world = demoWorld();
    const driving = driveOn(world);

    driving.apply('reverserForward');
    driving.apply('notchNeutral');
    for (let i = 0; i < 4; i++) driving.apply('powerUp');
    // ハンドルは手元の位置。装置のノッチは 1 度進めてから付いてくる。
    expect(driving.driver.handles.power).toBe(4);
    for (let i = 0; i < 1500; i++) driving.update(1 / 60);
    const running = driving.status();
    expect(running.speed).toBeGreaterThan(40);

    driving.apply('notchNeutral');
    for (let i = 0; i < 8; i++) driving.apply('brakeUp');
    for (let i = 0; i < 4000; i++) driving.update(1 / 60);
    expect(driving.status().speed).toBeLessThan(1);
  });

  it('運転台を引き継いだ時点でブレーキが込められている', () => {
    const world = demoWorld();
    const driving = driveOn(world);
    expect(driving.driver.handles.brake).toBeGreaterThan(0);
    // 何もしなければ動かない。始発は下り勾配にあるので、緩解したままだと転動する。
    for (let i = 0; i < 600; i++) driving.update(1 / 60);
    expect(driving.status().speed).toBeLessThan(0.5);
  });

  it('走った列車は線路の上を進み、姿勢が 1 両ずつ付いてくる', () => {
    const world = demoWorld();
    const driving = driveOn(world);
    const train = driving.train;
    const start = train.bodies[0]!.pos.clone();

    driving.apply('reverserForward');
    driving.apply('notchNeutral');
    for (let i = 0; i < 4; i++) driving.apply('powerUp');
    for (let i = 0; i < 1200; i++) driving.update(1 / 60);

    expect(train.bodies[0]!.pos.distanceTo(start)).toBeGreaterThan(100);
    expect(train.bodies.length).toBe(4);
    // 4 両が編成の順に並んでいる (重なっても離れてもいない)
    for (let k = 1; k < train.bodies.length; k++) {
      const gap = train.bodies[k - 1]!.pos.distanceTo(train.bodies[k]!.pos);
      expect(gap).toBeGreaterThan(18);
      expect(gap).toBeLessThan(22);
    }
  });

  it('惰行と制動では、速度の変わり方が桁で違う', () => {
    const world = demoWorld();
    const driving = driveOn(world);
    driving.apply('reverserForward');
    driving.apply('notchNeutral');
    for (let i = 0; i < 4; i++) driving.apply('powerUp');
    for (let i = 0; i < 1500; i++) driving.update(1 / 60);
    const top = driving.status().speed;

    // 惰行 5 秒。走行抵抗と勾配だけなので、上りでも下りでも変化はわずか。
    driving.apply('notchNeutral');
    for (let i = 0; i < 300; i++) driving.update(1 / 60);
    const coasted = Math.abs(driving.status().speed - top);
    const from = driving.status().speed;

    // 常用最大 5 秒。3.5km/h/s なので 15km/h 前後落ちる。
    for (let i = 0; i < 8; i++) driving.apply('brakeUp');
    for (let i = 0; i < 300; i++) driving.update(1 / 60);
    const braked = from - driving.status().speed;

    expect(braked).toBeGreaterThan(10);
    expect(coasted).toBeLessThan(braked / 3);
  });

  it('非常ブレーキは常用最大より短く止まる', () => {
    const stopDistance = (emergency: boolean): number => {
      const world = demoWorld();
      const driving = driveOn(world);
      driving.apply('reverserForward');
      driving.apply('notchNeutral');
      for (let i = 0; i < 4; i++) driving.apply('powerUp');
      for (let i = 0; i < 1500; i++) driving.update(1 / 60);
      const from = driving.status().position;
      driving.apply('notchNeutral');
      if (emergency) driving.apply('emergency');
      else for (let i = 0; i < 8; i++) driving.apply('brakeUp');
      for (let i = 0; i < 4000; i++) {
        driving.update(1 / 60);
        if (driving.status().speed < 0.3) break;
      }
      return driving.status().position - from;
    };
    expect(stopDistance(true)).toBeLessThan(stopDistance(false));
  });

  it('運転している列車は、他の車両から先行車として見える', () => {
    const world = demoWorld();
    const driving = driveOn(world);
    // Traffic に載っているので、在線・車間の計算にそのまま入る。
    expect(world.traffic.vehicles).toContain(driving.train);
    expect(driving.train.driven).toBe(true);
    // Traffic を進めても、運転している列車は勝手に動かない。
    const before = driving.train.head;
    world.traffic.step(1 / 60);
    expect(driving.train.head).toBeCloseTo(before, 9);
  });

  it('運転を終えると列車は線路から降りる', () => {
    const world = demoWorld();
    const driving = driveOn(world);
    driving.stop();
    expect(world.traffic.vehicles).not.toContain(driving.train);
  });
});

describe('経路の辿り方', () => {
  it('折り返しには入らない (止まらずに向きが変わることはない)', () => {
    const world = demoWorld();
    const start = longestRailStart(world.graph)!;
    const chain = walkForward(world.graph, start);
    const reverses = new Set(
      chain.map((id) => world.graph.lanes[id]?.reverse).filter((id) => id !== undefined),
    );
    for (const id of chain) expect(reverses.has(id)).toBe(false);
  });

  it('同じ車線を 2 度通らない', () => {
    const world = demoWorld();
    const chain = walkForward(world.graph, longestRailStart(world.graph)!);
    expect(new Set(chain).size).toBe(chain.length);
  });
});
