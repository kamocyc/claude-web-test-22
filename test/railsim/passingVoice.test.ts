import { describe, expect, it } from 'vitest';
import { PassingVoice, SILENT_PASSING, type PassingVoiceParams } from '../../src/railsim/audio/index.ts';
import { rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;
/** 相手の編成長 [m]（4 両） */
const LENGTH = 80;

const params = (over: Partial<PassingVoiceParams> = {}): PassingVoiceParams => ({
  ...SILENT_PASSING,
  present: true,
  headGap: 0,
  tailGap: LENGTH,
  closingSpeed: 28,
  separation: 3.4,
  level: 1,
  ...over,
});

/**
 * すれ違いの瞬間（`at` を跨いだ直後）の 0.2 秒の実効値。
 *
 * 圧力波は「先頭が並んだ瞬間」と「最後尾が抜けた瞬間」に来るので、その位置を
 * 跨いだ直後だけを測れば、並走中（何も起きない）と分けて比べられる。
 */
function pulseRms(over: Partial<PassingVoiceParams>, tail = false): number {
  const voice = new PassingVoice(SAMPLE_RATE);
  const head = tail ? -LENGTH + 2 : 2;
  voice.setParams(params({ ...over, headGap: head, tailGap: head + LENGTH }));
  const warm = new Float32Array(1024);
  voice.render(warm);
  // 跨いだ位置へ進める（ここで圧力波が起きる）
  voice.setParams(params({ ...over, headGap: head - 4, tailGap: head - 4 + LENGTH }));
  const out = new Float32Array(Math.floor(SAMPLE_RATE * 0.2));
  voice.render(out);
  return rms(out);
}

/** 位置関係を変えずに鳴らす（圧力波は起きないので無音になるはず） */
function steady(over: Partial<PassingVoiceParams> = {}): number {
  const voice = new PassingVoice(SAMPLE_RATE);
  voice.setParams(params(over));
  const out = new Float32Array(SAMPLE_RATE / 2);
  voice.render(out);
  return rms(out);
}

describe('すれ違いざまの圧力波', () => {
  it('相手の走行音はここには無い（並んでいるだけでは何も鳴らない）', () => {
    // 相手の転動音・歯車・インバータは自列車と同じ合成器（RemoteTrainVoice）が
    // 鳴らす。この音源が受け持つのは、音として伝わってくるのではない圧力波だけ。
    expect(steady({ headGap: -40, tailGap: 40 })).toBe(0);
    expect(steady({ present: false })).toBe(0);
  });

  it('先頭がすれ違う瞬間に圧力波が来る', () => {
    expect(pulseRms({})).toBeGreaterThan(0.01);
  });

  it('最後尾が抜けるときにも圧力波が来る（対で「バン…バン」になる）', () => {
    expect(pulseRms({}, true)).toBeGreaterThan(0.01);
  });

  it('圧力波は相対速度の 2 乗で効く', () => {
    const slow = pulseRms({ closingSpeed: 10 });
    const fast = pulseRms({ closingSpeed: 30 });
    // 3 倍の相対速度なら 9 倍。動圧が速度の 2 乗に比例することがそのまま出る。
    expect(fast / slow).toBeGreaterThan(7);
    expect(fast / slow).toBeLessThan(11);
  });

  it('線路が離れているほど弱い', () => {
    expect(pulseRms({ separation: 6.8 })).toBeLessThan(pulseRms({ separation: 3.4 }) * 0.6);
  });

  it('音量を 0 にすれば鳴らない', () => {
    expect(pulseRms({ level: 0 })).toBe(0);
  });
});
