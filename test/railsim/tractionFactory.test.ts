import { describe, expect, it } from 'vitest';
import {
  ChopperTractionSystem,
  NoTractionSystem,
  ResistorTractionSystem,
  VvvfTractionSystem,
  consistTractionKind,
  createInverterState,
  createTractionSystem,
  driveDetail,
  driveDetailRowLabel,
  driveLabel,
  driveRowLabel,
  createChopperDriveState,
  createResistorDriveState,
  createIdleDriveState,
} from '../../src/railsim/core/index.ts';
import {
  TEST_CHOPPER_TRACTION,
  TEST_RESISTOR_TRACTION,
  TEST_TRACTION,
  testConsist,
  testVehicle,
} from './fixtures.ts';

describe('動力装置のファクトリ', () => {
  it('編成の仕様から正しい実装を選ぶ', () => {
    expect(createTractionSystem(testConsist({ traction: TEST_TRACTION }))).toBeInstanceOf(
      VvvfTractionSystem,
    );
    expect(createTractionSystem(testConsist({ traction: TEST_RESISTOR_TRACTION }))).toBeInstanceOf(
      ResistorTractionSystem,
    );
    expect(createTractionSystem(testConsist({ traction: TEST_CHOPPER_TRACTION }))).toBeInstanceOf(
      ChopperTractionSystem,
    );
    expect(createTractionSystem(testConsist({ traction: null }))).toBeInstanceOf(NoTractionSystem);
  });

  it('駆動装置の状態が制御方式を名乗る', () => {
    const kindOf = (traction: Parameters<typeof testConsist>[0]) =>
      createTractionSystem(testConsist(traction)).driveState.kind;
    expect(kindOf({ traction: TEST_TRACTION })).toBe('vvvf');
    expect(kindOf({ traction: TEST_RESISTOR_TRACTION })).toBe('resistor');
    expect(kindOf({ traction: TEST_CHOPPER_TRACTION })).toBe('chopper');
    expect(kindOf({ traction: null })).toBe('none');
  });

  it('編成内で制御方式が混在していたら弾く', () => {
    const consist = testConsist({ cars: 2, traction: TEST_TRACTION });
    const mixed = {
      ...consist,
      vehicles: [consist.vehicles[0]!, testVehicle({ traction: TEST_RESISTOR_TRACTION })],
    };
    expect(() => createTractionSystem(mixed)).toThrow(/混在/);
    expect(() => consistTractionKind(mixed)).toThrow(/混在/);
  });

  it('動力車が無ければ制御方式も無い', () => {
    expect(consistTractionKind(testConsist({ traction: null }))).toBeNull();
  });

  it('付随車だけの編成では何も出さない', () => {
    const system = new NoTractionSystem();
    expect(system.state.tractiveEffort).toBe(0);
    expect(
      system.availableElectricBrakeForce(20, {
        dynamics: { vehicles: [] } as never,
        loadFactor: 0,
        regenerationReceptivity: 1,
        lineVoltage: 1500,
      }),
    ).toBe(0);
  });
});

describe('駆動装置の表示名', () => {
  it('VVVF は変調モードを出す', () => {
    const state = createInverterState();
    expect(driveRowLabel(state)).toBe('変調');
    expect(driveDetailRowLabel(state)).toBe('出力 / すべり');
    expect(driveLabel(state)).toBe('切');
    state.mode = 'sync';
    state.pulses = 9;
    expect(driveLabel(state)).toBe('同期 9 パルス');
  });

  it('抵抗制御は段とつなぎ方を出す', () => {
    const state = createResistorDriveState();
    expect(driveRowLabel(state)).toBe('制御');
    expect(driveDetailRowLabel(state)).toBe('電流 / 電圧');
    expect(driveLabel(state)).toBe('切');

    state.gate = true;
    state.stepCount = 19;
    state.step = 4;
    state.motorsInSeries = 8;
    state.branches = 1;
    expect(driveLabel(state)).toBe('直列 5/19 段');

    state.motorsInSeries = 4;
    state.branches = 2;
    state.step = 15;
    state.fieldRatio = 0.65;
    expect(driveLabel(state)).toBe('直並列 16/19 段 界磁 65%');

    state.transitioning = true;
    expect(driveLabel(state)).toBe('渡り');

    state.transitioning = false;
    state.dynamicBraking = true;
    state.armatureCurrent = 312.4;
    expect(driveLabel(state)).toBe('発電制動 312A');
  });

  it('チョッパは通流率と周波数を出す', () => {
    const state = createChopperDriveState(400);
    expect(driveLabel(state)).toBe('切');

    state.gate = true;
    state.duty = 0.62;
    expect(driveLabel(state)).toBe('通流率 62% (400Hz)');

    state.duty = 1;
    state.fieldRatio = 0.5;
    expect(driveLabel(state)).toBe('全通流 界磁 50%');

    state.regenerating = true;
    state.duty = 0.38;
    state.fieldRatio = 1;
    expect(driveLabel(state)).toBe('回生 通流率 38% (400Hz)');
  });

  it('2 行目は方式ごとに量を替える', () => {
    const inverter = createInverterState();
    inverter.mode = 'async';
    inverter.fundamentalFrequency = 42.5;
    inverter.slipFrequency = 1.8;
    inverter.motorRpm = 1234;
    expect(driveDetail(inverter)).toBe('42.5 / 1.80 Hz（1234 rpm）');

    const resistor = createResistorDriveState();
    resistor.armatureCurrent = 412.7;
    resistor.armatureVoltage = 187.5;
    resistor.motorRpm = 890;
    expect(driveDetail(resistor)).toBe('413 A / 188 V（890 rpm）');

    expect(driveDetail(createIdleDriveState())).toBe('— / — （0 rpm）');
  });
});
