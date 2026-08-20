import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';
import { easementFromTangent, spiralLengthFor, spiralPoint } from '../src/core/easement';
import { xz } from '../src/core/curve';

/**
 * 緩和曲線 (クロソイド)。
 *
 * 実物の線路は直線からいきなり円曲線に入らない。曲率を弧長に比例して
 * 増やす区間を挟む。ここではその区間の幾何と、「始点の接線に接し、指した
 * 点を通る」線形を解くソルバを確かめる。
 */

/** 台形則を細かく刻んだ基準値 (級数・ガウス積分の答え合わせ用)。 */
function referenceSpiral(k0: number, k1: number, Ls: number, l: number, steps = 20000) {
  const rate = (k1 - k0) / Ls;
  const theta = (t: number): number => k0 * t + (rate * t * t) / 2;
  let x = 0;
  let y = 0;
  for (let i = 0; i < steps; i++) {
    const t0 = (l * i) / steps;
    const t1 = (l * (i + 1)) / steps;
    x += ((Math.cos(theta(t0)) + Math.cos(theta(t1))) / 2) * (t1 - t0);
    y += ((Math.sin(theta(t0)) + Math.sin(theta(t1))) / 2) * (t1 - t0);
  }
  return { x, y, theta: theta(l) };
}

const RAIL = { minRadius: 120, designSpeed: 100 };
const YARD = { minRadius: 50, designSpeed: 40 };

describe('緩和曲線の幾何', () => {
  it('直線から入る緩和曲線が、細かく積分した値と一致する', () => {
    for (const [R, Ls] of [
      [120, 24],
      [200, 40],
      [50, 10],
      [400, 60],
    ]) {
      const got = spiralPoint(0, 1 / R, Ls, Ls);
      const want = referenceSpiral(0, 1 / R, Ls, Ls);
      expect(got.x).toBeCloseTo(want.x, 6);
      expect(got.y).toBeCloseTo(want.y, 6);
    }
  });

  it('曲率を引き継ぐ緩和曲線 (ガウス積分) も基準値と一致する', () => {
    for (const [k0, k1, Ls] of [
      [1 / 300, 1 / 120, 20],
      [-1 / 200, 1 / 200, 40],
      [1 / 150, 0, 25],
    ]) {
      const got = spiralPoint(k0, k1, Ls, Ls);
      const want = referenceSpiral(k0, k1, Ls, Ls);
      expect(got.x).toBeCloseTo(want.x, 6);
      expect(got.y).toBeCloseTo(want.y, 6);
    }
  });

  it('終端の方向が Ls·(k0+k1)/2 になる', () => {
    const Ls = 30;
    expect(spiralPoint(0, 1 / 120, Ls, Ls).theta).toBeCloseTo((Ls * (1 / 120)) / 2, 9);
    expect(spiralPoint(1 / 300, 1 / 120, Ls, Ls).theta).toBeCloseTo(
      (Ls * (1 / 300 + 1 / 120)) / 2,
      9,
    );
  });

  it('緩和曲線長がこの縮尺で使える範囲に収まる', () => {
    // 実物の式 (5.9 V²/R) だと 100 km/h・R=120 で 492 m になり使えない。
    const single = spiralLengthFor(0, 1 / 120, 100, 400);
    const gentle = spiralLengthFor(0, 1 / 400, 100, 400);
    const yard = spiralLengthFor(0, 1 / 50, 40, 400);
    expect(single).toBeGreaterThan(15);
    expect(single).toBeLessThan(35);
    expect(gentle).toBeGreaterThan(single);
    expect(yard).toBeGreaterThan(6);
    expect(yard).toBeLessThan(15);
    // 半径が大きいほど長い (緩やかに効く)。
    expect(gentle).toBeLessThanOrEqual(60);
  });

  it('区間が短ければ緩和曲線も短くなる', () => {
    expect(spiralLengthFor(0, 1 / 120, 100, 20)).toBeLessThan(
      spiralLengthFor(0, 1 / 120, 100, 400),
    );
  });
});

