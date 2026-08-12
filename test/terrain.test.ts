import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { CUT_SLOPE, FILL_SLOPE } from '../src/core/units';
import { TerrainGrading } from '../src/terrain/grading';
import { Heightfield } from '../src/terrain/heightfield';
import {
  classify,
  computeStructureProfile,
  mergeShortRuns,
  type StructureRun,
} from '../src/network/structure';
import { Alignment } from '../src/core/alignment';
import { HorizontalCurve } from '../src/core/curve';
import { Vector2 } from 'three';

/** 一定勾配の斜面を作った小さな高さ場。 */
function ramp(slope: number): Heightfield {
  const field = new Heightfield(64, 2);
  for (let iz = 0; iz < field.stride; iz++) {
    for (let ix = 0; ix < field.stride; ix++) {
      field.base[field.index(ix, iz)] = field.worldX(ix) * slope;
    }
  }
  field.resetWork();
  return field;
}

describe('TerrainGrading', () => {
  it('路面の下では地形が目標高さに一致する', () => {
    const field = ramp(0.25);
    const grading = new TerrainGrading(field);
    const targetY = 5;
    // X 方向に伸びる幅 12 m の帯を、一定高さで焼き込む。
    grading.stampQuad(
      new Vector3(-40, targetY, -6),
      new Vector3(40, targetY, -6),
      new Vector3(40, targetY, 6),
      new Vector3(-40, targetY, 6),
    );
    grading.apply();

    for (let x = -30; x <= 30; x += 5) {
      expect(field.heightAt(x, 0)).toBeCloseTo(targetY, 3);
    }
  });

  it('十分離れた場所では自然地形が保たれる', () => {
    const field = ramp(0.25);
    const before = field.baseHeightAt(0, 60);
    const grading = new TerrainGrading(field);
    grading.stampQuad(
      new Vector3(-20, 0, -6),
      new Vector3(20, 0, -6),
      new Vector3(20, 0, 6),
      new Vector3(-20, 0, 6),
    );
    grading.apply();
    expect(field.heightAt(0, 60)).toBeCloseTo(before, 3);
  });

  it('法面の勾配が許容値を超えない', () => {
    // 自然地形が許容勾配より緩ければ、整地後の地形全体が許容勾配に収まる。
    const field = ramp(0.3);
    const grading = new TerrainGrading(field);
    grading.stampQuad(
      new Vector3(-40, 0, -6),
      new Vector3(40, 0, -6),
      new Vector3(40, 0, 6),
      new Vector3(-40, 0, 6),
    );
    grading.apply();

    // チャンファ距離の近似誤差ぶんの余裕を見る。
    const limit = Math.max(CUT_SLOPE, FILL_SLOPE) * 1.1;
    for (let iz = 0; iz < field.stride; iz++) {
      for (let ix = 0; ix + 1 < field.stride; ix++) {
        const a = field.work[field.index(ix, iz)];
        const b = field.work[field.index(ix + 1, iz)];
        expect(Math.abs(b - a) / field.cell).toBeLessThanOrEqual(limit + 1e-6);
      }
    }
  });

  it('自然地形が急峻でも、整地した所からの立ち上がりは許容勾配に収まる', () => {
    const field = ramp(1.4); // 自然地形は 54 度相当の崖。
    const grading = new TerrainGrading(field);
    grading.stampQuad(
      new Vector3(-40, 0, -6),
      new Vector3(40, 0, -6),
      new Vector3(40, 0, 6),
      new Vector3(-40, 0, 6),
    );
    grading.apply();

    // 路面 (高さ 0) から離れるにつれ、許容勾配を超えて高くなることはない。
    const limit = Math.max(CUT_SLOPE, FILL_SLOPE) * 1.1;
    for (let z = 8; z <= 40; z += 2) {
      const rise = Math.abs(field.heightAt(0, z));
      expect(rise).toBeLessThanOrEqual((z - 6) * limit + 1e-3);
    }
  });

  it('切土でも盛土でも地形と路面が連続する (隙間ができない)', () => {
    const field = ramp(0.45);
    const grading = new TerrainGrading(field);
    const targetY = 0;
    grading.stampQuad(
      new Vector3(-40, targetY, -8),
      new Vector3(40, targetY, -8),
      new Vector3(40, targetY, 8),
      new Vector3(-40, targetY, 8),
    );
    grading.apply();

    // 帯の外側 1 セルでも、路面高さからの差はごくわずか。
    for (let x = -30; x <= 30; x += 5) {
      expect(Math.abs(field.heightAt(x, 9) - targetY)).toBeLessThan(2.0);
      expect(Math.abs(field.heightAt(x, -9) - targetY)).toBeLessThan(2.0);
    }
  });

  it('遮断した領域では自然地形がそのまま残る', () => {
    const field = ramp(0.3);
    const grading = new TerrainGrading(field);
    // 左半分を整地しつつ、右側は遮断する。
    grading.blockQuad(
      new Vector3(4, 0, -40),
      new Vector3(60, 0, -40),
      new Vector3(60, 0, 40),
      new Vector3(4, 0, 40),
    );
    grading.stampQuad(
      new Vector3(-40, 0, -6),
      new Vector3(2, 0, -6),
      new Vector3(2, 0, 6),
      new Vector3(-40, 0, 6),
    );
    grading.apply();

    expect(field.heightAt(-10, 0)).toBeCloseTo(0, 3);
    expect(field.heightAt(30, 0)).toBeCloseTo(field.baseHeightAt(30, 0), 3);
  });
});

