import { describe, expect, it } from 'vitest';
import {
  ChopperTractionSystem,
  ElectroPneumaticBrakeSystem,
  TrainDynamics,
  kmhToMps,
  mpsToKmh,
  type ChopperDriveState,
  type ChopperTractionSpec,
  type DynamicsEnvironment,
} from '../../src/railsim/core/index.ts';
import {
  NO_TUNNEL,
  TEST_CHOPPER_TRACTION,
  flatTrack,
  testConsist,
  type TestConsistOptions,
} from './fixtures.ts';

const DT = 0.001;
const CONTROL_DT = 0.01;

interface RigOptions extends TestConsistOptions {
  readonly initialSpeed?: number;
  readonly receptivity?: number;
  readonly loadFactor?: number;
  readonly traction?: ChopperTractionSpec | null;
}

/** 電機子チョッパ・ブレーキ・力学を結線した試験用リグ */
function rig(options: RigOptions = {}) {
  const traction = options.traction === undefined ? TEST_CHOPPER_TRACTION : options.traction;
  const consist = testConsist({ cars: options.cars ?? 2, ...options, traction });
  const dyn = new TrainDynamics(consist, flatTrack(), {
    initialSpeed: options.initialSpeed ?? 0,
    initialFrontPosition: 1000,
    loadFactor: options.loadFactor ?? 0,
  });
  const system = new ChopperTractionSystem(consist);
  const brake = new ElectroPneumaticBrakeSystem(consist, { controlPeriod: CONTROL_DT });
  const env: DynamicsEnvironment = { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL };
  const ctx = {
    dynamics: dyn,
    traction: system,
    loadFactor: options.loadFactor ?? 0,
    regenerationReceptivity: options.receptivity ?? 1,
    lineVoltage: 1500,
  };
  let sinceControl = 0;
  const run = (seconds: number, onStep?: () => void) => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      sinceControl += DT;
      if (sinceControl >= CONTROL_DT - 1e-9) {
        brake.update(sinceControl, ctx);
        system.update(sinceControl, ctx);
        sinceControl = 0;
      }
      dyn.step(DT, env);
      onStep?.();
    }
  };
  const drive = () => system.driveState as ChopperDriveState;
  return { consist, dyn, traction: system, brake, ctx, run, drive };
}

describe('通流率制御', () => {
  it('電機子電圧は通流率と架線電圧の積になる', () => {
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    // 立ち上がりの過渡ではインダクタンスが差を受け持つので、落ち着いてから測る
    r.run(2);
    r.run(6, () => {
      const s = r.drive();
      if (!s.gate) return;
      // 1 分岐に m 台直列なので、1 台の端子電圧は δ·V_線 / m
      const perMotor = (s.duty * 1500) / TEST_CHOPPER_TRACTION.motorsInSeries;
      expect(s.armatureVoltage).toBeGreaterThan(perMotor * 0.95);
      expect(s.armatureVoltage).toBeLessThan(perMotor * 1.05);
    });
  });

  it('速度が上がるにつれて通流率が単調に上がり、上限で頭打ちになる', () => {
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    const duties: number[] = [];
    r.run(20, () => {
      const s = r.drive();
      if (s.gate) duties.push(s.duty);
    });
    // 起動直後は低く、加速につれて上がる
    expect(duties[100]!).toBeLessThan(0.4);
    expect(Math.max(...duties)).toBeCloseTo(TEST_CHOPPER_TRACTION.maxDuty, 2);
    // 上限を超えない
    for (const d of duties) expect(d).toBeLessThanOrEqual(TEST_CHOPPER_TRACTION.maxDuty + 1e-9);
  });

  it('限流値制御のあいだは加速度がほぼ一定に保たれる（段が無いので滑らか）', () => {
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    // 通流率が飽和する前の範囲で測る
    r.run(2);
    const accelerations: number[] = [];
    r.run(4, () => {
      if (r.drive().duty < TEST_CHOPPER_TRACTION.maxDuty * 0.95) {
        accelerations.push(r.dyn.acceleration);
      }
    });
    expect(accelerations.length).toBeGreaterThan(1000);
    const max = Math.max(...accelerations);
    const min = Math.min(...accelerations);
    // 抵抗制御なら段のたびに 2 割以上ばらつくところが、チョッパでは 5% 以内に収まる
    expect((max - min) / max).toBeLessThan(0.05);
  });

  it('電機子電流が限流値の近くに保たれる', () => {
    const spec = TEST_CHOPPER_TRACTION;
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    r.run(2);
    r.run(8, () => {
      const s = r.drive();
      if (!s.gate) return;
      expect(s.armatureCurrent).toBeGreaterThan(spec.currentLimit * 0.9);
      expect(s.armatureCurrent).toBeLessThan(spec.currentLimit * 1.1);
    });
  });

  it('ノッチが浅いほど限流値が下がる', () => {
    const currentAt = (notch: number) => {
      const r = rig({ loadFactor: 0.5 });
      r.traction.setNotch(notch);
      r.run(3);
      return r.drive().armatureCurrent;
    };
    const low = currentAt(1);
    const high = currentAt(4);
    expect(low).toBeLessThan(high * 0.6);
  });
});

