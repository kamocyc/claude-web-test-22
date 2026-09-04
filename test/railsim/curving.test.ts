import { describe, expect, it } from 'vitest';
import {
  SQUEAL_RAIL_FACTOR,
  curveSquealDrive,
  curvingAngleOfAttack,
  lateralChordAngle,
  squealOnsetRadius,
  type AdhesionSpec,
} from '../../src/railsim/core/index.ts';
import { TEST_ADHESION } from './fixtures.ts';

/** 通勤形の固定軸距 [m] */
const WHEELBASE = 2.1;
const adhesion: AdhesionSpec = TEST_ADHESION;

/** 半径 R [m] の曲線を走る台車の駆動の強さ */
const atRadius = (radius: number, speed = 15, rail: 'dry' | 'wet' = 'dry'): number =>
  curveSquealDrive(adhesion, curvingAngleOfAttack(1 / radius, WHEELBASE), speed, rail);

describe('曲線でのアタック角', () => {
  it('固定軸距の半分を半径で割った値になる', () => {
    expect(curvingAngleOfAttack(1 / 400, WHEELBASE)).toBeCloseTo(1.05 / 400, 10);
    expect(curvingAngleOfAttack(1 / 145, WHEELBASE)).toBeCloseTo(1.05 / 145, 10);
  });

  it('左右どちらの曲線でも同じ大きさになる', () => {
    expect(curvingAngleOfAttack(-1 / 400, WHEELBASE)).toBeCloseTo(
      curvingAngleOfAttack(1 / 400, WHEELBASE),
      12,
    );
  });

  it('直線では 0', () => {
    expect(curvingAngleOfAttack(0, WHEELBASE)).toBe(0);
  });

  it('軸距が短い台車ほどアタック角が小さい（半径方向へ向きやすい）', () => {
    expect(curvingAngleOfAttack(1 / 300, 1.8)).toBeLessThan(curvingAngleOfAttack(1 / 300, 2.5));
  });
});

describe('通り狂いによるアタック角', () => {
  it('前後の輪軸を結ぶ弦の傾きになる', () => {
    // 一定の勾配で横へ振れていれば、弦の傾きはその勾配そのもの
    const ramp = (s: number): number => 0.004 * s;
    expect(lateralChordAngle(ramp, 10, WHEELBASE)).toBeCloseTo(0.004, 10);
  });

  it('横へ動いていなければ 0', () => {
    expect(lateralChordAngle(() => 0.003, 100, WHEELBASE)).toBe(0);
  });

  it('固定軸距より短い波長の狂いは弦で均されて効かない', () => {
    // 同じ振幅（2mm）でも、波長が軸距より短ければ台車は追えない。
    // 点の微分で取ると短波長ほど急勾配に見えてしまうので、そこが逆転する。
    const wave = (length: number) => (s: number) => 0.002 * Math.sin((2 * Math.PI * s) / length);
    const long = lateralChordAngle(wave(20), 0, WHEELBASE);
    const short = lateralChordAngle(wave(WHEELBASE), 0, WHEELBASE);
    expect(short).toBeLessThan(long / 100);
  });

  it('分岐器のトングレールの遊間はちょうど軸距の長さで効く', () => {
    // 4mm を 1.4m で振る（`TurnoutTrack` の POINTS_KICK / POINTS_HALF_WIDTH）
    const kick = (s: number): number => Math.max(0, Math.min(0.004, (0.004 * s) / 1.4));
    const angle = lateralChordAngle(kick, 0.7, WHEELBASE);
    // 4mm が軸距 2.1m のあいだにまるごと現れるので 1.9mrad
    expect(angle).toBeCloseTo(0.004 / WHEELBASE, 6);
    // 曲線だけでは足りない #12 のリード（R350）でも、これが乗れば閾値を越える
    expect(angle + curvingAngleOfAttack(1 / 350, WHEELBASE)).toBeGreaterThan(
      adhesion.lateralCreepSaturation,
    );
  });
});

describe('軋み音の駆動', () => {
  it('緩い曲線では鳴らない（横クリープが飽和に届かない）', () => {
    // 試験線の本線は R600 と R400。実車でもこの半径では鳴かない。
    expect(atRadius(600)).toBe(0);
    expect(atRadius(400)).toBe(0);
  });

  it('急曲線では鳴る', () => {
    // #8 分岐器のリード曲線（R145）くらいになると確実に鳴く
    expect(atRadius(145)).toBe(1);
    expect(atRadius(280)).toBeGreaterThan(0);
  });

  it('出はじめる半径が諸元から決まり、そこが境目になっている', () => {
    const onset = squealOnsetRadius(adhesion, WHEELBASE);
    // 固定軸距 2.1m・飽和 3mrad・滑走比 0.6 なら R300 前後
    expect(onset).toBeGreaterThan(280);
    expect(onset).toBeLessThan(330);
    expect(atRadius(onset * 1.05)).toBe(0);
    expect(atRadius(onset * 0.95)).toBeGreaterThan(0);
  });

  it('境目を越えると急に立ち上がる（自励振動は入るか入らないかである）', () => {
    const onset = squealOnsetRadius(adhesion, WHEELBASE);
    expect(atRadius(onset * 0.95)).toBeLessThan(atRadius(onset * 0.9));
    // 少し入っただけで限界サイクルに達する
    expect(atRadius(onset * 0.8)).toBe(1);
  });

  it('濡れたレールではほとんど鳴らない', () => {
    const dry = atRadius(145, 15, 'dry');
    const wet = atRadius(145, 15, 'wet');
    expect(wet).toBeGreaterThan(0);
    expect(wet).toBeCloseTo(dry * SQUEAL_RAIL_FACTOR.wet, 6);
    expect(wet).toBeLessThan(dry * 0.2);
  });

  it('止まっていれば鳴らない（転がらなければ固着と滑りも起きない）', () => {
    expect(atRadius(145, 0)).toBe(0);
    expect(atRadius(145, 0.5)).toBeLessThan(atRadius(145, 15));
    // 歩く程度の速さで立ち上がりきる
    expect(atRadius(145, 2)).toBeCloseTo(atRadius(145, 20), 10);
  });

  it('速度を上げても強さは変わらない（決めているのは半径と車輪だけ）', () => {
    expect(atRadius(160, 5)).toBeCloseTo(atRadius(160, 25), 10);
  });

  it('すべりきってしまえば負勾配が消えるので、また静かになる', () => {
    const saturation = adhesion.lateralCreepSaturation;
    // クリープ曲線の負勾配は x = √3 付近で最大になり、その先はまた 0 へ戻る
    expect(curveSquealDrive(adhesion, saturation * Math.sqrt(3), 15, 'dry')).toBe(1);
    expect(curveSquealDrive(adhesion, saturation * 20, 15, 'dry')).toBeLessThan(0.2);
  });
});
