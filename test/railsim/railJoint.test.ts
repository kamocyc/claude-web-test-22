import { describe, expect, it } from 'vitest';
import { axleOffsets, jointCrossings, kmhToMps } from '../../src/railsim/core/index.ts';
import { testVehicle } from './fixtures.ts';

describe('レール継目の通過', () => {
  it('前ステップと今ステップのあいだの継目をすべて拾う', () => {
    // 25m 間隔。40m から 90m まで進めば 50 / 75 の 2 つを跨ぐ。
    const u = jointCrossings(40, 90, 25);
    expect(u.length).toBe(2);
    expect(40 + u[0]! * 50).toBeCloseTo(50, 9);
    expect(40 + u[1]! * 50).toBeCloseTo(75, 9);
  });

  it('大きく進んでも取りこぼさない', () => {
    // 120km/h でも 1 フレーム（1/60 秒）に進むのは 0.56m だが、
    // 時間倍率 8 倍や処理落ちでは 1 ステップで何本も跨ぐ。
    const u = jointCrossings(0, 250, 25);
    expect(u.length).toBe(10);
    for (let i = 0; i < u.length; i++) {
      expect(u[i]! * 250).toBeCloseTo((i + 1) * 25, 9);
    }
  });

  it('ロングレール区間では継目が 1 つも出ない', () => {
    expect(jointCrossings(0, 1000, 0).length).toBe(0);
  });

  it('逆走しても取りこぼさない', () => {
    const u = jointCrossings(90, 40, 25);
    expect(u.length).toBe(2);
    expect(90 + u[0]! * -50).toBeCloseTo(75, 9);
    expect(90 + u[1]! * -50).toBeCloseTo(50, 9);
  });

  it('動かなければ何も起きない', () => {
    expect(jointCrossings(50, 50, 25).length).toBe(0);
  });
});

describe('軸の位置と継目音の間合い', () => {
  const spec = testVehicle();

  it('軸の位置が台車中心間距離と固定軸距から決まる', () => {
    const offsets = axleOffsets(spec);
    expect(offsets.length).toBe(4);
    // 前台車の 2 軸 → 後台車の 2 軸の順で、前が正
    expect(offsets[0]).toBeCloseTo(13.8 / 2 + 2.1 / 2, 9);
    expect(offsets[1]).toBeCloseTo(13.8 / 2 - 2.1 / 2, 9);
    expect(offsets[2]).toBeCloseTo(-13.8 / 2 + 2.1 / 2, 9);
    expect(offsets[3]).toBeCloseTo(-13.8 / 2 - 2.1 / 2, 9);
    // 前後対称
    expect(offsets[0]! + offsets[3]!).toBeCloseTo(0, 9);
  });

  it('「ガタン ゴトン」の間隔が固定軸距と台車中心間距離を映す', () => {
    // 同じ 1 つの継目を各軸が踏む時刻の間隔は、軸間距離 / 速度で決まる。
    const v = kmhToMps(72); // 20 m/s
    const offsets = axleOffsets(spec);
    const times = offsets.map((o) => (offsets[0]! - o) / v);

    // 台車内（2.1m）は 0.105 秒、台車をまたぐ（11.7m）は 0.585 秒
    expect(times[1]! - times[0]!).toBeCloseTo(2.1 / v, 9);
    expect(times[2]! - times[1]!).toBeCloseTo((13.8 - 2.1) / v, 9);
    expect(times[3]! - times[2]!).toBeCloseTo(2.1 / v, 9);
    // 「タン・タン …… タン・タン」という 2 拍ずつの並びになる
    expect(times[2]! - times[1]!).toBeGreaterThan((times[1]! - times[0]!) * 4);
  });

  it('速度が上がるほど継目を踏む間隔が詰まる', () => {
    const spacing = 25;
    const slow = spacing / kmhToMps(36);
    const fast = spacing / kmhToMps(108);
    expect(fast).toBeCloseTo(slow / 3, 9);
  });
});
