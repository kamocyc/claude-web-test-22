import { describe, expect, it } from 'vitest';
import {
  ElectroPneumaticBrakeSystem,
  TrainDynamics,
  VvvfTractionSystem,
  kmhToMps,
  paToKpa,
  type BrakeCommand,
  type DynamicsEnvironment,
  type RailCondition,
} from '../../src/railsim/core/index.ts';
import { NO_TUNNEL, flatTrack, testConsist } from './fixtures.ts';

const DT = 0.001;
const CONTROL_DT = 0.01;

/**
 * 動力・ブレーキ・力学を結線した試験用リグ（速度 60km/h の平坦線）。
 *
 * `rail` はブレーキ装置へ渡す軌条の状態で、力学側（粘着）は常に乾燥のままにする。
 * 粘着限界に頭を押さえられると制輪子の利きの差が見えなくなるので、ここでは
 * 踏面と制輪子のあいだだけを見る。
 */
function rig(
  rail: RailCondition = 'dry',
  options: { startSpeedKmh?: number; receptivity?: number } = {},
) {
  const startSpeedKmh = options.startSpeedKmh ?? 60;
  const consist = testConsist({ cars: 4 });
  const dyn = new TrainDynamics(consist, flatTrack(), {
    initialSpeed: kmhToMps(startSpeedKmh),
    initialFrontPosition: 1000,
  });
  const traction = new VvvfTractionSystem(consist);
  const brake = new ElectroPneumaticBrakeSystem(consist, { controlPeriod: CONTROL_DT });
  const env: DynamicsEnvironment = { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL };
  const ctx = {
    dynamics: dyn,
    traction,
    loadFactor: 0,
    regenerationReceptivity: options.receptivity ?? 1,
    lineVoltage: 1500,
    railCondition: rail,
  };
  let sinceControl = 0;
  const run = (seconds: number) => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      sinceControl += DT;
      if (sinceControl >= CONTROL_DT - 1e-9) {
        brake.update(sinceControl, ctx);
        traction.update(sinceControl, ctx);
        sinceControl = 0;
      }
      dyn.step(DT, env);
    }
  };
  return { dyn, brake, run };
}

/** 止まったままのリグ（噛み込みが速度で決まることを見るため） */
function rigAtRest(rail: RailCondition) {
  return rig(rail, { startSpeedKmh: 0 });
}

const cmd = (over: Partial<BrakeCommand> = {}): BrakeCommand => ({
  notch: 0,
  emergency: false,
  holdingNotch: 0,
  backup: false,
  snowproof: false,
  ...over,
});

describe('耐雪ブレーキ', () => {
  it('緩解中に低い圧力を込め続ける', () => {
    const r = rig();
    r.brake.setCommand(cmd({ snowproof: true }));
    r.run(4);
    const kpa = paToKpa(r.brake.averageCylinderPressure());
    // 制輪子を軽く当てておくだけの圧力。止めるための圧力ではない。
    expect(kpa).toBeGreaterThan(12);
    expect(kpa).toBeLessThan(60);
    // 空気だけで込める。電気ブレーキは呼ばない。
    expect(r.brake.state.electricForce).toBe(0);
  });

  it('入れなければ BC 圧は立たない', () => {
    const r = rig();
    r.brake.setCommand(cmd());
    r.run(4);
    expect(paToKpa(r.brake.averageCylinderPressure())).toBeLessThan(1);
  });

  it('常用ブレーキと重複して効かない（電空協調が耐雪ぶんを電気から差し引く）', () => {
    const plain = rig();
    plain.brake.setCommand(cmd({ notch: 3 }));
    plain.run(4);

    const snow = rig();
    snow.brake.setCommand(cmd({ notch: 3, snowproof: true }));
    snow.run(4);

    // 込まった空気のぶんだけ電気ブレーキの分担が減るので、指令減速度は変わらない
    expect(snow.dyn.speed).toBeCloseTo(plain.dyn.speed, 3);
    expect(snow.brake.state.electricForce).toBeLessThan(plain.brake.state.electricForce);
  });

  it('惰行の伸びが鈍る', () => {
    const coast = rig();
    coast.brake.setCommand(cmd());
    coast.run(20);

    const snow = rig();
    snow.brake.setCommand(cmd({ snowproof: true }));
    snow.run(20);

    // 制輪子を当てているぶんの抵抗。止めるほどではないが、惰行では目に見えて鈍る
    const differenceKmh = (coast.dyn.speed - snow.dyn.speed) * 3.6;
    expect(differenceKmh).toBeGreaterThan(2);
    expect(differenceKmh).toBeLessThan(10);
  });

  it('非常ブレーキ中は下限を張らない（非常の指令がそのまま出る）', () => {
    const plain = rig();
    plain.brake.setCommand(cmd({ emergency: true }));
    plain.run(2);

    const snow = rig();
    snow.brake.setCommand(cmd({ emergency: true, snowproof: true }));
    snow.run(2);

    expect(paToKpa(snow.brake.averageCylinderPressure())).toBeCloseTo(
      paToKpa(plain.brake.averageCylinderPressure()),
      6,
    );
  });
});

