import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVERTER,
  InverterModulation,
  kmhToMps,
  modulationLabel,
  type InverterState,
  type VvvfTractionSpec,
} from '../../src/railsim/core/index.ts';
import { TEST_TRACTION } from './fixtures.ts';

const DT = 0.01;
const WHEEL_RADIUS = 0.43;

/** 車速 [km/h] に対応する車軸の角速度 [rad/s] */
const axleOmega = (kmh: number): number => kmhToMps(kmh) / WHEEL_RADIUS;

/**
 * 一定の速度・トルクで十分に落ち着かせる。
 * すべり周波数指令には時定数 30ms の鈍りが入っているので、1 ステップでは収束しない。
 */
function settle(
  kmh: number,
  torqueRatio: number,
  spec: VvvfTractionSpec = TEST_TRACTION,
  steps = 100,
): { mod: InverterModulation; state: InverterState } {
  const mod = new InverterModulation(spec);
  for (let i = 0; i < steps; i++) {
    mod.step(DT, { axleAngularVelocity: axleOmega(kmh), torqueRatio });
  }
  return { mod, state: mod.state };
}

describe('インバータの変調', () => {
  it('停止して力行していなければ出力周波数は 0 で変調は切', () => {
    const { state } = settle(0, 0);
    expect(state.fundamentalFrequency).toBe(0);
    expect(state.carrierFrequency).toBe(0);
    expect(state.mode).toBe('off');
  });

  it('停止したまま全ノッチを入れると、すべり周波数だけで出力周波数が立つ', () => {
    // 起動の瞬間、回転子は止まっているので f1 = すべり周波数そのもの。
    // 実車で起動時にまず低い唸りが出るのはこれ。
    const { state } = settle(0, 1);
    expect(state.rotorFrequency).toBe(0);
    expect(state.fundamentalFrequency).toBeCloseTo(DEFAULT_INVERTER.ratedSlipFrequency, 3);
    expect(state.mode).toBe('async');
  });

  it('力行ですべり周波数が正、回生で負になる', () => {
    const power = settle(60, 1).state;
    const regen = settle(60, -1).state;
    expect(power.slipFrequency).toBeGreaterThan(0);
    expect(regen.slipFrequency).toBeLessThan(0);
    // 回生では出力周波数が回転子周波数より低い（電動機が発電機になる）
    expect(regen.fundamentalFrequency).toBeLessThan(regen.rotorFrequency);
    expect(power.fundamentalFrequency).toBeGreaterThan(power.rotorFrequency);
  });

  it('出力周波数が回転数から求まる（35km/h で約 53Hz）', () => {
    // 車輪径 0.86m・歯車比 7.07・4 極。定トルク域の上限 35km/h が基底周波数にあたる。
    const { state } = settle(35, 1);
    expect(state.motorRpm).toBeCloseTo(1526, 0);
    expect(state.rotorFrequency).toBeCloseTo(50.9, 1);
    expect(state.fundamentalFrequency).toBeCloseTo(52.9, 1);
  });

  it('パルスモードが速度に対して単調に落ちていく', () => {
    const speeds = [5, 10, 15, 20, 25, 30, 33, 36, 40, 60, 90, 120];
    const pulses = speeds.map((v) => settle(v, 1).state.pulses);
    // 非同期（0）は別扱いなので、同期に入ってからの並びを見る
    const sync = pulses.filter((p) => p > 0);
    for (let i = 1; i < sync.length; i++) {
      expect(sync[i]!).toBeLessThanOrEqual(sync[i - 1]!);
    }
    expect(pulses[0]).toBe(0); // 5km/h は非同期
    expect(pulses[pulses.length - 1]).toBe(1); // 120km/h は一パルス
  });

  it('同期モードではキャリア周波数が出力周波数の整数倍になる', () => {
    const { state } = settle(25, 1);
    expect(state.mode).toBe('sync');
    expect(state.pulses).toBeGreaterThan(1);
    expect(state.carrierFrequency).toBeCloseTo(state.pulses * state.fundamentalFrequency, 6);
  });

  it('非同期モードのキャリアは出力周波数と無関係に表で決まる', () => {
    // 8km/h (f1 ≒ 13.6Hz) と 10km/h (f1 ≒ 16.5Hz) はどちらも表の 480Hz の平坦部に入る
    const a = settle(8, 1).state;
    const b = settle(10, 1).state;
    expect(a.mode).toBe('async');
    expect(b.mode).toBe('async');
    expect(a.carrierFrequency).toBeCloseTo(480, 6);
    expect(b.carrierFrequency).toBeCloseTo(480, 6);
    expect(a.fundamentalFrequency).not.toBeCloseTo(b.fundamentalFrequency, 1);
  });

  it('基底周波数を超えると変調率が 1 に飽和して一パルスになる', () => {
    const below = settle(30, 1).state;
    const above = settle(70, 1).state;
    expect(below.modulationIndex).toBeLessThan(1);
    expect(above.modulationIndex).toBe(1);
    expect(above.mode).toBe('onePulse');
    expect(above.carrierFrequency).toBe(0);
  });

  it('起動時も変調率が 0 にならない（一次抵抗降下ぶんのブースト）', () => {
    // V/f 一定を素直に守ると f₁ → 0 で電圧も 0 になり、磁束が立たないので
    // 定格トルクを出せる説明がつかない。実機はその分を上乗せして入る。
    const boost = TEST_TRACTION.inverter.voltageBoost;
    expect(boost).toBeGreaterThan(0);
    const crawl = settle(0.5, 1).state;
    expect(crawl.modulationIndex).toBeGreaterThanOrEqual(boost);
  });

  it('ブーストは負荷に比例する（抵抗降下が電流に比例するため）', () => {
    const full = settle(2, 1).state.modulationIndex;
    const half = settle(2, 0.5).state.modulationIndex;
    const boost = TEST_TRACTION.inverter.voltageBoost;
    // すべり周波数が違うので f₁ も少し違う。差の主因がブーストであることを見る。
    expect(full - half).toBeGreaterThan(boost * 0.3);
    expect(full).toBeGreaterThan(half);
  });

  it('モード境界で速度が上下してもモードが振動しない（ヒステリシス）', () => {
    // 9 パルス → 5 パルスの境界は 38Hz。その周りを細かく往復させる。
    const mod = new InverterModulation(TEST_TRACTION);
    const boundarySpeed = 26.2; // f1 ≒ 38Hz あたり
    let changes = 0;
    let previous = -1;
    for (let i = 0; i < 400; i++) {
      const wobble = boundarySpeed + 0.1 * Math.sin(i * 0.7);
      const st = mod.step(DT, { axleAngularVelocity: axleOmega(wobble), torqueRatio: 1 });
      if (previous >= 0 && st.pulses !== previous) changes++;
      previous = st.pulses;
    }
    // ヒステリシス幅 1.5Hz に対して振れ幅は 0.3Hz 程度なので、一度落ち着けば動かない
    expect(changes).toBeLessThanOrEqual(1);
  });

  it('惰行では変調が切れるが、歯車のかみ合い周波数は回転から出続ける', () => {
    const { state } = settle(80, 0);
    expect(state.mode).toBe('off');
    expect(state.carrierFrequency).toBe(0);
    expect(state.fundamentalFrequency).toBe(0);
    // 電動機は回り続けているので歯車とスロットの周波数は残る
    expect(state.motorRpm).toBeGreaterThan(3000);
    expect(state.gearMeshFrequency).toBeCloseTo(
      (state.motorRpm / 60) * DEFAULT_INVERTER.pinionTeeth,
      3,
    );
    expect(state.slotFrequency).toBeGreaterThan(state.gearMeshFrequency);
  });

  it('車輪が空転すると出力周波数が跳ね上がる', () => {
    // 車速は同じでも、車輪が 1.3 倍で空回りしていれば電動機はその回転で回っている。
    const grip = settle(40, 1).state.fundamentalFrequency;
    const mod = new InverterModulation(TEST_TRACTION);
    let spun = 0;
    for (let i = 0; i < 100; i++) {
      spun = mod.step(DT, {
        axleAngularVelocity: axleOmega(40) * 1.3,
        torqueRatio: 1,
      }).fundamentalFrequency;
    }
    expect(spun).toBeGreaterThan(grip * 1.25);
  });

  it('同じ入力なら同じ状態になる（決定論）', () => {
    const run = (): string => {
      const mod = new InverterModulation(TEST_TRACTION);
      const out: number[] = [];
      for (let i = 0; i < 500; i++) {
        const st = mod.step(DT, {
          axleAngularVelocity: axleOmega(i * 0.2),
          torqueRatio: Math.sin(i * 0.05),
        });
        out.push(st.fundamentalFrequency, st.carrierFrequency, st.pulses);
      }
      return out.join(',');
    };
    expect(run()).toBe(run());
  });

  it('リセットすると初期状態へ戻る', () => {
    const { mod } = settle(90, 1);
    expect(mod.state.mode).toBe('onePulse');
    mod.reset();
    expect(mod.state.mode).toBe('off');
    expect(mod.state.fundamentalFrequency).toBe(0);
    expect(mod.state.pulses).toBe(0);
  });

  it('表示名がモードを言い分ける', () => {
    expect(modulationLabel(settle(0, 0).state)).toBe('切');
    expect(modulationLabel(settle(8, 1).state)).toBe('非同期 480Hz');
    expect(modulationLabel(settle(25, 1).state)).toMatch(/^同期 \d+ パルス$/);
    expect(modulationLabel(settle(90, 1).state)).toBe('一パルス');
  });
});
