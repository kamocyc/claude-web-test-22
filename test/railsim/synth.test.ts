import { describe, expect, it } from 'vitest';
import {
  SILENT_BRIDGE,
  SILENT_CHOPPER,
  SILENT_CROSSING,
  SILENT_CURVE_SQUEAL,
  SILENT_DOOR,
  SILENT_PASSING,
  SILENT_RESISTOR,
  TrainNoiseSynth,
  VOICE,
  VOICE_COUNT,
  type TrainNoiseParams,
} from '../../src/railsim/audio/index.ts';
import { aWeightedRms, bandPower, peakProminence, rms } from './spectrum.ts';

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

const merge = (over: Partial<TrainNoiseParams>): TrainNoiseParams => ({ ...silence(), ...over });

function render(p: TrainNoiseParams, seconds = 1): Float32Array {
  const synth = new TrainNoiseSynth(SAMPLE_RATE);
  synth.setParams(p);
  synth.render(new Float32Array(Math.floor(SAMPLE_RATE * 0.3)));
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  synth.render(out);
  return out;
}

/**
 * 80km/h で惰行しているときの走行音（音量バランスの基準になる）。
 * 車輪径 0.86m・歯車比 7.07・小歯車 17 枚。歯車だけは M 車の床下なので
 * 運転台から遠く、そのぶん小さい。
 */
const COASTING_80 = (): TrainNoiseParams =>
  merge({
    gear: { meshFrequency: 989, shaftFrequency: 58.2, load: 0.4, level: 0.385 },
    rolling: { speed: 80 / 3.6, corrugation: 0, level: 1 },
    wind: { speed: 80 / 3.6, level: 1 },
  });

describe('走行音の合成全体', () => {
  it('すべての音源が無音なら完全な無音になる', () => {
    expect(rms(render(silence()))).toBeLessThan(1e-5);
  });

  /**
   * 音源ごとの音量の関係は「耳で決めた」では検証できないので、走行音を基準に
   * 測って決めてある。ここはその関係が崩れていないことを見る回帰テスト。
   */
  describe('音源どうしの音量バランス', () => {
    it('空気圧縮機は 80km/h の走行音より 6dB 以上小さい', () => {
      // 車内でいちばん存在感のある補機だが、走っているあいだは走行音に
      // 埋もれるのが正しい。停車中に耳で合わせると必ず過大になる。
      const running = rms(render(COASTING_80()));
      const compressor = rms(render(merge({ auxiliary: { compressor: 1, level: 1 } })));
      expect(compressor).toBeLessThan(running * 0.5);
      // かといって聞こえないほど小さくもない（停車中は編成でいちばん大きい）
      expect(compressor).toBeGreaterThan(running * 0.15);
    });

    it('停車中は空気圧縮機だけが鳴る', () => {
      const x = render(merge({ auxiliary: { compressor: 1, level: 1 } }));
      expect(rms(x)).toBeGreaterThan(1e-3);
    });
  });

  describe('音源ごとの実効値メータ', () => {
    const levelsOf = (p: TrainNoiseParams): Float32Array => {
      const synth = new TrainNoiseSynth(SAMPLE_RATE);
      synth.setParams(p);
      synth.render(new Float32Array(SAMPLE_RATE / 2));
      const levels = new Float32Array(VOICE_COUNT);
      synth.readLevels(levels);
      return levels;
    };

    it('鳴っている音源だけが値を持つ', () => {
      const levels = levelsOf(merge({ auxiliary: { compressor: 1, level: 1 } }));
      expect(levels[VOICE.auxiliary]!).toBeGreaterThan(1e-3);
      for (const voice of [
        VOICE.inverter,
        VOICE.gear,
        VOICE.rolling,
        VOICE.wind,
        VOICE.brake,
        VOICE.railJoint,
      ]) {
        expect(levels[voice]!).toBeLessThan(1e-6);
      }
    });

    it('混ざる前の値なので、支配している音源が分かる', () => {
      const levels = levelsOf(merge({ ...COASTING_80(), auxiliary: { compressor: 1, level: 1 } }));
      // 80km/h では転動音が支配していて、補機はそのはるか下にいる
      expect(levels[VOICE.rolling]!).toBeGreaterThan(levels[VOICE.auxiliary]! * 2);
      expect(levels[VOICE.rolling]!).toBeGreaterThan(levels[VOICE.gear]!);
    });

    it('読み出すたびに直近のぶんだけを返す（積算が残らない）', () => {
      const synth = new TrainNoiseSynth(SAMPLE_RATE);
      synth.setParams(merge({ auxiliary: { compressor: 1, level: 1 } }));
      synth.render(new Float32Array(SAMPLE_RATE / 2));
      const first = new Float32Array(VOICE_COUNT);
      synth.readLevels(first);
      expect(first[VOICE.auxiliary]!).toBeGreaterThan(1e-3);

      // レンダせずにもう一度読めば、積算が空なので 0 が返る
      const again = new Float32Array(VOICE_COUNT).fill(1);
      synth.readLevels(again);
      expect(Array.from(again)).toEqual(Array<number>(VOICE_COUNT).fill(0));
    });
  });

  it('混ざっても出力が [-1, 1] に収まる', () => {
    const x = render(
      merge({
        inverter: {
          gate: true,
          fundamental: 40,
          carrier: 360,
          modulation: 0.8,
          pulses: 9,
          slotFrequency: 900,
          level: 1,
        },
        gear: { meshFrequency: 1200, shaftFrequency: 70, load: 1, level: 1 },
        rolling: { speed: 30, corrugation: 0, level: 1 },
        wind: { speed: 30, level: 1 },
        brake: { speed: 30, cylinderPressure: 1, pressureRate: -2, level: 1 },
        auxiliary: { compressor: 1, level: 1 },
      }),
    );
    for (let i = 0; i < x.length; i++) {
      expect(Number.isFinite(x[i]!)).toBe(true);
      expect(Math.abs(x[i]!)).toBeLessThanOrEqual(1);
    }
    expect(rms(x)).toBeGreaterThan(0.05);
  });
});

