import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector2, Vector3 } from 'three';
import { BuildTool } from '../src/app/buildTool';
import { LineMap } from '../src/network/line';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { stationAt, type Station } from '../src/network/station';
import { buildLaneGraph, type GraphLane, type LaneGraph } from '../src/sim/lanegraph';
import { planLines } from '../src/sim/lineRoute';
import { Traffic } from '../src/sim/traffic';
import { buildDemoNetwork } from '../src/app/demo';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { testField } from './support/field';

function straight(network: Network, a: number, b: number): SegmentId {
  const pa = network.getNode(a).pos;
  const pb = network.getNode(b).pos;
  const p0 = new Vector2(pa.x, pa.z);
  const p1 = new Vector2(pb.x, pb.z);
  return network.addSegment({
    classId: 'rail_single',
    a,
    b,
    ctrlA: p0.clone().lerp(p1, 1 / 3),
    ctrlB: p0.clone().lerp(p1, 2 / 3),
    gradeA: 0,
    gradeB: 0,
  }).id;
}

function laneGraphOf(network: Network): LaneGraph {
  const { junctions, trims } = solveJunctions(network);
  const ranges = new Map<SegmentId, { s0: number; s1: number }>();
  for (const segment of network.segments.values()) {
    const trim = trims.get(segment.id) ?? { a: 0, b: 0 };
    const length = network.alignmentOf(segment.id).length;
    ranges.set(segment.id, { s0: trim.a, s1: Math.max(trim.a + 0.5, length - trim.b) });
  }
  return buildLaneGraph(network, junctions, ranges);
}

/** 端の駅どうしを複線で結んだ、いちばん素直な路線の下地。 */
function shuttleNetwork(): { network: Network; a: Station; b: Station } {
  const network = new Network();
  const a = network.addStation({
    name: '南',
    center: new Vector3(0, 0, -200),
    heading: Math.PI / 2,
    length: 120,
    trackCount: 2,
    platformCount: 2,
    elevated: false,
  });
  const b = network.addStation({
    name: '北',
    center: new Vector3(0, 0, 200),
    heading: Math.PI / 2,
    length: 120,
    trackCount: 2,
    platformCount: 2,
    elevated: false,
  });
  // 1 番線どうし・2 番線どうしを結ぶ複線。線路に向きは無いので、
  // どちらの線路も両方向に走れる。
  const track = (station: Station, index: number) =>
    network.getSegment(station.tracks[index].segment);
  straight(network, track(a, 0).b, track(b, 0).a);
  straight(network, track(a, 1).b, track(b, 1).a);
  return { network, a, b };
}

/** 経路探索だけを見るための、作り物の車線グラフ。 */
function fakeGraph(
  lanes: { next?: number[]; length?: number; station?: number; s?: number; reverse?: number }[],
): LaneGraph {
  const built: GraphLane[] = lanes.map((lane, id) => ({
    id,
    kind: 'segment',
    vehicleKind: 'train',
    path: {
      length: lane.length ?? 100,
      poseAt: () => ({ pos: new Vector3(), dir: new Vector3(0, 0, 1), roll: 0 }),
    },
    speedLimit: 20,
    next: lane.next ?? [],
    reverse: lane.reverse,
    conflicts: [],
    stationStop: lane.station === undefined ? undefined : { station: lane.station, s: lane.s ?? 50 },
  }));
  return { lanes: built, spawnable: [] };
}

/** 1 両の長さ [m] (`traffic.ts` の TRAIN_SIZE)。 */
const TRAIN_CAR_LENGTH = 18;

function fakeStations(ids: number[]): Map<number, Station> {
  const out = new Map<number, Station>();
  for (const id of ids) {
    out.set(id, { id, name: `駅${id}` } as Station);
  }
  return out;
}

describe('路線の台帳', () => {
  it('駅を足し、同じ駅の続けての選択は無視し、消えた駅を落とす', () => {
    const lines = new LineMap();
    const line = lines.create();
    expect(line.stops).toEqual([]);
    expect(lines.addStop(line.id, 1)).toBe(true);
    expect(lines.addStop(line.id, 1)).toBe(false);
    expect(lines.addStop(line.id, 2)).toBe(true);
    expect(lines.addStop(line.id, 1)).toBe(true);
    expect(line.stops).toEqual([1, 2, 1]);

    expect(lines.prune(new Set([1]))).toBe(true);
    expect(line.stops).toEqual([1, 1]);
    expect(lines.prune(new Set([1]))).toBe(false);

    const second = lines.create();
    expect(second.name).not.toBe(line.name);
    expect(second.color).not.toEqual(line.color);
    expect(lines.all).toHaveLength(2);
    expect(lines.remove(line.id)).toBe(true);
    expect(lines.all).toHaveLength(1);
  });
});

