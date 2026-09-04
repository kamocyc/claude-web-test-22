import { describe, expect, it } from 'vitest';
import {
  CAR_BODY_CORNER,
  CAR_BODY_LOSS,
  CarBodyInsulation,
  CrossingVoice,
  RollingVoice,
  SILENT_CROSSING,
} from '../../src/railsim/audio/index.ts';
import { aWeightedRms, rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;

/** 正弦を 1 秒通して、透過した振幅の比を測る */
function transmission(frequency: number): number {
  const wall = new CarBodyInsulation(SAMPLE_RATE);
  let peak = 0;
  for (let i = 0; i < SAMPLE_RATE; i++) {
    const y = wall.process(Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE));
    if (i > SAMPLE_RATE / 2) peak = Math.max(peak, Math.abs(y));
  }
  return peak;
}

describe('運転台の遮音', () => {
  it('低い音はほぼ設計どおりの割合で透過する', () => {
    expect(transmission(30)).toBeCloseTo(CAR_BODY_LOSS, 2);
  });

  it('高い音ほどよく遮られる（質量則で 1 オクターブあたり 6dB）', () => {
    // 遮断周波数より十分上では、周波数が 2 倍になるごとに振幅が半分になる
    const low = transmission(CAR_BODY_CORNER * 4);
    const high = transmission(CAR_BODY_CORNER * 8);
    expect(high / low).toBeCloseTo(0.5, 1);
    // 遮断周波数では -3dB
    expect(transmission(CAR_BODY_CORNER) / CAR_BODY_LOSS).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it('外の音は小さくなるだけでなくこもる', () => {
    // 同じ大きさで入れた高い音と低い音では、出てくる比が変わる（音色が変わる）
    expect(transmission(2000) / transmission(100)).toBeLessThan(0.2);
  });
});

describe('踏切の警報音の聞こえ方', () => {
  /** 90km/h の転動音（車内で聞こえる走行音の物差し） */
  function rollingReference(): number {
    const voice = new RollingVoice(SAMPLE_RATE);
    voice.setParams({ speed: 25, corrugation: 0.2, level: 1 });
    const out = new Float32Array(SAMPLE_RATE);
    voice.render(out);
    return aWeightedRms(out, SAMPLE_RATE);
  }

  function crossing(distance: number): number {
    const voice = new CrossingVoice(SAMPLE_RATE);
    voice.setParams({
      ...SILENT_CROSSING,
      ringing: true,
      bell: 'electronic',
      distance,
      lateral: 3.5,
      postSpacing: 10,
      speed: 25,
      level: 1,
    });
    const out = new Float32Array(SAMPLE_RATE * 2);
    voice.render(out);
    return aWeightedRms(out, SAMPLE_RATE);
  }

  it('窓を閉めた運転台では走行音より小さく聞こえる', () => {
    // 屋外では走行音よりよほど大きい音だが、車体を透過して届くぶんは小さい。
    // 真横を過ぎる瞬間でも走行音より 1 割ほど下（約 -10dB）になる。
    const reference = rollingReference();
    expect(crossing(0)).toBeLessThan(reference * 0.5);
    expect(crossing(0)).toBeGreaterThan(reference * 0.15);
  });

  it('100m 手前ではまだほとんど聞こえない', () => {
    // 警報は 600m 以上手前から鳴っているが、運転台で気付くのは近づいてからになる
    expect(crossing(100)).toBeLessThan(crossing(0) * 0.2);
    expect(crossing(400)).toBeLessThan(crossing(0) * 0.05);
  });

  it('鳴っていなければ何も出ない', () => {
    const voice = new CrossingVoice(SAMPLE_RATE);
    voice.setParams({ ...SILENT_CROSSING, ringing: false, distance: 0, level: 1 });
    const out = new Float32Array(SAMPLE_RATE);
    voice.render(out);
    expect(rms(out.subarray(SAMPLE_RATE / 2) as unknown as Float32Array)).toBeLessThan(1e-6);
  });
});