describe('歯車の音', () => {
  const gear = (over: Partial<TrainNoiseParams['gear']>): TrainNoiseParams =>
    merge({ gear: { ...silence().gear, level: 1, ...over } });

  it('かみ合い周波数に峰が立ち、その高調波も出る', () => {
    const mesh = 900;
    const x = render(gear({ meshFrequency: mesh, shaftFrequency: 53, load: 1 }));
    expect(peakProminence(x, SAMPLE_RATE, mesh, 120)).toBeGreaterThan(10);
    expect(peakProminence(x, SAMPLE_RATE, 2 * mesh, 120)).toBeGreaterThan(10);
  });

  it('歯形誤差で 1 回転ごとの側帯波が付く（うなりの正体）', () => {
    const mesh = 900;
    const shaft = 53;
    const x = render(gear({ meshFrequency: mesh, shaftFrequency: shaft, load: 1 }));
    expect(peakProminence(x, SAMPLE_RATE, mesh - shaft, shaft / 2)).toBeGreaterThan(6);
    expect(peakProminence(x, SAMPLE_RATE, mesh + shaft, shaft / 2)).toBeGreaterThan(6);
  });

  it('惰行しても消えない（インバータ音との決定的な違い）', () => {
    const mesh = 900;
    const powering = render(gear({ meshFrequency: mesh, shaftFrequency: 53, load: 1 }));
    const coasting = render(gear({ meshFrequency: mesh, shaftFrequency: 53, load: 0 }));
    expect(peakProminence(coasting, SAMPLE_RATE, mesh, 120)).toBeGreaterThan(10);
    // 力行のほうが強いが、惰行でも半分程度は残る
    const ratio =
      bandPower(coasting, SAMPLE_RATE, 880, 920) / bandPower(powering, SAMPLE_RATE, 880, 920);
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(1);
  });

  it('電動機が回っていなければ無音（車速ではなく回転で決まる）', () => {
    expect(rms(render(gear({ meshFrequency: 0, shaftFrequency: 0, load: 1 })))).toBeLessThan(1e-5);
  });
});

