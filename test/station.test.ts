import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Vector2, Vector3 } from 'three';
import { BuildTool } from '../src/app/buildTool';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { planStationLayout, stationPlatformRange } from '../src/network/station';
import { WorldBuilder } from '../src/render/worldBuilder';
import { buildLaneGraph } from '../src/sim/lanegraph';
import { STATION_DWELL, Traffic } from '../src/sim/traffic';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';

function flatField(): Heightfield {
  return new Heightfield(128, 2);
}

function straight(
  network: Network,
  a: { id: number; pos: Vector3 },
  b: { id: number; pos: Vector3 },
): void {
  const p0 = new Vector2(a.pos.x, a.pos.z);
  const p1 = new Vector2(b.pos.x, b.pos.z);
  network.addSegment({
    classId: 'rail_single',
    a: a.id,
    b: b.id,
    ctrlA: p0.clone().lerp(p1, 1 / 3),
    ctrlB: p0.clone().lerp(p1, 2 / 3),
    gradeA: 0,
    gradeB: 0,
  });
}

function laneGraphOf(network: Network) {
  const { junctions, trims } = solveJunctions(network);
  const ranges = new Map<SegmentId, { s0: number; s1: number }>();
  for (const segment of network.segments.values()) {
    const trim = trims.get(segment.id) ?? { a: 0, b: 0 };
    const length = network.alignmentOf(segment.id).length;
    ranges.set(segment.id, { s0: trim.a, s1: Math.max(trim.a + 0.5, length - trim.b) });
  }
  return buildLaneGraph(network, junctions, ranges);
}

describe('駅の横断配置', () => {
  it('有効な全組合せで全線がホームに接する', () => {
    for (let tracks = 1; tracks <= 6; tracks++) {
      const range = stationPlatformRange(tracks);
      for (let platforms = range.min; platforms <= range.max; platforms++) {
        const a = planStationLayout(tracks, platforms);
        const b = planStationLayout(tracks, platforms);
        expect(a).toEqual(b);
        expect(a.tracks).toHaveLength(tracks);
        expect(a.platforms).toHaveLength(platforms);
        for (const track of a.tracks) {
          expect(a.platforms.some((platform) => platform.tracks.includes(track.index))).toBe(true);
        }
      }
    }
  });
});

describe('駅データ', () => {
  it('station tracksを生成し、改名と駅単位撤去ができる', () => {
    const network = new Network();
    const station = network.addStation({
      name: '中央',
      center: new Vector3(0, 4, 0),
      heading: 0,
      length: 120,
      trackCount: 3,
      platformCount: 2,
      elevated: true,
    });
    expect(network.stations.size).toBe(1);
    expect(station.tracks).toHaveLength(3);
    expect(station.tracks.every((track) => network.getSegment(track.segment).stationTrack?.station === station.id)).toBe(true);

    network.renameStation(station.id, '新中央');
    expect(network.stations.get(station.id)?.name).toBe('新中央');
    expect(() => network.splitSegment(station.tracks[0].segment, 30)).toThrow(/駅構内/);

    network.removeSegment(station.tracks[0].segment);
    expect(network.stations.size).toBe(0);
    expect(network.segments.size).toBe(0);
    expect(network.nodes.size).toBe(0);
  });
});

