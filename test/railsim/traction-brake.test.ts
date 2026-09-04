import { describe, expect, it } from 'vitest';
import {
  ElectroPneumaticBrakeSystem,
  TrainDynamics,
  VvvfTractionSystem,
  kmhToMps,
  motorTorqueAt,
  mpsToKmh,
  regenerationFade,
  type BrakeCommand,
  type DynamicsEnvironment,
  type RailCondition,
} from '../../src/railsim/core/index.ts';
import { NO_TUNNEL, TEST_TRACTION, flatTrack, gradeTrack, testConsist } from './fixtures.ts';

const DT = 0.001;
const CONTROL_DT = 0.01;

interface RigOptions {
  readonly cars?: number;
  readonly rail?: RailCondition;
  readonly loadFactor?: number;
  readonly initialSpeed?: number;
  readonly receptivity?: number;
  readonly gradePermil?: number;
}

/** 動力・ブレーキ・力学を結線した試験用リグ */
function rig(options: RigOptions = {}) {
  const consist = testConsist({ cars: options.cars ?? 4 });
  const alignment =
    options.gradePermil === undefined ? flatTrack() : gradeTrack(options.gradePermil);
  const dyn = new TrainDynamics(consist, alignment, {
    initialSpeed: options.initialSpeed ?? 0,
    initialFrontPosition: 1000,
    ...(options.loadFactor === undefined ? {} : { loadFactor: options.loadFactor }),
  });
  const traction = new VvvfTractionSystem(consist);
  const brake = new ElectroPneumaticBrakeSystem(consist, { controlPeriod: CONTROL_DT });
  const env: DynamicsEnvironment = {
    adhesion: { rail: options.rail ?? 'dry', sanding: false },
    ...NO_TUNNEL,
  };
  const ctx = {
    dynamics: dyn,
    traction,
    loadFactor: options.loadFactor ?? 0,
    regenerationReceptivity: options.receptivity ?? 1,
    lineVoltage: 1500,
  };
  let sinceControl = 0;
  const step = () => {
    sinceControl += DT;
    if (sinceControl >= CONTROL_DT - 1e-9) {
      brake.update(sinceControl, ctx);
      traction.update(sinceControl, ctx);
      sinceControl = 0;
    }
    dyn.step(DT, env);
  };
  const run = (seconds: number, onStep?: () => void) => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      step();
      onStep?.();
    }
  };
  return { consist, dyn, traction, brake, env, ctx, step, run };
}

const brakeCmd = (notch: number, emergency = false): BrakeCommand => ({
  notch,
  emergency,
  holdingNotch: 0,
  backup: false,
  snowproof: false,
});

describe('VVVF 電動機特性', () => {
  it('定トルク・定出力・特性の 3 領域を持つ', () => {
    const t0 = motorTorqueAt(TEST_TRACTION, kmhToMps(10), 1000);
    const t1 = motorTorqueAt(TEST_TRACTION, kmhToMps(35), 1000);
    expect(t0).toBe(1000);
    expect(t1).toBe(1000);
    // 定出力域: トルク ∝ 1/v
    const t50 = motorTorqueAt(TEST_TRACTION, kmhToMps(50), 1000);
    const t70 = motorTorqueAt(TEST_TRACTION, kmhToMps(70), 1000);
    expect(t50 * 50).toBeCloseTo(t70 * 70, 6);
    // 特性域: トルク ∝ 1/v^2
    const t100 = motorTorqueAt(TEST_TRACTION, kmhToMps(100), 1000);
    const t120 = motorTorqueAt(TEST_TRACTION, kmhToMps(120), 1000);
    expect(t100 * 100 * 100).toBeCloseTo(t120 * 120 * 120, 4);
  });

  it('回生絞り込み率が指定速度で 1 から 0 へ落ちる', () => {
    expect(regenerationFade(TEST_TRACTION, kmhToMps(30))).toBe(1);
    expect(regenerationFade(TEST_TRACTION, kmhToMps(10))).toBe(1);
    expect(regenerationFade(TEST_TRACTION, kmhToMps(6.5))).toBeCloseTo(0.5, 6);
    expect(regenerationFade(TEST_TRACTION, kmhToMps(3))).toBe(0);
    expect(regenerationFade(TEST_TRACTION, 0)).toBe(0);
  });
});

