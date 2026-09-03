import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector3 } from 'three';
import { WATER_CLEARANCE } from '../src/core/units';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { computeStructureProfile } from '../src/network/structure';
import { Network } from '../src/network/network';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { WorldBuilder } from '../src/render/worldBuilder';
import { getClass } from '../src/network/classes';
import { computePlacement, placeSegment } from '../src/network/editing';
import { testField } from './support/field';

/**
 * 水系と、その上に線形を敷いたときのふるまい。
 *
 * 地形は水文モデルで作るので、川・湖・海は敷設の側から見ても「触れない所」
 * でなければならない。ここでは水そのものの整合と、水の上に来た線形・整地・
 * 区画がどうなるかを見る。
 */

function world(seed = DEFAULT_TERRAIN.seed) {
  const field = testField();
  const terrain = generateTerrain(field, { ...DEFAULT_TERRAIN, seed });
  return { field, ...terrain };
}

describe('水系', () => {
  const { field, water, hydro } = world();

  it('川は源流から河口へ下り、川幅と水深が規格の範囲に収まる', () => {
    expect(water.network.stems.length).toBeGreaterThan(0);
    for (const stem of water.network.stems) {
      expect(stem.points.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < stem.points.length; i++) {
        // 水面は下流へ向かって登らない。
        expect(stem.points[i].waterY).toBeLessThanOrEqual(stem.points[i - 1].waterY + 1e-6);
      }
      for (const point of stem.points) {
        expect(point.widthM).toBeGreaterThanOrEqual(14 - 1e-6);
        expect(point.widthM).toBeLessThanOrEqual(76 + 1e-6);
        expect(point.depthM).toBeGreaterThanOrEqual(2 - 1e-6);
        expect(point.depthM).toBeLessThanOrEqual(7 + 1e-6);
      }
    }
  });

  it('河床は水面より下に刻まれている', () => {
    let checked = 0;
    for (const stem of water.network.stems) {
      for (let i = 0; i < stem.points.length; i += 7) {
        const point = stem.points[i];
        if (!field.contains(point.x, point.z)) continue;
        // 中心線の高さは水面より下。水が地面に埋まっていない。
        expect(field.baseHeightAt(point.x, point.z)).toBeLessThan(point.waterY);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('海面下の地面はすべて海と判定される', () => {
    const n = hydro.grid.n;
    let checked = 0;
    for (let iz = 1; iz < n - 1; iz += 3) {
      for (let ix = 1; ix < n - 1; ix += 3) {
        if (!hydro.sea[iz * n + ix]) continue;
        const x = hydro.grid.worldAt(ix);
        const z = hydro.grid.worldAt(iz);
        if (!field.contains(x, z)) continue;
        expect(water.waterAt(x, z)?.kind).toBe('sea');
        expect(field.baseHeightAt(x, z)).toBeLessThan(water.seaY);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('陸の上では水が無いと答える', () => {
    let land = 0;
    const n = hydro.grid.n;
    for (let iz = 2; iz < n - 2; iz += 5) {
      for (let ix = 2; ix < n - 2; ix += 5) {
        const i = iz * n + ix;
        if (hydro.sea[i] || hydro.lake[i] || hydro.rivers[i]) continue;
        const x = hydro.grid.worldAt(ix);
        const z = hydro.grid.worldAt(iz);
        if (!field.contains(x, z) || field.baseHeightAt(x, z) < 3) continue;
        if (water.waterAt(x, z) !== null) continue;
        land++;
      }
    }
    expect(land).toBeGreaterThan(50);
  });
});

/** 川を横切る位置と向きを 1 つ選ぶ。 */
function riverCrossing(water: ReturnType<typeof world>['water']): {
  center: Vector3;
  along: Vector3;
  widthM: number;
} | null {
  let widest = 0;
  let found: { center: Vector3; along: Vector3; widthM: number } | null = null;
  for (const stem of water.network.stems) {
    for (let i = 3; i < stem.points.length - 3; i++) {
      const point = stem.points[i];
      if (point.widthM <= widest) continue;
      const previous = stem.points[i - 1];
      const next = stem.points[i + 1];
      const tx = next.x - previous.x;
      const tz = next.z - previous.z;
      const length = Math.hypot(tx, tz) || 1;
      widest = point.widthM;
      // 河道に直交する向き。
      found = {
        center: new Vector3(point.x, point.waterY, point.z),
        along: new Vector3(-tz / length, 0, tx / length),
        widthM: point.widthM,
      };
    }
  }
  return found;
}

describe('水の上の敷設', () => {
  const { field, water } = world();
  const crossing = riverCrossing(water);

  it('川を渡る線形は、桁下が浅くても橋になる', () => {
    expect(crossing).not.toBeNull();
    if (!crossing) return;
    const network = new Network();
    const cls = getClass('road_medium');
    // 水面のすぐ上を、川に直交して渡る。
    const y = crossing.center.y + 1.5;
    const a = crossing.center.clone().addScaledVector(crossing.along, -120).setY(y);
    const b = crossing.center.clone().addScaledVector(crossing.along, 120).setY(y);
    const preview = computePlacement({ pos: a }, b, { straight: true, cls });
    const placed = placeSegment(network, 'road_medium', { pos: a }, { pos: b }, preview);
    const alignment = network.alignmentOf(placed.segment);
    const runs = computeStructureProfile(alignment, field, { s0: 0, s1: alignment.length });
    // 川の真上は橋。
    const middle = runs.find((run) => run.s0 <= alignment.length / 2 && run.s1 >= alignment.length / 2);
    expect(middle?.mode).toBe('bridge');
  });

  it('水面より下を通る線形は橋にならない (地表にも戻らない)', () => {
    expect(crossing).not.toBeNull();
    if (!crossing) return;
    const network = new Network();
    const cls = getClass('road_medium');
    const y = crossing.center.y - WATER_CLEARANCE - 3;
    const a = crossing.center.clone().addScaledVector(crossing.along, -120).setY(y);
    const b = crossing.center.clone().addScaledVector(crossing.along, 120).setY(y);
    const preview = computePlacement({ pos: a }, b, { straight: true, cls });
    const placed = placeSegment(network, 'road_medium', { pos: a }, { pos: b }, preview);
    const alignment = network.alignmentOf(placed.segment);
    const runs = computeStructureProfile(alignment, field, { s0: 0, s1: alignment.length });
    const middle = runs.find((run) => run.s0 <= alignment.length / 2 && run.s1 >= alignment.length / 2);
    expect(middle?.mode).toBe('tunnel');
  });

  it('川沿いに道路を敷いても、整地が河床を埋めない', () => {
    expect(crossing).not.toBeNull();
    if (!crossing) return;
    const network = new Network();
    const cls = getClass('road_medium');
    // 川の縁のすぐ外を、河道に沿って敷く。盛土は高さ 10 m なので、
    // 法面は 16 m 先まで届く — 押さえていなければ河床に流れ込む。
    const offset = crossing.along.clone().multiplyScalar(crossing.widthM * 0.5 + 12);
    const forward = new Vector3(-crossing.along.z, 0, crossing.along.x);
    const a = crossing.center.clone().add(offset).addScaledVector(forward, -90);
    const b = crossing.center.clone().add(offset).addScaledVector(forward, 90);
    a.y = field.baseHeightAt(a.x, a.z) + 10;
    b.y = field.baseHeightAt(b.x, b.z) + 10;
    const preview = computePlacement({ pos: a }, b, { straight: true, cls });
    placeSegment(network, 'road_medium', { pos: a }, { pos: b }, preview);
    const terrainMesh = new TerrainMesh(field, new MeshBasicMaterial());
    const builder = new WorldBuilder(network, field, terrainMesh);
    builder.rebuild();

    // 河道の中心線の上では、地形が自然のまま残っている。
    let checked = 0;
    for (const stem of water.network.stems) {
      for (const point of stem.points) {
        if (Math.hypot(point.x - crossing.center.x, point.z - crossing.center.z) > 120) continue;
        if (!field.contains(point.x, point.z)) continue;
        const ix = Math.round(field.toGridX(point.x));
        const iz = Math.round(field.toGridZ(point.z));
        const i = field.index(ix, iz);
        expect(field.work[i]).toBeCloseTo(field.base[i], 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('水の上の区画', () => {
  it('水に掛かるマスは区画にならない', () => {
    const { field, water } = world();
    const crossing = riverCrossing(water);
    expect(crossing).not.toBeNull();
    if (!crossing) return;
    const network = new Network();
    const cls = getClass('road_medium');
    // 川を渡る道路。沿道のマスの一部が水に掛かる。
    const y = crossing.center.y + 2;
    const a = crossing.center.clone().addScaledVector(crossing.along, -140).setY(y);
    const b = crossing.center.clone().addScaledVector(crossing.along, 140).setY(y);
    const preview = computePlacement({ pos: a }, b, { straight: true, cls });
    placeSegment(network, 'road_medium', { pos: a }, { pos: b }, preview);
    const builder = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = builder.rebuild();
    expect(result.zoneCells.length).toBeGreaterThan(10);
    for (const cell of result.zoneCells) {
      expect(water.isWater(cell.center.x, cell.center.z)).toBe(false);
    }
  });
});