describe('駅ツールと描画', () => {
  it('1クリックで駅を配置し、N/M相当の回転と高架設定を反映する', () => {
    const field = flatField();
    const network = new Network();
    let changed = 0;
    const tool = new BuildTool(network, field, () => changed++);
    tool.setMode('station');
    tool.setStationSettings({ name: '高架前', trackCount: 2, platformCount: 1, length: 80 });
    tool.rotateStation(1);
    tool.adjustElevation(2);
    tool.update(new Vector3(10, 0, 20), { straight: false, noSnap: false });
    expect(tool.status().blockers).toEqual([]);
    tool.click();

    const station = [...network.stations.values()][0];
    expect(station).toBeDefined();
    expect(station.elevated).toBe(true);
    expect(station.heading).toBeCloseTo(Math.PI / 12);
    expect(changed).toBe(1);

    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = world.rebuild();
    expect(result.stats.stations).toBe(1);
    const structures = world.group.children.find((child) => child.name === 'structures');
    const positions = (structures as Mesh).geometry.attributes.position;
    expect(positions.count).toBeGreaterThan(100);
  });

  it('駅の両端から線路を伸ばせ、構内線の進行方向へ自動的に接続される', () => {
    const field = flatField();
    const network = new Network();
    const y = field.heightAt(0, 0);
    const station = network.addStation({
      name: '接続試験駅',
      center: new Vector3(0, y, 0),
      heading: 0,
      length: 80,
      trackCount: 2,
      platformCount: 2,
      elevated: false,
    });
    const tool = new BuildTool(network, field, () => {});
    tool.setClass('rail_single');
    const stationSegment = network.getSegment(station.tracks[0].segment);

    for (const [nodeId, x0, x1] of [
      [stationSegment.a, -100, -180],
      [stationSegment.b, 100, 180],
    ] as const) {
      const end = network.getNode(nodeId).pos;
      tool.update(end, { straight: true, noSnap: false });
      expect(tool.status().snap).toBe('node');
      tool.click();
      tool.update(new Vector3(x0, y, end.z), { straight: true, noSnap: false });
      expect(tool.status().blockers).toEqual([]);
      tool.click();
      tool.update(new Vector3(x1, y, end.z), { straight: true, noSnap: false });
      expect(tool.status().blockers).toEqual([]);
      tool.click();
      tool.cancel();
    }
    expect(network.segments.size).toBe(6);

    const graph = laneGraphOf(network);
    const segmentLanes = graph.lanes.filter((lane) => lane.kind === 'segment');
    const stationLane = segmentLanes.find((lane) => lane.segment === stationSegment.id)!;
    const reaches = (from: number, target: number): boolean => {
      const queue = [from];
      const seen = new Set<number>();
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (id === target) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(...(graph.lanes[id]?.next ?? []));
      }
      return false;
    };
    const entryLane = segmentLanes
      .filter((lane) => lane.segment !== stationSegment.id && reaches(lane.id, stationLane.id))
      .sort((a, b) => a.path.poseAt(0).pos.x - b.path.poseAt(0).pos.x)[0];
    expect(entryLane).toBeDefined();
    expect(stationLane.next.length).toBeGreaterThan(0);

    // Spawn only on the approach that actually enters the station. The train must
    // survive both station boundaries, stop, and reach the departure track.
    graph.spawnable.splice(0, graph.spawnable.length, entryLane!.id);
    const traffic = new Traffic(graph, { trainSpacing: 1, maxTrains: 1, maxCars: 0, seed: 8 });
    let stopped = false;
    let reachedDepartureTrack = false;
    for (let i = 0; i < 3000; i++) {
      traffic.step(0.05);
      const train = traffic.vehicles.find((vehicle) => vehicle.kind === 'train');
      if (!train) continue;
      if (train.dwellUntil !== undefined) stopped = true;
      const lane = graph.lanes[traffic.laneOf(train)];
      if (stopped && lane?.kind === 'segment' && lane.segment !== stationSegment.id) {
        reachedDepartureTrack = true;
        break;
      }
    }
    expect(stopped).toBe(true);
    expect(reachedDepartureTrack).toBe(true);
  });
});

describe('列車の駅停車', () => {
  it('ホーム中央で5秒停車し、再発車する', () => {
    const network = new Network();
    const station = network.addStation({
      name: '試験駅',
      center: new Vector3(0, 0, 0),
      heading: 0,
      length: 120,
      trackCount: 1,
      platformCount: 1,
      elevated: false,
    });
    const stationSegment = network.getSegment(station.tracks[0].segment);
    const west = network.addNode(new Vector3(-420, 0, 0));
    straight(network, west, network.getNode(stationSegment.a));

    const graph = laneGraphOf(network);
    expect(graph.spawnable.every((id) => !graph.lanes[id].stationStop)).toBe(true);
    const traffic = new Traffic(graph, { trainSpacing: 100, maxTrains: 1, maxCars: 0, seed: 4 });
    const dt = 0.05;
    let stoppedFrom: number | null = null;
    let stoppedUntil: number | null = null;
    let departed = false;
    let centred = false;
    for (let i = 0; i < 2400; i++) {
      traffic.step(dt);
      const train = traffic.vehicles.find((vehicle) => vehicle.kind === 'train');
      if (!train) continue;
      if (train.dwellUntil !== undefined && train.speed === 0) {
        stoppedFrom ??= traffic.time;
        stoppedUntil = traffic.time;
        const first = train.bodies[0].pos;
        const last = train.bodies[train.bodies.length - 1].pos;
        centred ||= Math.abs((first.x + last.x) / 2) < 2;
      } else if (stoppedFrom !== null && train.speed > 0.5) {
        departed = true;
        break;
      }
    }
    expect(stoppedFrom).not.toBeNull();
    expect(stoppedUntil! - stoppedFrom!).toBeGreaterThanOrEqual(STATION_DWELL - 0.15);
    expect(centred).toBe(true);
    expect(departed).toBe(true);
  });
});