describe('転動音', () => {
  const rolling = (speed: number): TrainNoiseParams =>
    merge({ rolling: { speed, corrugation: 0, level: 1 } });

  it('30·log₁₀v で増える（速度 2 倍で約 9dB）', () => {
    const db = 20 * Math.log10(rms(render(rolling(20))) / rms(render(rolling(10))));
    // 振幅 ∝ v^1.5 なので、速度 2 倍で 20·log10(2^1.5) = 9.03 dB
    expect(db).toBeGreaterThan(8);
    expect(db).toBeLessThan(10);
  });

  it('停止していれば無音', () => {
    expect(rms(render(rolling(0)))).toBeLessThan(1e-5);
  });

  it('高速ほどスペクトル重心が上がる', () => {
    const centroid = (x: Float32Array): number => {
      let num = 0;
      let den = 0;
      for (let f = 200; f <= 3000; f += 50) {
        const p = bandPower(x, SAMPLE_RATE, f - 25, f + 25, 4);
        num += f * p;
        den += p;
      }
      return num / den;
    };
    expect(centroid(render(rolling(33)))).toBeGreaterThan(centroid(render(rolling(8))));
  });
});

describe('風切り音', () => {
  const wind = (speed: number): TrainNoiseParams => merge({ wind: { speed, level: 1 } });

  it('60·log₁₀v で増える（速度 2 倍で約 18dB）', () => {
    const db = 20 * Math.log10(rms(render(wind(20))) / rms(render(wind(10))));
    // 四重極音源なので振幅 ∝ v³ → 20·log10(2³) = 18.06 dB
    expect(db).toBeGreaterThan(17);
    expect(db).toBeLessThan(19);
  });

  it('最高速度でもまだ転動音のはるか下にいる', () => {
    // 速度依存の指数が違うのでいつかは逆転するが、鉄道で空力音が支配するのは
    // 250〜300km/h から。この車両の最高速度 120km/h では 6dB 以上下にいる。
    // 分けて測れなかったころは 90km/h で追い越していた（その回帰テスト）。
    const speed = 120 / 3.6;
    const w = rms(render(merge({ wind: { speed, level: 1 } })));
    const r = rms(render(merge({ rolling: { speed, corrugation: 0, level: 1 } })));
    expect(w).toBeLessThan(r * 0.5);
  });
});

describe('走行音の主役が速度で入れ替わる', () => {
  /** 運転台から見た音量。歯車だけは M 車の床下なので遠い。 */
  const at = (kmh: number): { rolling: number; gear: number } => {
    const shaft = ((kmh / 3.6 / 0.43) * 7.07) / (2 * Math.PI);
    return {
      rolling: rms(render(merge({ rolling: { speed: kmh / 3.6, corrugation: 0, level: 1 } }))),
      gear: rms(
        render(
          merge({
            gear: { meshFrequency: shaft * 17, shaftFrequency: shaft, load: 0.4, level: 0.385 },
          }),
        ),
      ),
    };
  };

  it('低速では歯車、高速では転動音が支配する', () => {
    // 通勤形の車内で実際に起きる移り変わり。歯車は回転数にしか比例しないのに
    // 対して転動音は 30·log₁₀v で増えるので、どこかで必ず入れ替わる。
    const slow = at(20);
    const fast = at(80);
    expect(slow.gear).toBeGreaterThan(slow.rolling * 1.5);
    expect(fast.rolling).toBeGreaterThan(fast.gear * 1.5);
  });
});
describe('ブレーキと空気の音', () => {
  const brake = (over: Partial<TrainNoiseParams['brake']>): TrainNoiseParams =>
    merge({ brake: { ...silence().brake, level: 1, ...over } });

  it('摩擦音は押付力と速度の両方が要る', () => {
    const moving = rms(render(brake({ speed: 20, cylinderPressure: 0.8 })));
    const stopped = rms(render(brake({ speed: 0, cylinderPressure: 0.8 })));
    const released = rms(render(brake({ speed: 20, cylinderPressure: 0 })));
    expect(moving).toBeGreaterThan(stopped * 5);
    expect(moving).toBeGreaterThan(released * 5);
  });

  it('鳴きは低速で押付力が強いときだけ出る', () => {
    const squealing = render(brake({ speed: 2.5, cylinderPressure: 0.9 }));
    const fast = render(brake({ speed: 25, cylinderPressure: 0.9 }));
    // 2.6kHz の鋭い共振
    expect(peakProminence(squealing, SAMPLE_RATE, 2600, 700)).toBeGreaterThan(3);
    expect(peakProminence(squealing, SAMPLE_RATE, 2600, 700)).toBeGreaterThan(
      peakProminence(fast, SAMPLE_RATE, 2600, 700),
    );
  });

  it('緩めの排気音は込めの音より大きい（大気開放だから）', () => {
    const fill = rms(render(brake({ speed: 15, cylinderPressure: 0.5, pressureRate: 1.5 })));
    const release = rms(render(brake({ speed: 15, cylinderPressure: 0.5, pressureRate: -1.5 })));
    expect(release).toBeGreaterThan(fill * 1.5);
  });
});