describe('路線の経路', () => {
  it('終点で折り返す往復運転は、ひと続きの区間になる', () => {
    const { network, a, b } = shuttleNetwork();
    const graph = laneGraphOf(network);
    const lines = new LineMap();
    const line = lines.create();
    lines.addStop(line.id, a.id);
    lines.addStop(line.id, b.id);

    const [plan] = planLines(graph, lines.all, network.stations);
    expect(plan.runnable).toBe(true);
    expect(plan.gaps).toEqual([]);
    expect(plan.itinerary).toEqual([a.id, b.id]);
    // 入ってきた線路をそのまま戻れるので、区間は切れない。
    expect(plan.runs).toHaveLength(1);
    expect(plan.seamless).toBe(true);
    expect(plan.runs[0].startStation).toBe(a.id);
    expect(plan.length).toBeGreaterThan(2 * 400);

    // 経路の途中で、同じ線路の逆向きの車線へ移る (そこが折り返し)。
    const lanes = plan.runs[0].lanes;
    const turns = lanes.filter((id, i) => graph.lanes[id].reverse === lanes[i + 1]);
    expect(turns).toHaveLength(1);
    // 折り返して戻るので、同じ線路を両方向に使う。行き違いはできない。
    expect(plan.singleTrack).toBe(true);
  });

  it('単線でも、終点で折り返して往復できる', () => {
    // 0/1 = 駅10 のホーム, 2/3 = 途中, 4/5 = 駅20 のホーム。
    // 偶数が北行き、奇数がその線路を南行きに走る車線。
    const graph = fakeGraph([
      { next: [2], station: 10, reverse: 1 },
      { station: 10, reverse: 0 },
      { next: [4], reverse: 3 },
      { next: [1], reverse: 2 },
      { station: 20, reverse: 5 },
      { next: [3], station: 20, reverse: 4 },
    ]);
    const lines = new LineMap();
    const line = lines.create();
    lines.addStop(line.id, 10);
    lines.addStop(line.id, 20);
    const [plan] = planLines(graph, lines.all, fakeStations([10, 20]));
    expect(plan.runnable).toBe(true);
    expect(plan.seamless).toBe(true);
    expect(plan.singleTrack).toBe(true);
    expect(plan.gaps).toEqual([]);
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0].lanes).toEqual([0, 2, 4, 5, 3, 1]);
  });

  it('折り返さずに一周できるなら、折り返さない', () => {
    // 0 → 1 → 2 → 3 → 0 の環状線。逆向き (4〜7) にも同じだけ走れるが、
    // 折り返すと時間がかかるぶん、そのまま一周する方が選ばれる。
    const graph = fakeGraph([
      { next: [1], station: 10, reverse: 4 },
      { next: [2], reverse: 5 },
      { next: [3], station: 20, reverse: 6 },
      { next: [0], reverse: 7 },
      { next: [7], station: 10, reverse: 0 },
      { next: [4], reverse: 1 },
      { next: [5], station: 20, reverse: 2 },
      { next: [6], reverse: 3 },
    ]);
    const lines = new LineMap();
    const line = lines.create();
    lines.addStop(line.id, 10);
    lines.addStop(line.id, 20);
    const [plan] = planLines(graph, lines.all, fakeStations([10, 20]));
    expect(plan.seamless).toBe(true);
    expect(plan.runs[0].lanes).toEqual([0, 1, 2, 3]);
    // 片方向にしか使わないので、複数の編成を走らせられる。
    expect(plan.singleTrack).toBe(false);
  });

  it('停車駅が 1 つだけなら走らせない', () => {
    const { network, a } = shuttleNetwork();
    const lines = new LineMap();
    const line = lines.create();
    lines.addStop(line.id, a.id);
    const [plan] = planLines(laneGraphOf(network), lines.all, network.stations);
    expect(plan.runnable).toBe(false);
    expect(plan.runs).toEqual([]);
  });

  it('線路が繋がっていない駅どうしは、繋がっていない区間として分かる', () => {
    const network = new Network();
    for (const [name, z] of [['西', -200], ['東', 200]] as const) {
      network.addStation({
        name,
        center: new Vector3(0, 0, z),
        heading: Math.PI / 2,
        length: 120,
        trackCount: 1,
        platformCount: 1,
        elevated: false,
      });
    }
    const [west, east] = [...network.stations.values()];
    const lines = new LineMap();
    const line = lines.create();
    lines.addStop(line.id, west.id);
    lines.addStop(line.id, east.id);
    const [plan] = planLines(laneGraphOf(network), lines.all, network.stations);
    expect(plan.runnable).toBe(false);
    expect(plan.gaps).toEqual([
      { from: '西', to: '東' },
      { from: '東', to: '西' },
    ]);
  });

  it('片方向しか繋がっていなければ、片道だけ走って戻りは回送になる', () => {
    // 0 = 西の駅, 1 = 途中, 2 = 東の駅。戻る線路は無い。
    const graph = fakeGraph([
      { next: [1], station: 10 },
      { next: [2] },
      { station: 20 },
    ]);
    const lines = new LineMap();
    const line = lines.create();
    lines.addStop(line.id, 10);
    lines.addStop(line.id, 20);
    const [plan] = planLines(graph, lines.all, fakeStations([10, 20]));
    expect(plan.runnable).toBe(true);
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0].lanes).toEqual([0, 1, 2]);
    expect(plan.gaps).toEqual([{ from: '駅20', to: '駅10' }]);
  });

  it('一周して戻る路線は、折り返さずに走り続ける', () => {
    // 0 = 駅10 → 1 → 2 = 駅20 → 3 → 0 の一方通行の環状線。
    const graph = fakeGraph([
      { next: [1], station: 10 },
      { next: [2] },
      { next: [3], station: 20 },
      { next: [0] },
    ]);
    const lines = new LineMap();
    const line = lines.create();
    lines.addStop(line.id, 10);
    lines.addStop(line.id, 20);
    const [plan] = planLines(graph, lines.all, fakeStations([10, 20]));
    expect(plan.seamless).toBe(true);
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0].lanes).toEqual([0, 1, 2, 3]);
    expect(plan.gaps).toEqual([]);
  });

  it('3 駅では、終点で折り返して順に戻る', () => {
    const graph = fakeGraph([
      { next: [1], station: 10 },
      { next: [2], station: 20 },
      { station: 30 },
    ]);
    const lines = new LineMap();
    const line = lines.create();
    for (const station of [10, 20, 30]) lines.addStop(line.id, station);
    const [plan] = planLines(graph, lines.all, fakeStations([10, 20, 30]));
    expect(plan.itinerary).toEqual([10, 20, 30, 20]);
  });
});

