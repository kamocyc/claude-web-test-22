import { describe, expect, it } from 'vitest';
import {
  ChopperVoice,
  InverterVoice,
  ResistorVoice,
  SILENT_CHOPPER,
  SILENT_RESISTOR,
  type ChopperVoiceParams,
  type ResistorVoiceParams,
} from '../../src/railsim/audio/index.ts';
import { aWeightedRms, bandPower, goertzel, peakProminence, rms } from './spectrum.ts';

/**
 * 実車の主電動機の次数（`packages/data/src/assets/commuter4Resistor.ts` と同じ値）。
 *
 * 3 つとも回転数に掛けるだけの量だが、**次数が桁で違う**ので音の性格がまるで違う。
 * 音程を担うのはスロットと通風であって、整流子ではない。
 */
const ARMATURE_SLOTS = 31;
const COMMUTATOR_BARS = 93;
const FAN_BLADES = 34;

/** 回転数 [rpm] から主電動機の 3 つの加振周波数を出す */
const motorAt = (rpm: number) => ({
  slotFrequency: (ARMATURE_SLOTS * rpm) / 60,
  commutatorFrequency: (COMMUTATOR_BARS * rpm) / 60,
  ventilationFrequency: (FAN_BLADES * rpm) / 60,
});

/** 電動機が止まっている状態（主回路だけを測りたいときに使う） */
const STOPPED = motorAt(0);

/** 40km/h（歯車比 5.6・車輪径 860mm）にあたる回転数。常用速度域の代表点。 */
const CRUISE_RPM = 1382;

const SAMPLE_RATE = 48_000;
/** 1 秒ぶんレンダすれば 1Hz 分解能で峰が見える */
const LENGTH = SAMPLE_RATE;

/**
 * 比較の基準になるインバータ音。
 * どの制御方式でもミキサのつまみ 1.0 でおおむね同じ大きさに聞こえてほしいので、
 * 直流機の音はこれを物差しにして較正してある。
 */
function renderInverterReference(): Float32Array {
  const voice = new InverterVoice(SAMPLE_RATE);
  voice.setParams({
    gate: true,
    fundamental: 45,
    carrier: 480,
    modulation: 1,
    pulses: 0,
    slotFrequency: 1200,
    level: 1,
  });
  voice.render(new Float32Array(Math.floor(SAMPLE_RATE * 0.5)));
  const out = new Float32Array(LENGTH);
  voice.render(out);
  return out;
}

const resistorParams = (over: Partial<ResistorVoiceParams> = {}): ResistorVoiceParams => ({
  gate: true,
  current: 1,
  ...motorAt(CRUISE_RPM),
  resistorPower: 0.6,
  steps: 0,
  groupChanges: 0,
  level: 1,
  ...over,
});

const chopperParams = (over: Partial<ChopperVoiceParams> = {}): ChopperVoiceParams => ({
  gate: true,
  current: 1,
  duty: 0.5,
  chopFrequency: 400,
  ...motorAt(CRUISE_RPM),
  level: 1,
  ...over,
});

/** 定常状態を 1 秒ぶんレンダする（平滑化と共振の立ち上がりは捨てる） */
function renderResistor(p: ResistorVoiceParams, length = LENGTH): Float32Array {
  const voice = new ResistorVoice(SAMPLE_RATE);
  voice.setParams(p);
  voice.render(new Float32Array(Math.floor(SAMPLE_RATE * 0.5)));
  // 撃力は setParams のたびに予約されるので、定常の測定では鳴らさない
  voice.setParams({ ...p, steps: 0, groupChanges: 0 });
  const out = new Float32Array(length);
  voice.render(out);
  return out;
}

function renderChopper(p: ChopperVoiceParams, length = LENGTH): Float32Array {
  const voice = new ChopperVoice(SAMPLE_RATE);
  voice.setParams(p);
  voice.render(new Float32Array(Math.floor(SAMPLE_RATE * 0.5)));
  const out = new Float32Array(length);
  voice.render(out);
  return out;
}