describe('補機の音', () => {
  it('空気圧縮機は回転周期の峰を持つ（連続音ではなく打撃の列）', () => {
    const x = render(merge({ auxiliary: { compressor: 1, level: 1 } }));
    // 2 気筒なので 16.5Hz の 2 倍 = 33Hz ごとに吐出しが起きる
    expect(peakProminence(x, SAMPLE_RATE, 33, 8)).toBeGreaterThan(4);
    expect(rms(x)).toBeGreaterThan(1e-3);
  });

  it('止まっていれば無音', () => {
    expect(rms(render(merge({ auxiliary: { compressor: 0, level: 1 } })))).toBeLessThan(1e-5);
  });
});

describe('レール継目の衝撃', () => {
  it('予約したサンプル位置ちょうどから鳴り始める', () => {
    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(silence());
    synth.triggerJoint({ delay: 1000, strength: 1 });
    const out = new Float32Array(4096);
    synth.render(out);

    let first = -1;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i]!) > 1e-6) {
        first = i;
        break;
      }
    }
    expect(first).toBe(1000);
  });

  /** 一撃を鳴らして、区間 [from, to] 秒の帯域エネルギーを返す */
  const shot = (from: number, to: number, lo: number, hi: number): number => {
    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(silence());
    synth.triggerJoint({ delay: 0, strength: 1 });
    const out = new Float32Array(SAMPLE_RATE);
    synth.render(out);
    const slice = out.subarray(Math.floor(SAMPLE_RATE * from), Math.floor(SAMPLE_RATE * to));
    return Math.sqrt(bandPower(slice, SAMPLE_RATE, lo, hi, 24));
  };

  it('低い成分ほど長く残る（「ガタン」の重さの正体）', () => {
    // 構造振動の一般則で、低次のモードほど減衰が小さい。すべて同じ時定数で
    // 減衰させていたころは低域が高域と一緒に切れ、「カタッ」と軽くなっていた。
    const lowEarly = shot(0, 0.02, 40, 150);
    const lowLate = shot(0.15, 0.25, 40, 150);
    const highEarly = shot(0, 0.02, 800, 3000);
    const highLate = shot(0.15, 0.25, 800, 3000);
    // 150ms 後、高域はほぼ消えているのに低域はまだ残っている
    expect(highLate / highEarly).toBeLessThan(0.02);
    expect(lowLate / lowEarly).toBeGreaterThan(highLate / highEarly);
  });

  it('低域・中域が高域より強い（打撃が軽く聞こえない）', () => {
    const low = shot(0, 0.3, 40, 150);
    const mid = shot(0, 0.3, 150, 500);
    const high = shot(0, 0.3, 800, 3000);
    expect(20 * Math.log10(low / high)).toBeGreaterThan(14);
    expect(20 * Math.log10(mid / high)).toBeGreaterThan(6);
  });

  it('衝撃は短く減衰し、鳴りっぱなしにならない', () => {
    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(silence());
    synth.triggerJoint({ delay: 0, strength: 1 });
    const out = new Float32Array(SAMPLE_RATE);
    synth.render(out);
    const head = rms(out.subarray(0, 2400));
    const tail = rms(out.subarray(SAMPLE_RATE - 2400));
    expect(head).toBeGreaterThan(1e-3);
    expect(tail).toBeLessThan(head / 100);
  });

  it('走行音に混ざっても衝撃として聞き取れる', () => {
    // 帯域通過を通した衝撃は、正規化のせいで見た目より遥かに小さくなる。
    // 「鳴ってはいるが転動音に埋もれて区別できない」という失敗をしたので、
    // 実際の走行音を背景に置いて突出しているかどうかで固める。
    const background: TrainNoiseParams = merge({
      // 約 90km/h
      gear: { meshFrequency: 1050, shaftFrequency: 62, load: 0, level: 0.385 },
      rolling: { speed: 24.7, corrugation: 0, level: 1 },
      wind: { speed: 24.7, level: 1 },
    });

    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(background);
    synth.render(new Float32Array(SAMPLE_RATE));

    const quiet = new Float32Array(2400);
    synth.render(quiet);
    synth.triggerJoint({ delay: 0, strength: 1 });
    const struck = new Float32Array(2400);
    synth.render(struck);

    // 衝撃の直後 50ms は、直前の 50ms より明確に大きくなければならない
    expect(rms(struck)).toBeGreaterThan(rms(quiet) * 1.8);
    let peak = 0;
    for (const v of struck) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(rms(quiet) * 4);
  });

  it('強さに比例した音量になる', () => {
    const shot = (strength: number): number => {
      const synth = new TrainNoiseSynth(SAMPLE_RATE);
      synth.setParams(silence());
      synth.triggerJoint({ delay: 0, strength });
      const out = new Float32Array(SAMPLE_RATE / 2);
      synth.render(out);
      return rms(out);
    };
    expect(shot(0.5)).toBeGreaterThan(shot(0.2));
    expect(shot(1)).toBeGreaterThan(shot(0.5));
  });

  it('同じ入力なら同じ波形になる（決定論）', () => {
    const once = (): string => {
      const synth = new TrainNoiseSynth(SAMPLE_RATE);
      synth.setParams(
        merge({
          gear: { meshFrequency: 1000, shaftFrequency: 59, load: 0.7, level: 1 },
          rolling: { speed: 25, corrugation: 0, level: 1 },
        }),
      );
      synth.triggerJoint({ delay: 128, strength: 0.8 });
      const out = new Float32Array(8192);
      synth.render(out);
      return Array.from(out).join(',');
    };
    expect(once()).toBe(once());
  });
});

