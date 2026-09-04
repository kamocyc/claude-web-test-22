import { describe, expect, it } from 'vitest';
import { DriverState } from '../src/app/driverState';

/**
 * 通勤形と同じ段数（力行 4・常用ブレーキ 7・抑速あり）。段数は関数で読ませる。
 *
 * 運転台の型は**ツーハンドルに明示して**返す。既定はワンハンドルなので、
 * ここで揃えておかないと 2 本のハンドルの相互排他を試すつもりの検査が、
 * いつのまにか 1 本の軸の検査に化ける。
 */
function makeState(power = 4, brake = 7, holding = true): DriverState {
  const state = new DriverState({
    powerNotchCount: () => power,
    brakeNotchCount: () => brake,
    hasHoldingBrake: () => holding,
  });
  state.setLayout('two-handle');
  return state;
}

describe('運転台のハンドル位置', () => {
  it('既定の運転台はワンハンドル', () => {
    const state = new DriverState({
      powerNotchCount: () => 4,
      brakeNotchCount: () => 7,
      hasHoldingBrake: () => true,
    });
    expect(state.layout).toBe('one-handle');
  });

  it('初期状態は切・戸閉め', () => {
    const state = makeState();
    expect(state.handles).toEqual({
      power: 0,
      brake: 0,
      holding: false,
      emergency: false,
      doorsClosed: true,
      reverser: 1,
      headlight: false,
      headlightHigh: true,
      wiper: 'off',
      snowproof: false,
    });
    expect(state.input.powerNotch).toBe(0);
    expect(state.input.doorsClosed).toBe(true);
  });

  it('力行とブレーキは同時に入らない', () => {
    const state = makeState();
    // N → 抑速 → B1 の順なので、B2 まで込めるには 3 回動かす
    state.apply('brakeUp');
    state.apply('brakeUp');
    state.apply('brakeUp');
    expect(state.handles.brake).toBe(2);

    state.apply('powerUp');
    expect(state.handles.power).toBe(1);
    expect(state.handles.brake).toBe(0);

    state.apply('brakeUp');
    expect(state.handles).toMatchObject({ power: 0, brake: 0, holding: true });
  });

  it('ノッチは段数で頭打ちになる', () => {
    const state = makeState();
    for (let i = 0; i < 10; i += 1) state.apply('powerUp');
    expect(state.handles.power).toBe(4);
    for (let i = 0; i < 10; i += 1) state.apply('powerDown');
    expect(state.handles.power).toBe(0);

    // 込め切ると非常まで行き、そこで止まる
    for (let i = 0; i < 20; i += 1) state.apply('brakeUp');
    expect(state.handles).toMatchObject({ brake: 7, emergency: true });
  });

  it('段数は操作のたびに読み直す（車両を替えても追従する）', () => {
    let brakeCount = 7;
    const state = new DriverState({
      powerNotchCount: () => 4,
      brakeNotchCount: () => brakeCount,
      hasHoldingBrake: () => true,
    });
    state.setBrake(99);
    expect(state.handles.brake).toBe(7);

    brakeCount = 8;
    state.setBrake(99);
    expect(state.handles.brake).toBe(8);
  });
});

describe('非常ブレーキ', () => {
  it('入れると力行が切れ、常用は最大段になる', () => {
    const state = makeState();
    state.apply('powerUp');
    state.apply('emergency');
    expect(state.handles).toMatchObject({ power: 0, brake: 7, emergency: true });
    expect(state.input.emergency).toBe(true);
  });

  it('緩める操作と力行では解けるが、込める操作では解けない', () => {
    const state = makeState();

    state.apply('emergency');
    state.apply('brakeUp');
    // 込めていく操作で非常が緩んでは事故になる
    expect(state.handles.emergency).toBe(true);

    state.apply('brakeDown');
    expect(state.handles).toMatchObject({ emergency: false, brake: 7 });

    state.apply('emergency');
    state.apply('powerUp');
    expect(state.handles.emergency).toBe(false);
    expect(state.handles.power).toBe(1);
  });

  it('レバーを常用位置へ動かすと解ける', () => {
    const state = makeState();
    state.apply('emergency');
    state.setBrake(3);
    expect(state.handles).toMatchObject({ brake: 3, emergency: false });
  });
});