describe('緩和曲線を含む線形を解く', () => {
  const a = xz(0, 0);
  const ta = xz(1, 0);

  it('始点では接線ちょうどから始まり、曲率が 0 から立ち上がる', () => {
    const r = easementFromTangent(a, ta, xz(200, 60), RAIL);
    expect(r.curve.tangentAt(0).dot(ta)).toBeGreaterThan(0.99999);
    // 円弧なら最初から 1/R あるところが、緩和曲線では 0 から始まる。
    expect(Math.abs(r.curve.curvatureAt(0))).toBeLessThan(0.2 / r.radius);
  });

  it('曲率が弧長に沿って単調に増えて、円曲線で一定になる', () => {
    const r = easementFromTangent(a, ta, xz(240, 80), RAIL);
    const L = r.curve.length;
    const ks: number[] = [];
    for (let i = 0; i <= 40; i++) ks.push(r.curve.curvatureAt((i / 40) * L));
    // 緩和曲線区間では増え続け、途中から一定になる (減らない)。
    for (let i = 1; i < ks.length; i++) expect(ks[i]).toBeGreaterThan(ks[i - 1] - 2e-4);
    expect(ks[ks.length - 1]).toBeCloseTo(1 / r.radius, 3);
  });

  it('指した点に届く', () => {
    const targets = [
      xz(200, 40),
      xz(150, -60),
      xz(300, 90),
      xz(80, 12),
      xz(240, -30),
      xz(120, 55),
    ];
    for (const b of targets) {
      const r = easementFromTangent(a, ta, b, RAIL);
      expect(r.gap).toBeLessThan(0.5);
    }
  });

  it('どの向き・どの距離でも規格の最小半径を割らない', () => {
    for (const opts of [RAIL, YARD]) {
      for (let deg = -80; deg <= 80; deg += 10) {
        for (const dist of [40, 80, 160, 320]) {
          const b = xz(dist * Math.cos(deg * (Math.PI / 180)), dist * Math.sin(deg * (Math.PI / 180)));
          const r = easementFromTangent(a, ta, b, opts);
          const { minRadius } = r.curve.extremeCurvature(48);
          expect(minRadius).toBeGreaterThan(opts.minRadius - 1e-6);
        }
      }
    }
  });

  it('接線の延長線上を指せば直線になる', () => {
    const r = easementFromTangent(a, ta, xz(150, 0), RAIL);
    expect(r.radius).toBe(Infinity);
    expect(r.curve.p1.distanceTo(xz(150, 0))).toBeLessThan(1e-6);
  });

  it('曲率を引き継いだ状態で真っ直ぐ先を指すと、曲率を抜く緩和区間ができる', () => {
    // 曲線の途中から分岐する場面。ここで直線を返すと、繋ぎ目で曲率が跳ぶ。
    const r = easementFromTangent(a, ta, xz(200, 0), { ...RAIL, startCurvature: 1 / 200 });
    expect(r.curve.pieceCount).toBeGreaterThan(1);
    expect(Math.abs(r.curve.curvatureAt(0) - 1 / 200)).toBeLessThan(2e-4);
    expect(Math.abs(r.curve.curvatureAt(r.curve.length))).toBeLessThan(Math.abs(1 / 200));
  });

  it('引き継いだ曲率が始点でそのまま繋がる', () => {
    for (const k0 of [1 / 150, -1 / 300, 1 / 500]) {
      const r = easementFromTangent(a, ta, xz(220, 50), { ...RAIL, startCurvature: k0 });
      expect(r.curve.curvatureAt(0)).toBeCloseTo(k0, 3);
    }
  });

  it('同じ入力からは必ず同じ線形が出る', () => {
    const one = easementFromTangent(a, ta, xz(210, 70), RAIL);
    const two = easementFromTangent(a, ta, xz(210, 70), RAIL);
    expect(one.curve.points.map((p) => [p.x, p.y])).toEqual(two.curve.points.map((p) => [p.x, p.y]));
  });

  it('真後ろを指しても暴走せず、届かないまま返る', () => {
    const r = easementFromTangent(a, ta, xz(-100, 5), RAIL);
    expect(Number.isFinite(r.curve.length)).toBe(true);
    expect(r.curve.length).toBeLessThan(1000);
    expect(r.gap).toBeGreaterThan(1);
  });

  it('終端の接線と曲率が、実際の曲線のものと合っている', () => {
    for (const b of [xz(200, 60), xz(160, -45), xz(300, 30)]) {
      const r = easementFromTangent(a, ta, b, RAIL);
      const L = r.curve.length;
      expect(r.curve.tangentAt(L).dot(new Vector2(r.endTangent.x, r.endTangent.y))).toBeGreaterThan(
        0.999,
      );
      expect(r.curve.curvatureAt(L)).toBeCloseTo(r.endCurvature, 3);
    }
  });
});