describe('力行', () => {
  it('定トルク域では加速度がほぼ一定、定出力域以降は低下する', () => {
    const r = rig({ cars: 4 });
    r.traction.setNotch(4);
    const samples: Array<{ v: number; a: number }> = [];
    r.run(60, () => {
      samples.push({ v: mpsToKmh(r.dyn.speed), a: r.dyn.acceleration });
    });
    const at = (kmh: number) => samples.find((s) => s.v >= kmh)!;
    const a10 = at(10).a;
    const a30 = at(30).a;
    const a60 = at(60).a;
    const a90 = at(90).a;
    expect(a30).toBeCloseTo(a10, 2); // 定トルク域では一定
    expect(a60).toBeLessThan(a30 * 0.95); // 定出力域で低下
    expect(a90).toBeLessThan(a60 * 0.8); // 特性域でさらに低下
    expect(a10).toBeGreaterThan(0.5);
  });

  it('ノッチを上げると引張力が増える', () => {
    const forces: number[] = [];
    for (const notch of [1, 2, 3, 4]) {
      const r = rig({ cars: 4, initialSpeed: kmhToMps(20) });
      r.traction.setNotch(notch);
      r.run(3);
      forces.push(r.traction.state.tractiveEffort);
    }
    for (let i = 1; i < forces.length; i++) {
      expect(forces[i]!).toBeGreaterThan(forces[i - 1]!);
    }
  });

  it('ノッチ投入時にトルク指令がレート制限で立ち上がる', () => {
    const r = rig({ cars: 4 });
    r.traction.setNotch(4);
    r.run(0.1);
    const early = r.traction.state.torqueCommand;
    r.run(1.0);
    const later = r.traction.state.torqueCommand;
    expect(early).toBeLessThan(0.5);
    expect(later).toBeCloseTo(1, 3);
  });

  it('乗車率が上がっても応荷重制御で加速度がほぼ保たれる', () => {
    const empty = rig({ cars: 4, loadFactor: 0 });
    const full = rig({ cars: 4, loadFactor: 1 });
    empty.traction.setNotch(4);
    full.traction.setNotch(4);
    empty.run(5);
    full.run(5);
    const ratio = full.dyn.acceleration / empty.dyn.acceleration;
    // 応荷重補正がなければ 0.8 程度まで落ちるが、補正により 0.95 以上を保つ
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThanOrEqual(1.02);
  });
});

describe('粘着・空転・再粘着制御', () => {
  it('乾燥レールでは全ノッチでも空転しない', () => {
    const r = rig({ cars: 4, rail: 'dry' });
    r.traction.setNotch(4);
    let sawSlip = false;
    r.run(20, () => {
      if (r.dyn.anySlipping) sawSlip = true;
    });
    expect(sawSlip).toBe(false);
    expect(r.traction.state.reAdhesionFactor).toBe(1);
  });

  it('降雪条件で全ノッチ起動すると空転し、再粘着制御が引張力を絞る', () => {
    const r = rig({ cars: 4, rail: 'snow' });
    r.traction.setNotch(4);
    let sawSlip = false;
    let minFactor = 1;
    r.run(20, () => {
      if (r.dyn.anySlipping) sawSlip = true;
      minFactor = Math.min(minFactor, r.traction.state.reAdhesionFactor);
    });
    expect(sawSlip).toBe(true);
    expect(minFactor).toBeLessThan(1);
    // 絞り込んでも列車は前進を続ける
    expect(r.dyn.speed).toBeGreaterThan(kmhToMps(5));
  });

  it('空転時の加速度は粘着限界に支配される', () => {
    const dry = rig({ cars: 4, rail: 'dry' });
    const snow = rig({ cars: 4, rail: 'snow' });
    dry.traction.setNotch(4);
    snow.traction.setNotch(4);
    dry.run(15);
    snow.run(15);
    expect(snow.dyn.speed).toBeLessThan(dry.dyn.speed);
  });

  it('砂撒きで粘着が回復し、空転時の加速が改善する', () => {
    const make = (sanding: boolean) => {
      const r = rig({ cars: 4, rail: 'snow' });
      const env: DynamicsEnvironment = {
        adhesion: { rail: 'snow', sanding },
        ...NO_TUNNEL,
      };
      r.traction.setNotch(4);
      let sinceControl = 0;
      for (let i = 0; i < 15_000; i++) {
        sinceControl += DT;
        if (sinceControl >= CONTROL_DT - 1e-9) {
          r.brake.update(sinceControl, r.ctx);
          r.traction.update(sinceControl, r.ctx);
          sinceControl = 0;
        }
        r.dyn.step(DT, env);
      }
      return r.dyn.speed;
    };
    expect(make(true)).toBeGreaterThan(make(false));
  });
});

