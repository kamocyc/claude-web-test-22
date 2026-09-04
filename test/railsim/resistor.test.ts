import { describe, expect, it } from 'vitest';
import {
  ElectroPneumaticBrakeSystem,
  ResistorTractionSystem,
  TrainDynamics,
  kmhToMps,
  mpsToKmh,
  selfExcitationThreshold,
  type DynamicsEnvironment,
  type ResistorDriveState,
  type ResistorTractionSpec,
} from '../../src/railsim/core/index.ts';
import {
  NO_TUNNEL,
  TEST_RESISTOR_TRACTION,
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
  readonly traction?: ResistorTractionSpec | null;
}

/** 抵抗制御・ブレーキ・力学を結線した試験用リグ */
function rig(options: RigOptions = {}) {
  const traction = options.traction === undefined ? TEST_RESISTOR_TRACTION : options.traction;
  const consist = testConsist({ cars: options.cars ?? 2, ...options, traction });
  const dyn = new TrainDynamics(consist, flatTrack(), {
    initialSpeed: options.initialSpeed ?? 0,
    initialFrontPosition: 1000,
    loadFactor: options.loadFactor ?? 0,
  });
  const system = new ResistorTractionSystem(consist);
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
  const drive = () => system.driveState as ResistorDriveState;
  return { consist, dyn, traction: system, brake, ctx, run, drive };
}

describe('カム軸の進段', () => {
  it('ノッチを入れると段が 1 つずつ単調に上がる', () => {
    const r = rig();
    r.traction.setNotch(4);
    const seen: number[] = [];
    r.run(30, () => {
      const s = r.drive();
      if (s.gate && seen.at(-1) !== s.step) seen.push(s.step);
    });
    expect(seen[0]).toBe(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1]! + 1);
    expect(seen.at(-1)).toBe(TEST_RESISTOR_TRACTION.camSteps.length - 1);
  });

  it('ノッチが選んだ段で止まる', () => {
    const r = rig();
    r.traction.setNotch(1);
    r.run(30);
    expect(r.drive().step).toBe(TEST_RESISTOR_TRACTION.notchFinalStep[0]);
  });

  it('進段の間隔が最短滞留時間を下回らない', () => {
    const r = rig();
    r.traction.setNotch(4);
    let last = -1;
    let previousTime = 0;
    let time = 0;
    const gaps: number[] = [];
    r.run(30, () => {
      time += DT;
      const s = r.drive();
      if (s.gate && s.step !== last) {
        if (last >= 0) gaps.push(time - previousTime);
        previousTime = time;
        last = s.step;
      }
    });
    expect(gaps.length).toBeGreaterThan(4);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(TEST_RESISTOR_TRACTION.stepDwell - 2 * CONTROL_DT);
    }
  });

  it('段が進むのは電流が進段電流を下回ったときだけ', () => {
    const r = rig();
    r.traction.setNotch(4);
    let last = 0;
    let previousCurrent = 0;
    r.run(30, () => {
      const s = r.drive();
      // 起動の 1 段目（主接触器の投入）は電流条件を待たない
      if (s.gate && s.step > last && s.step > 1) {
        expect(previousCurrent).toBeLessThan(TEST_RESISTOR_TRACTION.stepCurrent * 1.05);
      }
      if (s.gate) {
        last = s.step;
        previousCurrent = s.armatureCurrent;
      }
    });
  });

  it('高速からの再力行では電流を待たずにカム軸が回りきる', () => {
    const spec = TEST_RESISTOR_TRACTION;
    // 70km/h で惰行しているところへノッチを入れる。カム軸は開放まで戻っているので、
    // 速度に見合った段まで 1 段ずつ駆け上がることになる。
    const r = rig({ initialSpeed: kmhToMps(70) });
    r.run(0.5);
    expect(r.drive().gate).toBe(false);

    const startSpeed = r.dyn.speed;
    r.traction.setNotch(4);

    let time = 0;
    let last = -1;
    let groupEvents = 0;
    let previousTime = 0;
    let caughtUp = -1;
    let speedAfter2s = 0;
    const gaps: number[] = [];
    r.run(10, () => {
      time += DT;
      if (speedAfter2s === 0 && time >= 2) speedAfter2s = r.dyn.speed;
      const s = r.drive();
      if (!s.gate) return;
      if (s.step !== last) {
        const regrouped = s.groupEvents > groupEvents;
        groupEvents = s.groupEvents;
        // 渡りを挟む 1 回だけは組替えの時間が乗るので、間隔の検定から外す
        if (last >= 0 && !regrouped && caughtUp < 0) gaps.push(time - previousTime);
        previousTime = time;
        last = s.step;
      }
      // 速度に見合った段へ届くと、電流がようやく進段電流の水準まで戻る。
      if (caughtUp < 0 && s.armatureCurrent >= spec.stepCurrent * 0.9) caughtUp = time;
    });

    // 追いつくまでの進段の間隔は、カム軸の回転速度そのものになっている。起動時と
    // 違って電流条件は最初から満たされている（逆起電力が大きく、全抵抗が入った
    // 1 段目でも電流が進段電流を大きく下回る）ため、電流を待つ時間が乗らない。
    expect(gaps.length).toBeGreaterThan(8);
    for (const gap of gaps) {
      expect(gap).toBeLessThan(spec.stepDwell + 3 * CONTROL_DT);
    }

    // 速度に見合った段まで駆け上がって初めて電流が進段電流に届き、加速が戻る。
    // ここから先は起動時と同じで、電流条件のほうが律速に戻る。
    expect(caughtUp).toBeGreaterThan(1);
    expect(caughtUp).toBeLessThan(6);

    // それまでは引張力がほとんど出ないので、2 秒経ってもまだ加速していない。
    // 抵抗制御車で「一度ノッチを切ると再加速が遅い」と言われるのはこれである。
    expect(mpsToKmh(speedAfter2s - startSpeed)).toBeLessThan(1);
  });

  it('ノッチを戻すと段も戻る', () => {
    const r = rig();
    r.traction.setNotch(4);
    r.run(30);
    expect(r.drive().step).toBe(TEST_RESISTOR_TRACTION.camSteps.length - 1);
    r.traction.setNotch(1);
    r.run(1);
    expect(r.drive().step).toBe(TEST_RESISTOR_TRACTION.notchFinalStep[0]);
  });
});