describe('構造形式の判定', () => {
  it('路面が地形より高ければ高架、低ければトンネル', () => {
    expect(classify(20, 0)).toBe('bridge');
    expect(classify(0, 20)).toBe('tunnel');
    expect(classify(0, 0)).toBe('ground');
  });

  it('短い区間は隣に吸収される', () => {
    const runs: StructureRun[] = [
      { mode: 'ground', s0: 0, s1: 100 },
      { mode: 'bridge', s0: 100, s1: 104 },
      { mode: 'ground', s0: 104, s1: 200 },
    ];
    const merged = mergeShortRuns(runs);
    expect(merged).toHaveLength(1);
    expect(merged[0].mode).toBe('ground');
    expect(merged[0].s1).toBe(200);
  });

  it('橋の間の短い地表区間は橋に吸収される', () => {
    const runs: StructureRun[] = [
      { mode: 'bridge', s0: 0, s1: 60 },
      { mode: 'ground', s0: 60, s1: 68 },
      { mode: 'bridge', s0: 68, s1: 140 },
    ];
    const merged = mergeShortRuns(runs);
    expect(merged).toHaveLength(1);
    expect(merged[0].mode).toBe('bridge');
  });

  it('谷を一定高さで渡ると高架区間ができる', () => {
    const field = new Heightfield(64, 2);
    for (let iz = 0; iz < field.stride; iz++) {
      for (let ix = 0; ix < field.stride; ix++) {
        const x = field.worldX(ix);
        // 中央に深さ 30 m の谷。
        field.base[field.index(ix, iz)] = Math.abs(x) < 25 ? -30 : 0;
      }
    }
    field.resetWork();

    const curve = HorizontalCurve.straight(new Vector2(-60, 0), new Vector2(60, 0));
    const alignment = Alignment.create(curve, 0, 0);
    const runs = computeStructureProfile(alignment, field, { s0: 0, s1: curve.length });

    expect(runs.map((r) => r.mode)).toEqual(['ground', 'bridge', 'ground']);
    const bridge = runs[1];
    expect(bridge.s1 - bridge.s0).toBeGreaterThan(40);
  });

  it('丘を一定高さで貫くとトンネル区間ができる', () => {
    const field = new Heightfield(64, 2);
    for (let iz = 0; iz < field.stride; iz++) {
      for (let ix = 0; ix < field.stride; ix++) {
        const x = field.worldX(ix);
        field.base[field.index(ix, iz)] = Math.abs(x) < 30 ? 25 : 0;
      }
    }
    field.resetWork();

    const curve = HorizontalCurve.straight(new Vector2(-60, 0), new Vector2(60, 0));
    const alignment = Alignment.create(curve, 0, 0);
    const runs = computeStructureProfile(alignment, field, { s0: 0, s1: curve.length });

    expect(runs.map((r) => r.mode)).toEqual(['ground', 'tunnel', 'ground']);
  });
});
