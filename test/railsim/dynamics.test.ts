import { describe, expect, it } from 'vitest';
import {
  GRAVITY,
  TrainDynamics,
  buildAlignment,
  davisFromKgfPerTon,
  kgfPerTonToNPerKg,
  kmhToMps,
  slopeToSin,
  specificRunningResistance,
  type DynamicsEnvironment,
} from '../../src/railsim/core/index.ts';
import { NO_RESISTANCE, NO_TUNNEL, flatTrack, gradeTrack, testConsist } from './fixtures.ts';

const DT = 0.001;

const env = (rail: 'dry' | 'wet' = 'dry'): DynamicsEnvironment => ({
  adhesion: { rail, sanding: false },
  ...NO_TUNNEL,
});

function run(dyn: TrainDynamics, seconds: number, e = env()): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) dyn.step(DT, e);
}

/** 全動軸に同じ駆動トルクを与える */
function setDriveTorque(dyn: TrainDynamics, torque: number): void {
  for (const veh of dyn.vehicles) {
    for (const ax of veh.axles) {
      ax.driveTorque = ax.driven ? torque : 0;
    }
  }
}

describe('惰行（力が働かない場合）', () => {
  it('平坦・抵抗ゼロでは速度が変わらない', () => {
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
      initialSpeed: kmhToMps(60),
      initialFrontPosition: 1000,
    });
    run(dyn, 30);
    expect(dyn.speed).toBeCloseTo(kmhToMps(60), 6);
    expect(dyn.frontPosition).toBeCloseTo(1000 + kmhToMps(60) * 30, 3);
  });

  it('停止中は動き出さない', () => {
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
      initialSpeed: 0,
      initialFrontPosition: 1000,
    });
    run(dyn, 10);
    expect(dyn.speed).toBeCloseTo(0, 9);
    expect(dyn.frontPosition).toBeCloseTo(1000, 6);
  });
});

describe('勾配', () => {
  it('抵抗ゼロの下り勾配で a = g sinθ になる', () => {
    const permil = 33;
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), gradeTrack(-permil), {
      initialSpeed: kmhToMps(30),
      initialFrontPosition: 1000,
    });
    run(dyn, 10);
    const expected = GRAVITY * slopeToSin(permil / 1000);
    // 回転部慣性があるため、等価質量ぶんだけ加速度が下がる
    const gamma = 0.09;
    expect(dyn.acceleration).toBeCloseTo(expected / (1 + gamma), 4);
  });

  it('上り勾配では減速する', () => {
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), gradeTrack(25), {
      initialSpeed: kmhToMps(60),
      initialFrontPosition: 1000,
    });
    run(dyn, 10);
    expect(dyn.speed).toBeLessThan(kmhToMps(60));
    expect(dyn.acceleration).toBeLessThan(0);
  });

  it('勾配変化点をまたぐと各車が異なる勾配を受け、連結器に力が生じる', () => {
    const alignment = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 4000 }],
      vertical: [
        { length: 1000, gradePermil: 0 },
        { length: 3000, gradePermil: -33, verticalCurveLength: 100 },
      ],
      sampleStep: 5,
    });
    const dyn = new TrainDynamics(testConsist({ cars: 8 }), alignment, {
      initialSpeed: kmhToMps(60),
      initialFrontPosition: 900,
    });
    let maxCoupler = 0;
    let sawGradeSpread = false;
    for (let i = 0; i < 20_000; i++) {
      dyn.step(DT, env());
      maxCoupler = Math.max(maxCoupler, dyn.maxCouplerForce);
      const grades = dyn.vehicles.map((v) => v.grade);
      if (Math.max(...grades) - Math.min(...grades) > 0.01) sawGradeSpread = true;
    }
    expect(sawGradeSpread).toBe(true);
    expect(maxCoupler).toBeGreaterThan(1000);
  });
});

