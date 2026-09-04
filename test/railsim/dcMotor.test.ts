import { describe, expect, it } from 'vitest';
import {
  backEmf,
  currentRipple,
  fieldRatioForCurrent,
  fluxRatio,
  motorTorque,
  selfExcitationThreshold,
  selfExcitedCurrent,
  stepArmatureCurrent,
  voltageForCurrent,
} from '../../src/railsim/core/index.ts';
import { TEST_DC_MOTOR as M } from './fixtures.ts';

describe('直流直巻電動機の磁化曲線', () => {
  it('電流とともに単調に増え、飽和して 1 に漸近する', () => {
    expect(fluxRatio(M, 0)).toBe(0);
    let previous = 0;
    for (const i of [50, 100, 200, 400, 800, 2000, 10_000]) {
      const phi = fluxRatio(M, i);
      expect(phi).toBeGreaterThan(previous);
      expect(phi).toBeLessThan(1);
      previous = phi;
    }
    expect(fluxRatio(M, 1e6)).toBeCloseTo(1, 3);
    // 飽和電流ちょうどで半分になるのが φ = I/(I+I_飽和) の定義
    expect(fluxRatio(M, M.saturationCurrent)).toBeCloseTo(0.5, 12);
  });

  it('電流の向きに依らない（直巻機は界磁も一緒に反転するため）', () => {
    expect(fluxRatio(M, -300)).toBeCloseTo(fluxRatio(M, 300), 12);
  });
});

describe('直流直巻電動機のトルク', () => {
  it('小電流では電流の 2 乗、大電流では電流に比例する', () => {
    // 飽和電流よりずっと小さい領域: 電流を 2 倍にするとトルクは約 4 倍
    const low = motorTorque(M, 10, 1);
    const low2 = motorTorque(M, 20, 1);
    expect(low2 / low).toBeGreaterThan(3.8);
    expect(low2 / low).toBeLessThan(4.0);

    // 飽和したあと: 電流を 2 倍にするとトルクは約 2 倍。
    // まだ完全には飽和し切っていないので、2 倍を上から近づく。
    const high = motorTorque(M, 4000, 1);
    const high2 = motorTorque(M, 8000, 1);
    expect(high2 / high).toBeGreaterThan(2.0);
    expect(high2 / high).toBeLessThan(2.1);
    // さらに大きな電流ではより 2 に近づく
    expect(motorTorque(M, 80_000, 1) / motorTorque(M, 40_000, 1)).toBeLessThan(2.01);
  });

  it('界磁率に比例する', () => {
    expect(motorTorque(M, 400, 0.5)).toBeCloseTo(motorTorque(M, 400, 1) * 0.5, 9);
  });

  it('銘板の定格点を再現する（375V・350A・1630rpm → 約 120kW）', () => {
    const omega = (1630 * 2 * Math.PI) / 60;
    const torque = motorTorque(M, 350, 1);
    const emf = backEmf(M, 350, 1, omega);
    expect(emf).toBeCloseTo(375 - 350 * M.armatureResistance, 1);
    expect((torque * omega) / 1000).toBeGreaterThan(115);
    expect((torque * omega) / 1000).toBeLessThan(122);
  });

  it('電力が保存する（E·I = T·ω が厳密に成り立つ）', () => {
    for (const current of [50, 200, 480, 1200]) {
      for (const omega of [10, 100, 300]) {
        for (const field of [1, 0.6, 0.45]) {
          const electrical = backEmf(M, current, field, omega) * current;
          const mechanical = motorTorque(M, current, field) * omega;
          expect(electrical).toBeCloseTo(mechanical, 9);
        }
      }
    }
  });
});

