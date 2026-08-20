import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import {
  HorizontalCurve,
  arcToBezier,
  reversedCurve,
  xz,
  type XZ,
} from '../src/core/curve';
import { Alignment, splitBezier } from '../src/core/alignment';
import { VerticalProfile } from '../src/core/profile';
import { offsetCurve } from '../src/network/parallel';
import { Network } from '../src/network/network';

/**
 * 連結ベジエ (複数ピースの `HorizontalCurve`)。
 *
 * 緩和曲線は 1 本の 3 次ベジエでは表せないので、線形は制御点を `3n+1` 個
 * 持てるようにしてある。ここでは「ピースが増えても弧長・接線・曲率・分割・
 * オフセットが 1 ピースのときと同じように振る舞う」ことを確かめる。
 */

/** 半径 `r` の円弧を `pieces` 片の連結ベジエにする (原点中心、+X から開始)。 */
function arcChain(r: number, sweep: number, pieces: number): HorizontalCurve {
  const center = xz(0, 0);
  const points: XZ[] = [];
  for (let i = 0; i < pieces; i++) {
    const start = center
      .clone()
      .add(new Vector2(r, 0).rotateAround(new Vector2(0, 0), (sweep * i) / pieces));
    const piece = arcToBezier(center, start, sweep / pieces);
    if (i === 0) points.push(piece.p0);
    points.push(piece.c0, piece.c1, piece.p1);
  }
  return new HorizontalCurve(points);
}

/** 曲線を細かい折れ線として測った長さ。 */
function chordLength(curve: HorizontalCurve, steps = 4000): number {
  const n = curve.pieceCount;
  let total = 0;
  const prev = curve.pointAtT(0);
  const cur = new Vector2();
  for (let i = 1; i <= steps; i++) {
    curve.pointAtT((i / steps) * n, cur);
    total += cur.distanceTo(prev);
    prev.copy(cur);
  }
  return total;
}

describe('連結ベジエ', () => {
  it('ピースを増やしても、1 ピースのときと同じ弧長・同じ形になる', () => {
    const one = arcChain(200, Math.PI / 3, 1);
    const three = arcChain(200, Math.PI / 3, 3);
    expect(three.pieceCount).toBe(3);
    // 半径 200 m・60° の円弧の弧長。
    expect(three.length).toBeCloseTo((200 * Math.PI) / 3, 1);
    expect(three.length).toBeCloseTo(one.length, 1);
    // 弧長で見た同じ位置が同じ点になる。
    for (let i = 0; i <= 10; i++) {
      const s = (i / 10) * three.length;
      expect(three.pointAt(s).distanceTo(one.pointAt((s / three.length) * one.length))).toBeLessThan(
        0.05,
      );
    }
  });

  it('弧長テーブルが折れ線で測った長さと一致する', () => {
    const curve = arcChain(120, Math.PI / 2, 4);
    expect(curve.length).toBeCloseTo(chordLength(curve), 2);
  });

  it('ピースの境目で位置と接線が繋がっている', () => {
    const curve = arcChain(150, Math.PI / 2, 4);
    const boundary = curve.length / 4;
    for (let i = 1; i < 4; i++) {
      const s = boundary * i;
      const before = curve.pointAt(s - 0.001);
      const after = curve.pointAt(s + 0.001);
      expect(before.distanceTo(after)).toBeLessThan(0.01);
      const t0 = curve.tangentAt(s - 0.001);
      const t1 = curve.tangentAt(s + 0.001);
      expect(t0.dot(t1)).toBeGreaterThan(0.9999);
    }
  });

  it('曲率がピースの境目でも正しく出る (最小半径を見落とさない)', () => {
    const curve = arcChain(120, Math.PI / 2, 4);
    const { minRadius } = curve.extremeCurvature(48);
    expect(minRadius).toBeGreaterThan(119);
    expect(minRadius).toBeLessThan(121);
  });

  it('分割してもピースが潰れず、元の曲線の上を通る', () => {
    const curve = arcChain(180, Math.PI / 2, 4);
    const L = curve.length;
    const alignment = new Alignment(curve, new VerticalProfile(10, 22, 0.04, 0.04, L));
    const sub = alignment.subAlignment(L * 0.2, L * 0.8);
    // 1 本のベジエに握りつぶされていないこと。
    expect(sub.horizontal.pieceCount).toBeGreaterThan(1);
    expect(sub.length).toBeCloseTo(L * 0.6, 0);
    for (let i = 0; i <= 20; i++) {
      const s = (i / 20) * sub.length;
      const here = sub.horizontal.pointAt(s);
      const there = curve.pointAt(L * 0.2 + (s / sub.length) * L * 0.6);
      expect(here.distanceTo(there)).toBeLessThan(0.05);
    }
  });

  it('ピースの内側で切っても端が一致する', () => {
    const curve = arcChain(180, Math.PI / 2, 3);
    // ピース 1 の途中 (t = 0.35) からピース 2 の途中 (t = 0.6) まで。
    const sub = splitBezier(curve, 1.35 / 3, 2.6 / 3);
    expect(sub.p0.distanceTo(curve.pointAtT(1.35))).toBeLessThan(1e-6);
    expect(sub.p1.distanceTo(curve.pointAtT(2.6))).toBeLessThan(1e-6);
  });

  it('向きを反転しても形が変わらない', () => {
    const curve = arcChain(160, Math.PI / 2, 3);
    const back = reversedCurve(curve);
    expect(back.pieceCount).toBe(3);
    expect(back.length).toBeCloseTo(curve.length, 3);
    for (let i = 0; i <= 10; i++) {
      const s = (i / 10) * curve.length;
      expect(back.pointAt(back.length - s).distanceTo(curve.pointAt(s))).toBeLessThan(0.01);
    }
    // 2 回反転すれば元に戻る。
    expect(reversedCurve(back).p0.distanceTo(curve.p0)).toBeLessThan(1e-9);
  });

  it('横にずらしてもピース数が保たれ、間隔がどこでも一定になる', () => {
    const curve = arcChain(200, Math.PI / 2, 4);
    const offset = 8;
    const shifted = offsetCurve(curve, offset);
    expect(shifted.pieceCount).toBe(4);
    // 円弧をずらした結果は半径 200 - 8 の円弧 (右手側が正)。
    for (let i = 0; i <= 20; i++) {
      const p = shifted.pointAt((i / 20) * shifted.length);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(200 - offset, 1);
    }
  });

  it('中間の制御点がネットワークに保存され、線形が復元される', () => {
    const curve = arcChain(200, Math.PI / 2, 3);
    const network = new Network();
    const a = network.addNode(new Vector3(curve.p0.x, 10, curve.p0.y));
    const b = network.addNode(new Vector3(curve.p1.x, 10, curve.p1.y));
    const seg = network.addSegment({
      classId: 'rail_single',
      a: a.id,
      b: b.id,
      ctrlA: curve.c0,
      ctrlB: curve.c1,
      via: curve.via,
      gradeA: 0,
      gradeB: 0,
    });
    expect(seg.via).toHaveLength(6);
    const rebuilt = network.alignmentOf(seg.id).horizontal;
    expect(rebuilt.pieceCount).toBe(3);
    expect(rebuilt.length).toBeCloseTo(curve.length, 3);

    // 分割しても中間の制御点が引き継がれる。
    const mid = network.splitSegment(seg.id, curve.length / 2);
    const halves = mid.segments.map((id) => network.alignmentOf(id).horizontal);
    expect(halves.some((h) => h.pieceCount > 1)).toBe(true);
    expect(halves[0].length + halves[1].length).toBeCloseTo(curve.length, 0);
  });
});