describe('分岐器の衝撃', () => {
  /** 一撃を鳴らして波形を返す */
  const shot = (crossing: boolean, strength = 1, seconds = 1): Float32Array => {
    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(silence());
    synth.triggerTurnout({ delay: 0, strength, crossing });
    const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
    synth.render(out);
    return out;
  };

  it('予約したサンプル位置ちょうどから鳴り始める', () => {
    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(silence());
    synth.triggerTurnout({ delay: 700, strength: 1, crossing: true });
    const out = new Float32Array(4096);
    synth.render(out);
    let first = -1;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i]!) > 1e-6) {
        first = i;
        break;
      }
    }
    expect(first).toBe(700);
  });

  /**
   * 分岐器のクロッシングは、継目の段差より深く落ちてばね下がまるごと上下する。
   * 継目より低くて重い音になっていなければ、渡ったことが分からない。
   */
  it('レール継目より低く、長く残る', () => {
    const turnout = shot(true);
    const joint = (() => {
      const synth = new TrainNoiseSynth(SAMPLE_RATE);
      synth.setParams(silence());
      synth.triggerJoint({ delay: 0, strength: 1 });
      const out = new Float32Array(SAMPLE_RATE);
      synth.render(out);
      return out;
    })();
    const lowRatio = (x: Float32Array) =>
      bandPower(x, SAMPLE_RATE, 30, 120, 24) / bandPower(x, SAMPLE_RATE, 600, 3000, 24);
    expect(lowRatio(turnout)).toBeGreaterThan(lowRatio(joint));
    // 200ms 後にまだ残っている量も分岐器のほうが多い
    const late = (x: Float32Array) => rms(x.subarray(SAMPLE_RATE * 0.2, SAMPLE_RATE * 0.3));
    expect(late(turnout)).toBeGreaterThan(late(joint));
  });

  it('トングレールの衝撃はクロッシングより軽い', () => {
    expect(rms(shot(false))).toBeLessThan(rms(shot(true)));
  });

  it('衝撃は減衰し、鳴りっぱなしにならない', () => {
    const out = shot(true);
    const head = rms(out.subarray(0, 2400));
    const tail = rms(out.subarray(SAMPLE_RATE - 2400));
    expect(head).toBeGreaterThan(1e-3);
    expect(tail).toBeLessThan(head / 100);
  });

  it('走行音に混ざっても衝撃として聞き取れる', () => {
    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(
      merge({
        rolling: { speed: 24.7, corrugation: 0, level: 1 },
        wind: { speed: 24.7, level: 1 },
      }),
    );
    synth.render(new Float32Array(SAMPLE_RATE));
    const quiet = new Float32Array(2400);
    synth.render(quiet);
    synth.triggerTurnout({ delay: 0, strength: 1, crossing: true });
    const struck = new Float32Array(2400);
    synth.render(struck);
    expect(rms(struck)).toBeGreaterThan(rms(quiet) * 1.8);
  });

  it('レール継目とは別の音源として測れる', () => {
    const synth = new TrainNoiseSynth(SAMPLE_RATE);
    synth.setParams(silence());
    synth.triggerTurnout({ delay: 0, strength: 1, crossing: true });
    synth.render(new Float32Array(4800));
    const levels = new Float32Array(VOICE_COUNT);
    synth.readLevels(levels);
    expect(levels[VOICE.turnout]!).toBeGreaterThan(0);
    expect(levels[VOICE.railJoint]!).toBe(0);
  });

  it('同じ入力なら同じ波形になる（決定論）', () => {
    const once = (): string => Array.from(shot(true, 0.8, 0.1)).join(',');
    expect(once()).toBe(once());
  });
});