describe('引張力の鋸歯', () => {
  it('段ごとに電流が限流値まで跳ね上がり、進段電流まで落ちる', () => {
    // 進段表は基準乗車率での限流値・進段電流に合わせて組んであるので、
    // 応荷重の補正が 1 になる乗車率で測る（空車だと進段電流が下がり、
    // それに応じて山も低くなる — それはそれで正しい挙動）。
    const r = rig({ loadFactor: 0.5 });
    r.traction.setNotch(4);
    const spec = TEST_RESISTOR_TRACTION;
    // 段ごとの山（進段直後の跳ね上がり）と谷（次の進段の直前）を拾う
    const peaks: number[] = [];
    const troughs: number[] = [];
    let step = -1;
    let peak = 0;
    let previous = 0;
    r.run(25, () => {
      const s = r.drive();
      if (!s.gate || s.resistance <= 0) return;
      if (s.step !== step) {
        if (step >= 0) {
          peaks.push(peak);
          troughs.push(previous);
        }
        step = s.step;
        peak = 0;
      }
      peak = Math.max(peak, s.armatureCurrent);
      previous = s.armatureCurrent;
    });

    expect(peaks.length).toBeGreaterThan(6);
    // どの山も進段電流より上へ跳ね返り、限流値を大きくは超えない。
    // 山が限流値ちょうどにならないのは、カム軸に最短滞留時間があるためである。
    // 進段電流を割ってから実際に進むまでのあいだに電流がもう少し落ち、
    // そのぶん次の山も下がる。
    for (const p of peaks) {
      expect(p).toBeGreaterThan(spec.stepCurrent);
      expect(p).toBeLessThan(spec.currentLimit * 1.1);
    }
    // 平均するとおよそ限流値の 9 割。滞留時間による取りこぼしぶんだけ下にいる。
    const meanPeak = peaks.reduce((a, b) => a + b, 0) / peaks.length;
    expect(meanPeak).toBeGreaterThan(spec.currentLimit * 0.87);
    expect(meanPeak).toBeLessThan(spec.currentLimit);
    for (const t of troughs) {
      expect(t).toBeGreaterThan(spec.stepCurrent * 0.9);
      expect(t).toBeLessThan(spec.stepCurrent * 1.1);
    }
    // 山と谷がはっきり分かれている（一定値に張り付いていない）＝これが鋸歯
    expect(Math.min(...peaks) - Math.max(...troughs)).toBeGreaterThan(0);
  });

  it('直並列の組替えで一瞬引張力が落ちる', () => {
    const r = rig();
    r.traction.setNotch(4);
    let groupEvents = 0;
    let before = 0;
    let after = Number.POSITIVE_INFINITY;
    let previous = 0;
    let sinceChange = -1;
    r.run(30, () => {
      const s = r.drive();
      if (s.groupEvents > groupEvents) {
        groupEvents = s.groupEvents;
        // 組替えの直前まで出ていた引張力
        before = previous;
        sinceChange = 0;
      }
      if (sinceChange >= 0 && sinceChange < 0.2) {
        after = Math.min(after, r.traction.state.tractiveEffort);
        sinceChange += DT;
      }
      previous = r.traction.state.tractiveEffort;
    });
    expect(groupEvents).toBe(1);
    expect(before).toBeGreaterThan(0);
    // 渡りのあいだは主回路が開いているので、引張力は完全に抜ける
    expect(after).toBe(0);
  });

  it('弱め界磁の段ではトルクが落ちて回転が伸びる', () => {
    const spec = TEST_RESISTOR_TRACTION;
    const r = rig();
    r.traction.setNotch(4);
    r.run(30);
    const s = r.drive();
    expect(s.fieldRatio).toBeLessThan(1);
    expect(s.step).toBe(spec.camSteps.length - 1);
    expect(mpsToKmh(r.dyn.speed)).toBeGreaterThan(60);
  });
});