describe('抵抗制御の主回路音', () => {
  it('無音のパラメータでは何も鳴らない', () => {
    const voice = new ResistorVoice(SAMPLE_RATE);
    voice.setParams(SILENT_RESISTOR);
    const out = new Float32Array(LENGTH);
    voice.render(out);
    expect(rms(out)).toBe(0);
  });

  it('電機子スロットの通過周波数に峰が立つ', () => {
    const out = renderResistor(resistorParams({ resistorPower: 0 }));
    const { slotFrequency } = motorAt(CRUISE_RPM);
    expect(peakProminence(out, SAMPLE_RATE, slotFrequency, 70)).toBeGreaterThan(50);
  });

  it('音程はスロットが担い、整流子はその下に隠れる', () => {
    // ここが今の音といちばん違っていたところ。整流子（93 次）で音程を決めていたころは
    // 40km/h で 2.1kHz の澄んだ音程が立ち、実車よりはっきり高く聞こえていた。
    for (const rpm of [690, CRUISE_RPM, 2073]) {
      const { slotFrequency, commutatorFrequency } = motorAt(rpm);
      const out = renderResistor(resistorParams({ ...motorAt(rpm), resistorPower: 0 }));
      expect(goertzel(out, SAMPLE_RATE, commutatorFrequency)).toBeLessThan(
        goertzel(out, SAMPLE_RATE, slotFrequency) * 0.25,
      );
    }
  });

  it('音程は回転数だけで決まる（キャリアが無いので段では変わらない）', () => {
    const slow = renderResistor(resistorParams({ ...motorAt(800), resistorPower: 0 }));
    const fast = renderResistor(resistorParams({ ...motorAt(1600), resistorPower: 0 }));
    expect(peakProminence(slow, SAMPLE_RATE, motorAt(800).slotFrequency, 70)).toBeGreaterThan(50);
    expect(peakProminence(fast, SAMPLE_RATE, motorAt(1600).slotFrequency, 70)).toBeGreaterThan(50);
    // 速いほうに遅いほうの峰は立っていない
    expect(peakProminence(fast, SAMPLE_RATE, motorAt(800).slotFrequency, 70)).toBeLessThan(3);
  });

  it('電流が大きいほど電磁音が大きい（力は磁束 × 電流 ≒ 電流²）', () => {
    const { slotFrequency } = motorAt(CRUISE_RPM);
    const half = renderResistor(resistorParams({ current: 0.5, resistorPower: 0 }));
    const full = renderResistor(resistorParams({ current: 1.0, resistorPower: 0 }));
    // 線のパワーは振幅の 2 乗、振幅は電流の 2 乗なので、電流 2 倍でおよそ 16 倍になる
    expect(goertzel(full, SAMPLE_RATE, slotFrequency)).toBeGreaterThan(
      goertzel(half, SAMPLE_RATE, slotFrequency) * 8,
    );
  });

  it('惰行しても通風音が残る（電流に依存しない成分があるため）', () => {
    const { slotFrequency } = motorAt(CRUISE_RPM);
    const powering = renderResistor(resistorParams({ resistorPower: 0 }));
    const coasting = renderResistor(resistorParams({ gate: false, current: 0, resistorPower: 0 }));
    // 主回路が切れても電動機は回り続けるので、音が完全には消えない
    expect(rms(coasting)).toBeGreaterThan(rms(powering) * 0.1);
    expect(rms(coasting)).toBeLessThan(rms(powering) * 0.7);
    // 残るのは広帯域の通風音だけで、電磁音の音程は消えている
    expect(peakProminence(coasting, SAMPLE_RATE, slotFrequency, 70)).toBeLessThan(3);
  });

  it('起動抵抗を短絡すると低いうなりが消える', () => {
    const hot = renderResistor(resistorParams({ resistorPower: 1 }));
    const shorted = renderResistor(resistorParams({ resistorPower: 0 }));
    // 抵抗器のうなりの帯（100〜900Hz）で明確に差が出る
    expect(bandPower(hot, SAMPLE_RATE, 120, 600)).toBeGreaterThan(
      bandPower(shorted, SAMPLE_RATE, 120, 600) * 3,
    );
  });

  it('進段すると撃力が鳴り、短時間で減衰する', () => {
    const voice = new ResistorVoice(SAMPLE_RATE);
    voice.setParams(
      resistorParams({ ...STOPPED, gate: false, current: 0, resistorPower: 0, steps: 1 }),
    );
    const out = new Float32Array(Math.floor(SAMPLE_RATE * 0.5));
    voice.render(out);
    const head = out.subarray(0, Math.floor(SAMPLE_RATE * 0.05));
    const tail = out.subarray(Math.floor(SAMPLE_RATE * 0.3));
    expect(rms(head)).toBeGreaterThan(0);
    // 300ms 後にはほぼ収まっている
    expect(rms(tail)).toBeLessThan(rms(head) * 0.05);
  });

  it('直並列の組替えは進段より重い音になる', () => {
    const strike = (over: Partial<ResistorVoiceParams>) => {
      const voice = new ResistorVoice(SAMPLE_RATE);
      voice.setParams(
        resistorParams({ ...STOPPED, gate: false, current: 0, resistorPower: 0, ...over }),
      );
      const out = new Float32Array(Math.floor(SAMPLE_RATE * 0.3));
      voice.render(out);
      return rms(out);
    };
    expect(strike({ steps: 1, groupChanges: 1 })).toBeGreaterThan(strike({ steps: 1 }) * 1.5);
  });
});