/**
 * 高速域でインバータ音がどれだけ聞こえるか。
 *
 * 弱め界磁に入ると磁束が 1/f₁ に落ちるので、電磁力は 1/f₁²（−40·log₁₀f）で
 * 減る。だから高速で静かになること自体は正しい。問題は**どこまで静かに
 * なるか**で、放射効率（一致周波数より下では f² に比例）と 2.4kHz 以上の
 * 構造モードを入れていなかったころは、電動機の音が高速域で走行音より 27dB も
 * 下に沈んで完全に聞こえなくなっていた。回転子スロット高調波は高速で 3.8kHz
 * まで上がるので、ちょうどモデルの穴に落ちていた。
 */
describe('高速域のインバータ音', () => {
  /** 運転台で聞こえる A 特性音量（歯車は M 車の床下なので遠い） */
  const heard = (kmh: number, f1: number, pulses: number, carrier: number) => {
    const shaft = ((kmh / 3.6 / 0.43) * 7.07) / (2 * Math.PI);
    const inverter = render(
      merge({
        inverter: {
          gate: true,
          fundamental: f1,
          carrier,
          modulation: Math.min(1, f1 / 53),
          pulses,
          slotFrequency: shaft * 44,
          level: 0.385,
        },
      }),
    );
    const background = render(
      merge({
        gear: { meshFrequency: shaft * 17, shaftFrequency: shaft, load: 1, level: 0.385 },
        rolling: { speed: kmh / 3.6, corrugation: 0, level: 1 },
        wind: { speed: kmh / 3.6, level: 1 },
      }),
    );
    return (
      20 * Math.log10(aWeightedRms(inverter, SAMPLE_RATE) / aWeightedRms(background, SAMPLE_RATE))
    );
  };

  it('低速では走行音を圧倒する', () => {
    // 起動時の「ヒュイーン」が編成でいちばん目立つ音であること
    expect(heard(20, 31, 9, 279)).toBeGreaterThan(6);
  });

  it('最高速度でも走行音に埋もれきらない', () => {
    // 走行音より下にはいるが、聞き取れる範囲に留まる
    const top = heard(120, 176, 1, 0);
    expect(top).toBeLessThan(0);
    expect(top).toBeGreaterThan(-22);
  });

  it('速度とともに主役が走行音へ移る（単調に下がる）', () => {
    const low = heard(35, 53, 3, 159);
    const mid = heard(80, 118, 1, 0);
    const top = heard(120, 176, 1, 0);
    expect(mid).toBeLessThan(low);
    expect(top).toBeLessThan(mid);
  });
});

