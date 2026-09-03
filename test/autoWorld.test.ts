import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial } from 'three';
import { buildAutoWorld } from '../src/app/autoWorld';
import { getClass } from '../src/network/classes';
import { Network, type SegmentId } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { TERRAIN_CELL } from '../src/core/units';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { planCities } from '../src/world/cities';
import { planRoadLinks } from '../src/world/roadNetwork';
import { RouteField, findRoute, smoothRoute } from '../src/world/routing';
import { testField, TEST_MAP_SIZE } from './support/field';

function terrainField(seed = DEFAULT_TERRAIN.seed): Heightfield {
  const field = testField();
  generateTerrain(field, { ...DEFAULT_TERRAIN, seed });
  return field;
}

/** 道路が「ノードを共有してひと繋がりか」を数える。 */
function componentCount(network: Network): number {
  const parent = new Map<SegmentId, SegmentId>();
  const find = (a: SegmentId): SegmentId => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root) as SegmentId;
    return root;
  };
  for (const seg of network.segments.values()) parent.set(seg.id, seg.id);
  for (const node of network.nodes.values()) {
    for (let i = 1; i < node.segments.length; i++) {
      const a = find(node.segments[0]);
      const b = find(node.segments[i]);
      if (a !== b) parent.set(a, b);
    }
  }
  return new Set([...network.segments.keys()].map(find)).size;
}

describe('都市の配置', () => {
  it('同じ地形からは同じ都市が決まる', () => {
    const field = terrainField();
    const a = planCities(field, { seed: 1234, waterLevel: 0 });
    const b = planCities(field, { seed: 1234, waterLevel: 0 });
    expect(a.length).toBeGreaterThanOrEqual(4);
    expect(b).toEqual(a);
  });

  it('水没した所には置かず、互いに離れて並ぶ', () => {
    const field = terrainField();
    const cities = planCities(field, { seed: 20260903, waterLevel: 0 });
    for (const city of cities) {
      expect(field.baseHeightAt(city.x, city.z)).toBeGreaterThan(0);
    }
    for (let i = 0; i < cities.length; i++) {
      for (let j = i + 1; j < cities.length; j++) {
        const d = Math.hypot(cities[i].x - cities[j].x, cities[i].z - cities[j].z);
        expect(d).toBeGreaterThan(TEST_MAP_SIZE * 0.1);
      }
    }
  });

  it('大きな都市ほど平らな所に置かれる', () => {
    const field = terrainField();
    const cities = planCities(field, { seed: 20260903, waterLevel: 0 });
    // 市街地が乗る範囲の起伏。順位が上の都市ほど小さいはず。
    const relief = (x: number, z: number): number => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const h = field.baseHeightAt(x + Math.cos(a) * 120, z + Math.sin(a) * 120);
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
      return max - min;
    };
    const big = cities.filter((c) => c.tier === 2);
    const small = cities.filter((c) => c.tier === 0);
    expect(big.length).toBeGreaterThan(0);
    expect(small.length).toBeGreaterThan(0);
    const worstBig = Math.max(...big.map((c) => relief(c.x, c.z)));
    const bestSmall = Math.min(...small.map((c) => relief(c.x, c.z)));
    // 大都市の中でいちばん起伏のある所でも、町のいちばん平らな所と大差ない。
    expect(worstBig).toBeLessThan(bestSmall + 6);
  });
});