describe('ブレーキ', () => {
  it('常用最大ブレーキの定常減速度が指令減速度と一致する', () => {
    const r = rig({ cars: 4, initialSpeed: kmhToMps(80) });
    r.brake.setCommand(brakeCmd(8));
    r.run(5); // 立ち上がりを待つ
    const before = r.dyn.speed;
    r.run(5);
    const decel = (before - r.dyn.speed) / 5;
    expect(decel).toBeCloseTo(r.consist.brake.maxServiceDeceleration, 2);
  });

  it('ノッチごとに減速度が段階的に増える', () => {
    const decels: number[] = [];
    for (const notch of [2, 4, 6, 8]) {
      const r = rig({ cars: 4, initialSpeed: kmhToMps(80) });
      r.brake.setCommand(brakeCmd(notch));
      r.run(6);
      const before = r.dyn.speed;
      r.run(3);
      decels.push((before - r.dyn.speed) / 3);
    }
    for (let i = 1; i < decels.length; i++) {
      expect(decels[i]!).toBeGreaterThan(decels[i - 1]!);
    }
    expect(decels[3]!).toBeCloseTo(1.0, 2);
  });

  it('ブレーキ指令にむだ時間と立ち上がり遅れがある', () => {
    // 回生を受け入れない条件にして、空気ブレーキだけが働く状況を作る
    const r = rig({ cars: 4, initialSpeed: kmhToMps(60), receptivity: 0 });
    r.brake.setCommand(brakeCmd(8));
    r.run(0.2);
    // むだ時間 0.3s のあいだは BC 圧が上がらない
    expect(r.brake.averageCylinderPressure()).toBeLessThan(1000);
    r.run(2.0);
    expect(r.brake.averageCylinderPressure()).toBeGreaterThan(50_000);
  });

  it('電空協調: 高速域では回生が分担し、低速域で空気に受け渡される', () => {
    const r = rig({ cars: 4, initialSpeed: kmhToMps(45) });
    r.brake.setCommand(brakeCmd(6));
    const trace: Array<{ v: number; elec: number; air: number; a: number }> = [];
    r.run(40, () => {
      trace.push({
        v: mpsToKmh(r.dyn.speed),
        elec: r.brake.state.electricForce,
        air: r.brake.state.airForceActual,
        a: r.dyn.acceleration,
      });
    });
    const at = (kmh: number) => [...trace].reverse().find((t) => t.v >= kmh)!;
    const high = at(35);
    const low = at(4);
    // 高速域では回生が主体で空気ブレーキはほとんど使わない
    expect(high.elec).toBeGreaterThan(high.air * 3);
    expect(high.air).toBeLessThan(high.elec * 0.2);
    // 回生絞り込み速度（10km/h）を下回ると回生が減り、空気が受け持つ
    expect(low.elec).toBeLessThan(high.elec * 0.7);
    expect(low.air).toBeGreaterThan(low.elec);
    // 受け渡し区間では減速度がわずかに落ち込む（実車にも現れる回生失効の過渡）。
    // 空気ブレーキの先込め制御により、落ち込みは指令減速度の 25% 以内に収まる。
    const commanded = r.brake.decelerationForNotch(6);
    const handover = trace.filter((t) => t.v > 2 && t.v < 12);
    const worst = Math.max(...handover.map((t) => t.a));
    expect(worst).toBeLessThan(-commanded * 0.75);
    expect(worst).toBeGreaterThan(-commanded * 1.05);
    expect(r.dyn.speed).toBeCloseTo(0, 3);
  });

  it('回生失効（架線が回生を受け入れない）でも空気ブレーキが減速度を保つ', () => {
    const normal = rig({ cars: 4, initialSpeed: kmhToMps(60), receptivity: 1 });
    const lost = rig({ cars: 4, initialSpeed: kmhToMps(60), receptivity: 0 });
    normal.brake.setCommand(brakeCmd(7));
    lost.brake.setCommand(brakeCmd(7));
    // 立ち上がりを待ってから定常減速度を比較する
    normal.run(3);
    lost.run(3);
    const v1 = normal.dyn.speed;
    const v2 = lost.dyn.speed;
    normal.run(5);
    lost.run(5);
    const d1 = (v1 - normal.dyn.speed) / 5;
    const d2 = (v2 - lost.dyn.speed) / 5;
    expect(lost.brake.state.electricForce).toBe(0);
    expect(lost.brake.state.airForceActual).toBeGreaterThan(normal.brake.state.airForceActual);
    expect(Math.abs(d1 - d2)).toBeLessThan(0.02);
  });

  it('停止距離が v^2 / (2a) の理論値に近い', () => {
    const v0 = kmhToMps(80);
    const r = rig({ cars: 4, initialSpeed: v0 });
    const start = r.dyn.frontPosition;
    r.brake.setCommand(brakeCmd(8));
    r.run(60);
    const distance = r.dyn.frontPosition - start;
    const ideal = (v0 * v0) / (2 * r.consist.brake.maxServiceDeceleration);
    expect(r.dyn.speed).toBeCloseTo(0, 3);
    // 空走（むだ時間 + 立ち上がり）のぶんだけ理論値より延びる
    expect(distance).toBeGreaterThan(ideal);
    expect(distance).toBeLessThan(ideal + v0 * 1.5);
  });
});