describe('雪の噛み込みと耐雪ブレーキ', () => {
  /**
   * 2 分だけ走ってから非常ブレーキで止め、そのときの制動距離を返す。
   *
   * 非常は空気ブレーキだけで受け持つ（`emergencyIsAirOnly`）ので、制輪子の利きが
   * そのまま停止距離に出る。常用は電気ブレーキが受け持つあいだ制輪子がほとんど
   * 当たらないので差が出ない。実物でも、回生ブレーキの車が雪で困るのはまさに
   * これで、ふだん制輪子が当たらないぶん雪が入り込み、いざ空気ブレーキが要る
   * ところで利かない。耐雪ブレーキはそのために当てておく装置である。
   */
  function emergencyStopDistance(rail: RailCondition, snowproof: boolean): number {
    const r = rig(rail);
    r.brake.setCommand(cmd({ snowproof }));
    r.run(120);
    const from = r.dyn.frontPosition;
    r.brake.setCommand(cmd({ emergency: true }));
    for (let i = 0; i < 60 && Math.abs(r.dyn.speed) > 0.05; i++) r.run(0.5);
    return r.dyn.frontPosition - from;
  }

  it('降雪中に制輪子を離したまま走ると、非常制動距離が延びる', () => {
    const dry = emergencyStopDistance('dry', false);
    const snow = emergencyStopDistance('snow', false);
    // 込めた圧力は同じでも、噛み込んだ雪のぶん摩擦が落ちて止まりきらない
    expect(snow).toBeGreaterThan(dry * 1.05);
  });

  it('耐雪ブレーキを入れておけば雪が入り込まない', () => {
    const loose = rig('snow');
    loose.brake.setCommand(cmd());
    loose.run(120);
    expect(loose.brake.state.snowLoss).toBeGreaterThan(0.1);

    const guarded = rig('snow');
    guarded.brake.setCommand(cmd({ snowproof: true }));
    guarded.run(120);
    // 制輪子を当て続けているので、噛み込みは進まない
    expect(guarded.brake.state.snowLoss).toBeLessThan(0.01);
  });

  it('制輪子が当たれば数十秒で落ちる', () => {
    const r = rig('snow');
    r.brake.setCommand(cmd());
    r.run(120);
    expect(r.brake.state.snowLoss).toBeGreaterThan(0.1);

    // 耐雪ブレーキを入れて制輪子を当てれば掻き落とされる
    r.brake.setCommand(cmd({ snowproof: true }));
    r.run(30);
    expect(r.brake.state.snowLoss).toBeLessThan(0.02);
  });

  it('止まっているあいだはほとんど噛み込まない', () => {
    const r = rigAtRest('snow');
    r.brake.setCommand(cmd());
    r.run(120);
    expect(r.brake.state.snowLoss).toBeLessThan(0.03);
  });

  it('晴天では耐雪ブレーキを入れなくても利きは落ちない', () => {
    const r = rig('dry');
    r.brake.setCommand(cmd());
    r.run(120);
    expect(r.brake.state.snowLoss).toBe(0);
  });
});