describe('電機子チョッパの音', () => {
  it('無音のパラメータでは何も鳴らない', () => {
    const voice = new ChopperVoice(SAMPLE_RATE);
    voice.setParams(SILENT_CHOPPER);
    const out = new Float32Array(LENGTH);
    voice.render(out);
    expect(rms(out)).toBe(0);
  });

  it('チョッパ周波数に峰が立つ', () => {
    const out = renderChopper(chopperParams({ ...STOPPED }));
    expect(peakProminence(out, SAMPLE_RATE, 400, 60)).toBeGreaterThan(6);
  });

  it('速度が変わっても音程が動かない（チョッパ車の音のいちばんの特徴）', () => {
    const slow = renderChopper(chopperParams({ ...motorAt(600) }));
    const fast = renderChopper(chopperParams({ ...motorAt(1800) }));
    expect(peakProminence(slow, SAMPLE_RATE, 400, 60)).toBeGreaterThan(6);
    expect(peakProminence(fast, SAMPLE_RATE, 400, 60)).toBeGreaterThan(6);
  });

  it('全通流ではチョッパ音が消え、電動機の音だけが残る', () => {
    const chopping = renderChopper(chopperParams({ ...STOPPED, duty: 0.5 }));
    const full = renderChopper(chopperParams({ ...STOPPED, duty: 1 }));
    expect(bandPower(full, SAMPLE_RATE, 350, 450)).toBeLessThan(
      bandPower(chopping, SAMPLE_RATE, 350, 450) * 0.05,
    );
  });

  it('通流率 0.5 でリップルが最大になる', () => {
    const at = (duty: number) =>
      bandPower(renderChopper(chopperParams({ ...STOPPED, duty })), SAMPLE_RATE, 350, 450);
    expect(at(0.5)).toBeGreaterThan(at(0.2));
    expect(at(0.5)).toBeGreaterThan(at(0.85));
  });

  it('ゲートを切ると主回路の音が消え、電動機の音だけが残る', () => {
    const on = renderChopper(chopperParams());
    const off = renderChopper(chopperParams({ gate: false }));
    // チョッパの線が消える（通風音は広帯域なので、この帯に量そのものは残る）
    expect(goertzel(off, SAMPLE_RATE, 400)).toBeLessThan(goertzel(on, SAMPLE_RATE, 400) * 0.05);
    // 電動機は回り続けているので無音にはならない
    expect(rms(off)).toBeGreaterThan(0);
  });
});

describe('直流電動機の音の大きさと高域', () => {
  // 起動から最高速まで（限流値制御なので電流はほぼ一定）。3455rpm = 100km/h。
  const RPMS = [600, 1000, CRUISE_RPM, 1800, 2200, 3455];
  const render = (rpm: number) =>
    renderResistor(resistorParams({ ...motorAt(rpm), resistorPower: 0 }));

  it('どの回転数でもインバータ音と同じ桁に収まる', () => {
    // 構造共振を跨ぐぶんの上下はあってよい（実機の電動機も特定の速度で唸りが太る）が、
    // 桁で外れてはいけない。車両を切り替えるたびに音量を取り直すことになる。
    const reference = aWeightedRms(renderInverterReference(), SAMPLE_RATE);
    for (const rpm of RPMS) {
      const level = aWeightedRms(render(rpm), SAMPLE_RATE);
      expect(level).toBeGreaterThan(reference * 0.2);
      expect(level).toBeLessThan(reference * 2);
    }
  });

  it('スペクトルが高域へ向かって落ちる（上がりっぱなしにならない）', () => {
    for (const rpm of RPMS) {
      const out = render(rpm);
      const mid = bandPower(out, SAMPLE_RATE, 800, 3000);
      const high = bandPower(out, SAMPLE_RATE, 4000, 14000);
      // 放射効率が高域を持ち上げるぶんを、質量制御のロールオフと通風路の切れが
      // 上回っていること。ここが逆転すると、回転が上がるほど耳につく音になる。
      expect(high).toBeLessThan(mid * 0.05);
    }
  });
});

describe('チョッパ音と主電動機の釣り合い', () => {
  it('チョッパ音が主電動機の音に埋もれない', () => {
    // この車の音のいちばんの特徴なので、電動機の音程（スロット通過）と同じ桁で
    // 鳴っていること。速度が上がるほど比が下がるのは、チョッパ周波数が固定なのに
    // スロット通過は回転とともに放射のよい帯へ入っていくためである。
    for (const rpm of [600, CRUISE_RPM, 2200]) {
      const out = renderChopper(chopperParams({ ...motorAt(rpm), duty: 0.5 }));
      const chop = goertzel(out, SAMPLE_RATE, 400);
      const slot = goertzel(out, SAMPLE_RATE, motorAt(rpm).slotFrequency);
      expect(chop / slot).toBeGreaterThan(0.1);
      // かといって電動機を覆い隠すほどでもない
      expect(chop / slot).toBeLessThan(4);
    }
  });
});
