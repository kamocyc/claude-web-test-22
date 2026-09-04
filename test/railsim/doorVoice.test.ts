import { describe, expect, it } from 'vitest';
import { AlarmVoice, DoorVoice, SILENT_DOOR, type DoorVoiceParams } from '../../src/railsim/audio/index.ts';
import { aWeightedRms, bandPower, goertzel, peakProminence, rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;
const LENGTH = SAMPLE_RATE;

/** ドアチャイムの 2 音（完全 4 度） */
const HIGH = 987.77;
const LOW = 739.99;

const params = (over: Partial<DoorVoiceParams> = {}): DoorVoiceParams => ({
  ...SILENT_DOOR,
  level: 1,
  ...over,
});

function render(p: DoorVoiceParams, seconds = 1, voice = new DoorVoice(SAMPLE_RATE)): Float32Array {
  voice.setParams(p);
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  voice.render(out);
  return out;
}

/**
 * 音量を比べる物差し。
 * 車内で鳴る合図なので、走行音ではなく運転台の報知音（ATS チャイム）と揃える。
 */
function alarmChimeReference(): number {
  const voice = new AlarmVoice(SAMPLE_RATE);
  voice.setParams({ bell: false, chime: true, patternApproach: false, level: 1 });
  const out = new Float32Array(LENGTH);
  voice.render(out);
  return aWeightedRms(out, SAMPLE_RATE);
}

describe('客用扉の音', () => {
  it('何も起きていなければ無音', () => {
    const voice = new DoorVoice(SAMPLE_RATE);
    voice.setParams(SILENT_DOOR);
    const out = new Float32Array(LENGTH);
    voice.render(out);
    expect(rms(out)).toBe(0);
  });

  it('扉が動いているあいだだけ空気音が鳴る', () => {
    const moving = render(params({ moving: true }), 0.5);
    const still = render(params({ moving: false }), 0.5);
    expect(rms(moving)).toBeGreaterThan(rms(still) * 50);
    // 帯域雑音であって、音程を持たない。帯域通過のぶんのゆるい山はあるが、
    // 本物の音程（チャイム）と比べれば桁が違う。
    const air = peakProminence(moving, SAMPLE_RATE, 1100, 200);
    const tone = peakProminence(render(params({ chiming: true }), 2), SAMPLE_RATE, HIGH, 120);
    expect(air).toBeLessThan(tone / 5);
  });

  it('閉めるときは開くときより空気音が小さい（排気を絞るため）', () => {
    const opening = render(params({ moving: true, closing: false }), 0.5);
    const closing = render(params({ moving: true, closing: true }), 0.5);
    expect(rms(closing)).toBeLessThan(rms(opening));
    expect(rms(closing)).toBeGreaterThan(rms(opening) * 0.5);
  });

  it('扉が止まると空気音が抜けていく', () => {
    const voice = new DoorVoice(SAMPLE_RATE);
    render(params({ moving: true }), 0.5, voice);
    const after = render(params({ moving: false }), 0.5, voice);
    const head = after.subarray(0, Math.floor(SAMPLE_RATE * 0.02));
    const tail = after.subarray(Math.floor(SAMPLE_RATE * 0.4));
    expect(rms(head)).toBeGreaterThan(0);
    expect(rms(tail)).toBeLessThan(rms(head) * 0.05);
  });
});

describe('ドアチャイム', () => {
  it('完全 4 度の 2 音が鳴る', () => {
    const out = render(params({ chiming: true }), 2);
    expect(peakProminence(out, SAMPLE_RATE, HIGH, 120)).toBeGreaterThan(8);
    expect(peakProminence(out, SAMPLE_RATE, LOW, 120)).toBeGreaterThan(8);
    // 完全 4 度（周波数比 4:3）
    expect(HIGH / LOW).toBeCloseTo(4 / 3, 2);
  });

  it('高いほうが先、低いほうがあとに鳴る（呼び出し音にならない向き）', () => {
    const out = render(params({ chiming: true }), 1.0);
    const first = out.subarray(0, Math.floor(SAMPLE_RATE * 0.4));
    const second = out.subarray(Math.floor(SAMPLE_RATE * 0.45), Math.floor(SAMPLE_RATE * 0.82));
    expect(goertzel(first, SAMPLE_RATE, HIGH)).toBeGreaterThan(
      goertzel(first, SAMPLE_RATE, LOW) * 10,
    );
    expect(goertzel(second, SAMPLE_RATE, LOW)).toBeGreaterThan(
      goertzel(second, SAMPLE_RATE, HIGH) * 10,
    );
  });

  it('鳴り止めると音が消える', () => {
    const voice = new DoorVoice(SAMPLE_RATE);
    render(params({ chiming: true }), 0.3, voice);
    const after = render(params({ chiming: false }), 0.5, voice);
    expect(rms(after.subarray(Math.floor(SAMPLE_RATE * 0.2)))).toBeLessThan(1e-4);
  });

  it('運転台の報知音と同じくらいの大きさに収まる', () => {
    // チャイムは鳴り続ける音ではないので、全体の実効値ではなく**鳴っている瞬間**で
    // 比べる。1 音目の頭 0.2 秒を切り出す。
    const out = render(params({ chiming: true }), 2);
    const striking = out.subarray(0, Math.floor(SAMPLE_RATE * 0.2)) as unknown as Float32Array;
    const reference = alarmChimeReference();
    const level = aWeightedRms(striking, SAMPLE_RATE);
    expect(level).toBeGreaterThan(reference * 0.6);
    expect(level).toBeLessThan(reference * 1.7);
  });
});

describe('戸当たり', () => {
  it('閉じ切ると撃力が鳴り、短時間で減衰する', () => {
    const out = render(params({ latches: 1 }), 0.6);
    const head = out.subarray(0, Math.floor(SAMPLE_RATE * 0.05));
    const tail = out.subarray(Math.floor(SAMPLE_RATE * 0.4));
    expect(rms(head)).toBeGreaterThan(0);
    expect(rms(tail)).toBeLessThan(rms(head) * 0.05);
  });

  it('戸閉めのほうが開き切りより重い', () => {
    const latch = render(params({ latches: 1 }), 0.4);
    const open = render(params({ opens: 1 }), 0.4);
    expect(rms(latch)).toBeGreaterThan(rms(open) * 1.5);
  });

  it('接触器の進段音より低いところに重心がある（戸先ゴムがあるため）', () => {
    const out = render(params({ latches: 1 }), 0.4);
    const low = bandPower(out, SAMPLE_RATE, 60, 250);
    const high = bandPower(out, SAMPLE_RATE, 1500, 4000);
    expect(low).toBeGreaterThan(high * 5);
  });
});
