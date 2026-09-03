import { describe, expect, it } from 'vitest';
import { Mesh, MeshBasicMaterial, Vector2, Vector3 } from 'three';
import { BuildTool } from '../src/app/buildTool';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import {
  planStationLayout,
  stationLocal,
  stationPlatformRange,
  stationPointOn,
} from '../src/network/station';
import { applyStationRetrofit, planStationRetrofit } from '../src/network/stationRetrofit';
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


/** 直線の線路を `pieces` 本に分けて敷く。 */
function rail(network: Network, from: Vector3, to: Vector3, pieces = 1): void {
  let prev = network.addNode(from.clone());
  for (let i = 1; i <= pieces; i++) {
    const at = from.clone().lerp(to, i / pieces);
    const node = network.addNode(at);
    straight(network, prev, node);
    prev = node;
  }
}

/** 半径 `radius` の円弧の線路。中心角 `sweep` [rad] を `pieces` 本に分ける。 */
function curvedRail(network: Network, radius: number, sweep: number, pieces = 6): void {
  const at = (t: number): Vector3 =>
    new Vector3(Math.sin(t) * radius, 0, Math.cos(t) * radius - radius);
  let prev = network.addNode(at(-sweep / 2));
  for (let i = 1; i <= pieces; i++) {
    const t0 = -sweep / 2 + (sweep * (i - 1)) / pieces;
    const t1 = -sweep / 2 + (sweep * i) / pieces;
    const node = network.addNode(at(t1));
    const a = new Vector2(prev.pos.x, prev.pos.z);
    const b = new Vector2(node.pos.x, node.pos.z);
    // 円弧に近づく制御点 (端の接線方向へ弦長の 1/3)。
    const handle = a.distanceTo(b) / 3;
    network.addSegment({
      classId: 'rail_single',
      a: prev.id,
      b: node.id,
      ctrlA: a.clone().add(new Vector2(Math.cos(t0), -Math.sin(t0)).multiplyScalar(handle)),
      ctrlB: b.clone().sub(new Vector2(Math.cos(t1), -Math.sin(t1)).multiplyScalar(handle)),
      gradeA: 0,
      gradeB: 0,
    });
    prev = node;
  }
}

/** 指した所に駅を後付けする。 */
function retrofit(
  network: Network,
  at: Vector3,
  settings: { length?: 80 | 120 | 160 | 200; trackCount?: number; platformCount?: number } = {},
) {
  const hit = network.findSegmentNear(at, 30);
  if (!hit) throw new Error('線路が見つかりません');
  return planStationRetrofit(
    network,
    {
      name: '後付け駅',
      length: settings.length ?? 120,
      trackCount: settings.trackCount ?? 1,
      platformCount: settings.platformCount ?? 1,
      adopt: { segment: hit.segment, s: hit.s },
      trackIndex: 0,
      reversed: false,
    },
    flatField(),
  );
}