describe('ロングレール区間で高速に出る音', () => {
  const rolling = (kmh: number, corrugation: number): Float32Array =>
    render(merge({ rolling: { speed: kmh / 3.6, corrugation, level: 1 } }));

  /** 波状摩耗の代表波長 55mm から決まるうなりの周波数 */
  const hum = (kmh: number): number => kmh / 3.6 / 0.055;

  /**
   * 唸りの峰が周囲の谷に対して何 dB 立っているか。
   * 雑音のスペクトルは 1 点ごとの散らばりが大きいので、帯域で均して測る。
   */
  const humPeak = (x: Float32Array, f: number): number => {
    const band = (lo: number, hi: number): number =>
      Math.sqrt(bandPower(x, SAMPLE_RATE, f * lo, f * hi, 16));
    return 20 * Math.log10(band(0.93, 1.07) / ((band(0.5, 0.7) + band(1.4, 1.8)) / 2));
  };

  it('波状摩耗が v / 波長 の唸りを作り、速度とともに音程が上がる', () => {
    // 転動音そのものが帯域を持っているので、峰の有無は**削正されたレールとの差**で
    // 見る。そうしないと転動音のスペクトルの傾きを峰と読んでしまう。
    for (const kmh of [60, 120]) {
      const worn = humPeak(rolling(kmh, 0.7), hum(kmh));
      const smooth = humPeak(rolling(kmh, 0), hum(kmh));
      expect(worn - smooth).toBeGreaterThan(4);
    }
    // 120km/h の音を 60km/h の唸りの位置で見ても、何も立っていない
    const off = humPeak(rolling(120, 0.7), hum(60)) - humPeak(rolling(120, 0), hum(60));
    expect(off).toBeLessThan(1);
  });

  it('まくらぎ通過で転動音が v / 0.6m の周期で脈動する', () => {
    // レールはまくらぎの上で硬く、間では柔らかい。支持剛性の周期変化が
    // 接触力を脈動させるので、包絡（整流した波形）にその周波数の峰が立つ。
    const speed = 100 / 3.6;
    const x = rolling(100, 0);
    const envelope = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) envelope[i] = Math.abs(x[i]!);
    const sleeper = speed / 0.6;
    expect(peakProminence(envelope, SAMPLE_RATE, sleeper, 12)).toBeGreaterThan(4);
  });
});