describe('レバーからの直接指定', () => {
  it('0〜段数へ丸める', () => {
    const state = makeState();
    state.setPower(99);
    expect(state.handles.power).toBe(4);
    state.setPower(-5);
    expect(state.handles.power).toBe(0);
    state.setBrake(2.4);
    expect(state.handles.brake).toBe(2);
  });

  it('力行を入れるとブレーキが緩解し、0 に戻すだけならブレーキに触らない', () => {
    const state = makeState();
    state.setBrake(3);
    state.setPower(2);
    expect(state.handles).toMatchObject({ power: 2, brake: 0 });

    state.setBrake(3);
    state.setPower(0);
    expect(state.handles.brake).toBe(3);
  });
});

describe('ブレーキ側の段の並び（N → 抑速 → B1 → … → 非常）', () => {
  it('切の次が抑速、その次が B1 になる', () => {
    const state = makeState();
    expect(state.brakePosition).toBe(0);

    state.apply('brakeUp');
    expect(state.handles).toMatchObject({ brake: 0, holding: true });
    expect(state.brakePosition).toBe(1);

    state.apply('brakeUp');
    expect(state.handles).toMatchObject({ brake: 1, holding: false });

    state.apply('brakeDown');
    expect(state.handles).toMatchObject({ brake: 0, holding: true });

    state.apply('brakeDown');
    expect(state.handles).toMatchObject({ brake: 0, holding: false });
  });

  it('抑速を持たない車両では切の次が B1 になる', () => {
    const state = makeState(4, 7, false);
    state.apply('brakeUp');
    expect(state.handles).toMatchObject({ brake: 1, holding: false });
    state.setHolding(true);
    expect(state.handles.holding).toBe(false);
  });

  it('非常はブレーキ側のいちばん先の位置にある', () => {
    const state = makeState();
    expect(state.brakePositionCount).toBe(9); // 切 + 抑速 + B1..B7 + 非常
    state.setBrakePosition(9);
    expect(state.handles).toMatchObject({ emergency: true, brake: 7 });
  });
});

describe('抑速ブレーキ', () => {
  it('段を持たず、入切だけが ControlInput へ渡る', () => {
    // 何段の電気ブレーキを出すかは装置が速度を見て選ぶ。運転士の手元にあるのは
    // 抑速位置に入れたかどうかだけである。
    const state = makeState();
    state.setHolding(true);
    expect(state.handles.holding).toBe(true);
    expect(state.input).toMatchObject({ holding: true, holdingNotch: 0, brakeNotch: 0 });

    state.setHolding(false);
    expect(state.input.holding).toBe(false);
  });

  it('力行を入れると抑速は落ちる', () => {
    const state = makeState();
    state.setHolding(true);
    state.setPower(2);
    expect(state.handles).toMatchObject({ power: 2, holding: false });
  });

  it('常用ブレーキを込めると抑速は落ちる', () => {
    // ブレーキ装置は常用が切のときしか抑速を見ない。ハンドルだけ抑速位置に
    // 残ると、表示と実際の効きが食い違う。
    const state = makeState();
    state.setHolding(true);
    state.setBrake(3);
    expect(state.handles).toMatchObject({ brake: 3, holding: false });

    state.setHolding(true);
    state.apply('emergency');
    expect(state.handles).toMatchObject({ holding: false, emergency: true });
  });
});

describe('ワンハンドルマスコン', () => {
  it('4 つのノッチ操作がすべて 1 本の軸の上下になる', () => {
    const state = makeState();
    state.setLayout('one-handle');

    state.apply('powerUp');
    state.apply('powerUp');
    expect(state.handles.power).toBe(2);
    expect(state.lever).toBe(2);

    // 「ブレーキを込める」も同じ軸を下げる操作になる
    state.apply('brakeUp');
    expect(state.handles.power).toBe(1);
    state.apply('brakeUp');
    expect(state.handles).toMatchObject({ power: 0, brake: 0, holding: false });

    // 切より先は抑速、その先が常用
    state.apply('brakeUp');
    expect(state.handles.holding).toBe(true);
    state.apply('brakeUp');
    expect(state.handles.brake).toBe(1);

    // 「力行を上げる」は同じ軸を戻す操作になる
    state.apply('powerUp');
    expect(state.handles).toMatchObject({ brake: 0, holding: true });
  });

  it('軸の両端は最大力行と非常', () => {
    const state = makeState();
    state.setLayout('one-handle');
    for (let i = 0; i < 30; i += 1) state.apply('brakeUp');
    expect(state.handles).toMatchObject({ emergency: true, brake: 7 });
    expect(state.lever).toBe(-9);

    for (let i = 0; i < 30; i += 1) state.apply('powerUp');
    expect(state.handles).toMatchObject({ power: 4, emergency: false });
    expect(state.lever).toBe(4);
  });

  it('型を切り替えても握っている位置は動かない', () => {
    const state = makeState();
    state.setBrake(3);
    state.setLayout('one-handle');
    expect(state.handles.brake).toBe(3);
    state.setLayout('two-handle');
    expect(state.handles.brake).toBe(3);
  });
});

