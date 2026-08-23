import { describe, expect, it } from 'vitest';
import { BufferAttribute, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { getClass } from '../src/network/classes';
import { Network } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { ZONE_CELL, ZONE_DEPTH, ZONE_SETBACK } from '../src/network/zoning';
import { draw } from './support/adversarial';
import { testField } from './support/field';

/**
 * 沿道の区画と建物。
 *
 * 区画はネットワークから毎回作り直す導出物で、覚えているのは「どこに何を
 * 塗ったか」だけ。ここでは
 *   割り付け (道路の左右・地表・沿道向けの種別だけ) →
 *   塗り (道路を引き直しても残る) →
 *   建物 (塗った区画にだけ建つ)
 * の順に確かめる。
 */

interface Scene {
  network: Network;
  world: WorldBuilder;
  field: ReturnType<typeof testField>;
}

/**
 * 道路を 1 本引いただけの場面。
 * `slope` を与えると、道路に**直交する**向きに傾いた斜面になる。
 */
function straightRoad(classId = 'road_medium', y = 20, slope = 0): Scene {
  const field = testField();
  for (let iz = 0; iz <= field.cells; iz++) {
    for (let ix = 0; ix <= field.cells; ix++) {
      field.base[field.index(ix, iz)] = y + field.worldZ(iz) * slope;
    }
  }
  field.resetWork();
  const network = new Network();
  draw(network, field, classId, [
    { x: -150, z: 0, y },
    { x: 150, z: 0, y },
  ], { straight: true });
  const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
  return { network, world, field };
}

function meshOf(world: WorldBuilder, name: string): Mesh {
  return world.group.getObjectByName(name) as Mesh;
}

function vertexCount(world: WorldBuilder, name: string): number {
  const mesh = meshOf(world, name);
  return (mesh.geometry.getAttribute('position') as BufferAttribute | undefined)?.count ?? 0;
}

describe('沿道の区画', () => {
  it('道路の左右に、舗装の外から始まる区画が並ぶ', () => {
    const scene = straightRoad();
    const result = scene.world.rebuild();
    const cls = getClass('road_medium');

    expect(result.stats.lots).toBeGreaterThan(20);
    expect(result.lots.some((lot) => lot.side === 1)).toBe(true);
    expect(result.lots.some((lot) => lot.side === -1)).toBe(true);

    for (const lot of result.lots) {
      // 中心線からの距離が、舗装の外 + 奥行きの半分になっている。
      const distance = Math.abs(lot.center.z);
      expect(distance).toBeCloseTo(cls.halfWidth + ZONE_SETBACK + ZONE_DEPTH / 2, 3);
      // 区画は道路に沿って並ぶ。
      expect(Math.abs(lot.along.x)).toBeCloseTo(1, 3);
      expect(Math.abs(lot.outward.z)).toBeCloseTo(1, 3);
      expect(lot.halfFrontage * 2).toBeCloseTo(ZONE_CELL, 6);
    }
  });

  it('自動車専用道・線路には区画を割り付けない', () => {
    for (const classId of ['road_highway', 'road_ramp', 'rail_single']) {
      const scene = straightRoad(classId);
      const result = scene.world.rebuild();
      expect(`${classId}: ${result.stats.lots}`).toBe(`${classId}: 0`);
    }
  });

  it('用途を塗ると、その区画にだけ建物が建つ', () => {
    const scene = straightRoad();
    scene.world.rebuild();
    expect(vertexCount(scene.world, 'buildings')).toBe(0);

    scene.world.zones.paint(60, 30, 24, 'residential');
    const result = scene.world.rebuild();

    const zoned = result.lots.filter((lot) => lot.zone !== null);
    expect(zoned.length).toBeGreaterThan(0);
    expect(result.stats.buildings).toBe(zoned.length);
    expect(vertexCount(scene.world, 'buildings')).toBeGreaterThan(0);
    // 塗ったのは道路の片側だけ。反対側は空き地のまま。
    expect(zoned.every((lot) => lot.center.z > 0)).toBe(true);
    for (const lot of zoned) expect(lot.zone).toBe('residential');
  });

  it('建物は区画の中に収まり、地面に接している', () => {
    const scene = straightRoad();
    scene.world.zones.paint(0, 30, 60, 'commercial');
    const result = scene.world.rebuild();
    expect(result.stats.buildings).toBeGreaterThan(0);

    const mesh = meshOf(scene.world, 'buildings');
    const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
    const lots = result.lots.filter((lot) => lot.zone !== null);
    const point = new Vector3();
    let lowest = Infinity;
    for (let i = 0; i < pos.count; i++) {
      point.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      lowest = Math.min(lowest, point.y);
      // どれかの区画の中にある (間口・奥行きの内側)。
      const inside = lots.some((lot) => {
        const d = point.clone().sub(lot.center);
        const along = Math.abs(d.dot(lot.along));
        const out = Math.abs(d.dot(lot.outward));
        return along <= lot.halfFrontage + 0.01 && out <= lot.depth / 2 + 0.01;
      });
      expect(inside, `建物の頂点 (${point.x.toFixed(1)}, ${point.z.toFixed(1)}) が区画の外`).toBe(
        true,
      );
    }
    // 基礎が地面まで下りている (宙に浮いていない)。
    expect(lowest).toBeLessThan(20);
  });

  it('急斜面の区画は残るが、建物は建たない', () => {
    // 道路に直交する向きの 35% 勾配。区画の奥行き (20 m) で 7 m の高低差。
    const scene = straightRoad('road_medium', 20, 0.35);
    scene.world.zones.paint(0, 30, 60, 'residential');
    const result = scene.world.rebuild();

    const zoned = result.lots.filter((lot) => lot.zone !== null);
    expect(zoned.length).toBeGreaterThan(0);
    expect(zoned.every((lot) => lot.buildable)).toBe(false);
    expect(result.stats.buildings).toBeLessThan(zoned.length);
    // 建てられない区画にはメッシュを作らない。
    expect(vertexCount(scene.world, 'zones')).toBeGreaterThan(0);
  });

  it('塗りは地面に残り、道路を消せば区画も建物も消える', () => {
    const scene = straightRoad();
    scene.world.zones.paint(0, 30, 40, 'industrial');
    const before = scene.world.rebuild();
    expect(before.stats.buildings).toBeGreaterThan(0);

    for (const id of [...scene.network.segments.keys()]) scene.network.removeSegment(id);
    scene.network.pruneOrphanNodes();
    const after = scene.world.rebuild();
    expect(after.stats.lots).toBe(0);
    expect(after.stats.buildings).toBe(0);
    expect(vertexCount(scene.world, 'buildings')).toBe(0);
    // 塗りそのものは残っているので、引き直せば同じ所に建つ。
    expect(scene.world.zones.size).toBeGreaterThan(0);
    draw(scene.network, scene.field, 'road_medium', [
      { x: -150, z: 0, y: 20 },
      { x: 150, z: 0, y: 20 },
    ], { straight: true });
    const again = scene.world.rebuild();
    expect(again.stats.buildings).toBe(before.stats.buildings);
  });

  it('区画のマス目は区画ツールを使っている間だけ出す', () => {
    const scene = straightRoad();
    scene.world.rebuild();
    const grid = meshOf(scene.world, 'zones');
    expect(vertexCount(scene.world, 'zones')).toBeGreaterThan(0);
    expect(grid.visible).toBe(false);

    scene.world.setZoneView(true);
    expect(grid.visible).toBe(true);
    // 地下ビューでは地上の表示を伏せる。
    scene.world.setUndergroundView(true);
    expect(grid.visible).toBe(false);
    expect(meshOf(scene.world, 'buildings').visible).toBe(false);
    // 地下ビューの最中に区画ツールへ入っても、地上のマス目は出さない。
    scene.world.setZoneView(false);
    scene.world.setZoneView(true);
    expect(grid.visible).toBe(false);
    scene.world.setUndergroundView(false);
    expect(grid.visible).toBe(true);
    scene.world.setZoneView(false);
    expect(grid.visible).toBe(false);
  });

  it('塗り替えた分だけ変わったと答える', () => {
    const scene = straightRoad();
    const zones = scene.world.zones;
    expect(zones.paint(0, 30, 20, 'residential')).toBe(true);
    // 同じ用途で塗り直しても変わらない。
    expect(zones.paint(0, 30, 20, 'residential')).toBe(false);
    expect(zones.paint(0, 30, 20, 'commercial')).toBe(true);
    expect(zones.at(0, 30)).toBe('commercial');
    expect(zones.paint(0, 30, 20, null)).toBe(true);
    expect(zones.at(0, 30)).toBe(null);
    expect(zones.paint(0, 30, 20, null)).toBe(false);
  });
});