describe('空気ばねのきしみ', () => {
  const spring = (strokeRate: number): Float32Array =>
    render(merge({ airSpring: { strokeRate, level: 1 } }));

  it('車体が動いていなければ無音', () => {
    expect(rms(spring(0))).toBeLessThan(1e-5);
  });

  it('擦れは伸縮が速いほど大きい（摩擦の仕事率）', () => {
    expect(rms(spring(0.04))).toBeGreaterThan(rms(spring(0.01)));
  });

  it('きしみは「動いてはいるが遅い」ときにだけ出る', () => {
    // スティックスリップの自励振動なので、速く滑ると固着する暇が無く鳴かない。
    // 制輪子の鳴きとまったく同じ条件。擦れの音は速いほど大きくなるので、
    // 「きしみの帯（780Hz）が擦れの帯（360Hz）に対してどれだけ立っているか」で
    // 見る。こうすれば全体の音量に引きずられない。
    const ratio = (rate: number): number => {
      const x = spring(rate);
      return bandPower(x, SAMPLE_RATE, 740, 820, 8) / bandPower(x, SAMPLE_RATE, 300, 420, 8);
    };
    expect(ratio(0.025)).toBeGreaterThan(ratio(0.3) * 3);
  });
});

describe('運転台の音', () => {
  const alarm = (over: Partial<TrainNoiseParams['alarm']>): Float32Array =>
    render(merge({ alarm: { ...silence().alarm, level: 1, ...over } }));

  /**
   * 保安装置と警笛は**運転台の中**で鳴るので距離減衰を受けない。走行音に
   * 埋もれてしまっては装置の意味が無いのだから、走行音より大きいのは
   * 都合ではなく設計である。
   */
  const RUNNING_A = (): number => aWeightedRms(render(COASTING_80()), SAMPLE_RATE);

  it('打鈴・チャイム・ブザーがそれぞれ独立に鳴る', () => {
    expect(rms(alarm({ bell: true }))).toBeGreaterThan(1e-3);
    expect(rms(alarm({ chime: true }))).toBeGreaterThan(1e-3);
    expect(rms(alarm({ patternApproach: true }))).toBeGreaterThan(1e-3);
    expect(rms(alarm({}))).toBeLessThan(1e-5);
  });

  it('報知音は 80km/h の走行音より大きい（埋もれない）', () => {
    const running = RUNNING_A();
    for (const on of [{ bell: true }, { chime: true }, { patternApproach: true }]) {
      expect(aWeightedRms(alarm(on), SAMPLE_RATE)).toBeGreaterThan(running);
    }
  });

  it('打鈴はハンマーの打数で脈動する（持続音ではない）', () => {
    const x = alarm({ bell: true });
    const envelope = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) envelope[i] = Math.abs(x[i]!);
    expect(peakProminence(envelope, SAMPLE_RATE, 32, 10)).toBeGreaterThan(4);
  });

  describe('警笛', () => {
    const horn = (sounding: boolean): Float32Array =>
      render(merge({ horn: { sounding, level: 1 } }));

    it('吹鳴すると走行音より大きく鳴る', () => {
      expect(aWeightedRms(horn(true), SAMPLE_RATE)).toBeGreaterThan(RUNNING_A() * 2);
      expect(rms(horn(false))).toBeLessThan(1e-5);
    });

    it('2 管の和音になっている（単音ではない）', () => {
      const x = horn(true);
      expect(peakProminence(x, SAMPLE_RATE, 311, 40)).toBeGreaterThan(6);
      expect(peakProminence(x, SAMPLE_RATE, 370, 25)).toBeGreaterThan(6);
    });

    it('リードの音なので倍音が豊か', () => {
      const x = horn(true);
      // 基音の 2 倍・3 倍にもはっきり峰が立つ
      expect(peakProminence(x, SAMPLE_RATE, 622, 40)).toBeGreaterThan(6);
      expect(peakProminence(x, SAMPLE_RATE, 933, 40)).toBeGreaterThan(6);
    });

    it('離すと圧力が抜けて消える', () => {
      const synth = new TrainNoiseSynth(SAMPLE_RATE);
      synth.setParams(merge({ horn: { sounding: true, level: 1 } }));
      synth.render(new Float32Array(SAMPLE_RATE / 2));
      synth.setParams(merge({ horn: { sounding: false, level: 1 } }));
      const out = new Float32Array(SAMPLE_RATE / 2);
      synth.render(out);
      expect(rms(out.subarray(0, 2400))).toBeGreaterThan(1e-3);
      expect(rms(out.subarray(out.length - 2400))).toBeLessThan(1e-5);
    });
  });
});
