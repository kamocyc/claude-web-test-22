import { describe, expect, it } from 'vitest';
import {
  GRAPH_W,
  bandPoints,
  formatCant,
  formatGrade,
  formatRadius,
  formatStation,
  formatStructure,
  formatVerticalRadius,
} from '../src/app/inspect';

/**
 * 確認モードの読み取りの表示。
 *
 * 数値そのものは `test/buildTool.test.ts` で実際に指して確かめる。ここでは
 * 「どう見せるか」だけを素の関数として突く (グラフの折れ線も文字列なので、
 * ブラウザなしで座標を確かめられる)。
 */

describe('確認モードの表示', () => {
  it('曲線半径は向きつきで、緩すぎる曲線は直線として出す', () => {
    expect(formatRadius(1 / 252)).toBe('右 R 252 m');
    expect(formatRadius(-1 / 120)).toBe('左 R 120 m');
    expect(formatRadius(0)).toBe('直線');
    // この縮尺 (数 km 四方) では、6000 m の曲線は直線と区別がつかない。
    expect(formatRadius(1 / 6000)).toBe('直線');
    expect(formatRadius(1 / 4000)).toBe('右 R 4000 m');
  });

  it('勾配は符号つき', () => {
    expect(formatGrade(0.0235)).toBe('+2.35 %');
    expect(formatGrade(-0.02)).toBe('-2.00 %');
    expect(formatGrade(0)).toBe('+0.00 %');
  });

  it('縦曲線半径は凸と凹を区別する', () => {
    // 2 階微分が負 = 上に凸 (山)。
    expect(formatVerticalRadius(620, -0.0016)).toBe('凸 R 620 m');
    expect(formatVerticalRadius(620, 0.0016)).toBe('凹 R 620 m');
    expect(formatVerticalRadius(Infinity, 0)).toBe('直線');
    expect(formatVerticalRadius(50000, 1e-9)).toBe('直線');
  });

  it('カントは高い側も出す', () => {
    expect(formatCant(0.105, 0.073)).toBe('105 mm (右が高い)');
    expect(formatCant(0.105, -0.073)).toBe('105 mm (左が高い)');
    expect(formatCant(0, 0)).toBe('0 mm');
  });

  it('構造形式と弧長', () => {
    expect(formatStructure('bridge')).toBe('橋');
    expect(formatStructure('tunnel')).toBe('トンネル');
    expect(formatStructure('ground')).toBe('地表');
    expect(formatStructure(null)).toBe('—');
    expect(formatStation(42.34, 105)).toBe('42.3 / 105.0 m');
  });
});

describe('グラフの折れ線', () => {
  /** `points` 属性を数値の組に戻す。 */
  function parse(points: string): { x: number; y: number }[] {
    return points.split(' ').map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
  }

  it('弧長が横一杯に広がる', () => {
    const { points } = bandPoints(new Float32Array(9).fill(0), 0.01, 27);
    const pts = parse(points);
    expect(pts).toHaveLength(9);
    expect(pts[0].x).toBeCloseTo(0, 6);
    expect(pts[8].x).toBeCloseTo(GRAPH_W, 6);
  });

  it('弧長に比例して変わる値は、まっすぐな斜めの線になる', () => {
    // 緩和曲線の曲率がこの形。ここが折れ線になっていれば、グラフを見て
    // 「緩和曲線が入っている」と言えなくなる。
    const ramp = new Float32Array(33);
    for (let i = 0; i < ramp.length; i++) ramp[i] = (i / (ramp.length - 1)) * 0.008;
    const pts = parse(bandPoints(ramp, 1 / 120, 27).points);
    // 座標は 0.1 px 刻みで書き出すので、その丸めのぶんは外積に残る。
    const step = GRAPH_W / (ramp.length - 1);
    for (let i = 2; i < pts.length; i++) {
      const a = { x: pts[i - 1].x - pts[i - 2].x, y: pts[i - 1].y - pts[i - 2].y };
      const b = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y };
      expect(Math.abs(a.x * b.y - a.y * b.x)).toBeLessThan(step * 0.2);
    }
    // 値が増えるほど上に行く (画面の y は下向きなので減る)。
    expect(pts[pts.length - 1].y).toBeLessThan(pts[0].y);
  });

  it('規格値で目盛りが決まるので、規格内なら必ず帯に収まる', () => {
    const limit = 1 / 120;
    const half = 21;
    // 規格ちょうどの値。1.15 の余裕を取ってあるので帯からはみ出さない。
    const at = new Float32Array(5).fill(limit);
    const pts = parse(bandPoints(at, limit, 27, half).points);
    for (const p of pts) {
      expect(p.y).toBeGreaterThan(27 - half);
      expect(p.y).toBeLessThan(27);
    }
  });

  it('全て 0 でも NaN を出さない', () => {
    // SVG の points に NaN が混ざると、ブラウザは黙って何も描かない。
    const { points } = bandPoints(new Float32Array(5), 0, 27);
    for (const p of parse(points)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeCloseTo(27, 6);
    }
  });
});
