import { describe, expect, it } from 'vitest';
import {
  RemoteTrainVoice,
  RollingVoice,
  SILENT_BRIDGE,
  SILENT_CHOPPER,
  SILENT_CROSSING,
  SILENT_CURVE_SQUEAL,
  SILENT_DOOR,
  SILENT_PASSING,
  SILENT_RESISTOR,
  type RemoteTrainParams,
  type TrainNoiseParams,
} from '../../src/railsim/audio/index.ts';
import { bandPower, rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;

const silence = (): TrainNoiseParams => ({
  inverter: {
    gate: false,
    fundamental: 0,
    carrier: 0,
    modulation: 0,
    pulses: 0,
    slotFrequency: 0,
    level: 0,
  },
  resistor: SILENT_RESISTOR,
  chopper: SILENT_CHOPPER,
  gear: { meshFrequency: 0, shaftFrequency: 0, load: 0, level: 0 },
  rolling: { speed: 0, corrugation: 0, level: 0 },
  wind: { speed: 0, level: 0 },
  brake: { speed: 0, cylinderPressure: 0, pressureRate: 0, level: 0 },
  auxiliary: { compressor: 0, level: 0 },
  airSpring: { strokeRate: 0, level: 0 },
  curveSqueal: SILENT_CURVE_SQUEAL,
  bridge: SILENT_BRIDGE,
  crossing: SILENT_CROSSING,
  passing: SILENT_PASSING,
  door: SILENT_DOOR,
  alarm: { bell: false, chime: false, patternApproach: false, level: 0 },
  horn: { sounding: false, level: 0 },
});

/** 相手が 100km/h で力行しているときの音（自列車へ渡すのとまったく同じ形） */
const RUNNING = (level = 1): TrainNoiseParams => ({
  ...silence(),
  gear: { meshFrequency: 1250, shaftFrequency: 73.5, load: 0.5, level },
  rolling: { speed: 28, corrugation: 0.2, level },
});

const remote = (distance: number, train = RUNNING(), level = 1): RemoteTrainParams => ({
  present: true,
  train,
  distance,
  level,
});

/**
 * 距離を `from` から `to` へ動かしながら鳴らし、その波形を返す。
 * 伝搬の遅れが縮む／伸びることが、そのまま音程の上下（ドップラー効果）になる。
 */
function sweep(from: number, to: number, seconds: number, train = RUNNING()): Float32Array {
  const voice = new RemoteTrainVoice(SAMPLE_RATE);
  const block = 512;
  const frames = Math.floor((SAMPLE_RATE * seconds) / block);
  const out = new Float32Array(frames * block);
  const buffer = new Float32Array(block);
  for (let frame = 0; frame < frames; frame++) {
    const t = frame / Math.max(1, frames - 1);
    voice.setParams(remote(from + (to - from) * t, train));
    buffer.fill(0);
    voice.render(buffer);
    out.set(buffer, frame * block);
  }
  return out;
}

/** 一定の距離で鳴らす */
function still(distance: number, train = RUNNING(), seconds = 1): Float32Array {
  const voice = new RemoteTrainVoice(SAMPLE_RATE);
  voice.setParams(remote(distance, train));
  // 伝搬の遅れのぶんだけ待ってから測る
  voice.render(new Float32Array(SAMPLE_RATE));
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  voice.render(out);
  return out;
}

/** 歯車のかみ合いの線が立っている周波数 [Hz]（後半 1 秒で測る） */
function meshPeak(x: Float32Array, nominal: number): number {
  const window = x.length > SAMPLE_RATE ? x.subarray(x.length - SAMPLE_RATE) : x;
  let best = nominal;
  let bestPower = -Infinity;
  for (let f = nominal * 0.85; f <= nominal * 1.15; f += 2) {
    const power = bandPower(window as unknown as Float32Array, SAMPLE_RATE, f - 2, f + 2, 2);
    if (power > bestPower) {
      bestPower = power;
      best = f;
    }
  }
  return best;
}

describe('隣の線路を走る列車', () => {
  it('隣に誰も居なければ鳴らない', () => {
    const voice = new RemoteTrainVoice(SAMPLE_RATE);
    voice.setParams(null);
    const out = new Float32Array(SAMPLE_RATE);
    voice.render(out);
    expect(rms(out)).toBe(0);
  });

  it('音源の音量をそのまま渡せば鳴る（自列車と同じパラメータで動く）', () => {
    expect(rms(still(3.4))).toBeGreaterThan(1e-3);
  });

  it('音は 343m/s でしか進まないので、遠いほど遅れて届く', () => {
    const voice = new RemoteTrainVoice(SAMPLE_RATE);
    voice.setParams(remote(343));
    // 1 秒ぶん鳴らしても、まだ音は届いていない
    const first = new Float32Array(SAMPLE_RATE - 2000);
    voice.render(first);
    expect(rms(first)).toBe(0);
    const later = new Float32Array(SAMPLE_RATE);
    voice.render(later);
    expect(rms(later)).toBeGreaterThan(0);
  });

  it('近づくあいだは音程が高く、離れるあいだは低い（ドップラー効果）', () => {
    // 相対 28m/s なら前後で 1.082 倍と 0.918 倍。合成器の側では何も変えておらず、
    // 遅延の長さが縮む／伸びることだけでこうなる。
    const mesh = 1250;
    const approaching = meshPeak(sweep(200, 60, 5), mesh);
    const receding = meshPeak(sweep(60, 200, 5), mesh);
    expect(approaching).toBeGreaterThan(mesh * 1.05);
    expect(receding).toBeLessThan(mesh * 0.95);
    // 近づく側と離れる側で対称（同じ速さで動かしているので）
    expect(approaching / mesh - 1).toBeCloseTo(1 - receding / mesh, 1);
  });

  it('距離が変わらなければ音程も変わらない（真横を過ぎる瞬間）', () => {
    expect(meshPeak(still(3.4), 1250)).toBeCloseTo(1250, -1);
  });

  it('遠いほど高い成分が先に失われる（空気の吸収）', () => {
    const near = still(10);
    const far = still(200);
    const tilt = (x: Float32Array): number =>
      bandPower(x, SAMPLE_RATE, 2000, 4000) / bandPower(x, SAMPLE_RATE, 200, 400);
    expect(tilt(far)).toBeLessThan(tilt(near) * 0.5);
  });

  it('車体を透過して届くので、同じ音でもこもって聞こえる', () => {
    // 相手の転動音は自分の転動音と同じ音源だが、届き方が違う。同じ量を入れて
    // 比べると、高い成分だけが削られている（質量則）。
    const own = new RollingVoice(SAMPLE_RATE);
    own.setParams({ speed: 28, corrugation: 0.2, level: 1 });
    const inside = new Float32Array(SAMPLE_RATE);
    own.render(inside);
    const outside = still(3.4, {
      ...silence(),
      rolling: { speed: 28, corrugation: 0.2, level: 1 },
    });
    const tilt = (x: Float32Array): number =>
      bandPower(x, SAMPLE_RATE, 2000, 4000) / bandPower(x, SAMPLE_RATE, 200, 400);
    expect(tilt(outside)).toBeLessThan(tilt(inside) * 0.2);
  });

  it('すぐ隣を通るときは自分の走行音と同じ桁で聞こえる', () => {
    // 車体という同じ壁を外向きに 1 回・内向きに 1 回通るので、低い成分では
    // ほぼ相殺する。3.4m の隣を 100km/h で抜けていく列車は、自分の走行音の
    // 半分ほどの大きさになる。
    const own = new RollingVoice(SAMPLE_RATE);
    own.setParams({ speed: 25, corrugation: 0.2, level: 1 });
    const reference = new Float32Array(SAMPLE_RATE);
    own.render(reference);
    const beside = rms(still(3.4));
    expect(beside).toBeGreaterThan(rms(reference) * 0.2);
    expect(beside).toBeLessThan(rms(reference) * 1.5);
  });

  it('距離による音量の減衰はここには無い（音源ごとに位置が違うため）', () => {
    // 電動機は相手の M 車の床下、転動音は相手の編成の全長…と音源ごとに距離が
    // 違うので、音量の減衰は `level` に織り込んで渡す。ここが受け持つのは
    // 伝わる時間・空気の吸収・車体の遮音だけで、そのぶんだけ遠いほうが小さい。
    expect(rms(still(200))).toBeLessThan(rms(still(3.4)));
  });

  it('音量を 0 にすれば鳴らない', () => {
    const voice = new RemoteTrainVoice(SAMPLE_RATE);
    voice.setParams(remote(3.4, RUNNING(), 0));
    const out = new Float32Array(SAMPLE_RATE);
    voice.render(out);
    expect(rms(out)).toBe(0);
  });

  it('相手が踏んだ継目も同じ音源から鳴る', () => {
    const voice = new RemoteTrainVoice(SAMPLE_RATE);
    voice.setParams(remote(3.4, silence()));
    voice.triggerJoint({ delay: 100, strength: 1 });
    // 伝搬の遅れ（3.4m = 0.01 秒）ぶん置いてから届く
    const out = new Float32Array(SAMPLE_RATE);
    voice.render(out);
    expect(rms(out)).toBeGreaterThan(1e-4);
  });
});
