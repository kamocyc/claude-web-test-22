import { describe, expect, it } from 'vitest';
import { MeshStandardMaterial, Vector2, Vector3, type Mesh } from 'three';
import { Network } from '../src/network/network';
import { Occupancy } from '../src/network/occupancy';
import { TownPlans } from '../src/terrain/town/plans';
import { VegetationView } from '../src/render/vegetationView';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import {
  TREE_JITTER,
  TREE_MAX_SLOPE,
  TREE_MIN_Y,
  VegetationField,
  type Tree,
} from '../src/terrain/vegetation';
import { testField } from './support/field';

/**
 * 森の濃さと木の散らばり。
 *
 * 見た目ではなく「生えてよい所にだけ、決まった形で生える」ことを見る。
 */

function world(seed = DEFAULT_TERRAIN.seed) {
  const field = testField();
  const terrain = generateTerrain(field, { ...DEFAULT_TERRAIN, seed });
  const vegetation = new VegetationField();
  vegetation.build(terrain.hydro, seed);
  return { field, vegetation, ...terrain };
}

/** マップの中ほどを覆う区画をいくつか。 */
function tiles(size = 256, span = 1536) {
  const out: { minX: number; minZ: number; size: number }[] = [];
  for (let z = -span; z < span; z += size) {
    for (let x = -span; x < span; x += size) out.push({ minX: x, minZ: z, size });
  }
  return out;
}