describe('都市間の結び方', () => {
  const city = (
    id: number,
    x: number,
    z: number,
    tier: 0 | 1 | 2,
    population: number,
  ) => ({
    id,
    name: `第${id}`,
    tier,
    x,
    z,
    y: 0,
    population,
    radius: 120,
    heading: 0,
  });

  it('全ての都市がひと繋がりになる', () => {
    const cities = [
      city(0, -800, -600, 2, 600_000),
      city(1, 700, -500, 1, 200_000),
      city(2, -600, 700, 0, 40_000),
      city(3, 800, 900, 0, 50_000),
      city(4, 0, 0, 1, 180_000),
    ];
    const links = planRoadLinks(cities);
    const seen = new Set<number>([0]);
    for (let pass = 0; pass < cities.length; pass++) {
      for (const link of links) {
        if (seen.has(link.from)) seen.add(link.to);
        if (seen.has(link.to)) seen.add(link.from);
      }
    }
    expect(seen.size).toBe(cities.length);
  });

  it('大都市ほど多くの道が集まる', () => {
    const cities = [
      city(0, 0, 0, 2, 800_000),
      city(1, 900, 0, 0, 30_000),
      city(2, -900, 0, 0, 30_000),
      city(3, 0, 900, 0, 30_000),
      city(4, 0, -900, 0, 30_000),
      city(5, 1500, 1500, 0, 30_000),
    ];
    const links = planRoadLinks(cities);
    const degree = new Array(cities.length).fill(0);
    for (const link of links) {
      degree[link.from]++;
      degree[link.to]++;
    }
    expect(degree[0]).toBeGreaterThan(Math.max(...degree.slice(1)));
  });

  it('太い規格は交通量の多い所に割り当てる', () => {
    const cities = [
      city(0, 0, 0, 2, 800_000),
      city(1, 700, 0, 2, 700_000),
      city(2, -900, 400, 0, 25_000),
    ];
    const links = planRoadLinks(cities);
    const trunk = links.find((l) => (l.from === 0 && l.to === 1) || (l.from === 1 && l.to === 0));
    const branch = links.find((l) => l.from === 2 || l.to === 2);
    expect(trunk?.classId).toBe('road_large');
    expect(getClass(branch?.classId ?? 'road_large').halfWidth).toBeLessThan(
      getClass('road_large').halfWidth,
    );
    // 交通量の多い順に敷く (太い幹線が先にできて、細い道がそこへ寄る)。
    expect(links[0].flow).toBeGreaterThanOrEqual(links[links.length - 1].flow);
  });
});

describe('地形を見た経路探索', () => {
  /** 真ん中に尾根があり、1 か所だけ峠が開いている地形。 */
  function ridgeField(): Heightfield {
    const field = new Heightfield(TEST_MAP_SIZE / TERRAIN_CELL, TERRAIN_CELL);
    for (let iz = 0; iz < field.stride; iz++) {
      const z = field.worldZ(iz);
      for (let ix = 0; ix < field.stride; ix++) {
        const x = field.worldX(ix);
        // x = 0 に高さ 120 m の尾根。z = 400 のあたりだけ低い峠になっている。
        const ridge = Math.max(0, 1 - Math.abs(x) / 120) * 120;
        const pass = Math.max(0, 1 - Math.abs(z - 400) / 150);
        field.base[field.index(ix, iz)] = 10 + ridge * (1 - pass * 0.95);
      }
    }
    field.resetWork();
    return field;
  }

  it('尾根を直登せず、峠へ回り込む', () => {
    const field = ridgeField();
    const route = new RouteField(field, { waterLevel: 0 });
    const path = findRoute(route, { x: -600, z: 0 }, { x: 600, z: 0 }, { maxGrade: 0.1 });
    expect(path).not.toBeNull();
    // 尾根を越える所 (x ≒ 0) が峠に寄っている。
    const crest = (path as { x: number; z: number }[])
      .slice()
      .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
    expect(crest.z).toBeGreaterThan(200);
    // 直線距離より長く、しかし遠回りしすぎない。
    const length = (path as { x: number; z: number }[]).reduce(
      (sum, p, i, all) => (i === 0 ? 0 : sum + Math.hypot(p.x - all[i - 1].x, p.z - all[i - 1].z)),
      0,
    );
    expect(length).toBeGreaterThan(1200);
    expect(length).toBeLessThan(3000);
  });

  it('既にある道の上は安く通れる (道が束ねられる)', () => {
    const field = ridgeField();
    const route = new RouteField(field, { waterLevel: 0 });
    const first = findRoute(route, { x: -600, z: 0 }, { x: 600, z: 0 }, { maxGrade: 0.1 });
    expect(first).not.toBeNull();
    route.markCorridor(first as { x: number; z: number }[], 1);

    // 少しずれた所から引くと、既設路に寄ってから峠を越える。
    const second = findRoute(route, { x: -600, z: -200 }, { x: 600, z: 200 }, { maxGrade: 0.1 });
    expect(second).not.toBeNull();
    const onCorridor = (second as { x: number; z: number }[]).filter(
      (p) => route.corridorAt(p.x, p.z) > 0.9,
    ).length;
    expect(onCorridor / (second as unknown[]).length).toBeGreaterThan(0.4);
  });

  it('経由点は間隔を空けて並べ直される', () => {
    const raw: { x: number; z: number }[] = [];
    for (let i = 0; i <= 60; i++) raw.push({ x: i * 32, z: (i % 2) * 20 });
    const points = smoothRoute(raw, { minSpacing: 90, maxSpacing: 200 });
    expect(points.length).toBeGreaterThan(2);
    for (let i = 1; i < points.length; i++) {
      const d = Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
      expect(d).toBeGreaterThan(40);
      expect(d).toBeLessThanOrEqual(200 + 1e-6);
    }
    // 端は動かさない。
    expect(points[0].x).toBeCloseTo(raw[0].x, 6);
    expect(points[points.length - 1].x).toBeCloseTo(raw[raw.length - 1].x, 6);
  });
});