describe('押している間だけ有効な操作', () => {
  it('押すと立ち、離すと落ちる', () => {
    const state = makeState();
    expect(state.input.horn).toBe(false);
    state.hold('horn');
    expect(state.input.horn).toBe(true);
    state.release('horn');
    expect(state.input.horn).toBe(false);
  });

  it('複数を同時に押せる（マルチタッチ）', () => {
    const state = makeState();
    state.hold('horn');
    state.hold('sanding');
    state.hold('acknowledge');
    expect(state.input).toMatchObject({ horn: true, sanding: true, acknowledge: true });

    state.release('horn');
    expect(state.input).toMatchObject({ horn: false, sanding: true, acknowledge: true });
  });

  it('releaseAll で全部落ちる（指を奪われた・背面へ回った）', () => {
    const state = makeState();
    state.hold('horn');
    state.hold('safetyReset');
    state.releaseAll();
    expect(state.input).toMatchObject({ horn: false, safetyReset: false });
    expect(state.isHeld('horn')).toBe(false);
  });
});

describe('扉と引き継ぎ', () => {
  it('戸閉めは押すたびに入れ替わる', () => {
    const state = makeState();
    state.apply('doorsToggle');
    expect(state.handles.doorsClosed).toBe(false);
    state.apply('doorsToggle');
    expect(state.handles.doorsClosed).toBe(true);
  });

  it('takeOver は装置のノッチをそのまま引き継ぐ（非常だけ解く）', () => {
    const state = makeState();
    state.apply('emergency');
    state.takeOver(0, 3, false);
    expect(state.handles).toEqual({
      power: 0,
      brake: 3,
      holding: false,
      emergency: false,
      doorsClosed: false,
      reverser: 1,
      headlight: false,
      headlightHigh: true,
      wiper: 'off',
      snowproof: false,
    });
  });

  it('takeOver は装置の抑速を抑速位置として引き継ぐ', () => {
    // 下り勾配の途中で手を替えたときにここが抜けると、装置が入れていた
    // 電気ブレーキが突然切れて列車が加速しはじめる。
    const state = makeState();
    state.takeOver(0, 0, true, 5);
    expect(state.handles).toMatchObject({ power: 0, brake: 0, holding: true });
    expect(state.input.holding).toBe(true);
  });

  it('reset で初期状態へ戻る', () => {
    const state = makeState();
    state.apply('powerUp');
    state.apply('doorsToggle');
    state.hold('horn');
    state.reset();
    expect(state.handles).toEqual({
      power: 0,
      brake: 0,
      holding: false,
      emergency: false,
      doorsClosed: true,
      reverser: 1,
      headlight: false,
      headlightHigh: true,
      wiper: 'off',
      snowproof: false,
    });
    expect(state.input.horn).toBe(false);
  });
});

describe('ControlInput への写し取り', () => {
  it('割り当てのない項目は中立のまま残る', () => {
    const state = makeState();
    state.setPower(2);
    // 抑速の段指定（自動運転装置の入口）と直通予備は運転台に割り当てが無く、
    // 中立の既定値が保たれる
    expect(state.input).toMatchObject({
      powerNotch: 2,
      holdingNotch: 0,
      backupBrake: false,
    });
  });

  it('前照灯とワイパーは載せない（物理に効かないので記録も膨らませない）', () => {
    const state = makeState();
    state.apply('headlightToggle');
    state.apply('wiper');
    expect(state.handles).toMatchObject({ headlight: true, wiper: 'slow' });
    expect(state.input).not.toHaveProperty('headlight');
    expect(state.input).not.toHaveProperty('wiper');
  });
});

