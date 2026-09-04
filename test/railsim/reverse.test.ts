import { describe, expect, it } from 'vitest';
import {
  ElectroPneumaticBrakeSystem,
  TrainDynamics,
  VvvfTractionSystem,
  mpsToKmh,
  type DynamicsEnvironment,
} from '../../src/railsim/core/index.ts';
import { NO_TUNNEL, flatTrack, testConsist } from './fixtures.ts';

const DT = 0.001;
const CONTROL_DT = 0.01;

/** 逆転機の向きを与えて走らせる試験用リグ */
function rig(direction: 1 | -1) {
  const consist = testConsist({ cars: 4 });
  const dyn = new TrainDynamics(consist, flatTrack(), {
    initialSpeed: 0,
    initialFrontPosition: 1000,
  });
  const traction = new VvvfTractionSystem(consist);
  const brake = new ElectroPneumaticBrakeSystem(consist, { controlPeriod: CONTROL_DT });
  const env: DynamicsEnvironment = { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL };
  const ctx = {
    dynamics: dyn,
    traction,
    loadFactor: 0,
    regenerationReceptivity: 1,
    lineVoltage: 1500,
    direction,
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
  return { dyn, traction, brake, run };
}

describe('逆転機と後退運転', () => {
  it('後位では逆向きに走り出し、距離程が減る', () => {
    const back = rig(-1);
    back.traction.setNotch(2);
    back.run(10);

    expect(back.dyn.speed).toBeLessThan(0);
    expect(back.dyn.frontPosition).toBeLessThan(1000);
  });

  it('速さの出方は前位と同じ（向きだけが違う）', () => {
    const forward = rig(1);
    forward.traction.setNotch(2);
    forward.run(10);

    const back = rig(-1);
    back.traction.setNotch(2);
    back.run(10);

    expect(Math.abs(back.dyn.speed)).toBeCloseTo(forward.dyn.speed, 2);
  });

  it('後退中も力行は電力を使う（回生と取り違えない）', () => {
    const back = rig(-1);
    back.traction.setNotch(2);
    back.run(5);

    expect(back.traction.state.power).toBeGreaterThan(0);
    expect(back.traction.state.motorCurrent).toBeGreaterThan(0);
  });

  it('後退中もブレーキが利いて止まる', () => {
    const back = rig(-1);
    back.traction.setNotch(3);
    back.run(12);
    expect(mpsToKmh(Math.abs(back.dyn.speed))).toBeGreaterThan(10);

    back.traction.setNotch(0);
    back.brake.setCommand({
      notch: 5,
      emergency: false,
      holdingNotch: 0,
      backup: false,
      snowproof: false,
    });
    back.run(35);

    expect(Math.abs(back.dyn.speed)).toBeLessThan(0.05);
    // 止まったあと勝手に前へ動き出さない
    back.run(3);
    expect(Math.abs(back.dyn.speed)).toBeLessThan(0.05);
  });
});
