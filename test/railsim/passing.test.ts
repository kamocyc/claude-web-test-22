import { describe, expect, it } from 'vitest';
import {
  AdjacentTrack,
  crossingAngle,
  loopSpacingOf,
  nearestPassingEncounter,
  passingDistance,
  scheduledTrainState,
  turnoutBranchOffset,
  type PassingLoop,
  type ScheduledTrain,
} from '../../src/railsim/core/index.ts';

/** #12 分岐器（R350）の諸元 */
const ANGLE = crossingAngle(12);
const RADIUS = 350;
const LEAD = RADIUS * ANGLE;
const TAIL = LEAD * 0.4;

/** 起点駅の交換設備（40m 〜 460.7m。隣の線路は右） */
const loop: PassingLoop = {
  id: 'loop',
  entry: 40,
  exit: 40 + 420.7,
  radius: RADIUS,
  angle: ANGLE,
  tailLength: TAIL,
  spacing: loopSpacingOf(RADIUS, ANGLE, TAIL),
  side: 1,
  widening: 0,
  wideningLength: 120,
};

/** 複線区間（6850m 〜 11840.7m。線路中心間隔 3.8m、拡幅 140m） */
const DOUBLE_SPACING = 3.8;
const double: PassingLoop = {
  id: 'double',
  entry: 6850,
  exit: 11840.7,
  radius: RADIUS,
  angle: ANGLE,
  tailLength: TAIL,
  spacing: loopSpacingOf(RADIUS, ANGLE, TAIL),
  side: 1,
  widening: DOUBLE_SPACING - loopSpacingOf(RADIUS, ANGLE, TAIL),
  wideningLength: 140,
};

const opposing = (over: Partial<ScheduledTrain> = {}): ScheduledTrain => ({
  id: 'opposing',
  length: 80,
  track: 'adjacent',
  waypoints: [
    { time: 0, position: 400 },
    { time: 40, position: 0 },
  ],
  ...over,
});

describe('交換設備の隣の線路', () => {
  it('線路中心間隔は分岐器の番数が決める', () => {
    // R(1−cosα) を 2 回と、護輪軌条部の sinα ぶん
    const expected = 2 * RADIUS * (1 - Math.cos(ANGLE)) + TAIL * Math.sin(ANGLE);
    expect(loop.spacing).toBeCloseTo(expected, 9);
    // #12 なら 3.4m 前後（在来線の線路中心間隔とほぼ同じ）
    expect(loop.spacing).toBeCloseTo(3.38, 2);
  });

  it('分岐器の途中では横のずれが増えていく', () => {
    // リード曲線の途中は d²/2R の放物線に近い
    expect(turnoutBranchOffset(10, RADIUS, ANGLE, TAIL)).toBeCloseTo((10 * 10) / (2 * RADIUS), 3);
    // 寄りきったあとは平行になる（それ以上は離れない）
    expect(turnoutBranchOffset(1000, RADIUS, ANGLE, TAIL)).toBeCloseTo(loop.spacing, 9);
    expect(turnoutBranchOffset(0, RADIUS, ANGLE, TAIL)).toBe(0);
  });

  it('交換設備の外には隣の線路が無い（単線なので）', () => {
    const adjacent = new AdjacentTrack([loop]);
    expect(adjacent.has(20)).toBe(false);
    expect(adjacent.has(200)).toBe(true);
    expect(adjacent.has(600)).toBe(false);
    expect(adjacent.offsetAt(20)).toBe(0);
    expect(adjacent.offsetAt(600)).toBe(0);
  });

  it('分岐器で 0 から線路中心間隔まで開き、出口でまた閉じる', () => {
    const adjacent = new AdjacentTrack([loop]);
    expect(adjacent.offsetAt(40)).toBe(0);
    expect(adjacent.offsetAt(200)).toBeCloseTo(loop.spacing, 9);
    expect(adjacent.offsetAt(loop.exit)).toBeCloseTo(0, 9);
    // 入口の途中では開きかけ
    const halfway = adjacent.offsetAt(70);
    expect(halfway).toBeGreaterThan(0);
    expect(halfway).toBeLessThan(loop.spacing);
  });

  it('分岐側を走っていれば隣の線路は反対側になる', () => {
    const left = new AdjacentTrack([{ ...loop, side: -1 }]);
    expect(left.offsetAt(200)).toBeCloseTo(-loop.spacing, 9);
  });
});

