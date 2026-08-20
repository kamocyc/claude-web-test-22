import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { VerticalProfile } from '../src/core/profile';
import { getClass } from '../src/network/classes';
import { computePlacement } from '../src/network/editing';

/**
 * 縦断線形の 2 階微分と縦曲線半径。
 *
 * 勾配の変化の速さ (= 縦曲線の半径) に上限を掛けるための道具。3 次
 * エルミートの 2 階微分は `t` について線形なので、極値は必ず両端にある。
 */

/** 数値差分で測った 2 階微分。 */
function numericSecond(p: VerticalProfile, s: number, h = 0.05): number {
  return (p.yAt(s + h) - 2 * p.yAt(s) + p.yAt(s - h)) / (h * h);
}

describe('縦断線形', () => {
  it('2 階微分が数値差分と一致する', () => {
    const p = new VerticalProfile(10, 24, 0.09, 0.01, 120);
    for (const s of [10, 30, 60, 90, 110]) {
      expect(p.secondDerivativeAt(s)).toBeCloseTo(numericSecond(p, s), 4);
    }
  });

  it('2 階微分は弧長について線形 (極値は両端にしかない)', () => {
    const p = new VerticalProfile(0, 8, 0.12, 0.0, 100);
    const a = p.secondDerivativeAt(0);
    const b = p.secondDerivativeAt(100);
    for (let i = 0; i <= 10; i++) {
      const s = i * 10;
      expect(p.secondDerivativeAt(s)).toBeCloseTo(a + ((b - a) * s) / 100, 9);
    }
  });

  it('真っ直ぐな縦断の縦曲線半径は無限大', () => {
    expect(VerticalProfile.linear(5, 15, 200).minVerticalRadius()).toBe(Infinity);
  });

  it('標準の縦断では縦曲線半径が L / (4|d|) になる', () => {
    // 敷設ソルバが作る形: 終点勾配 = 平均勾配、始点勾配 = 平均 + d。
    // 半径は勾配の分だけ (1 + m²)^{3/2} 倍になるが、5% 勾配で 1.004 倍。
    // 敷設時のクランプはこの係数を省いた L / (4|d|) を使う。
    const L = 120;
    const average = 0.02;
    for (const d of [0.01, 0.03, -0.025]) {
      const p = new VerticalProfile(0, average * L, average + d, average, L);
      expect(p.minVerticalRadius() / (L / (4 * Math.abs(d)))).toBeCloseTo(1, 2);
    }
  });

  it('勾配を急に変えるほど縦曲線半径が小さくなる', () => {
    const gentle = new VerticalProfile(0, 2, 0.04, 0.02, 100).minVerticalRadius();
    const sharp = new VerticalProfile(0, 2, 0.14, 0.02, 100).minVerticalRadius();
    expect(sharp).toBeLessThan(gentle);
    // 同じ勾配差でも、区間が長ければ縦曲線は緩くなる。
    const long = new VerticalProfile(0, 4, 0.14, 0.02, 200).minVerticalRadius();
    expect(long).toBeGreaterThan(sharp);
  });
});

describe('縦曲線 (敷設ツール)', () => {
  /** 勾配 `grade` で来ている線形から、`length` m 先の同じ高さへ引く。 */
  function place(classId: string, grade: number, length: number): VerticalProfile {
    const cls = getClass(classId);
    const anchor = {
      pos: new Vector3(0, 20, 0),
      tangent: new Vector2(1, 0),
      grade,
    };
    const preview = computePlacement(anchor, new Vector3(length, 20, 0), {
      straight: true,
      cls,
    });
    return new VerticalProfile(
      20,
      preview.end.y,
      preview.startGrade,
      preview.endGrade,
      preview.horizontal.length,
    );
  }

  it('短い区間で勾配を急に変えようとしても、縦曲線が規格に収まる', () => {
    for (const [classId, length] of [
      ['rail_single', 40],
      ['rail_single', 70],
      ['rail_yard', 30],
      ['road_highway', 50],
    ] as const) {
      const cls = getClass(classId);
      const profile = place(classId, cls.maxGrade * 0.95, length);
      expect(profile.minVerticalRadius()).toBeGreaterThan(cls.minVerticalRadius * 0.98);
    }
  });

  it('区間が長ければ勾配をそのまま引き継げる (無駄に平らにしない)', () => {
    // rail_single は縦曲線半径 400 m。区間 500 m なら d ≤ 31% まで許され、
    // 規格勾配 5% の方が先に効くので、引き継いだ勾配がそのまま残る。
    const profile = place('rail_single', 0.04, 500);
    expect(profile.m0).toBeCloseTo(0.04, 4);
  });

  it('勾配そのものの規格は今までどおり効く', () => {
    const cls = getClass('rail_single');
    const profile = place('rail_single', 0.2, 600);
    expect(profile.maxGrade(32)).toBeLessThan(cls.maxGrade + 1e-6);
  });
});