describe('既設の線路への駅の後付け', () => {
  it('線路を取り込んで構内線にし、撤去すると普通の線路に戻る', () => {
    const network = new Network();
    rail(network, new Vector3(-300, 0, 0), new Vector3(300, 0, 0));
    const result = retrofit(network, new Vector3(0, 0, 0));
    expect(result.blockers).toEqual([]);

    const station = applyStationRetrofit(network, result.plan!);
    expect(station.adopted).toBe(0);
    // 元の 1 本が「手前・構内・先」の 3 本に分かれる。
    expect(network.segments.size).toBe(3);
    const host = network.getSegment(station.tracks[0].segment);
    expect(host.stationTrack).toEqual({ station: station.id, index: 0 });
    expect(network.alignmentOf(host.id).length).toBeCloseTo(120, 1);

    // 撤去しても線路は残る (路線に穴を空けない)。
    network.removeStation(station.id);
    expect(network.stations.size).toBe(0);
    expect(network.segments.size).toBe(3);
    expect(network.getSegment(host.id).stationTrack).toBeUndefined();
  });

  it('複数の区間にまたがっても1本の構内線にまとまる', () => {
    const network = new Network();
    rail(network, new Vector3(-300, 0, 0), new Vector3(300, 0, 0), 8);
    const result = retrofit(network, new Vector3(0, 0, 0), { length: 200 });
    expect(result.blockers).toEqual([]);

    const station = applyStationRetrofit(network, result.plan!);
    const host = network.getSegment(station.tracks[0].segment);
    // 継ぎ目をまたいだので連結ベジエになる。形は元の線路のまま。
    expect(host.via?.length ?? 0).toBeGreaterThan(0);
    expect(network.alignmentOf(host.id).length).toBeCloseTo(200, 0);
    const alignment = network.alignmentOf(host.id);
    for (let i = 0; i <= 10; i++) {
      const p = alignment.sampleAt((alignment.length * i) / 10).pos;
      expect(Math.abs(p.z)).toBeLessThan(0.05);
    }
  });

  it('曲線の線路に置くと、ホームも曲線に沿う', () => {
    const network = new Network();
    curvedRail(network, 400, 1.2);
    const result = retrofit(network, new Vector3(0, 0, 0));
    expect(result.blockers).toEqual([]);
    const station = applyStationRetrofit(network, result.plan!);

    // 中心線が曲がっている。
    expect(station.path.horizontal.extremeCurvature(48).minRadius).toBeLessThan(600);

    // ホーム上の点は中心線から一定の横距にあり、直線には乗らない。
    const platform = station.platforms[0];
    const points = [-40, 0, 40].map((along) => stationPointOn(station, along, platform.offset));
    for (const point of points) {
      expect(stationLocal(station, point.x, point.z).across).toBeCloseTo(platform.offset, 1);
    }
    const chord = points[0].clone().lerp(points[2], 0.5);
    expect(points[1].distanceTo(chord)).toBeGreaterThan(0.5);

    // 曲線の駅でも組み立てが通る。
    const field = flatField();
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const built = world.rebuild();
    expect(built.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(built.stats.stations).toBe(1);
  });

  it('待避線を足すと、駅の前後で本線に合流する', () => {
    const network = new Network();
    rail(network, new Vector3(-600, 0, 0), new Vector3(600, 0, 0));
    const result = retrofit(network, new Vector3(0, 0, 0), { trackCount: 2, platformCount: 1 });
    expect(result.blockers).toEqual([]);
    expect(result.plan!.throats).toHaveLength(2);

    const station = applyStationRetrofit(network, result.plan!);
    expect(station.tracks).toHaveLength(2);
    const throats = [...network.segments.values()].filter((s) => s.stationThroat === station.id);
    expect(throats).toHaveLength(2);

    // 分岐器ができ、ぜんぶひと繋がりのまま。
    const field = flatField();
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const built = world.rebuild();
    expect(built.stats.turnouts).toBe(2);
    expect(built.stats.railNetworks).toBe(1);
    expect(built.warnings.filter((w) => w.severity === 'error')).toEqual([]);

    // 両方の番線にホームの停車位置がある。
    const graph = laneGraphOf(network);
    const stops = new Set(
      graph.lanes.filter((lane) => lane.stationStop).map((lane) => lane.segment),
    );
    expect(stops.size).toBe(2);

    // 撤去すると待避線と取り付きは消え、本線は残る。
    network.removeStation(station.id);
    expect([...network.segments.values()].every((s) => s.stationThroat === undefined)).toBe(true);
    expect(network.stations.size).toBe(0);
    const remaining = [...network.segments.values()];
    expect(remaining.every((s) => s.stationTrack === undefined)).toBe(true);
  });

  it('分岐のある所や線路の端では置けない', () => {
    const network = new Network();
    rail(network, new Vector3(-300, 0, 0), new Vector3(300, 0, 0), 2);
    // 中央のノードから支線を分ける。
    const middle = network.findNodeNear(new Vector3(0, 0, 0), 1)!;
    const branch = network.addNode(new Vector3(60, 0, 120));
    straight(network, middle, branch);
    const overBranch = retrofit(network, new Vector3(-40, 0, 0));
    expect(overBranch.plan).toBeNull();
    expect(overBranch.blockers.join()).toMatch(/分岐/);

    const short = new Network();
    rail(short, new Vector3(-30, 0, 0), new Vector3(30, 0, 0));
    const tooLong = retrofit(short, new Vector3(0, 0, 0), { length: 120 });
    expect(tooLong.plan).toBeNull();
    expect(tooLong.blockers.join()).toMatch(/線路の端/);
  });

  it('曲線に対して敷地が広すぎると置けない', () => {
    // 半径 20 m の曲線に 6 線 (敷地の半幅 33 m) を並べると、内側の縁が
    // 自分と交わってしまう。
    const network = new Network();
    curvedRail(network, 20, 6, 24);
    const result = retrofit(network, new Vector3(0, 0, 0), {
      length: 80,
      trackCount: 6,
      platformCount: 4,
    });
    expect(result.blockers.join()).toMatch(/曲線/);
  });
});

describe('駅ツールの後付け操作', () => {
  it('線路を指すと後付けに切り替わり、N / M で取り込む番線が変わる', () => {
    const field = flatField();
    const network = new Network();
    rail(network, new Vector3(-400, 0, 0), new Vector3(400, 0, 0));
    const tool = new BuildTool(network, field, () => {});
    tool.setMode('station');
    tool.setStationSettings({ name: '取り込み', trackCount: 2, platformCount: 1, length: 120 });

    // 空き地では今までどおり向きが回る。
    tool.update(new Vector3(0, 0, 200), { straight: false, noSnap: false });
    expect(tool.status().stationAdopt).toBeNull();
    const heading = tool.status().station.heading;
    tool.rotateStation(1);
    expect(tool.status().station.heading).not.toBeCloseTo(heading);

    // 線路の上では取り込みに切り替わり、N / M は番線を変える。
    tool.update(new Vector3(0, 0, 0), { straight: false, noSnap: false });
    expect(tool.status().stationAdopt).toEqual({ trackIndex: 0, reversed: false });
    expect(tool.status().blockers).toEqual([]);
    const turned = tool.status().station.heading;
    tool.rotateStation(1);
    expect(tool.status().stationAdopt).toEqual({ trackIndex: 1, reversed: false });
    expect(tool.status().station.heading).toBeCloseTo(turned);

    tool.click();
    const station = [...network.stations.values()][0];
    expect(station).toBeDefined();
    expect(station.adopted).toBe(1);
    expect(network.getSegment(station.tracks[1].segment).stationTrack).toBeDefined();
  });
});