describe('抵抗制御の起動加速度', () => {
  it('限流値から手計算した値と一致する', () => {
    const spec = TEST_RESISTOR_TRACTION;
    const r = rig({ cars: 2 });
    r.traction.setNotch(4);
    // 引張力は鋸歯を描くので、限流値に対応するのは**山**の加速度である。
    let peak = 0;
    r.run(5, () => {
      peak = Math.max(peak, r.dyn.acceleration);
    });

    const flux = spec.currentLimit / (spec.currentLimit + spec.motor.saturationCurrent);
    const torque = spec.motor.fluxConstant * flux * spec.currentLimit;
    const rimForce =
      (torque * spec.motorCount * spec.gearRatio * spec.driveEfficiency) / (0.86 / 2);
    const force = rimForce * 2;
    const mass = r.consist.vehicles.reduce(
      (a, v) => a + v.tareMass + v.rotatingMassFactor * v.tareMass,
      0,
    );
    expect(peak).toBeGreaterThan((force / mass) * 0.9);
    expect(peak).toBeLessThan((force / mass) * 1.1);
  });

  it('起動抵抗で熱にしている電力は、段が進むにつれて減り全短絡で 0 になる', () => {
    const r = rig();
    r.traction.setNotch(4);
    let first = 0;
    r.run(1.0, () => {
      if (first === 0) first = r.drive().resistorPower;
    });
    expect(first).toBeGreaterThan(0);
    r.run(30);
    expect(r.drive().resistance).toBe(0);
    expect(r.drive().resistorPower).toBe(0);
  });
});

