import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';
import { HorizontalCurve, arcFromTangent, MAX_ARC_SWEEP } from '../src/core/curve';
import { Alignment } from '../src/core/alignment';
import { VerticalProfile } from '../src/core/profile';

const xz = (x: number, z: number): Vector2 => new Vector2(x, z);

describe('HorizontalCurve', () => {
  it('直線の弧長は 2 点間の距離になる', () => {
    const curve = HorizontalCurve.straight(xz(0, 0), xz(30, 40));
    expect(curve.length).toBeCloseTo(50, 3);
  });

  it('弧長パラメータで等間隔に点が取れる', () => {
    const curve = HorizontalCurve.straight(xz(0, 0), xz(100, 0));
    const a = curve.pointAt(25);
    const b = curve.pointAt(50);
    expect(a.x).toBeCloseTo(25, 2);
    expect(b.x).toBeCloseTo(50, 2);
  });

  it('直線の曲率はほぼ 0', () => {
    const curve = HorizontalCurve.straight(xz(0, 0), xz(80, 20));
    expect(Math.abs(curve.curvatureAt(40))).toBeLessThan(1e-6);
  });
});

describe('arcFromTangent', () => {
  it('始点の接線を保つ', () => {
    const a = xz(0, 0);
    const ta = xz(1, 0);
    const { curve } = arcFromTangent(a, ta, xz(100, 40));
    const t = curve.tangentAt(0);
    expect(t.x).toBeCloseTo(1, 3);
    expect(t.y).toBeCloseTo(0, 3);
  });

  it('掃引角が制限内なら指定した終点に到達する', () => {
    const { curve, sweep } = arcFromTangent(xz(0, 0), xz(1, 0), xz(120, 50));
    expect(Math.abs(sweep)).toBeLessThan(MAX_ARC_SWEEP);
    expect(curve.p1.x).toBeCloseTo(120, 1);
    expect(curve.p1.y).toBeCloseTo(50, 1);
  });

  it('円弧の半径は曲率の逆数と一致する', () => {
    const { curve, radius } = arcFromTangent(xz(0, 0), xz(1, 0), xz(100, 30));
    const measured = 1 / Math.abs(curve.curvatureAt(curve.length / 2));
    // 単一 3 次ベジエによる近似なので、数 % の誤差は許容する。
    expect(measured).toBeGreaterThan(radius * 0.96);
    expect(measured).toBeLessThan(radius * 1.04);
  });

  it('掃引角が上限を超える指定はクランプされ、終点は指定点と異なる', () => {
    const { curve, sweep } = arcFromTangent(xz(0, 0), xz(1, 0), xz(-10, 60));
    expect(Math.abs(sweep)).toBeCloseTo(MAX_ARC_SWEEP, 5);
    expect(curve.p1.distanceTo(xz(-10, 60))).toBeGreaterThan(1);
  });

  it('接線の延長線上なら直線になる', () => {
    const { curve, radius } = arcFromTangent(xz(0, 0), xz(1, 0), xz(50, 0));
    expect(radius).toBe(Infinity);
    expect(curve.length).toBeCloseTo(50, 3);
  });
});

describe('Alignment', () => {
  it('サンプルの端点は必ず両端に一致する', () => {
    const curve = HorizontalCurve.straight(xz(0, 0), xz(100, 0));
    const alignment = Alignment.create(curve, 0, 10);
    const samples = alignment.sample(7);
    expect(samples[0].s).toBeCloseTo(0, 6);
    expect(samples[samples.length - 1].s).toBeCloseTo(curve.length, 6);
  });

  it('縦断は端点の高さと勾配を満たす', () => {
    const profile = new VerticalProfile(10, 30, 0, 0, 100);
    expect(profile.yAt(0)).toBeCloseTo(10, 6);
    expect(profile.yAt(100)).toBeCloseTo(30, 6);
    expect(profile.gradeAt(0)).toBeCloseTo(0, 6);
    expect(profile.gradeAt(100)).toBeCloseTo(0, 6);
    // 端で水平なので中間の勾配は平均より急になる。
    expect(profile.maxGrade()).toBeGreaterThan(0.2);
  });

  it('進行方向ベクトルは勾配を含む', () => {
    const curve = HorizontalCurve.straight(xz(0, 0), xz(100, 0));
    const alignment = Alignment.create(curve, 0, 10);
    const sample = alignment.sampleAt(50);
    expect(sample.forward.y).toBeGreaterThan(0.09);
    expect(sample.forward.length()).toBeCloseTo(1, 6);
  });

  it('右手ベクトルは進行方向に直交する水平ベクトル', () => {
    const curve = HorizontalCurve.straight(xz(0, 0), xz(0, 100));
    const alignment = Alignment.create(curve, 0, 0);
    const sample = alignment.sampleAt(10);
    expect(sample.right.y).toBeCloseTo(0, 6);
    expect(sample.right.dot(sample.forward)).toBeCloseTo(0, 6);
    // +Z 方向に進むとき、右手側は -X。
    expect(sample.right.x).toBeCloseTo(-1, 5);
  });

  it('部分区間は元の線形と同じ点を通る', () => {
    const curve = new HorizontalCurve(xz(0, 0), xz(40, 10), xz(70, 50), xz(100, 60));
    const alignment = Alignment.create(curve, 0, 20);
    const sub = alignment.subAlignment(20, 60);
    expect(sub.length).toBeCloseTo(40, 0);

    const original = alignment.sampleAt(40).pos;
    const partial = sub.sampleAt(sub.length / 2).pos;
    expect(partial.distanceTo(original)).toBeLessThan(1.0);
  });
});
