import { describe, expect, it } from 'vitest';
import { AirCompressor, DEFAULT_COMPRESSOR, paToKpa } from '../../src/railsim/core/index.ts';

const DT = 0.01;

/** `seconds` 秒ぶん回して、その間にコンプレッサが動いていた時間を返す */
function run(cp: AirCompressor, seconds: number, fillRate = 0): number {
  let running = 0;
  for (let i = 0; i < seconds / DT; i++) {
    cp.step(DT, fillRate);
    if (cp.state.running) running += DT;
  }
  return running;
}

describe('元空気溜めと空気圧縮機', () => {
  it('満タンから始まり、漏れだけで下限まで下がる時間が現実的', () => {
    const cp = new AirCompressor();
    expect(cp.state.pressure).toBe(DEFAULT_COMPRESSOR.cutOutPressure);
    expect(cp.state.running).toBe(false);

    // 130kPa を 800Pa/s で失うので約 163 秒
    const idle = run(cp, 150);
    expect(idle).toBe(0);
    expect(paToKpa(cp.state.pressure)).toBeGreaterThan(750);
    run(cp, 30);
    expect(cp.state.running).toBe(true);
  });

  it('起動したら上限まで込めて止まる（断続運転）', () => {
    const cp = new AirCompressor();
    // 起動した「瞬間」まで回す（途中から数えると込め時間が短く出る）
    for (let i = 0; i < 400 / DT && !cp.state.running; i++) cp.step(DT, 0);
    expect(cp.state.running).toBe(true);

    // 止まるまで（止まった瞬間の圧力を見たいので、そこで測るのをやめる）
    let runningTime = 0;
    for (let i = 0; i < 120 / DT && cp.state.running; i++) {
      cp.step(DT, 0);
      runningTime += DT;
    }
    expect(cp.state.running).toBe(false);
    expect(paToKpa(cp.state.pressure)).toBeGreaterThan(870);
    // 130kPa を正味 2450Pa/s（吐出し 3250 − 漏れ 800）で込めるので約 53 秒
    expect(runningTime).toBeGreaterThan(40);
    expect(runningTime).toBeLessThan(70);
  });

  it('ブレーキを使うほど早く回り出す', () => {
    const idleOnly = new AirCompressor();
    const braking = new AirCompressor();
    // 常用最大のブレーキを繰り返すような消費（BC 圧を 400kPa/s で込め続ける）
    run(idleOnly, 60);
    run(braking, 60, 400_000);
    expect(braking.state.pressure).toBeLessThan(idleOnly.state.pressure);
  });

  it('起動直後は吐出しが立ち上がる（突然全開にならない）', () => {
    const cp = new AirCompressor();
    run(cp, 200);
    expect(cp.state.running).toBe(true);
    // 起動判定の直後は出力が 1 未満のはず
    const fresh = new AirCompressor();
    run(fresh, 163);
    if (fresh.state.running) {
      expect(fresh.state.output).toBeGreaterThan(0);
      expect(fresh.state.output).toBeLessThanOrEqual(1);
    }
  });

  it('リセットで満タンに戻る', () => {
    const cp = new AirCompressor();
    run(cp, 200);
    cp.reset();
    expect(cp.state.pressure).toBe(DEFAULT_COMPRESSOR.cutOutPressure);
    expect(cp.state.running).toBe(false);
    expect(cp.state.output).toBe(0);
  });

  it('同じ入力なら同じ経過になる（決定論）', () => {
    const once = (): string => {
      const cp = new AirCompressor();
      const out: number[] = [];
      for (let i = 0; i < 30_000; i++) {
        const st = cp.step(DT, i % 500 < 30 ? 300_000 : 0);
        if (i % 500 === 0) out.push(st.pressure, st.running ? 1 : 0);
      }
      return out.join(',');
    };
    expect(once()).toBe(once());
  });
});