describe('ノッチの即時操作', () => {
  it('ツーハンドルでは Q も A も力行を抜くだけで N を越えない', () => {
    const state = makeState();
    state.setPower(2);
    state.apply('notchToBrake');
    expect(state.handles).toMatchObject({ power: 1, brake: 0, holding: false });
    state.apply('notchToBrake');
    state.apply('notchToBrake');
    expect(state.handles).toMatchObject({ power: 0, brake: 0, holding: false });
  });

  it('ワンハンドルでは Q だけが N を越えてブレーキ側へ入る', () => {
    const state = makeState();
    state.setLayout('one-handle');
    state.apply('notchToBrake');
    expect(state.handles.holding).toBe(true);

    state.setLever(0);
    state.apply('powerDown');
    expect(state.lever).toBe(0);
  });

  it('ワンハンドルの A はブレーキ側からも N へ 1 段ずつ戻る', () => {
    const state = makeState();
    state.setLayout('one-handle');
    state.setBrake(1);
    expect(state.handles).toMatchObject({ brake: 1, holding: false });

    // B1 → 抑速 → N。一息に N へ飛ばない（飛ぶのは S）
    state.apply('powerDown');
    expect(state.handles).toMatchObject({ brake: 0, holding: true });
    state.apply('powerDown');
    expect(state.lever).toBe(0);
    // N から先（力行側）へは越えない
    state.apply('powerDown');
    expect(state.lever).toBe(0);
  });

  it('W は抑速を飛ばして B1 に入る', () => {
    const state = makeState();
    state.apply('notchB1');
    expect(state.handles).toMatchObject({ power: 0, brake: 1, holding: false });
  });

  it('S は一息に N へ戻し、非常も緩解する', () => {
    const state = makeState();
    state.apply('emergency');
    state.apply('notchNeutral');
    expect(state.handles).toMatchObject({ power: 0, brake: 0, holding: false, emergency: false });

    state.setPower(3);
    state.apply('notchNeutral');
    expect(state.handles.power).toBe(0);
  });
});

describe('逆転ハンドル', () => {
  it('既定は前位で、前 → 中立 → 後と 1 段ずつ動く', () => {
    const state = makeState();
    expect(state.handles.reverser).toBe(1);
    state.apply('reverserBackward');
    expect(state.handles.reverser).toBe(0);
    state.apply('reverserBackward');
    expect(state.handles.reverser).toBe(-1);
    // 端では止まる
    state.apply('reverserBackward');
    expect(state.handles.reverser).toBe(-1);
    state.apply('reverserForward');
    expect(state.handles.reverser).toBe(0);
  });

  it('力行を入れているあいだは動かない', () => {
    const state = makeState();
    state.setPower(1);
    state.apply('reverserBackward');
    expect(state.handles.reverser).toBe(1);
  });

  it('走行中は動かない（実車の鎖錠と同じ）', () => {
    let stopped = false;
    const state = new DriverState({
      powerNotchCount: () => 4,
      brakeNotchCount: () => 7,
      hasHoldingBrake: () => true,
      canMoveReverser: () => stopped,
    });
    state.apply('reverserBackward');
    expect(state.handles.reverser).toBe(1);

    stopped = true;
    state.apply('reverserBackward');
    expect(state.handles.reverser).toBe(0);
  });

  it('位置は ControlInput に出る', () => {
    const state = makeState();
    state.apply('reverserBackward');
    state.apply('reverserBackward');
    expect(state.input.reverser).toBe(-1);
  });
});

describe('運転台の装備', () => {
  it('前照灯の入切と減光は別々に効く', () => {
    const state = makeState();
    expect(state.handles).toMatchObject({ headlight: false, headlightHigh: true });
    state.apply('headlightToggle');
    expect(state.handles.headlight).toBe(true);
    state.apply('headlightDim');
    expect(state.handles).toMatchObject({ headlight: true, headlightHigh: false });
    state.apply('headlightToggle');
    // 消しても減光の位置は覚えている（実車のスイッチも別々に残る）
    expect(state.handles).toMatchObject({ headlight: false, headlightHigh: false });
  });

  it('ワイパーは 切 → 低速 → 高速 と回る', () => {
    const state = makeState();
    state.apply('wiper');
    expect(state.handles.wiper).toBe('slow');
    state.apply('wiper');
    expect(state.handles.wiper).toBe('fast');
    state.apply('wiper');
    expect(state.handles.wiper).toBe('off');
  });

  it('耐雪ブレーキは ControlInput に出る', () => {
    const state = makeState();
    expect(state.input.snowproofBrake).toBe(false);
    state.apply('snowproofToggle');
    expect(state.handles.snowproof).toBe(true);
    expect(state.input.snowproofBrake).toBe(true);
  });

  it('ドアは開と閉で別々の指令になる（何度押しても同じ）', () => {
    const state = makeState();
    state.apply('doorsOpen');
    state.apply('doorsOpen');
    expect(state.handles.doorsClosed).toBe(false);
    state.apply('doorsClose');
    state.apply('doorsClose');
    expect(state.handles.doorsClosed).toBe(true);
  });
});
