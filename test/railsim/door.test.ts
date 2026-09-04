import { describe, expect, it } from 'vitest';
import { DEFAULT_DOOR, DoorSystem, doorLabel, type DoorSpec } from '../../src/railsim/core/index.ts';

const DT = 0.01;

/** 指令を出してから `seconds` 秒ぶん動かす */
function run(doors: DoorSystem, seconds: number, onStep?: () => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    doors.update(DT);
    onStep?.();
  }
}

const spec: DoorSpec = DEFAULT_DOOR;

describe('客用扉の開閉', () => {
  it('初期状態は全閉で、力行してよい', () => {
    const doors = new DoorSystem(spec);
    expect(doors.state.phase).toBe('closed');
    expect(doors.state.position).toBe(0);
    expect(doors.interlocked).toBe(true);
  });

  it('開指令ですぐ動き出し、指定の時間で開き切る', () => {
    const doors = new DoorSystem(spec);
    doors.setCommand(false);
    expect(doors.state.phase).toBe('opening');

    run(doors, spec.openTime * 0.5);
    expect(doors.state.position).toBeGreaterThan(0.4);
    expect(doors.state.position).toBeLessThan(0.6);
    expect(doors.state.moving).toBe(true);

    run(doors, spec.openTime * 0.6);
    expect(doors.state.phase).toBe('open');
    expect(doors.state.position).toBe(1);
    expect(doors.state.moving).toBe(false);
    expect(doors.state.openEvents).toBe(1);
  });

  it('閉指令ではまず予告があり、そのあいだ扉は動かない', () => {
    const doors = new DoorSystem(spec);
    doors.setCommand(false);
    run(doors, 3);
    doors.setCommand(true);
    expect(doors.state.phase).toBe('warning');

    // 予告のあいだは全開のまま（まだ乗り降りできる）
    run(doors, spec.closeWarningTime * 0.8);
    expect(doors.state.phase).toBe('warning');
    expect(doors.state.position).toBe(1);
    expect(doors.state.moving).toBe(false);

    run(doors, spec.closeWarningTime * 0.4);
    expect(doors.state.phase).toBe('closing');
    expect(doors.state.moving).toBe(true);
    expect(doors.state.closing).toBe(true);
  });

  it('閉じ切ると施錠され、そこで初めて戸閉連動が成立する', () => {
    const doors = new DoorSystem(spec);
    doors.setCommand(false);
    run(doors, 3);
    expect(doors.interlocked).toBe(false);

    doors.setCommand(true);
    // 予告 + 閉扉の途中はまだ力行できない
    run(doors, spec.closeWarningTime + spec.closeTime * 0.9);
    expect(doors.interlocked).toBe(false);

    run(doors, spec.closeTime * 0.2);
    expect(doors.state.phase).toBe('closed');
    expect(doors.state.position).toBe(0);
    expect(doors.interlocked).toBe(true);
    expect(doors.state.latchEvents).toBe(1);
  });

  it('閉指令から力行できるようになるまでに予告 + 閉扉の時間がかかる', () => {
    const doors = new DoorSystem(spec);
    doors.setCommand(false);
    run(doors, 3);
    doors.setCommand(true);

    let elapsed = 0;
    let unlockedAt: number | null = null;
    run(doors, 10, () => {
      elapsed += DT;
      if (unlockedAt === null && doors.interlocked) unlockedAt = elapsed;
    });
    expect(unlockedAt).not.toBeNull();
    expect(unlockedAt!).toBeGreaterThan(spec.closeWarningTime + spec.closeTime - 3 * DT);
    expect(unlockedAt!).toBeLessThan(spec.closeWarningTime + spec.closeTime + 3 * DT);
  });

  it('閉扉の途中で開指令を出せば、その位置から開き直す', () => {
    const doors = new DoorSystem(spec);
    doors.setCommand(false);
    run(doors, 3);
    doors.setCommand(true);
    run(doors, spec.closeWarningTime + spec.closeTime * 0.5);
    const half = doors.state.position;
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThan(0.7);

    doors.setCommand(false);
    expect(doors.state.phase).toBe('opening');
    run(doors, DT * 2);
    expect(doors.state.position).toBeGreaterThan(half);
    // 閉まり切っていないので施錠はされていない
    expect(doors.state.latchEvents).toBe(0);
  });
});

describe('ドアチャイム', () => {
  it('開くときも閉めるときも鳴る', () => {
    const doors = new DoorSystem(spec);
    doors.setCommand(false);
    expect(doors.state.chimeEvents).toBe(1);
    run(doors, 3);
    doors.setCommand(true);
    expect(doors.state.chimeEvents).toBe(2);
  });

  it('指定の時間だけ鳴って止まる', () => {
    const doors = new DoorSystem(spec);
    doors.setCommand(false);
    run(doors, spec.chimeDuration * 0.5);
    expect(doors.state.chiming).toBe(true);
    run(doors, spec.chimeDuration * 0.6);
    expect(doors.state.chiming).toBe(false);
  });

  it('閉めるときはチャイムが先に鳴り、あとから扉が動き出す', () => {
    const doors = new DoorSystem(spec);
    doors.setCommand(false);
    run(doors, 3);
    doors.setCommand(true);
    // 予告の頭ではチャイムだけが鳴っていて、扉はまだ動いていない
    run(doors, DT * 2);
    expect(doors.state.chiming).toBe(true);
    expect(doors.state.moving).toBe(false);
  });

  it('鳴らさない設定なら鳴らない', () => {
    const silent: DoorSpec = { ...spec, chimeOnOpen: false, chimeOnClose: false };
    const doors = new DoorSystem(silent);
    doors.setCommand(false);
    run(doors, 0.1);
    expect(doors.state.chiming).toBe(false);
    expect(doors.state.chimeEvents).toBe(0);
  });
});

describe('扉の表示名', () => {
  it('段階に応じた名前を出す', () => {
    const doors = new DoorSystem(spec);
    expect(doorLabel(doors.state)).toBe('戸閉');
    doors.setCommand(false);
    run(doors, spec.openTime * 0.5);
    expect(doorLabel(doors.state)).toMatch(/^開扉中 \d+%$/);
    run(doors, spec.openTime);
    expect(doorLabel(doors.state)).toBe('戸開');
    doors.setCommand(true);
    expect(doorLabel(doors.state)).toBe('閉扉予告');
    run(doors, spec.closeWarningTime + spec.closeTime * 0.5);
    expect(doorLabel(doors.state)).toMatch(/^閉扉中 \d+%$/);
  });
});
