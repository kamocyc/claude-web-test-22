import { describe, expect, it } from 'vitest';
import { Biquad, RailJointVoice, type JointImpactKind } from '../../src/railsim/audio/index.ts';
import { RAIL_JOINT_STRENGTH } from '../../src/railsim/core/index.ts';
import { rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;

/** 1 打だけ鳴らして 0.5 秒ぶん返す */
function strike(kind: JointImpactKind, strength = 1, delay = 0): Float32Array {
  const voice = new RailJointVoice(SAMPLE_RATE);
  voice.trigger({ delay, strength, kind });
  const out = new Float32Array(SAMPLE_RATE / 2);
  voice.render(out);
  return out;
}

/**
 * 帯域ごとの実効値。
 *
 * 打撃音は数ミリ秒で減衰するので、窓を掛けた周波数解析（`bandPower`）では
 * 減衰の速い成分ほど窓に削られてしまう。時間軸で帯域通過してから実効値を測れば、
 * 短い成分も長い成分も同じ土俵で比べられる。
 */
function bandRms(x: Float32Array, frequency: number): number {
  const filter = new Biquad().bandPass(SAMPLE_RATE, frequency, 2);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    const y = filter.process(x[i]!);
    sum += y * y;
  }
  return Math.sqrt(sum / x.length);
}

/** 高域（車輪踏面とレール端の当たり）と低域（ばね上・ばね下）の比 */
function brightness(x: Float32Array): number {
  return bandRms(x, 1500) / bandRms(x, 100);
}

describe('レール継目の衝撃音', () => {
  it('種類を指定しなければ定尺の突合せ継目になる', () => {
    const voice = new RailJointVoice(SAMPLE_RATE);
    voice.trigger({ delay: 0, strength: 1 });
    const out = new Float32Array(SAMPLE_RATE / 2);
    voice.render(out);
    expect(rms(out)).toBeCloseTo(rms(strike('standard')), 12);
  });

  it('突合せ継目がいちばん大きい（段差をそのまま踏むので）', () => {
    // 路線データが与える強さ（`RAIL_JOINT_STRENGTH`）まで含めた、実際に鳴る大きさ
    const level = (kind: JointImpactKind, strength: number): number => rms(strike(kind, strength));
    const standard = level('standard', RAIL_JOINT_STRENGTH.standard);
    expect(level('expansion', RAIL_JOINT_STRENGTH.expansion)).toBeLessThan(standard * 0.6);
    expect(level('insulated', RAIL_JOINT_STRENGTH.insulated)).toBeLessThan(standard * 0.4);
    expect(level('insulated', RAIL_JOINT_STRENGTH.insulated)).toBeGreaterThan(0);
  });

  it('絶縁継目は低域が出ない（ばね下が落ちないので「ガタン」にならない）', () => {
    // 段差が無く、端面どうしが硬く当たるだけなので、高いところに音が寄る
    expect(brightness(strike('insulated'))).toBeGreaterThan(brightness(strike('standard')) * 2);
    expect(bandRms(strike('insulated'), 100)).toBeLessThan(bandRms(strike('standard'), 100) * 0.4);
  });

  it('伸縮継目は擦れる音になる（踏むのではなく斜めに乗り移るので）', () => {
    // 立ち上がりの衝撃が小さく、代わりに接触面を擦る高い成分が残る
    expect(brightness(strike('expansion'))).toBeGreaterThan(brightness(strike('standard')) * 2);
    expect(bandRms(strike('expansion'), 100)).toBeLessThan(bandRms(strike('standard'), 100) * 0.6);
  });

  it('踏切板の目地は鈍い（弾性体が高域を吸う）', () => {
    expect(brightness(strike('panel'))).toBeLessThan(brightness(strike('standard')) * 0.6);
  });

  it('遅らせた予約はその位置から鳴る（サンプル精度）', () => {
    const delayed = strike('standard', 1, 1000);
    expect(rms(delayed.subarray(0, 999) as unknown as Float32Array)).toBe(0);
    expect(rms(delayed.subarray(1000, 2000) as unknown as Float32Array)).toBeGreaterThan(0);
  });

  it('強さに比例する', () => {
    expect(rms(strike('standard', 0.5))).toBeCloseTo(rms(strike('standard')) * 0.5, 3);
  });
});
