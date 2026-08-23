import { describe, expect, it } from 'vitest';
import { BufferAttribute, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { getClass } from '../src/network/classes';
import { Network } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import {
  ZONE_CELL,
  ZONE_DEPTH,
  ZONE_ROWS,
  ZONE_ROW_DEPTH,
  ZONE_SETBACK,
} from '../src/network/zoning';
import { draw } from './support/adversarial';
import { testField } from './support/field';

/**
 * 沿道の区画と建物。
 *
 * 区画はネットワークから毎回作り直す導出物で、覚えているのは「どこに何を
 * 塗ったか」だけ。ここでは
 *   マスの割り付け (道路の左右・地表・沿道向けの種別だけ) →
 *   塗り (道路を引き直しても残る) →
 *   まとめ (塗った形が建物の大きさになる) →
 *   建物 (床は道路に接する縁の高さ)
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
  it('道路の左右に、舗装の外から奥へ列を成してマスが並ぶ', () => {
    const scene = straightRoad();
    const result = scene.world.rebuild();
    const cls = getClass('road_medium');

    expect(result.stats.zoneCells).toBeGreaterThan(40);
    expect(result.zoneCells.some((cell) => cell.side === 1)).toBe(true);
    expect(result.zoneCells.some((cell) => cell.side === -1)).toBe(true);
    expect(new Set(result.zoneCells.map((cell) => cell.row))).toEqual(
      new Set([...Array(ZONE_ROWS).keys()]),
    );

    for (const cell of result.zoneCells) {
      // 中心線からの距離が、舗装の外 + 列の位置になっている。
      const distance = Math.abs(cell.center.z);
      expect(distance).toBeCloseTo(
        cls.halfWidth + ZONE_SETBACK + (cell.row + 0.5) * ZONE_ROW_DEPTH,
        3,
      );
      // マスは道路に沿って並ぶ。
      expect(Math.abs(cell.along.x)).toBeCloseTo(1, 3);
      expect(Math.abs(cell.outward.z)).toBeCloseTo(1, 3);
    }
  });

  it('自動車専用道・線路には区画を割り付けない', () => {
    for (const classId of ['road_highway', 'road_ramp', 'rail_single']) {
      const scene = straightRoad(classId);
      const result = scene.world.rebuild();
      expect(`${classId}: ${result.stats.zoneCells}`).toBe(`${classId}: 0`);
    }
  });

  it('用途を塗ると、そのマスにだけ建物が建つ', () => {
    const scene = straightRoad();
    scene.world.rebuild();
    expect(vertexCount(scene.world, 'buildings')).toBe(0);

    scene.world.zones.paint(60, 30, 24, 'residential');
    const result = scene.world.rebuild();

    expect(result.lots.length).toBeGreaterThan(0);
    expect(result.stats.buildings).toBe(result.lots.length);
    expect(vertexCount(scene.world, 'buildings')).toBeGreaterThan(0);
    // 塗ったのは道路の片側だけ。反対側は空き地のまま。
    expect(result.lots.every((lot) => lot.center.z > 0)).toBe(true);
    for (const lot of result.lots) expect(lot.zone).toBe('residential');
  });

  it('塗った形のぶんだけマスをまとめて 1 棟にする', () => {
    // 道路沿いにたっぷり塗る。奥の列まで届く太さの筆。
    const wide = straightRoad();
    wide.world.zones.paint(0, ZONE_DEPTH, 80, 'industrial');
    const industrial = wide.world.rebuild().lots.filter((lot) => lot.center.z > 0);
    expect(industrial.length).toBeGreaterThan(0);
    for (const lot of industrial) {
      expect(lot.halfFrontage * 2).toBeCloseTo(lot.cells.wide * ZONE_CELL, 6);
      expect(lot.depth).toBeCloseTo(lot.cells.deep * ZONE_ROW_DEPTH, 6);
      expect(lot.cells.deep).toBe(ZONE_ROWS);
    }
    // 工業は間口 4 マスまでまとまる。同じ大きさばかりが並ばない。
    expect(Math.max(...industrial.map((lot) => lot.cells.wide))).toBe(4);
    expect(new Set(industrial.map((lot) => lot.cells.wide)).size).toBeGreaterThan(1);
    // 住宅は同じ塗り方でも小さいまま。
    const narrow = straightRoad();
    narrow.world.zones.paint(0, ZONE_DEPTH, 80, 'residential');
    const houses = narrow.world.rebuild().lots.filter((lot) => lot.center.z > 0);
    expect(Math.max(...houses.map((lot) => lot.cells.wide))).toBe(2);
    // マスが小さいぶん、同じ長さに建つ棟数は増える。
    expect(houses.length).toBeGreaterThan(industrial.length);
  });

  it('道路沿いだけ塗れば、奥行きの浅い建物になる', () => {
    const scene = straightRoad();
    const cls = getClass('road_medium');
    // 手前の列の中心だけを、奥に届かない細い筆で塗る。
    const front = cls.halfWidth + ZONE_SETBACK + ZONE_ROW_DEPTH / 2;
    for (let x = -40; x <= 40; x += ZONE_CELL) {
      scene.world.zones.paint(x, front, 3, 'commercial');
    }
    const lots = scene.world.rebuild().lots;
    expect(lots.length).toBeGreaterThan(0);
    for (const lot of lots) {
      expect(lot.cells.deep).toBe(1);
      expect(lot.depth).toBeCloseTo(ZONE_ROW_DEPTH, 6);
    }
  });

  it('建物は敷地の中に収まり、地面に接している', () => {
    const scene = straightRoad();
    scene.world.zones.paint(0, 30, 60, 'commercial');
    const result = scene.world.rebuild();
    expect(result.stats.buildings).toBeGreaterThan(0);

    const mesh = meshOf(scene.world, 'buildings');
    const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
    const point = new Vector3();
    let lowest = Infinity;
    for (let i = 0; i < pos.count; i++) {
      point.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      lowest = Math.min(lowest, point.y);
      // どれかの敷地の中にある (間口・奥行きの内側)。
      const inside = result.lots.some((lot) => {
        const d = point.clone().sub(lot.center);
        const along = Math.abs(d.dot(lot.along));
        const out = Math.abs(d.dot(lot.outward));
        return along <= lot.halfFrontage + 0.01 && out <= lot.depth / 2 + 0.01;
      });
      expect(inside, `建物の頂点 (${point.x.toFixed(1)}, ${point.z.toFixed(1)}) が敷地の外`).toBe(
        true,
      );
    }
    // 基礎が地面まで下りている (宙に浮いていない)。
    expect(lowest).toBeLessThan(20);
  });

  it('建物の床は、道路に接する縁のいちばん高い所に合う', () => {
    // 道路に勾配を付ける。1 棟の間口の中でも道路の高さが変わる。
    const field = testField();
    field.base.fill(10);
    field.resetWork();
    const network = new Network();
    draw(network, field, 'road_medium', [
      { x: -120, z: 0, y: 10 },
      { x: 120, z: 0, y: 22 },
    ], { straight: true });
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    world.zones.paint(0, ZONE_DEPTH, 90, 'commercial');
    const result = world.rebuild();
    expect(result.lots.length).toBeGreaterThan(0);

    for (const lot of result.lots) {
      // 敷地の道路側の縁を端から端まで見て、その最大値になっている。
      const front = lot.center.clone().addScaledVector(lot.outward, -lot.depth / 2);
      let highest = -Infinity;
      for (let t = -1; t <= 1; t += 0.1) {
        const p = front.clone().addScaledVector(lot.along, t * lot.halfFrontage);
        highest = Math.max(highest, field.heightAt(p.x, p.z));
      }
      expect(Math.abs(lot.padY - highest)).toBeLessThan(0.15);
    }
  });

  it('道路より高い側の急斜面には建たないが、低い側には基礎を伸ばして建つ', () => {
    // 道路に直交する 50% の斜面。+z 側が高く、-z 側が低い。
    const scene = straightRoad('road_medium', 20, 0.5);
    scene.world.zones.paint(0, 0, 90, 'residential');
    const result = scene.world.rebuild();

    const uphill = result.zoneCells.filter((cell) => cell.center.z > 0);
    const downhill = result.zoneCells.filter((cell) => cell.center.z < 0);
    expect(uphill.some((cell) => cell.buildable)).toBe(false);
    expect(downhill.some((cell) => cell.buildable)).toBe(true);
    expect(result.lots.every((lot) => lot.center.z < 0)).toBe(true);
    // 建てられないマスも、マス目としては残る。
    expect(vertexCount(scene.world, 'zones')).toBeGreaterThan(0);

    // 低い側は道路の高さに床を合わせ、基礎を斜面まで下ろす。
    const mesh = meshOf(scene.world, 'buildings');
    const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
    let lowest = Infinity;
    for (let i = 0; i < pos.count; i++) lowest = Math.min(lowest, pos.getY(i));
    const padY = Math.max(...result.lots.map((lot) => lot.padY));
    // 旧来の上限 (4 m) より深い高低差でも建つ。
    expect(padY - lowest).toBeGreaterThan(4);
  });

  it('塗りは地面に残り、道路を消せば区画も建物も消える', () => {
    const scene = straightRoad();
    scene.world.zones.paint(0, 30, 40, 'industrial');
    const before = scene.world.rebuild();
    expect(before.stats.buildings).toBeGreaterThan(0);

    for (const id of [...scene.network.segments.keys()]) scene.network.removeSegment(id);
    scene.network.pruneOrphanNodes();
    const after = scene.world.rebuild();
    expect(after.stats.zoneCells).toBe(0);
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
