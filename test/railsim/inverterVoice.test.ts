import { describe, expect, it } from 'vitest';
import { InverterVoice, type InverterVoiceParams, type InverterVoiceOptions } from '../../src/railsim/audio/index.ts';
import { bandPower, goertzel, peakProminence, rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;
/** 1 秒ぶんレンダすれば 1Hz 分解能で峰が見える */
const LENGTH = SAMPLE_RATE;

const params = (over: Partial<InverterVoiceParams> = {}): InverterVoiceParams => ({
  gate: true,
  fundamental: 30,
  carrier: 450,
  modulation: 0.6,
  pulses: 0,
  slotFrequency: 0,
  level: 1,
  ...over,
});

/**
 * 定常状態を 1 秒ぶんレンダする。
 * 平滑化（磁束確立の 60ms を含む）と共振の立ち上がりを含まないよう、
 * 最初の 0.5 秒は捨てる。振幅が動いているあいだにスペクトルを取ると、
 * その包絡が変調として効いて谷が埋まってしまう。
 */
function render(
  p: InverterVoiceParams,
  options: InverterVoiceOptions = {},
  length = LENGTH,
): Float32Array {
  const voice = new InverterVoice(SAMPLE_RATE, options);
  voice.setParams(p);
  const warmup = new Float32Array(Math.floor(SAMPLE_RATE * 0.5));
  voice.render(warmup);
  const out = new Float32Array(length);
  voice.render(out);
  return out;
}

describe('PWM 波形から合成するインバータ音', () => {
  it('非同期モードでキャリアの左右に出力周波数のサイドバンドが立つ', () => {
    // これが合成の正しさの中心。個別に発振器を置いていないのに、三角波比較と
    // 磁束の 2 乗だけからサイドバンドが現れることを確かめる。
    const f1 = 30;
    const fc = 450;
    const x = render(params({ fundamental: f1, carrier: fc }));

    // 1 次と 3 次のサイドバンド（420/480 と 360/540）。谷は ±15Hz に取る。
    for (const k of [1, 3]) {
      expect(peakProminence(x, SAMPLE_RATE, fc - k * f1, f1 / 2)).toBeGreaterThan(8);
      expect(peakProminence(x, SAMPLE_RATE, fc + k * f1, f1 / 2)).toBeGreaterThan(8);
    }
  });

  it('3 相の打ち消しでキャリアそのものと偶数次サイドバンドが消える', () => {
    // 線間中性点電圧を取ると零相分が消えるため、キャリア周波数ちょうどの成分と
    // その偶数次サイドバンドは現れない。実機の PWM でも同じことが起きる。
    // 打ち消しを見ていない実装（1 相だけで作るなど）はここで落ちる。
    const f1 = 30;
    const fc = 450;
    const x = render(params({ fundamental: f1, carrier: fc }));
    const sideband = goertzel(x, SAMPLE_RATE, fc - f1);
    for (const f of [fc, fc - 2 * f1, fc + 2 * f1]) {
      expect(goertzel(x, SAMPLE_RATE, f)).toBeLessThan(sideband * 1e-6);
    }
  });

  it('電磁力は出力周波数の偶数倍にしか現れない', () => {
    // 力は磁束の 2 乗なので、磁束の成分どうしの和と差だけが残る。
    // 磁束は奇数次しか持たない（3 相の打ち消し）ため、力は必ず偶数次になる。
    // 「回転数の 2 倍の唸り」が実機で聞こえるのはこれ。
    const f1 = 40;
    const x = render(params({ fundamental: f1, carrier: 600 }));
    const hum = goertzel(x, SAMPLE_RATE, 2 * f1);
    expect(peakProminence(x, SAMPLE_RATE, 2 * f1, f1 / 2)).toBeGreaterThan(8);
    for (const k of [1, 3, 5]) {
      expect(goertzel(x, SAMPLE_RATE, k * f1)).toBeLessThan(hum * 1e-6);
    }
  });

  it('出力周波数を変えるとサイドバンドは動き、キャリアの峰は動かない', () => {
    const fc = 500;
    const a = render(params({ fundamental: 25, carrier: fc }));
    const b = render(params({ fundamental: 45, carrier: fc }));

    // それぞれの f1 に応じた位置にサイドバンドが立つ
    expect(peakProminence(a, SAMPLE_RATE, fc - 25, 12)).toBeGreaterThan(8);
    expect(peakProminence(b, SAMPLE_RATE, fc - 45, 12)).toBeGreaterThan(8);
    // 相手側の位置には立たない
    expect(peakProminence(a, SAMPLE_RATE, fc - 45, 12)).toBeLessThan(
      peakProminence(b, SAMPLE_RATE, fc - 45, 12),
    );
  });

  it('同期モードではすべての成分が出力周波数の整数倍に乗る（うなりが出ない）', () => {
    // 9 パルス・f1 = 35Hz → キャリア 315Hz。すべての成分が 35Hz の倍数になるはず。
    const f1 = 35;
    const x = render(params({ fundamental: f1, carrier: 9 * f1, pulses: 9 }));
    // キャリア ± f1（8f1, 10f1）と ± 3f1（6f1, 12f1）に峰が立つ
    for (const k of [6, 8, 10, 12]) {
      expect(peakProminence(x, SAMPLE_RATE, k * f1, f1 / 2)).toBeGreaterThan(8);
    }
    // 整数倍から外れた位置（9.5 f1 など）は谷でしかない。位相がロックされて
    // いない実装なら、ここに周波数の揺らぎによる裾が出る。
    for (const k of [7.5, 9.5, 11.5]) {
      expect(peakProminence(x, SAMPLE_RATE, k * f1, f1 / 4)).toBeLessThan(3);
    }
  });

  it('一パルスではキャリアの帯が消え、低次の偶数次高調波が主役になる', () => {
    const f1 = 60;
    const one = render(params({ fundamental: f1, carrier: 0, pulses: 1, modulation: 1 }));
    // キャリアを出力周波数の整数倍から外して（非同期 470Hz）、キャリア由来の
    // 成分と回転由来の成分を周波数で区別できるようにする
    const fc = 470;
    const pwm = render(params({ fundamental: f1, carrier: fc, pulses: 0 }));

    // 矩形波の磁束（奇数次）を 2 乗した偶数次だけが残る
    for (const k of [2, 4, 6]) {
      expect(peakProminence(one, SAMPLE_RATE, k * f1, f1 / 2)).toBeGreaterThan(8);
    }

    // 非同期 PWM にはキャリア ± f₁ の峰が立つが、一パルスのほうにはそこに何も無い。
    // 実車で高速域に入るとインバータの「音程」が消えて低い唸りだけになるのがこれ。
    for (const f of [fc - f1, fc + f1]) {
      expect(peakProminence(pwm, SAMPLE_RATE, f, f1 / 2)).toBeGreaterThan(8);
      expect(goertzel(one, SAMPLE_RATE, f)).toBeLessThan(goertzel(pwm, SAMPLE_RATE, f) * 1e-4);
    }
  });

  it('回転子スロット高調波がスロット周波数 ± 2f₁ の側帯波を作る', () => {
    const f1 = 40;
    const slot = 1500;
    const x = render(params({ fundamental: f1, carrier: 600, slotFrequency: slot }));
    // パーミアンス変動は磁束に掛け算で入るので、2 乗すると slot ± 2f1 に出る
    expect(peakProminence(x, SAMPLE_RATE, slot - 2 * f1, f1 / 2)).toBeGreaterThan(4);
    expect(peakProminence(x, SAMPLE_RATE, slot + 2 * f1, f1 / 2)).toBeGreaterThan(4);
  });

  it('弱め界磁に入ると磁気音が弱まる（V/f 一定の帰結）', () => {
    // 基底周波数以下は V/f 一定なので磁束が一定、以上は電圧が頭打ちで磁束 ∝ 1/f。
    const low = rms(render(params({ fundamental: 25, carrier: 450, modulation: 25 / 53 })));
    const base = rms(render(params({ fundamental: 53, carrier: 477, pulses: 9, modulation: 1 })));
    const weak = rms(render(params({ fundamental: 150, carrier: 0, pulses: 1, modulation: 1 })));
    // 基底以下では磁束が保たれるので、低速でも音が痩せない
    expect(low).toBeGreaterThan(base * 0.4);
    // 弱め界磁では磁束が落ちる
    expect(weak).toBeLessThan(base);
  });

  it('主回路が切れていれば完全な無音になる', () => {
    const x = render(params({ level: 0 }));
    expect(rms(x)).toBeLessThan(1e-4);
  });

  it('変調率 0 でも発散しない', () => {
    const x = render(params({ modulation: 0 }));
    for (let i = 0; i < x.length; i++) {
      expect(Number.isFinite(x[i]!)).toBe(true);
      expect(Math.abs(x[i]!)).toBeLessThan(4);
    }
  });

  it('全域で発散せず、無音にもならない', () => {
    // 飽和は合成全体（`TrainNoiseSynth`）で最後に 1 回だけ掛けるので、
    // ここでは「暴れていないこと」だけを見る。
    for (const f1 of [2, 18, 53, 120, 200]) {
      const x = render(
        params({ fundamental: f1, carrier: f1 < 18 ? 480 : 0, pulses: f1 < 18 ? 0 : 1 }),
      );
      const peak = Math.max(...Array.from(x, Math.abs));
      expect(Number.isFinite(peak)).toBe(true);
      expect(peak).toBeLessThan(4);
      expect(rms(x)).toBeGreaterThan(1e-5);
    }
  });

  it('オーバーサンプリングを切ると折り返し成分が増える', () => {
    // 比較器の出力は理想的な矩形波なので、そのままの速度で作ると
    // 高次高調波がナイキストで折り返して低域へ落ちてくる。
    const p = params({ fundamental: 47, carrier: 9 * 47, pulses: 9 });
    // 出力周波数の整数倍から外れた位置＝本来何も無いはずの場所を見る
    const probe = (x: Float32Array): number => bandPower(x, SAMPLE_RATE, 3020, 3080);
    const withOs = probe(render(p, { oversample: 4 }));
    const without = probe(render(p, { oversample: 1 }));
    expect(without).toBeGreaterThan(withOs * 2);
  });

  it('同じパラメータなら同じ波形になる（決定論）', () => {
    const a = render(params({ fundamental: 33, carrier: 400 }), {}, 4096);
    const b = render(params({ fundamental: 33, carrier: 400 }), {}, 4096);
    expect(Array.from(a).join(',')).toBe(Array.from(b).join(','));
  });

  it('パルスモードが切り替わっても波形が飛ばない（クリックが出ない）', () => {
    // 9 パルス → 5 パルスの切替は実車でも音程が段で落ちるが、電圧に段差は作らない。
    const voice = new InverterVoice(SAMPLE_RATE);
    const f1 = 40;
    voice.setParams(params({ fundamental: f1, carrier: 9 * f1, pulses: 9 }));
    const before = new Float32Array(SAMPLE_RATE * 0.3);
    voice.render(before);
    voice.setParams(params({ fundamental: f1, carrier: 5 * f1, pulses: 5 }));
    const after = new Float32Array(512);
    voice.render(after);

    // 切替直後のサンプルが、切替前の振幅の範囲を大きく超えない
    let priorPeak = 0;
    for (let i = before.length - 2048; i < before.length; i++) {
      priorPeak = Math.max(priorPeak, Math.abs(before[i]!));
    }
    let jump = 0;
    for (let i = 0; i < 64; i++) jump = Math.max(jump, Math.abs(after[i]!));
    expect(jump).toBeLessThan(priorPeak * 2 + 0.05);
  });

  /**
   * ノッチの入切は、実車では「電圧が掛かるか掛からないか」でしかない。合成でも
   * 音量ではなくゲートで表しているので、切れば磁束が電動機自身の時定数で
   * 減衰し、入れれば立ち上がる。以下はどちらの過渡でも**定常より大きな音が
   * 出ない**ことを見る。
   *
   * 出力周波数を 0 へ落とす実装だと、磁束が積分（利得 ∝ 1/f）であるために
   * 消えぎわで利得が跳ね上がり、80km/h では定常の 14 倍もの掃引音が出る。
   * 実際にそれが「ピッ」という異音として聞こえていた。
   */
  describe('ノッチの入切', () => {
    /** 定常のピークと、遷移させてからのピークを返す */
    const transition = (
      before: InverterVoiceParams,
      after: InverterVoiceParams,
    ): { steady: number; peak: number } => {
      const voice = new InverterVoice(SAMPLE_RATE);
      voice.setParams(before);
      const warm = new Float32Array(SAMPLE_RATE * 0.5);
      voice.render(warm);
      let steady = 0;
      for (const v of warm.subarray(warm.length - 4096)) steady = Math.max(steady, Math.abs(v));

      voice.setParams(after);
      const out = new Float32Array(SAMPLE_RATE * 0.15);
      voice.render(out);
      let peak = 0;
      for (const v of out) peak = Math.max(peak, Math.abs(v));
      return { steady, peak };
    };

    const RUNNING = params({ fundamental: 116, carrier: 0, pulses: 1, modulation: 1 });
    const COASTING = params({
      gate: false,
      fundamental: 116,
      carrier: 0,
      pulses: 0,
      modulation: 0,
    });
    const SYNC9 = params({ fundamental: 33, carrier: 297, pulses: 9, modulation: 0.62 });
    const SYNC9_OFF = params({
      gate: false,
      fundamental: 33,
      carrier: 0,
      pulses: 0,
      modulation: 0,
    });

    it('ゲートを切ると定常より大きくならずに減衰する', () => {
      for (const [on, off] of [
        [RUNNING, COASTING],
        [SYNC9, SYNC9_OFF],
      ] as const) {
        const { steady, peak } = transition(on, off);
        expect(peak).toBeLessThan(steady);
      }
    });

    it('ゲートを切れば 0.15 秒後には無音になっている', () => {
      const voice = new InverterVoice(SAMPLE_RATE);
      voice.setParams(RUNNING);
      voice.render(new Float32Array(SAMPLE_RATE * 0.5));
      voice.setParams(COASTING);
      voice.render(new Float32Array(SAMPLE_RATE * 0.15));
      const tail = new Float32Array(4096);
      voice.render(tail);
      expect(rms(tail)).toBeLessThan(1e-6);
    });

    it('ゲートを入れても突入の突出が定常を超えない', () => {
      // 磁束の無い電動機へ電圧をいきなり掛けると励磁突入（磁束の直流分）が
      // 起きる。変調率を鈍らせて電圧を絞って入ることで抑えている。
      for (const [off, on] of [
        [COASTING, RUNNING],
        [SYNC9_OFF, SYNC9],
      ] as const) {
        const steady = transition(on, on).steady;
        const { peak } = transition(off, on);
        expect(peak).toBeLessThan(steady);
      }
    });
  });
});