describe('路線の列車', () => {
  it('始発ホームから走り出し、終点でその場で折り返して戻ってくる', () => {
    const { network, a, b } = shuttleNetwork();
    const graph = laneGraphOf(network);
    const lines = new LineMap();
    const line = lines.create();
    lines.addStop(line.id, a.id);
    lines.addStop(line.id, b.id);
    const plans = planLines(graph, lines.all, network.stations);

    const traffic = new Traffic(graph, { maxCars: 0, maxTrains: 0 });
    traffic.setLines(plans);

    const visited: number[] = [];
    let turnedBack = 0;
    /** 折り返したときに、編成の真ん中がどれだけ動いたか [m]。 */
    let worstShift = 0;
    let facing: Vector3 | null = null;
    let middle: Vector3 | null = null;
    for (let i = 0; i < 8000; i++) {
      traffic.step(0.05);
      const train = traffic.vehicles.find((vehicle) => vehicle.line?.id === line.id);
      expect(traffic.vehicles).toHaveLength(1);
      if (!train) continue;
      if (train.lastStation !== undefined && visited[visited.length - 1] !== train.lastStation) {
        visited.push(train.lastStation);
      }
      // 折り返しは「その場で向きが返る」こと。編成の真ん中は動かない。
      const now = train.bodies[Math.floor(train.cars / 2)].pos.clone();
      const dir = train.bodies[0].dir.clone();
      if (facing && middle && facing.dot(dir) < 0) {
        turnedBack++;
        worstShift = Math.max(worstShift, middle.distanceTo(now));
      }
      facing = dir;
      middle = now;
      if (visited.length >= 4) break;
    }
    expect(turnedBack).toBeGreaterThan(0);
    // 入ってきた線路をそのまま戻るので、編成は 1 両ぶんも動かない。
    expect(worstShift).toBeLessThan(TRAIN_CAR_LENGTH);
    // 南 (始発) → 北 (終点) → 折り返して南 → また北。
    expect(visited.slice(0, 4)).toEqual([a.id, b.id, a.id, b.id]);
  });

  it('駅の敷地を指すとその駅が返る', () => {
    const { network, a, b } = shuttleNetwork();
    const stations = [...network.stations.values()];
    expect(stationAt(stations, a.center.x, a.center.z)?.id).toBe(a.id);
    expect(stationAt(stations, b.center.x, b.center.z)?.id).toBe(b.id);
    // ホームの上 (中心から横にずれた所) でも同じ駅。
    const platform = b.platforms[0];
    const x = b.center.x - Math.sin(b.heading) * platform.offset;
    const z = b.center.z + Math.cos(b.heading) * platform.offset;
    expect(stationAt(stations, x, z)?.id).toBe(b.id);
    // 駅の外。
    expect(stationAt(stations, 0, 0)).toBeNull();
    expect(stationAt(stations, 400, a.center.z)).toBeNull();
  });
});