describe('電機子回路の時間発展', () => {
  const circuit = (over: Partial<Parameters<typeof stepArmatureCurrent>[0]> = {}) => ({
    spec: M,
    current: 0,
    appliedVoltage: 1500,
    motorsInSeries: 4,
    externalResistance: 2.0,
    fieldRatio: 1,
    motorOmega: 0,
    dt: 0.01,
    ...over,
  });

  it('定常解 (V − m·E)/R_合計 へ収束する', () => {
    const c = circuit({ motorOmega: 50 });
    let current = 0;
    for (let i = 0; i < 2000; i++) current = stepArmatureCurrent({ ...c, current });
    const emf = backEmf(M, current, 1, 50);
    const expected =
      (c.appliedVoltage - c.motorsInSeries * emf) /
      (c.motorsInSeries * M.armatureResistance + c.externalResistance);
    expect(current).toBeCloseTo(expected, 6);
  });

  it('時定数 τ = L_合計 / R_合計 で立ち上がる（1τ でおよそ 63%）', () => {
    const c = circuit();
    const tau =
      (c.motorsInSeries * M.armatureInductance) /
      (c.motorsInSeries * M.armatureResistance + c.externalResistance);
    const steady =
      c.appliedVoltage / (c.motorsInSeries * M.armatureResistance + c.externalResistance);

    let current = 0;
    const dt = tau / 100;
    for (let i = 0; i < 100; i++) current = stepArmatureCurrent({ ...c, current, dt });
    expect(current / steady).toBeCloseTo(1 - Math.exp(-1), 3);
  });

  it('刻みが時定数より大きくても発散しない（厳密解を使っているため）', () => {
    const c = circuit({ dt: 1.0 });
    let current = 0;
    for (let i = 0; i < 50; i++) {
      current = stepArmatureCurrent({ ...c, current, dt: 1.0 });
      expect(Number.isFinite(current)).toBe(true);
      expect(current).toBeGreaterThanOrEqual(0);
    }
    const steady =
      c.appliedVoltage / (c.motorsInSeries * M.armatureResistance + c.externalResistance);
    expect(current).toBeCloseTo(steady, 6);
  });

  it('逆流しない（主回路のダイオードに相当）', () => {
    // 逆起電力が印加電圧を上回る状況でも 0 で止まる
    const c = circuit({ motorOmega: 400, appliedVoltage: 100, current: 200 });
    const next = stepArmatureCurrent(c);
    expect(next).toBeGreaterThanOrEqual(0);
  });

  it('抵抗が短絡されると定常電流が跳ね上がる（進段の鋸歯の正体）', () => {
    const base = circuit({ motorOmega: 60, externalResistance: 2.0 });
    let current = 0;
    for (let i = 0; i < 2000; i++) current = stepArmatureCurrent({ ...base, current });
    let advanced = current;
    const next = { ...base, externalResistance: 1.0 };
    for (let i = 0; i < 2000; i++) advanced = stepArmatureCurrent({ ...next, current: advanced });
    expect(advanced).toBeGreaterThan(current);
  });
});

describe('発電ブレーキの自励', () => {
  it('閾値速度より下では電流が流れない', () => {
    const threshold = selfExcitationThreshold(M, 1, 4, 6.2);
    expect(selfExcitedCurrent(M, 1, threshold * 0.99, 4, 6.2)).toBe(0);
    expect(selfExcitedCurrent(M, 1, threshold * 1.01, 4, 6.2)).toBeGreaterThan(0);
  });

  it('閾値より上では角速度に比例して立ち上がる', () => {
    const a = selfExcitedCurrent(M, 1, 200, 4, 6.2);
    const b = selfExcitedCurrent(M, 1, 300, 4, 6.2);
    const c = selfExcitedCurrent(M, 1, 400, 4, 6.2);
    expect(b - a).toBeCloseTo(c - b, 6);
  });

  it('つり合いの式 I·R = m·kΦ·φ(I)·ω を満たす', () => {
    const omega = 300;
    const resistance = 6.2;
    const motors = 4;
    const current = selfExcitedCurrent(M, 1, omega, motors, resistance);
    const total = motors * M.armatureResistance + resistance;
    expect(current * total).toBeCloseTo(motors * backEmf(M, current, 1, omega), 6);
  });

  it('制動抵抗を大きくすると閾値速度が上がる', () => {
    expect(selfExcitationThreshold(M, 1, 4, 10)).toBeGreaterThan(
      selfExcitationThreshold(M, 1, 4, 6.2),
    );
  });
});

describe('チョッパ制御に使う逆算', () => {
  it('voltageForCurrent は目標電流を流す電圧を返す', () => {
    const v = voltageForCurrent(M, 480, 1, 120, 4);
    let current = 0;
    for (let i = 0; i < 2000; i++) {
      current = stepArmatureCurrent({
        spec: M,
        current,
        appliedVoltage: v,
        motorsInSeries: 4,
        externalResistance: 0,
        fieldRatio: 1,
        motorOmega: 120,
        dt: 0.01,
      });
    }
    expect(current).toBeCloseTo(480, 3);
  });

  it('fieldRatioForCurrent は電圧が飽和したあとの界磁率を返す', () => {
    const omega = 300;
    const field = fieldRatioForCurrent(M, 480, 1455, omega, 4);
    expect(field).toBeGreaterThan(0);
    expect(field).toBeLessThan(1);
    // その界磁率なら、与えた電圧でちょうど目標電流が流れる
    expect(voltageForCurrent(M, 480, field, omega, 4)).toBeCloseTo(1455, 6);
  });
});

describe('電機子電流のリップル（チョッパ音の素）', () => {
  it('通流率 0.5 で最大になる', () => {
    const at = (duty: number) => currentRipple(M, 1500, duty, 400, 4);
    expect(at(0.5)).toBeGreaterThan(at(0.3));
    expect(at(0.5)).toBeGreaterThan(at(0.7));
    expect(at(0.3)).toBeCloseTo(at(0.7), 9);
  });

  it('全通流・全遮断で 0 になる（チョッパ音が消える）', () => {
    expect(currentRipple(M, 1500, 1, 400, 4)).toBeCloseTo(0, 12);
    expect(currentRipple(M, 1500, 0, 400, 4)).toBeCloseTo(0, 12);
  });

  it('チョッパ周波数に反比例する', () => {
    expect(currentRipple(M, 1500, 0.5, 800, 4)).toBeCloseTo(
      currentRipple(M, 1500, 0.5, 400, 4) / 2,
      9,
    );
  });
});
