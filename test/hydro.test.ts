import { describe, expect, it } from 'vitest';
import { generateHydroWorld } from '../src/terrain/hydro/world';
import type { HydroParams, HydroWorld } from '../src/terrain/hydro/types';

/**
 * 水文エンジンの健全性。
 *
 * 移植元 (ctest105) の `verify-generator.ts` が 128 シードで見ている項目を、
 * 走る時間に収まる範囲へ絞って移したもの。地形の見た目ではなく
 * **排水が成立していること**を見る。ここが崩れると、川が途中で消えたり
 * 内陸に出口の無い水たまりが残ったりする。
 */

const BASE: HydroParams = {
  seed: 12345,
  sea: 0.24,
  rugged: 0.65,
  flat: 0.36,
  basin: 0.45,
  river: 0.55,
  meander: 0.68,
  erosion: 0.55,
};

/** 極端な設定。定数が格子の大きさに依っている所はここで露見する。 */
const PROFILES: Array<{ name: string; params: HydroParams }> = [
  { name: '既定', params: BASE },
  { name: '平坦・川なし', params: { ...BASE, rugged: 0, flat: 0.75, basin: 0, river: 0, meander: 0, erosion: 0 } },
  { name: '険しい・川だらけ', params: { ...BASE, rugged: 1, flat: 0.05, basin: 1, river: 1, meander: 1, erosion: 1 } },
  { name: '海が広い', params: { ...BASE, sea: 0.58 } },
];

/** 本番と同じ 40 m 格子で、テストが重くならない大きさ (5.12 km 相当)。 */
const CELLS = 128;

function auditDrainage(world: HydroWorld): void {
  const { grid, parent, filled, sea } = world;
  const n = grid.n;
  const state = new Uint8Array(grid.len);
  for (let start = 0; start < grid.len; start++) {
    if (state[start]) continue;
    const path: number[] = [];
    let i = start;
    while (i >= 0 && !state[i]) {
      state[i] = 1;
      path.push(i);
      const next = parent[i];
      // 出口は海か外周でなければならない。
      if (next === -1) {
        const x = i % n;
        const y = (i / n) | 0;
        expect(sea[i] === 1 || x === 0 || y === 0 || x === n - 1 || y === n - 1).toBe(true);
        break;
      }
      expect(next).not.toBe(-2);
      // 下流は自分より高くならない。
      expect(filled[next]).toBeLessThanOrEqual(filled[i] + 1e-6);
      // 経路の途中に戻ってきたら循環している。
      expect(state[next]).not.toBe(1);
      i = next;
    }
    for (const j of path) state[j] = 2;
  }
}

describe('水文エンジン', () => {
  for (const profile of PROFILES) {
    describe(profile.name, () => {
      const world = generateHydroWorld(CELLS, profile.params);

      it('全セルの排水経路が海か外周へ抜け、循環も内陸の行き止まりも無い', () => {
        auditDrainage(world);
      });

      it('海の面積が指定した割合に近い', () => {
        let count = 0;
        for (let i = 0; i < world.grid.len; i++) if (world.sea[i]) count++;
        expect(Math.abs(count / world.grid.len - profile.params.sea)).toBeLessThan(0.05);
      });

      it('海の中に川が無い', () => {
        for (let i = 0; i < world.grid.len; i++) if (world.sea[i]) expect(world.rivers[i]).toBe(0);
      });

      it('内陸に排水の行き止まりが残らない (窪地は埋めて平らな地面にする)', () => {
        for (let i = 0; i < world.grid.len; i++) {
          if (world.sea[i]) continue;
          // 埋め立てたあとの面がそのまま地面なので、水の溜まる余地が無い。
          expect(world.filled[i]).toBe(world.terrain[i]);
        }
      });
    });
  }

  it('山地の上部は低地より急である', () => {
    // 移植元の `auditSteepness` と同じ採り方: 順位ではなく**陸の起伏に対する
    // 標高の割合**で上位 2 割と下位 2 割に分ける。
    // 1 つのシードでは上下することがあるので、移植元と同じく数枚を合算する。
    let high = 0;
    let highCells = 0;
    let low = 0;
    let lowCells = 0;
    for (const seed of [1, 2, 3, 4]) {
      const { grid, terrain, sea, slope } = generateHydroWorld(CELLS, { ...BASE, seed });
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < grid.len; i++) {
        if (sea[i]) continue;
        if (terrain[i] < lo) lo = terrain[i];
        if (terrain[i] > hi) hi = terrain[i];
      }
      const range = hi - lo || 1;
      for (let i = 0; i < grid.len; i++) {
        if (sea[i]) continue;
        const z = (terrain[i] - lo) / range;
        if (z > 0.8) {
          high += slope[i];
          highCells++;
        } else if (z < 0.2) {
          low += slope[i];
          lowCells++;
        }
      }
    }
    expect(highCells).toBeGreaterThan(0);
    expect(high / highCells).toBeGreaterThan((low / lowCells) * 2);
  });

  it('同じシードなら同じ地形になる', () => {
    const a = generateHydroWorld(64, BASE);
    const b = generateHydroWorld(64, BASE);
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
    expect(Array.from(a.rivers)).toEqual(Array.from(b.rivers));
    expect(a.seaLevel).toBe(b.seaLevel);
  });

  it('シードが違えば違う地形になる', () => {
    const a = generateHydroWorld(64, BASE);
    const b = generateHydroWorld(64, { ...BASE, seed: BASE.seed + 1 });
    expect(Array.from(a.terrain)).not.toEqual(Array.from(b.terrain));
  });
});