describe('サンプルの町の路線', () => {
  it('終端駅どうしを結ぶと、折り返しながら往復し続ける', () => {
    const field = testField();
    generateTerrain(field, DEFAULT_TERRAIN);
    const network = new Network();
    buildDemoNetwork(network, field);
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    for (const station of network.stations.values()) {
      const line = world.lines.all[0] ?? world.lines.create();
      world.lines.addStop(line.id, station.id);
    }
    const [plan] = world.rebuild().lines;
    expect(plan.runnable).toBe(true);
    // 引き上げ線も渡り線も無いので、終端では入ってきた線路をそのまま戻る。
    expect(plan.seamless).toBe(true);
    expect(plan.singleTrack).toBe(true);
    expect(plan.gaps).toEqual([]);

    const [south, north] = [...network.stations.values()].sort(
      (a, b) => a.center.z - b.center.z,
    );
    const visited: number[] = [];
    let stuck = 0;
    let worstStuck = 0;
    for (let i = 0; i < 12000; i++) {
      world.traffic.step(0.05);
      const train = world.traffic.vehicles.find((vehicle) => vehicle.line);
      if (!train) continue;
      if (train.lastStation !== undefined && visited[visited.length - 1] !== train.lastStation) {
        visited.push(train.lastStation);
      }
      // 停車・折り返し以外で止まったままにならない。
      stuck = train.speed < 0.5 && train.dwellUntil === undefined ? stuck + 0.05 : 0;
      worstStuck = Math.max(worstStuck, stuck);
      if (visited.length >= 3) break;
    }
    expect(visited).toEqual([north.id, south.id, north.id]);
    expect(worstStuck).toBeLessThan(30);
  });
});

describe('路線ツール', () => {
  it('駅をクリックしていくと路線ができ、列車が走り出す', () => {
    const field = testField();
    const network = new Network();
    // 平らな所に、複線で結んだ 2 駅を置く。
    const a = network.addStation({
      name: '南',
      center: new Vector3(0, field.heightAt(0, -160), -160),
      heading: Math.PI / 2,
      length: 120,
      trackCount: 2,
      platformCount: 2,
      elevated: false,
    });
    const b = network.addStation({
      name: '北',
      center: new Vector3(0, field.heightAt(0, 160), 160),
      heading: Math.PI / 2,
      length: 120,
      trackCount: 2,
      platformCount: 2,
      elevated: false,
    });
    const track = (station: Station, index: number) =>
      network.getSegment(station.tracks[index].segment);
    straight(network, track(a, 0).b, track(b, 0).a);
    straight(network, track(a, 1).b, track(b, 1).a);

    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    let changed = 0;
    const tool = new BuildTool(network, field, () => changed++, world, world.zones, world.lines);
    tool.setMode('line');

    // 駅の外を指しても何も起きない。
    tool.update(new Vector3(300, 0, 0), { straight: false, noSnap: false });
    expect(tool.status().hoverStation).toBeNull();
    tool.click();
    expect(world.lines.size).toBe(0);

    for (const station of [a, b]) {
      tool.update(station.center.clone(), { straight: false, noSnap: false });
      expect(tool.status().hoverStation?.id).toBe(station.id);
      tool.click();
    }
    expect(changed).toBe(2);
    expect(world.lines.size).toBe(1);
    expect(tool.status().line?.stops).toEqual(['南', '北']);

    const result = world.rebuild();
    expect(result.stats.lines).toBe(1);
    const [plan] = result.lines;
    expect(plan.runnable).toBe(true);
    expect(plan.runs).toHaveLength(1);
    expect(plan.seamless).toBe(true);

    // 走らせると、路線の列車が始発ホームに現れる。
    world.animate(0, 0.05);
    const train = world.traffic.vehicles.find((vehicle) => vehicle.line?.id === plan.id);
    expect(train).toBeDefined();
    expect(train!.color).toEqual(plan.color);
    expect(train!.lastStation).toBe(a.id);

    // Esc で区切ると、次のクリックは新しい路線になる。
    tool.cancel();
    expect(tool.status().line).toBeNull();
    tool.update(b.center.clone(), { straight: false, noSnap: false });
    tool.click();
    expect(world.lines.size).toBe(2);

    // 駅を撤去すると、その駅は停車駅から落ちる。
    network.removeStation(b.id);
    const after = world.rebuild();
    expect(world.lines.all[0].stops).toEqual([a.id]);
    expect(after.lines[0].runnable).toBe(false);
    expect(world.traffic.vehicles.filter((v) => v.line)).toHaveLength(0);
  });
});