describe('停止保持（静止摩擦）', () => {
  /** 全ての基礎ブレーキ軸に同じブレーキトルクを与える */
  const setBrakeTorque = (dyn: TrainDynamics, torque: number): void => {
    for (const veh of dyn.vehicles) {
      for (const ax of veh.axles) ax.brakeTorque = ax.braked ? torque : 0;
    }
  };

  const onGrade = (permil: number, speed = 0) =>
    new TrainDynamics(testConsist({ cars: 4 }), gradeTrack(permil), {
      initialSpeed: speed,
      initialFrontPosition: 1000,
    });

  it('ブレーキを掛けていれば勾配上で停車を保持する', () => {
    for (const permil of [-10, -25, -35]) {
      const dyn = onGrade(permil);
      // 非常ブレーキ相当（1 軸あたり 5kN·m ≒ 粘着限界の 1/3）
      setBrakeTorque(dyn, 5000);
      const start = dyn.frontPosition;
      run(dyn, 120);
      expect(dyn.speed).toBe(0);
      expect(dyn.frontPosition - start).toBe(0);
    }
  });

  it('ブレーキを緩解すれば勾配を転動し始める', () => {
    const dyn = onGrade(-25);
    setBrakeTorque(dyn, 5000);
    run(dyn, 5);
    expect(dyn.speed).toBe(0);
    setBrakeTorque(dyn, 0);
    run(dyn, 5);
    // 車輪が転がるので保持できず、下り勾配を加速していく
    expect(dyn.speed).toBeGreaterThan(0.5);
  });

  it('ブレーキ力が足りなければ保持できずに動き出す', () => {
    const dyn = onGrade(-35);
    // 35‰ を保持するには 1 軸あたり 3.6kN·m 要る
    setBrakeTorque(dyn, 500);
    run(dyn, 5);
    expect(dyn.speed).toBeGreaterThan(0.5);
  });

  it('粘着が足りなければブレーキが強くても滑り出す', () => {
    const slippery = testConsist({ cars: 4, adhesion: { mu0: 0.02 } });
    const dyn = new TrainDynamics(slippery, gradeTrack(-35), {
      initialSpeed: 0,
      initialFrontPosition: 1000,
    });
    setBrakeTorque(dyn, 20_000);
    run(dyn, 10);
    expect(dyn.speed).toBeGreaterThan(0.5);
  });

  it('上り勾配で停車中に力行すれば発進できる', () => {
    const dyn = onGrade(25);
    setDriveTorque(dyn, 6000);
    run(dyn, 5);
    expect(dyn.speed).toBeGreaterThan(0.5);
  });

  it('剛体モードでも勾配上で停車を保持する', () => {
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), gradeTrack(-25), {
      initialSpeed: 0,
      initialFrontPosition: 1000,
      rigidConsist: true,
    });
    setBrakeTorque(dyn, 5000);
    const start = dyn.frontPosition;
    run(dyn, 60);
    expect(dyn.speed).toBe(0);
    expect(dyn.frontPosition - start).toBe(0);
  });
});

describe('走行抵抗', () => {
  it('惰行減速が抵抗式から予測される値と一致する', () => {
    const coef = davisFromKgfPerTon({ a: 1.65, b: 0.0247, c: 0.00078 });
    const consist = testConsist({ cars: 1, runningResistance: coef, rotatingMassFactor: 0 });
    const dyn = new TrainDynamics(consist, flatTrack(), {
      initialSpeed: kmhToMps(100),
      initialFrontPosition: 1000,
    });
    // 独立に 4 次ルンゲ・クッタで積分した解と突き合わせる
    const f = (v: number) => -specificRunningResistance(coef, v);
    let v = kmhToMps(100);
    const h = DT;
    for (let i = 0; i < 60_000; i++) {
      const k1 = f(v);
      const k2 = f(v + (h / 2) * k1);
      const k3 = f(v + (h / 2) * k2);
      const k4 = f(v + h * k3);
      v += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    }
    run(dyn, 60);
    expect(dyn.speed).toBeCloseTo(v, 4);
  });

  it('トンネル内では空気抵抗が増えて減速が強まる', () => {
    const coef = davisFromKgfPerTon({ a: 1.65, b: 0.0247, c: 0.00078 });
    const consist = testConsist({ cars: 4, runningResistance: coef });
    const open = new TrainDynamics(consist, flatTrack(), {
      initialSpeed: kmhToMps(120),
      initialFrontPosition: 1000,
    });
    const tunnel = new TrainDynamics(consist, flatTrack(), {
      initialSpeed: kmhToMps(120),
      initialFrontPosition: 1000,
    });
    run(open, 30);
    for (let i = 0; i < 30_000; i++) {
      tunnel.step(DT, { adhesion: { rail: 'dry', sanding: false }, isTunnel: () => true });
    }
    expect(tunnel.speed).toBeLessThan(open.speed);
  });

  it('曲線抵抗が半径に反比例する', () => {
    const make = (radius: number) =>
      buildAlignment({
        gauge: 1.067,
        horizontal: [{ length: 20_000, radius }],
        vertical: [{ length: 20_000, gradePermil: 0 }],
        sampleStep: 10,
      });
    const consist = testConsist({
      cars: 1,
      runningResistance: NO_RESISTANCE,
      rotatingMassFactor: 0,
      curveResistanceCoefficient: kgfPerTonToNPerKg(600),
    });
    const r300 = new TrainDynamics(consist, make(300), { initialSpeed: kmhToMps(50) });
    const r600 = new TrainDynamics(consist, make(600), { initialSpeed: kmhToMps(50) });
    run(r300, 5);
    run(r600, 5);
    const dec300 = kmhToMps(50) - r300.speed;
    const dec600 = kmhToMps(50) - r600.speed;
    expect(dec300 / dec600).toBeCloseTo(2, 2);
    // 絶対値: r = 600/R kgf/t → R=300 で 2 kgf/t = 0.0196 m/s^2
    expect(dec300 / 5).toBeCloseTo(kgfPerTonToNPerKg(600) / 300, 4);
  });
});

