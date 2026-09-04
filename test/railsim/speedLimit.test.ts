import { describe, expect, it } from 'vitest';
import { StepTable, kmhToMps, mpsToKmh, occupiedSpeedLimit } from '../../src/railsim/core/index.ts';

/**
 * 試験線の R400（4200〜5100m で 80km/h）を模した制限。
 * 線路最高は 110km/h。
 */
const limits = new StepTable<number>(
  [
    { s: 0, value: kmhToMps(110) },
    { s: 4200, value: kmhToMps(80) },
    { s: 5100, value: kmhToMps(110) },
  ],
  kmhToMps(110),
);

/** 先頭端 `front` にいる長さ `length` の列車にかかっている制限 [km/h] */
const at = (front: number, length = 80): number =>
  mpsToKmh(occupiedSpeedLimit(limits, { front, rear: front - length }));

describe('在線範囲で引く制限速度', () => {
  it('制限区間の手前では線路最高速度', () => {
    expect(at(4000)).toBeCloseTo(110, 6);
  });

  it('先頭が入った時点で効きはじめる', () => {
    // 最後部はまだ 4120m（制限の外）だが、先頭が入っているので制限がかかる
    expect(at(4201)).toBeCloseTo(80, 6);
  });

  it('先頭が抜けても最後部が残っていれば解けない', () => {
    expect(at(5099)).toBeCloseTo(80, 6);
    expect(at(5101)).toBeCloseTo(80, 6); // 最後部 5021m — まだ曲線の中
    expect(at(5179)).toBeCloseTo(80, 6); // 最後部 5099m — あと 1m
  });

  it('最後部が抜けた時点で解ける', () => {
    expect(at(5181)).toBeCloseTo(110, 6);
  });

  it('編成が長いほど制限を引きずる距離が伸びる', () => {
    // 10 両編成（200m）なら、抜けてから 200m のあいだ制限が続く
    expect(at(5250, 200)).toBeCloseTo(80, 6);
    expect(at(5301, 200)).toBeCloseTo(110, 6);
  });

  it('編成長が 0 なら先頭端で引くのと同じになる', () => {
    expect(at(5101, 0)).toBeCloseTo(110, 6);
  });

  it('編成より短い制限が編成の中に収まっていても拾える', () => {
    // 40m だけの一時制限 45km/h。80m 編成はこれをまたいで在線する。
    const temporary = new StepTable<number>(
      [
        { s: 0, value: kmhToMps(110) },
        { s: 1000, value: kmhToMps(45) },
        { s: 1040, value: kmhToMps(110) },
      ],
      kmhToMps(110),
    );
    const span = (front: number): number =>
      mpsToKmh(occupiedSpeedLimit(temporary, { front, rear: front - 80 }));
    // 先頭 1060m・最後部 980m。制限区間は完全に編成の内側にある。
    expect(span(1060)).toBeCloseTo(45, 6);
    expect(span(1121)).toBeCloseTo(110, 6);
  });

  it('複数の制限に跨がっていれば最も低いものを採る', () => {
    const two = new StepTable<number>(
      [
        { s: 0, value: kmhToMps(110) },
        { s: 1000, value: kmhToMps(75) },
        { s: 1050, value: kmhToMps(45) },
      ],
      kmhToMps(110),
    );
    expect(mpsToKmh(occupiedSpeedLimit(two, { front: 1060, rear: 980 }))).toBeCloseTo(45, 6);
  });

  it('起点付近で最後部が負の距離程にいても破綻しない', () => {
    expect(at(40)).toBeCloseTo(110, 6);
  });
});