describe('発電ブレーキ', () => {
  it('架線の回生受け入れ率を変えても制動力が変わらない', () => {
    const speed = kmhToMps(70);
    const full = rig({ initialSpeed: speed, receptivity: 1 });
    const dead = rig({ initialSpeed: speed, receptivity: 0 });
    const a = full.traction.availableElectricBrakeForce(speed, full.ctx);
    const b = dead.traction.availableElectricBrakeForce(speed, dead.ctx);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeCloseTo(a, 6);
  });

  it('自励の閾値より下では 0 になり、上では速度とともに増える', () => {
    const spec = TEST_RESISTOR_TRACTION;
    const r = rig();
    const omegaToSpeed = (omega: number) => (omega / spec.gearRatio) * (0.86 / 2);
    const threshold = omegaToSpeed(
      selfExcitationThreshold(
        spec.motor,
        spec.brakeFieldRatio,
        spec.brakeMotorsInSeries,
        spec.brakeResistance,
      ),
    );
    expect(r.traction.availableElectricBrakeForce(threshold * 0.9, r.ctx)).toBe(0);
    const low = r.traction.availableElectricBrakeForce(threshold * 1.5, r.ctx);
    const high = r.traction.availableElectricBrakeForce(threshold * 2.5, r.ctx);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });

  it('発電ブレーキを持たない車両では常に 0', () => {
    const r = rig({ traction: { ...TEST_RESISTOR_TRACTION, hasDynamicBrake: false } });
    expect(r.traction.availableElectricBrakeForce(kmhToMps(80), r.ctx)).toBe(0);
  });

  it('ブレーキを込めると減速し、制動抵抗で電力を捨てる', () => {
    const r = rig({ initialSpeed: kmhToMps(80) });
    r.brake.setCommand({
      notch: 5,
      emergency: false,
      holdingNotch: 0,
      backup: false,
      snowproof: false,
    });
    let sawDynamic = false;
    r.run(3, () => {
      if (r.drive().dynamicBraking && r.drive().resistorPower > 0) sawDynamic = true;
    });
    expect(sawDynamic).toBe(true);
    expect(mpsToKmh(r.dyn.speed)).toBeLessThan(75);
    // 架線からは取らず、架線へも返さない
    expect(r.traction.state.power).toBe(0);
  });
});

describe('主回路の電気量', () => {
  it('架線電流は分岐の数だけ電機子電流が並んだもの', () => {
    const r = rig();
    r.traction.setNotch(4);
    r.run(1.0);
    const s = r.drive();
    const motors = r.consist.vehicles.reduce(
      (a, v) => a + (v.traction?.kind === 'resistor' ? v.traction.motorCount : 0),
      0,
    );
    expect(r.traction.state.motorCurrent).toBeCloseTo(
      (motors / s.motorsInSeries) * s.armatureCurrent,
      6,
    );
    // 変換器が無いので、架線電力は素直に電圧 × 電流
    expect(r.traction.state.power).toBeCloseTo(1500 * r.traction.state.motorCurrent, 6);
  });

  it('惰行では主接触器が開き、引張力が消える', () => {
    const r = rig();
    r.traction.setNotch(4);
    r.run(10);
    r.traction.setNotch(0);
    r.run(1);
    expect(r.drive().gate).toBe(false);
    expect(r.traction.state.tractiveEffort).toBe(0);
    expect(r.traction.state.motorCurrent).toBe(0);
  });
});

describe('音の元になる回転周波数', () => {
  const motor = TEST_RESISTOR_TRACTION.motor;

  it('どれも回転数 × 次数として出る', () => {
    const r = rig();
    r.traction.setNotch(4);
    r.run(12);
    const s = r.drive();
    const rps = s.motorRpm / 60;
    expect(rps).toBeGreaterThan(1);
    expect(s.slotFrequency).toBeCloseTo(rps * motor.armatureSlots, 6);
    expect(s.commutatorFrequency).toBeCloseTo(rps * motor.commutatorBars, 6);
    expect(s.ventilationFrequency).toBeCloseTo(rps * motor.fanBlades, 6);
    expect(s.gearMeshFrequency).toBeCloseTo(rps * motor.pinionTeeth, 6);
  });

  it('主電動機の音程は歯車のかみ合いの 3 倍以内に収まる', () => {
    // 実車で聞こえる成分（歯車・スロット・通風）は 1 オクターブほどの幅に集まる。
    // 音程を整流子片数（93 次 = 歯車の 6.2 倍）で決めていたころは、この関係が
    // 崩れて実車よりはっきり高く聞こえていた。整流子はその上のかすれでしかない。
    expect(motor.armatureSlots / motor.pinionTeeth).toBeLessThan(3);
    expect(motor.fanBlades / motor.pinionTeeth).toBeLessThan(3);
    expect(motor.commutatorBars / motor.pinionTeeth).toBeGreaterThan(3);
  });

  it('整流子片数は 1 スロットに入るコイル辺の数だけスロット数より多い', () => {
    const sides = motor.commutatorBars / motor.armatureSlots;
    expect(Number.isInteger(sides)).toBe(true);
    expect(sides).toBeGreaterThanOrEqual(2);
    expect(sides).toBeLessThanOrEqual(4);
  });
});
