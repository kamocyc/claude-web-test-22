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
import { WorldBuilder } from '../src/render/worldBuilder';
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
  // 上り線 (南の 1 番線 → 北の 1 番線) と下り線 (北の 2 番線 → 南の 2 番線)。
  const track = (station: Station, index: number) =>
    network.getSegment(station.tracks[index].segment);
  straight(network, track(a, 0).b, track(b, 0).a);
  straight(network, track(b, 1).b, track(a, 1).a);
  return { network, a, b };
}

/** 経路探索だけを見るための、作り物の車線グラフ。 */
function fakeGraph(
  lanes: { next?: number[]; length?: number; station?: number; s?: number }[],
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
    conflicts: [],
    stationStop: lane.station === undefined ? undefined : { station: lane.station, s: lane.s ?? 50 },
  }));
  return { lanes: built, spawnable: [] };
}

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
  it('複線の折り返し運転では、往路と復路の 2 区間になる', () => {
    const { network, a, b } = shuttleNetwork();
    const graph = laneGraphOf(network);
    const lines = new LineMap();
    const line = lines.create();
    lines.addStop(line.id, a.id);
    lines.addStop(line.id, b.id);

    const [plan] = planLines(graph, lines.all, network.stations);
    expect(plan.runnable).toBe(true);
    expect(plan.seamless).toBe(false);
    expect(plan.gaps).toEqual([]);
    expect(plan.itinerary).toEqual([a.id, b.id]);
    expect(plan.runs).toHaveLength(2);
    expect(plan.runs[0].startStation).toBe(a.id);
    expect(plan.runs[0].endStation).toBe(b.id);
    expect(plan.runs[1].startStation).toBe(b.id);
    expect(plan.runs[1].endStation).toBe(a.id);
    // 往路と復路で別の線路 (別のホーム) を通る。
    expect(plan.runs[0].lanes).not.toEqual(plan.runs[1].lanes);
    expect(plan.length).toBeGreaterThan(2 * 400);
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
  it('始発ホームから走り出し、終点で折り返して戻ってくる', () => {
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
    let turnedBack = false;
    for (let i = 0; i < 8000; i++) {
      traffic.step(0.05);
      const train = traffic.vehicles.find((vehicle) => vehicle.line?.id === line.id);
      expect(traffic.vehicles).toHaveLength(1);
      if (!train) continue;
      if (train.lastStation !== undefined && visited[visited.length - 1] !== train.lastStation) {
        visited.push(train.lastStation);
      }
      if (train.line!.run === 1) turnedBack = true;
      if (visited.length >= 4) break;
    }
    expect(turnedBack).toBe(true);
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
    straight(network, track(b, 1).b, track(a, 1).a);

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
    expect(plan.runs).toHaveLength(2);

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