describe('滑走と滑走防止装置', () => {
  it('降雪条件の非常ブレーキで滑走が発生し、滑走防止が BC 圧を緩解する', () => {
    const r = rig({ cars: 4, initialSpeed: kmhToMps(70), rail: 'snow' });
    r.brake.setCommand(brakeCmd(0, true));
    let sawSlide = false;
    let sawAntiSkid = false;
    let minFactor = 1;
    r.run(40, () => {
      if (r.dyn.anySliding) sawSlide = true;
      if (r.brake.state.antiSkidActive) sawAntiSkid = true;
      minFactor = Math.min(minFactor, ...r.brake.state.antiSkidFactor);
    });
    expect(sawSlide).toBe(true);
    expect(sawAntiSkid).toBe(true);
    expect(minFactor).toBeLessThan(1);
    expect(r.dyn.speed).toBeCloseTo(0, 3);
  });

  it('粘着が悪いほど非常制動距離が延びる', () => {
    const stopDistance = (rail: RailCondition) => {
      const r = rig({ cars: 4, initialSpeed: kmhToMps(70), rail });
      const start = r.dyn.frontPosition;
      r.brake.setCommand(brakeCmd(0, true));
      r.run(60);
      return r.dyn.frontPosition - start;
    };
    const dry = stopDistance('dry');
    const wet = stopDistance('wet');
    const snow = stopDistance('snow');
    const leaves = stopDistance('leaves');
    // 乾燥では粘着限界に達しないため、指令減速度どおりに止まる
    expect(dry).toBeGreaterThan(150);
    expect(dry).toBeLessThan(200);
    // 湿潤はちょうど粘着限界付近（わずかに滑走するが距離はほぼ変わらない）
    expect(wet).toBeGreaterThanOrEqual(dry);
    // 降雪・落葉では粘着限界が指令減速度を下回り、距離が明確に延びる
    expect(snow).toBeGreaterThan(dry * 1.4);
    expect(leaves).toBeGreaterThan(snow * 1.2);
  });

  it('滑走防止装置を切ると制動距離が悪化する', () => {
    const stopDistance = (antiSkid: boolean) => {
      const base = testConsist({ cars: 4 });
      const consist = {
        ...base,
        brake: { ...base.brake, antiSkid, antiSkidOnEmergency: antiSkid },
      };
      const dyn = new TrainDynamics(consist, flatTrack(), {
        initialSpeed: kmhToMps(70),
        initialFrontPosition: 1000,
      });
      const traction = new VvvfTractionSystem(consist);
      const brake = new ElectroPneumaticBrakeSystem(consist, { controlPeriod: CONTROL_DT });
      const env: DynamicsEnvironment = {
        adhesion: { rail: 'snow', sanding: false },
        ...NO_TUNNEL,
      };
      const ctx = {
        dynamics: dyn,
        traction,
        loadFactor: 0,
        regenerationReceptivity: 1,
        lineVoltage: 1500,
      };
      brake.setCommand(brakeCmd(0, true));
      const start = dyn.frontPosition;
      let sinceControl = 0;
      for (let i = 0; i < 60_000; i++) {
        sinceControl += DT;
        if (sinceControl >= CONTROL_DT - 1e-9) {
          brake.update(sinceControl, ctx);
          traction.update(sinceControl, ctx);
          sinceControl = 0;
        }
        dyn.step(DT, env);
      }
      return dyn.frontPosition - start;
    };
    expect(stopDistance(false)).toBeGreaterThan(stopDistance(true));
  });
});

