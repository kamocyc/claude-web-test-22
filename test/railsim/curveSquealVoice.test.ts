import { describe, expect, it } from 'vitest';
import {
  CurveSquealVoice,
  RollingVoice,
  SILENT_CURVE_SQUEAL,
  type CurveSquealParams,
} from '../../src/railsim/audio/index.ts';
import { aWeightedRms, bandPower, peakProminence, rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;
const LENGTH = SAMPLE_RATE;

/** 軋りを起こす車輪の面外モード（`curveSquealVoice.ts` の WHEEL_MODE） */
const WHEEL_MODE = 1150;

const params = (over: Partial<CurveSquealParams> = {}): CurveSquealParams => ({
  ...SILENT_CURVE_SQUEAL,
  speed: 12,
  level: 1,
  ...over,
});

function render(
  p: CurveSquealParams,
  seconds = 1,
  voice = new CurveSquealVoice(SAMPLE_RATE),
): Float32Array {
  voice.setParams(p);
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  voice.render(out);
  return out;
}

/** 比較の物差し。同じ速度域の転動音。 */
function rollingReference(speed: number): number {
  const voice = new RollingVoice(SAMPLE_RATE);
  voice.setParams({ speed, corrugation: 0.3, level: 1 });
  const out = new Float32Array(LENGTH);
  voice.render(out);
  return aWeightedRms(out, SAMPLE_RATE);
}

describe('曲線の軋み音', () => {
  it('負減衰でなければ何も鳴らない', () => {
    expect(rms(render(params({ drive: 0 }), 1))).toBe(0);
  });

  it('車輪の固有振動数の純音になる', () => {
    const out = render(params({ drive: 1 }), 2);
    const tail = out.subarray(SAMPLE_RATE) as unknown as Float32Array;
    expect(peakProminence(tail, SAMPLE_RATE, WHEEL_MODE, 250)).toBeGreaterThan(50);
  });

  it('音程が速度に依らない（決めているのは車輪であって回転ではない）', () => {
    const slow = render(params({ drive: 1, speed: 4 }), 2).subarray(
      SAMPLE_RATE,
    ) as unknown as Float32Array;
    const fast = render(params({ drive: 1, speed: 25 }), 2).subarray(
      SAMPLE_RATE,
    ) as unknown as Float32Array;
    // うなりで音程がわずかに揺れるので、線の高さではなく峰の帯で測る
    const at = (x: Float32Array): number =>
      bandPower(x, SAMPLE_RATE, WHEEL_MODE * 0.95, WHEEL_MODE * 1.05);
    // 同じ周波数に同じだけ立っている（転動音や歯車のように音程が上がらない）
    expect(at(fast)).toBeGreaterThan(at(slow) * 0.5);
    expect(at(fast)).toBeLessThan(at(slow) * 2);
  });

  it('倍音を持つ（固着と滑りの繰り返しは正弦波ではない）', () => {
    const out = render(params({ drive: 1 }), 2).subarray(SAMPLE_RATE) as unknown as Float32Array;
    expect(peakProminence(out, SAMPLE_RATE, WHEEL_MODE * 2, 250)).toBeGreaterThan(5);
    expect(peakProminence(out, SAMPLE_RATE, WHEEL_MODE * 3, 250)).toBeGreaterThan(5);
  });

  it('大きい軋りほど倍音が濃い（振れるほど正弦から遠ざかる）', () => {
    const ratio = (drive: number): number => {
      const out = render(params({ drive }), 2).subarray(SAMPLE_RATE) as unknown as Float32Array;
      const band = (f: number): number => bandPower(out, SAMPLE_RATE, f * 0.96, f * 1.04);
      return band(WHEEL_MODE * 2) / band(WHEEL_MODE);
    };
    expect(ratio(1)).toBeGreaterThan(ratio(0.3) * 1.5);
  });

  it('育つのに時間が要り、消えるのは速い', () => {
    const voice = new CurveSquealVoice(SAMPLE_RATE);
    const rising = render(params({ drive: 1 }), 1, voice);
    const head = rms(rising.subarray(0, Math.floor(SAMPLE_RATE * 0.05)));
    const held = rms(rising.subarray(Math.floor(SAMPLE_RATE * 0.8)));
    // 立ち上がりの 50ms ではまだ育ちきっていない
    expect(head).toBeLessThan(held * 0.5);

    const falling = render(params({ drive: 0 }), 1, voice);
    // 負減衰でなくなればすぐ消える
    expect(rms(falling.subarray(Math.floor(SAMPLE_RATE * 0.3)))).toBeLessThan(held * 0.01);
  });

  it('一瞬の不整では鳴き切らない（分岐器を直進で渡るとき）', () => {
    const voice = new CurveSquealVoice(SAMPLE_RATE);
    // 護輪軌条を踏んでいるのは 40ms ほど
    const brief = render(params({ drive: 1 }), 0.04, voice);
    const sustained = render(params({ drive: 1 }), 2, new CurveSquealVoice(SAMPLE_RATE));
    expect(rms(brief)).toBeLessThan(rms(sustained.subarray(Math.floor(SAMPLE_RATE * 1.5))) * 0.25);
  });

  it('鳴いているあいだは転動音を覆うほど大きい', () => {
    const out = render(params({ drive: 1, speed: 12 }), 2).subarray(
      SAMPLE_RATE,
    ) as unknown as Float32Array;
    const squeal = aWeightedRms(out, SAMPLE_RATE);
    const rolling = rollingReference(12);
    expect(squeal).toBeGreaterThan(rolling);
    // ただし飽和させるほどではない
    expect(squeal).toBeLessThan(rolling * 12);
  });

  it('駆動が弱ければ小さい', () => {
    const strong = rms(
      render(params({ drive: 1 }), 2).subarray(SAMPLE_RATE) as unknown as Float32Array,
    );
    const weak = rms(
      render(params({ drive: 0.25 }), 2).subarray(SAMPLE_RATE) as unknown as Float32Array,
    );
    expect(weak).toBeGreaterThan(0);
    expect(weak).toBeLessThan(strong * 0.3);
  });

  it('音量を 0 にすれば鳴らない', () => {
    expect(rms(render(params({ drive: 1, level: 0 }), 1))).toBe(0);
  });
});