describe('対向列車', () => {
  it('距離程が減っていく折れ線は対向列車になる', () => {
    const state = scheduledTrainState(opposing(), 20)!;
    expect(state.direction).toBe(-1);
    expect(state.leadPosition).toBeCloseTo(200, 9);
    expect(state.speed).toBeCloseTo(10, 9);
    // 先頭端は進行方向の先（距離程の小さい側）。編成は後ろへ伸びる。
    expect(state.occupancy.rear).toBeCloseTo(200, 9);
    expect(state.occupancy.front).toBeCloseTo(280, 9);
  });

  it('ダイヤの時間帯の外では在線しない', () => {
    expect(scheduledTrainState(opposing(), -1)).toBeNull();
    expect(scheduledTrainState(opposing(), 41)).toBeNull();
  });

  it('すれ違いは相対速度で決まる（自分が止まっていても相手が速ければ速い）', () => {
    const adjacent = new AdjacentTrack([loop]);
    const state = scheduledTrainState(opposing(), 20)!;
    const encounter = nearestPassingEncounter(150, 5, [state], adjacent)!;
    expect(encounter.trainId).toBe('opposing');
    // 相手の先頭は 200m、最後尾は 280m。運転台は 150m。
    expect(encounter.headGap).toBeCloseTo(50, 9);
    expect(encounter.tailGap).toBeCloseTo(130, 9);
    // 近づく速さは両方の速度の和
    expect(encounter.closingSpeed).toBeCloseTo(15, 9);
    expect(encounter.lateralSeparation).toBeCloseTo(loop.spacing, 9);
  });

  it('並んでいるあいだの距離は線路中心間隔になる', () => {
    const adjacent = new AdjacentTrack([loop]);
    const state = scheduledTrainState(opposing(), 20)!;
    // 運転台が相手の編成（200〜280m）の中ほどにいる
    const encounter = nearestPassingEncounter(240, 5, [state], adjacent)!;
    expect(encounter.headGap).toBeLessThan(0);
    expect(encounter.tailGap).toBeGreaterThan(0);
    expect(passingDistance(encounter)).toBeCloseTo(loop.spacing, 9);
  });

  it('同じ線路の先行列車はすれ違いの相手にならない（衝突になってしまう）', () => {
    const adjacent = new AdjacentTrack([loop]);
    const state = scheduledTrainState(opposing({ track: 'own' }), 20)!;
    expect(nearestPassingEncounter(150, 5, [state], adjacent)).toBeNull();
  });

  it('遠すぎる対向列車は聞こえない', () => {
    const adjacent = new AdjacentTrack([loop]);
    const state = scheduledTrainState(opposing(), 0)!;
    // 相手は 400m 先。運転台が 0m ならもう届かない。
    expect(nearestPassingEncounter(-100, 5, [state], adjacent)).toBeNull();
  });
});

describe('複線区間の隣の線路', () => {
  const track = new AdjacentTrack([double]);

  it('分岐器で寄ったあと、拡幅して所定の線路中心間隔になる', () => {
    // 分岐器 1 組で寄りきる位置（リード + 護輪軌条部 + 戻し曲線）
    const run = 2 * LEAD + TAIL;
    expect(track.spacingAt(double.entry + run)).toBeCloseTo(double.spacing, 6);
    // 拡幅が終われば所定の間隔。以降どこまで行っても変わらない
    expect(track.spacingAt(double.entry + run + double.wideningLength)).toBeCloseTo(
      DOUBLE_SPACING,
      6,
    );
    expect(track.spacingAt(9000)).toBeCloseTo(DOUBLE_SPACING, 6);
    expect(track.spacingAt(11000)).toBeCloseTo(DOUBLE_SPACING, 6);
  });

  it('拡幅は S 字なので、途中でちょうど半分寄っている', () => {
    const run = 2 * LEAD + TAIL;
    const half = track.spacingAt(double.entry + run + double.wideningLength / 2);
    expect(half - double.spacing).toBeCloseTo(double.widening / 2, 6);
  });

  it('出口側も同じ形で単線へ戻る', () => {
    expect(track.spacingAt(double.exit)).toBeCloseTo(0, 6);
    expect(track.offsetAt(double.exit + 1)).toBe(0);
    expect(track.has(double.entry - 1)).toBe(false);
  });

  it('隣の線路は進行方向右にある（左側通行なので上り線）', () => {
    expect(track.offsetAt(9000)).toBeCloseTo(DOUBLE_SPACING, 6);
  });
});