describe('等価質量（回転部慣性）', () => {
  it('一定引張力での加速度が a = F / (m (1+γ)) になる', () => {
    const gamma = 0.09;
    const consist = testConsist({ cars: 1, rotatingMassFactor: gamma });
    const dyn = new TrainDynamics(consist, flatTrack(), {
      initialSpeed: kmhToMps(20),
      initialFrontPosition: 1000,
    });
    const torque = 1500; // N*m/軸
    setDriveTorque(dyn, torque);
    run(dyn, 2);
    const r = 0.86 / 2;
    const F = (4 * torque) / r;
    const m = consist.vehicles[0]!.tareMass;
    expect(dyn.acceleration).toBeCloseTo(F / (m * (1 + gamma)), 3);
  });

  it('乗車率が上がると同じトルクでの加速度が下がる', () => {
    const consist = testConsist({ cars: 1 });
    const empty = new TrainDynamics(consist, flatTrack(), { initialSpeed: kmhToMps(20) });
    const full = new TrainDynamics(consist, flatTrack(), {
      initialSpeed: kmhToMps(20),
      loadFactor: 1,
    });
    setDriveTorque(empty, 1500);
    setDriveTorque(full, 1500);
    run(empty, 2);
    run(full, 2);
    expect(full.acceleration).toBeLessThan(empty.acceleration);
    const ratio = full.acceleration / empty.acceleration;
    const m0 = 32_000;
    const m1 = 32_000 + 9_000;
    const gamma = 0.09;
    expect(ratio).toBeCloseTo((m0 * (1 + gamma)) / (m1 + gamma * m0), 3);
  });
});

describe('剛体モードと多質点モード', () => {
  it('連結器を硬くすると多質点モードが剛体モードに漸近する', () => {
    const stiff = {
      slack: 0,
      stiffness1: 5.0e8,
      travel1: 1,
      stiffness2: 5.0e8,
      damping: 5.0e6,
    };
    const consist = testConsist({
      cars: 4,
      coupler: stiff,
      runningResistance: davisFromKgfPerTon({ a: 1.65, b: 0.0247, c: 0.00078 }),
    });
    const flex = new TrainDynamics(consist, gradeTrack(-20), {
      initialSpeed: kmhToMps(40),
      initialFrontPosition: 1000,
    });
    const rigid = new TrainDynamics(consist, gradeTrack(-20), {
      initialSpeed: kmhToMps(40),
      initialFrontPosition: 1000,
      rigidConsist: true,
    });
    setDriveTorque(flex, 800);
    setDriveTorque(rigid, 800);
    run(flex, 20);
    run(rigid, 20);
    expect(flex.speed).toBeCloseTo(rigid.speed, 2);
    expect(flex.frontPosition).toBeCloseTo(rigid.frontPosition, 0);
  });
});
