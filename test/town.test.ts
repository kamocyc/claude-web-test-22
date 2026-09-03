import { describe, expect, it } from 'vitest';
import { TOWN_DENSITY, TOWN_MIN_SPACING } from '../src/core/units';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { testField } from './support/field';

/**
 * 町の位置。
 *
 * 見た目ではなく「置ける所に、散らばって、決まった数だけ」置かれることを見る。
 */

function world(seed = DEFAULT_TERRAIN.seed) {
  const field = testField();
  return { field, ...generateTerrain(field, { ...DEFAULT_TERRAIN, seed }) };
}

describe('町の位置', () => {
  const { field, towns, water, hydro } = world();

  it('広さに応じた数だけ置かれる', () => {
    const extent = field.cells * field.cell;
    const expected = Math.max(1, Math.round(((extent / 1000) ** 2) * TOWN_DENSITY));
    expect(towns.length).toBe(expected);
  });

  it('水の上には置かれない', () => {
    for (const town of towns) {
      expect(water.isWater(town.x, town.z)).toBe(false);
      expect(field.baseHeightAt(town.x, town.z)).toBeGreaterThan(water.seaY);
    }
  });

  it('互いに最小間隔より離れている', () => {
    for (let i = 0; i < towns.length; i++) {
      for (let j = i + 1; j < towns.length; j++) {
        const gap = Math.hypot(towns[i].x - towns[j].x, towns[i].z - towns[j].z);
        expect(gap).toBeGreaterThanOrEqual(TOWN_MIN_SPACING);
      }
    }
  });

  it('マップの外周には置かれない', () => {
    for (const town of towns) {
      expect(field.contains(town.x, town.z)).toBe(true);
      // 水文格子で外周 3 セル (120 m) は候補から外している。
      expect(Math.min(town.x - field.worldMin, field.worldMax - town.x)).toBeGreaterThan(100);
      expect(Math.min(town.z - field.worldMin, field.worldMax - town.z)).toBeGreaterThan(100);
    }
  });

  it('適性の高い所から順に格が決まる', () => {
    const rank = { city: 0, town: 1, village: 2 };
    for (let i = 1; i < towns.length; i++) {
      // 点数の降順に並び、格もその順に落ちていく。
      expect(towns[i].score).toBeLessThanOrEqual(towns[i - 1].score);
      expect(rank[towns[i].kind]).toBeGreaterThanOrEqual(rank[towns[i - 1].kind]);
    }
    expect(towns.some((t) => t.kind === 'city')).toBe(true);
  });

  it('名前と向きと広がりを持つ', () => {
    for (const town of towns) {
      expect(town.name.length).toBeGreaterThan(0);
      expect(town.angle).toBeGreaterThanOrEqual(0);
      expect(town.angle).toBeLessThan(Math.PI / 2);
      expect(town.radiusM).toBeGreaterThan(0);
      expect(town.development).toBeGreaterThan(0);
      expect(town.development).toBeLessThanOrEqual(1);
    }
  });

  it('適性の場のいちばん良い所を外していない', () => {
    // どの町も、その水文セルの適性が候補の下限を超えている。
    for (const town of towns) {
      expect(hydro.suitability[town.cell]).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('同じシードなら同じ町になる', () => {
    const again = world();
    expect(again.towns.map((t) => `${t.name}@${t.x},${t.z}`)).toEqual(
      towns.map((t) => `${t.name}@${t.x},${t.z}`),
    );
  });

  it('シードが違えば違う町になる', () => {
    const other = world(DEFAULT_TERRAIN.seed + 1);
    expect(other.towns.map((t) => `${t.x},${t.z}`)).not.toEqual(towns.map((t) => `${t.x},${t.z}`));
  });
});