describe('停止と停車の保持', () => {
  it('停止直前までブレーキ力が抜けず、止まった瞬間に減速度が消える', () => {
    const r = rig({ cars: 4, initialSpeed: kmhToMps(60) });
    r.brake.setCommand(brakeCmd(0, true));
    // 1km/h まで落ちた時点の減速度。摩擦に静止摩擦が無いと、ここで
    // ブレーキトルクが半分ほどに抜けてしまい、停止がなだらかになる。
    let atCrawl: number | null = null;
    for (let i = 0; i < 30_000; i++) {
      r.step();
      if (atCrawl === null && r.dyn.speed < kmhToMps(1)) atCrawl = r.dyn.acceleration;
    }
    expect(atCrawl).toBeLessThan(-1.2);
    // 止まったあとは動かず、減速度も残らない
    expect(r.dyn.speed).toBe(0);
    expect(r.dyn.acceleration).toBe(0);
  });

  it('非常ブレーキで勾配上に停車すると 1 分間 1mm も動かない', () => {
    const r = rig({ cars: 4, initialSpeed: kmhToMps(15), gradePermil: -33 });
    r.brake.setCommand(brakeCmd(0, true));
    r.run(20);
    expect(r.dyn.speed).toBe(0);
    const stopped = r.dyn.frontPosition;
    r.run(60);
    expect(r.dyn.frontPosition - stopped).toBe(0);
  });

  it('勾配上で停車中にブレーキを緩解すると転動する', () => {
    const r = rig({ cars: 4, initialSpeed: kmhToMps(15), gradePermil: -33 });
    r.brake.setCommand(brakeCmd(0, true));
    r.run(20);
    expect(r.dyn.speed).toBe(0);
    r.brake.setCommand(brakeCmd(0, false));
    r.run(10);
    expect(r.dyn.speed).toBeGreaterThan(kmhToMps(3));
  });
});

describe('抑速ブレーキ', () => {
  it('下り勾配で電気ブレーキのみで速度上昇を抑える', () => {
    const free = rig({ cars: 4, initialSpeed: kmhToMps(50), gradePermil: -33 });
    const held = rig({ cars: 4, initialSpeed: kmhToMps(50), gradePermil: -33 });
    held.brake.setCommand({
      notch: 0,
      emergency: false,
      holdingNotch: 4,
      backup: false,
      snowproof: false,
    });
    free.run(20);
    held.run(20);
    expect(held.dyn.speed).toBeLessThan(free.dyn.speed);
    // 空気ブレーキは使っていない
    expect(held.brake.averageCylinderPressure()).toBeLessThan(1000);
  });
});
