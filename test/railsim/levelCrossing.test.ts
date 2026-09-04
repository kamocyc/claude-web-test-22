import { describe, expect, it } from 'vitest';
import {
  LevelCrossingSystem,
  LevelCrossingTrack,
  crossingEdges,
  warningDistanceOf,
  type DirectedOccupancy,
  type LevelCrossing,
} from '../../src/railsim/core/index.ts';

const crossing = (over: Partial<LevelCrossing> = {}): LevelCrossing => ({
  id: 'xg',
  name: '踏切',
  position: 1000,
  roadWidth: 8,
  surface: 'rubber',
  bell: 'electronic',
  warningDistance: 600,
  barrierDelay: 5,
  barrierFall: 7,
  barrierRise: 6,
  ...over,
});

/** 距離程 `front` に先端がある、長さ 80m の下り列車 */
const down = (front: number): DirectedOccupancy => ({
  front,
  rear: front - 80,
  direction: 1,
});

/** 距離程 `front` に**後端**がある上り列車（先端は距離程の小さい側） */
const up = (rear: number): DirectedOccupancy => ({ front: rear, rear: rear - 80, direction: -1 });

/** 鳴動が落ち着くまで進める */
function settle(system: LevelCrossingSystem, trains: DirectedOccupancy[], seconds: number): void {
  const dt = 0.01;
  for (let t = 0; t < seconds; t += dt) system.update(dt, trains);
}

describe('踏切', () => {
  it('警報開始距離は 警報時間 × 最高速度 で決まる', () => {
    // 110km/h の線区で 30 秒なら 917m 手前
    expect(warningDistanceOf(30, 110 / 3.6)).toBeCloseTo(916.7, 1);
  });

  it('踏切道の両端が踏切板の目地になる', () => {
    const track = new LevelCrossingTrack([crossing()]);
    expect(crossingEdges(crossing())).toEqual([996, 1004]);
    // 軸が跨げば入口と出口で 1 回ずつ踏む
    expect(track.crossing(990, 1010).map((e) => e.s)).toEqual([996, 1004]);
    expect(track.crossing(990, 1000)).toHaveLength(1);
  });

  it('踏切板と舗装の段差は局所的な軌道狂いになる', () => {
    const track = new LevelCrossingTrack([crossing()]);
    // 目地の上でいちばん落ち込み、少し離れれば 0 に戻る
    expect(track.verticalAt(996)).toBeLessThan(0);
    expect(track.verticalAt(980)).toBe(0);
    expect(track.verticalAt(1020)).toBe(0);
    // コンクリート板のほうが硬いので段差も大きく効く
    const hard = new LevelCrossingTrack([crossing({ surface: 'concrete' })]);
    expect(hard.verticalAt(996)).toBeLessThan(track.verticalAt(996));
  });

  it('警報開始点を踏むと鳴り出し、最後部が抜けると止まる', () => {
    const system = new LevelCrossingSystem(new LevelCrossingTrack([crossing()]));
    const state = system.states[0]!;

    system.update(0.01, [down(395)]);
    expect(state.ringing).toBe(false);

    // 警報開始点は踏切道の入口（996m）の 600m 手前、すなわち 396m
    system.update(0.01, [down(397)]);
    expect(state.ringing).toBe(true);

    // 先頭が渡りきっても、最後部が抜けるまでは鳴り続ける
    system.update(0.01, [down(1050)]);
    expect(state.ringing).toBe(true);

    system.update(0.01, [down(1090)]);
    expect(state.ringing).toBe(false);
  });

  it('反対向きの列車にも鳴る（踏切は列車の向きを選ばない）', () => {
    const system = new LevelCrossingSystem(new LevelCrossingTrack([crossing()]));
    const state = system.states[0]!;
    // 上り列車が踏切道の出口（1004m）の 600m 向こうから近づいてくる
    system.update(0.01, [up(1690)]);
    expect(state.ringing).toBe(false);
    system.update(0.01, [up(1600)]);
    expect(state.ringing).toBe(true);
    // 抜けきれば止まる
    system.update(0.01, [up(900)]);
    expect(state.ringing).toBe(false);
  });

  it('遮断桿は警報より遅れて下り、通過後に上がる', () => {
    const system = new LevelCrossingSystem(new LevelCrossingTrack([crossing()]));
    const state = system.states[0]!;
    const approaching = [down(500)];

    settle(system, approaching, 4);
    // 鳴り始めてすぐは竿が上がったまま（渡っている人を閉じ込めないため）
    expect(state.ringing).toBe(true);
    expect(state.barrier).toBe(0);

    settle(system, approaching, 5);
    expect(state.barrier).toBeGreaterThan(0);
    expect(state.barrier).toBeLessThan(1);

    settle(system, approaching, 10);
    expect(state.barrier).toBe(1);

    // 抜けたら上がる
    settle(system, [down(1200)], 3);
    expect(state.barrier).toBeGreaterThan(0);
    expect(state.barrier).toBeLessThan(1);
    settle(system, [down(1200)], 5);
    expect(state.barrier).toBe(0);
  });

  it('いちばん近い鳴っている踏切を選べる', () => {
    const track = new LevelCrossingTrack([crossing(), crossing({ id: 'xg2', position: 1400 })]);
    const system = new LevelCrossingSystem(track);
    system.update(0.01, [down(900)]);
    // どちらも鳴動範囲だが、近いほうを採る
    expect(system.states.every((s) => s.ringing)).toBe(true);
    expect(system.nearestRinging(900)?.crossing.id).toBe('xg');
    expect(system.nearestRinging(1300)?.crossing.id).toBe('xg2');
  });
});