describe('自動生成した世界', () => {
  function build(seed = DEFAULT_TERRAIN.seed) {
    const field = terrainField(seed);
    const network = new Network();
    const result = buildAutoWorld(network, field, { seed });
    const terrainMesh = new TerrainMesh(field, new MeshBasicMaterial());
    const world = new WorldBuilder(network, field, terrainMesh);
    return { field, network, result, build: world.rebuild() };
  }

  it('都市を道路で結び、全体がひと繋がりになる', () => {
    const { network, result } = build();
    expect(result.cities.length).toBeGreaterThanOrEqual(4);
    expect(result.links.length).toBeGreaterThanOrEqual(result.cities.length - 1);
    expect(result.placed).toBeGreaterThan(0);
    expect(network.segments.size).toBeGreaterThan(20);
    expect(componentCount(network)).toBe(1);
  });

  it('どの区間も規格の勾配と曲線半径に収まる', () => {
    const { network } = build();
    for (const seg of network.segments.values()) {
      const cls = network.classOf(seg);
      const alignment = network.alignmentOf(seg.id);
      expect(alignment.vertical.maxGrade(32)).toBeLessThanOrEqual(cls.maxGrade + 1e-3);
      expect(alignment.horizontal.extremeCurvature(48).minRadius).toBeGreaterThan(
        cls.minRadius * 0.9,
      );
    }
  });

  it('組み立てが通り、致命的な誤りが出ない', () => {
    const { build: result } = build();
    expect(result.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    expect(result.stats.roadNetworks).toBe(1);
    expect(result.stats.intersections).toBeGreaterThan(0);
  });

  it('区画を渡すと市街地に用途が塗られる', () => {
    const field = terrainField();
    const network = new Network();
    const terrainMesh = new TerrainMesh(field, new MeshBasicMaterial());
    const world = new WorldBuilder(network, field, terrainMesh);
    const result = buildAutoWorld(network, field, { zones: world.zones });
    expect(world.zones.size).toBeGreaterThan(100);
    // 中心は商業、外れは住宅か工業。
    const big = result.cities.find((c) => c.tier === 2) ?? result.cities[0];
    expect(world.zones.at(big.x, big.z)).toBe('commercial');
    expect(world.rebuild().stats.buildings).toBeGreaterThan(0);
  });

  it('地形が変われば都市も道路も変わる', () => {
    const a = build(DEFAULT_TERRAIN.seed);
    const b = build(DEFAULT_TERRAIN.seed ^ 0x1234);
    expect(b.result.cities.map((c) => [c.x, c.z])).not.toEqual(
      a.result.cities.map((c) => [c.x, c.z]),
    );
  });
});