describe('森の濃さ', () => {
  const { vegetation, hydro } = world();

  it('0 から 1 の間に収まる', () => {
    for (let i = 0; i < hydro.grid.len; i++) {
      const x = hydro.grid.worldAt(i % hydro.grid.n);
      const z = hydro.grid.worldAt(Math.floor(i / hydro.grid.n));
      const d = vegetation.densityAt(x, z);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it('海の上は 0', () => {
    let checked = 0;
    for (let i = 0; i < hydro.grid.len; i++) {
      if (!hydro.sea[i]) continue;
      const x = hydro.grid.worldAt(i % hydro.grid.n);
      const z = hydro.grid.worldAt(Math.floor(i / hydro.grid.n));
      // 陸のセルとの補間が効かない、海の内側だけを見る。
      const ix = i % hydro.grid.n;
      const iz = Math.floor(i / hydro.grid.n);
      if (ix === 0 || iz === 0 || ix >= hydro.grid.n - 2 || iz >= hydro.grid.n - 2) continue;
      const n = hydro.grid.n;
      if (!hydro.sea[i + 1] || !hydro.sea[i + n] || !hydro.sea[i + n + 1]) continue;
      // 双一次補間の丸めが残るので、厳密な 0 ではなく無視できる大きさで見る。
      expect(vegetation.densityAt(x, z)).toBeLessThan(1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('集落を置きやすい所は薄い (町のまわりが開ける)', () => {
    // 適性の上位 1 割と下位 1 割で濃さの平均を比べる。
    const cells: { i: number; s: number }[] = [];
    for (let i = 0; i < hydro.grid.len; i++) {
      if (hydro.sea[i]) continue;
      cells.push({ i, s: hydro.suitability[i] });
    }
    cells.sort((a, b) => a.s - b.s);
    const slice = Math.max(1, Math.floor(cells.length / 10));
    const mean = (list: { i: number }[]): number => {
      let sum = 0;
      for (const { i } of list) {
        const x = hydro.grid.worldAt(i % hydro.grid.n);
        const z = hydro.grid.worldAt(Math.floor(i / hydro.grid.n));
        sum += vegetation.densityAt(x, z);
      }
      return sum / list.length;
    };
    const low = mean(cells.slice(0, slice));
    const high = mean(cells.slice(-slice));
    expect(high).toBeLessThan(low);
  });
});

describe('木の散らばり', () => {
  const { field, vegetation, towns, water } = world();
  const all: Tree[] = tiles().flatMap((tile) => vegetation.treesIn(tile, field, towns));

  it('木が生える', () => {
    expect(all.length).toBeGreaterThan(200);
  });

  it('同じ区画からは同じ木ができる', () => {
    const tile = { minX: 0, minZ: 0, size: 256 };
    const a = vegetation.treesIn(tile, field, towns);
    const b = vegetation.treesIn(tile, field, towns);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('シードが違えば違う木になる', () => {
    const other = world(DEFAULT_TERRAIN.seed + 991);
    const tile = { minX: 0, minZ: 0, size: 256 };
    const a = vegetation.treesIn(tile, field, towns);
    const b = other.vegetation.treesIn(tile, other.field, other.towns);
    expect(a).not.toEqual(b);
  });

  it('水の上には生えない', () => {
    for (const tree of all) expect(water.isWater(tree.x, tree.z)).toBe(false);
  });

  it('急斜面と森林限界の外には生えない', () => {
    for (const tree of all) {
      expect(field.slopeAt(tree.x, tree.z)).toBeLessThanOrEqual(TREE_MAX_SLOPE);
      expect(tree.y).toBeGreaterThanOrEqual(TREE_MIN_Y);
    }
  });

  it('町の中には生えない', () => {
    for (const tree of all) {
      for (const town of towns) {
        expect(Math.hypot(town.x - tree.x, town.z - tree.z)).toBeGreaterThan(town.radiusM);
      }
    }
  });

  it('区画からはみ出すのはジッタのぶんだけ', () => {
    const tile = { minX: 512, minZ: -256, size: 256 };
    for (const tree of vegetation.treesIn(tile, field, towns)) {
      expect(tree.x).toBeGreaterThanOrEqual(tile.minX - TREE_JITTER);
      expect(tree.x).toBeLessThanOrEqual(tile.minX + tile.size + TREE_JITTER);
      expect(tree.z).toBeGreaterThanOrEqual(tile.minZ - TREE_JITTER);
      expect(tree.z).toBeLessThanOrEqual(tile.minZ + tile.size + TREE_JITTER);
    }
  });

  it('隣り合う区画で木が二重にならない・抜けない', () => {
    const size = 128;
    const whole = vegetation.treesIn({ minX: 0, minZ: 0, size: size * 2 }, field, towns);
    const parts = [
      { minX: 0, minZ: 0, size },
      { minX: size, minZ: 0, size },
      { minX: 0, minZ: size, size },
      { minX: size, minZ: size, size },
    ].flatMap((tile) => vegetation.treesIn(tile, field, towns));
    const key = (t: Tree): string => `${t.x.toFixed(3)},${t.z.toFixed(3)}`;
    expect(new Set(parts.map(key))).toEqual(new Set(whole.map(key)));
    expect(parts.length).toBe(whole.length);
  });

  it('間引くと減り、残るのは元の一部', () => {
    const tile = { minX: 0, minZ: 0, size: 512 };
    const full = vegetation.treesIn(tile, field, towns);
    const thin = vegetation.treesIn(tile, field, towns, 0.4);
    expect(thin.length).toBeLessThan(full.length);
    expect(thin.length).toBeGreaterThan(0);
    const key = (t: Tree): string => `${t.x.toFixed(3)},${t.z.toFixed(3)}`;
    const kept = new Set(full.map(key));
    for (const tree of thin) expect(kept.has(key(tree))).toBe(true);
    // 間引く割合は覚えているので、同じ値なら同じ木が残る。
    expect(vegetation.treesIn(tile, field, towns, 0.4)).toEqual(thin);
  });

  it('地形を組み直していない場に対しては何も返さない', () => {
    const empty = new VegetationField();
    expect(empty.ready).toBe(false);
    expect(empty.treesIn({ minX: 0, minZ: 0, size: 256 }, field, towns)).toEqual([]);
  });
});

describe('木の描画', () => {
  function scene() {
    const field = testField();
    const terrain = generateTerrain(field, DEFAULT_TERRAIN);
    const vegetation = new VegetationField();
    vegetation.build(terrain.hydro, DEFAULT_TERRAIN.seed);
    const plans = new TownPlans(field);
    plans.setTowns(terrain.towns);
    const network = new Network();
    const view = new VegetationView(field, vegetation, plans, new MeshStandardMaterial());
    return { field, vegetation, plans, network, view };
  }

  /** 区画ごとの頂点数。 */
  function tileVertices(view: VegetationView): Map<string, number> {
    const out = new Map<string, number>();
    for (const child of view.group.children) {
      out.set(child.name, (child as Mesh).geometry.attributes.position.count);
    }
    return out;
  }

  /** 森の中を突っ切る道路を敷く (敷設ツールを通さず、当たり判定だけ見る)。 */
  function cut(network: Network, field: ReturnType<typeof testField>, z: number): void {
    const a = { x: -400, z };
    const b = { x: 400, z };
    const na = network.addNode(new Vector3(a.x, field.heightAt(a.x, a.z), a.z));
    const nb = network.addNode(new Vector3(b.x, field.heightAt(b.x, b.z), b.z));
    network.addSegment({
      classId: 'road_large',
      a: na.id,
      b: nb.id,
      ctrlA: new Vector2(a.x + (b.x - a.x) / 3, a.z),
      ctrlB: new Vector2(a.x + (2 * (b.x - a.x)) / 3, a.z),
      gradeA: 0,
      gradeB: 0,
    });
  }

  it('カメラのまわりだけ組み、離れると捨てる', () => {
    const { view } = scene();
    // 予算があるので、組み切るまで何度も呼ぶ。
    for (let i = 0; i < 400; i++) view.setCenter(0, 0);
    const near = view.tileCount;
    expect(near).toBeGreaterThan(10);
    for (let i = 0; i < 400; i++) view.setCenter(0, 0);
    expect(view.tileCount).toBe(near);
  });

  it('敷いた線形に掛かる木は出さない', () => {
    const { field, network, view } = scene();
    for (let i = 0; i < 400; i++) view.setCenter(0, 0);
    const before = tileVertices(view);
    expect(before.size).toBeGreaterThan(0);

    cut(network, field, 0);
    view.setObstacles(new Occupancy(network));
    for (let i = 0; i < 400; i++) view.setCenter(0, 0);
    const after = tileVertices(view);

    // 道路が通った区画の木は減り、離れた区画はそのまま。
    let dropped = 0;
    let intact = 0;
    for (const [name, count] of before) {
      const now = after.get(name);
      if (now === undefined) continue;
      if (now < count) dropped++;
      else if (now === count) intact++;
    }
    expect(dropped).toBeGreaterThan(0);
    // 触っていない区画の方がずっと多い (森の奥まで組み直していない)。
    expect(intact).toBeGreaterThan(dropped * 3);
  });

  it('地下ビューでは消える', () => {
    const { view } = scene();
    view.setUndergroundView(true);
    expect(view.group.visible).toBe(false);
    view.setUndergroundView(false);
    expect(view.group.visible).toBe(true);
  });

  it('reset で組んだものを捨てる', () => {
    const { view } = scene();
    for (let i = 0; i < 200; i++) view.setCenter(0, 0);
    expect(view.tileCount).toBeGreaterThan(0);
    view.reset();
    expect(view.tileCount).toBe(0);
    expect(view.group.children.length).toBe(0);
  });
});