describe('弱め界磁', () => {
  it('通流率が上限に貼り付いてから初めて界磁が弱まる', () => {
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    let sawWeakening = false;
    r.run(40, () => {
      const s = r.drive();
      if (!s.gate) return;
      if (s.fieldRatio < 0.999) {
        sawWeakening = true;
        // 界磁を弱めているあいだは、必ず電圧を使い切っている
        expect(s.duty).toBeGreaterThan(TEST_CHOPPER_TRACTION.maxDuty * 0.99);
      }
    });
    expect(sawWeakening).toBe(true);
  });

  it('界磁率は下限より下がらない', () => {
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    r.run(60, () => {
      expect(r.drive().fieldRatio).toBeGreaterThanOrEqual(
        TEST_CHOPPER_TRACTION.minFieldRatio - 1e-9,
      );
    });
  });

  it('弱め界磁のおかげで全通流の速度より先まで加速できる', () => {
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    let fullDutySpeed = 0;
    r.run(60, () => {
      if (fullDutySpeed === 0 && r.drive().duty >= TEST_CHOPPER_TRACTION.maxDuty * 0.99) {
        fullDutySpeed = r.dyn.speed;
      }
    });
    expect(mpsToKmh(fullDutySpeed)).toBeGreaterThan(20);
    expect(r.dyn.speed).toBeGreaterThan(fullDutySpeed * 1.5);
  });
});

describe('回生ブレーキ', () => {
  it('架線の回生受け入れ率に比例する', () => {
    const speed = kmhToMps(60);
    const full = rig({ initialSpeed: speed, receptivity: 1 });
    const half = rig({ initialSpeed: speed, receptivity: 0.5 });
    const dead = rig({ initialSpeed: speed, receptivity: 0 });
    const a = full.traction.availableElectricBrakeForce(speed, full.ctx);
    expect(a).toBeGreaterThan(0);
    expect(half.traction.availableElectricBrakeForce(speed, half.ctx)).toBeCloseTo(a * 0.5, 6);
    expect(dead.traction.availableElectricBrakeForce(speed, dead.ctx)).toBe(0);
  });

  it('低速で絞り込まれ、失効速度以下では 0 になる', () => {
    const spec = TEST_CHOPPER_TRACTION;
    const r = rig();
    expect(r.traction.availableElectricBrakeForce(spec.regenFadeEndSpeed * 0.5, r.ctx)).toBe(0);
    const mid = r.traction.availableElectricBrakeForce(
      (spec.regenFadeStartSpeed + spec.regenFadeEndSpeed) / 2,
      r.ctx,
    );
    const high = r.traction.availableElectricBrakeForce(spec.regenFadeStartSpeed * 2, r.ctx);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(high);
  });

  it('ブレーキを込めると減速し、架線へ電力を返す', () => {
    const r = rig({ initialSpeed: kmhToMps(70) });
    r.brake.setCommand({
      notch: 5,
      emergency: false,
      holdingNotch: 0,
      backup: false,
      snowproof: false,
    });
    let sawRegeneration = false;
    // 空気ブレーキのむだ時間と込め時定数があるので、立ち上がりを含めて見る
    r.run(5, () => {
      if (r.drive().regenerating && r.traction.state.power < 0) sawRegeneration = true;
    });
    expect(sawRegeneration).toBe(true);
    expect(mpsToKmh(r.dyn.speed)).toBeLessThan(62);
  });
});

describe('惰行', () => {
  it('ノッチを切るとチョッパが止まり、引張力が消える', () => {
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    r.run(6);
    expect(r.traction.state.tractiveEffort).toBeGreaterThan(0);
    r.traction.setNotch(0);
    r.run(2);
    expect(r.drive().gate).toBe(false);
    expect(r.traction.state.tractiveEffort).toBe(0);
    expect(r.drive().duty).toBe(0);
  });
});

describe('同じ電動機での方式比較', () => {
  it('チョッパは段が無いので、加速中の引張力が単調に近く滑らか', () => {
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    r.run(2);
    let previous = r.traction.state.tractiveEffort;
    let drops = 0;
    r.run(6, () => {
      const now = r.traction.state.tractiveEffort;
      // 抵抗制御なら進段のたびに大きく跳ねる。チョッパにはその段差が無い。
      if (now < previous * 0.95) drops++;
      previous = now;
    });
    expect(drops).toBe(0);
  });
});
