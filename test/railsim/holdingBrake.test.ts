import { describe, expect, it } from 'vitest';
import { HoldingBrakeRegulator, kmhToMps } from '../../src/railsim/core/index.ts';

const dt = 0.05;

/** `seconds` 秒ぶん、速度を与えながら回す */
function run(
  regulator: HoldingBrakeRegulator,
  seconds: number,
  speedAt: (t: number) => number,
  count = 7,
): number {
  let notch = 0;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    notch = regulator.update(dt, true, speedAt(i * dt), count);
  }
  return notch;
}

describe('抑速ブレーキの調速器', () => {
  it('抑速位置に入っていなければ段は出ない', () => {
    const regulator = new HoldingBrakeRegulator();
    expect(regulator.update(dt, false, kmhToMps(70), 7)).toBe(0);
    expect(regulator.command).toBe(0);
    expect(regulator.targetSpeed).toBe(0);
  });

  it('入れた瞬間の速度を目標にする', () => {
    const regulator = new HoldingBrakeRegulator();
    regulator.update(dt, true, kmhToMps(65), 7);
    expect(regulator.targetSpeed).toBeCloseTo(kmhToMps(65), 9);
    // 入れた直後は目標どおりなので、まだ段を出す理由が無い
    expect(regulator.command).toBe(0);
  });

  it('目標より速くなれば段を強め、遅くなれば緩める', () => {
    const regulator = new HoldingBrakeRegulator();
    regulator.update(dt, true, kmhToMps(70), 7);

    // 下り勾配で加速していく想定。段は 1 つずつしか動かないので時間がかかる
    const strong = run(regulator, 8, (t) => kmhToMps(70 + t));
    expect(strong).toBeGreaterThan(1);

    // 効きすぎて目標を割り込めば、同じ速さで緩んでいく
    const weak = run(regulator, 8, () => kmhToMps(66));
    expect(weak).toBeLessThan(strong);
  });

  it('段は車両のブレーキ段数で頭打ちになる', () => {
    const regulator = new HoldingBrakeRegulator();
    regulator.update(dt, true, kmhToMps(50), 7);
    expect(run(regulator, 60, (t) => kmhToMps(50 + t), 7)).toBe(7);
  });

  it('電気ブレーキが立たない低速では段を出さない', () => {
    const regulator = new HoldingBrakeRegulator();
    regulator.update(dt, true, kmhToMps(60), 7);
    run(regulator, 10, (t) => kmhToMps(60 + t));
    expect(regulator.command).toBeGreaterThan(0);
    // 速度が落ちれば、目標を大きく下回っているかどうかに関わらず切れる
    expect(regulator.update(dt, true, kmhToMps(3), 7)).toBe(0);
  });

  it('抜いて入れ直すと、その時点の速度を新しい目標にする', () => {
    const regulator = new HoldingBrakeRegulator();
    regulator.update(dt, true, kmhToMps(70), 7);
    run(regulator, 8, (t) => kmhToMps(70 + t));
    expect(regulator.command).toBeGreaterThan(0);

    regulator.update(dt, false, kmhToMps(78), 7);
    expect(regulator.command).toBe(0);

    regulator.update(dt, true, kmhToMps(78), 7);
    expect(regulator.targetSpeed).toBeCloseTo(kmhToMps(78), 9);
    expect(regulator.command).toBe(0);
  });
});
