import { describe, expect, it } from 'vitest';
import { CrossingVoice, SILENT_CROSSING, type CrossingVoiceParams } from '../../src/railsim/audio/index.ts';
import { bandPower, goertzel, rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;
/** 電子式の基本周波数（`crossingVoice.ts` の ELECTRONIC_BASE） */
const BASE = 700;
/** 空気中の音速 [m/s] */
const SOUND_SPEED = 343;

const params = (over: Partial<CrossingVoiceParams> = {}): CrossingVoiceParams => ({
  ...SILENT_CROSSING,
  ringing: true,
  bell: 'electronic',
  distance: 0,
  lateral: 3.5,
  postSpacing: 10,
  speed: 0,
  level: 1,
  ...over,
});

function render(p: CrossingVoiceParams, seconds = 2): Float32Array {
  const voice = new CrossingVoice(SAMPLE_RATE);
  voice.setParams(p);
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  voice.render(out);
  return out;
}

/** 基本周波数の近くで、いちばんパワーの大きい周波数を探す */
function dominantFrequency(x: Float32Array, around: number, span: number): number {
  let best = around;
  let bestPower = -Infinity;
  for (let f = around - span; f <= around + span; f += 1) {
    const power = goertzel(x, SAMPLE_RATE, f);
    if (power > bestPower) {
      bestPower = power;
      best = f;
    }
  }
  return best;
}

describe('踏切の警報音', () => {
  it('鳴動していなければ（余韻が消えたあとは）静か', () => {
    const voice = new CrossingVoice(SAMPLE_RATE);
    voice.setParams(params({ ringing: false }));
    const out = new Float32Array(SAMPLE_RATE);
    voice.render(out);
    // 打ち直さないので、最後の 1 打の余韻が消えたあとは無音になる
    expect(rms(out.subarray(SAMPLE_RATE / 2) as unknown as Float32Array)).toBeLessThan(1e-6);
  });

  it('近づくほど大きい（音源は線路脇の 1 点なので距離に反比例する）', () => {
    const far = rms(render(params({ distance: 200 })));
    const near = rms(render(params({ distance: 20 })));
    const beside = rms(render(params({ distance: 0 })));
    expect(near).toBeGreaterThan(far * 3);
    expect(beside).toBeGreaterThan(near * 1.5);
  });

  it('遠いほど高い成分が先に失われる（空気の吸収）', () => {
    const ratio = (distance: number): number => {
      const out = render(params({ distance }));
      return bandPower(out, SAMPLE_RATE, 1800, 2400) / bandPower(out, SAMPLE_RATE, 600, 800);
    };
    expect(ratio(300)).toBeLessThan(ratio(10) * 0.5);
  });

  it('通り過ぎると音程が下がる（ドップラー効果）', () => {
    const speed = 30;
    const approaching = dominantFrequency(render(params({ distance: 120, speed })), BASE, 120);
    const receding = dominantFrequency(render(params({ distance: -120, speed })), BASE, 120);
    // 観測者が動く場合の式 f (1 ± v/c)。ほぼ真正面・真後ろなので全速度が視線方向に乗る。
    expect(approaching).toBeCloseTo(BASE * (1 + speed / SOUND_SPEED), -1);
    expect(receding).toBeCloseTo(BASE * (1 - speed / SOUND_SPEED), -1);
    expect(approaching - receding).toBeGreaterThan(100);
  });

  it('止まっていれば音程は動かない（動いているのは自分だけなので）', () => {
    const ahead = dominantFrequency(render(params({ distance: 120, speed: 0 })), BASE, 120);
    const behind = dominantFrequency(render(params({ distance: -120, speed: 0 })), BASE, 120);
    expect(ahead).toBeCloseTo(BASE, -1);
    expect(behind).toBeCloseTo(BASE, -1);
  });

  it('踏切のまん中では 2 台が違う音程で鳴る', () => {
    // 警報機は踏切道の両側に建っているので、渡っている最中は**片方が近づき、
    // もう片方が遠ざかっている**。同じ機種の 2 台なのに音程がずれて聞こえるのは
    // このためで、実物の踏切を渡るときの独特の響きはここから出る。
    const out = render(params({ distance: 0, speed: 30 }));
    const at = (f: number): number => bandPower(out, SAMPLE_RATE, f * 0.99, f * 1.01);
    const shift = (30 * 5) / Math.hypot(5, 3.5) / SOUND_SPEED;
    expect(at(BASE * (1 + shift))).toBeGreaterThan(at(BASE) * 4);
    expect(at(BASE * (1 - shift))).toBeGreaterThan(at(BASE) * 4);
  });

  it('電子式は基本波の整数倍に部分音が並ぶ', () => {
    const out = render(params({ bell: 'electronic' }));
    const at = (f: number): number => bandPower(out, SAMPLE_RATE, f * 0.97, f * 1.03);
    // 2 倍・3 倍の位置に峰が立つ（発振器の音なので当然そうなる）
    expect(at(BASE * 2)).toBeGreaterThan(at(BASE * 2.4) * 5);
    expect(at(BASE * 3)).toBeGreaterThan(at(BASE * 2.4) * 3);
  });

  it('電鐘式は整数倍に並ばない（鐘の部分音は非整数比）', () => {
    const out = render(params({ bell: 'gong' }));
    const at = (f: number): number => bandPower(out, SAMPLE_RATE, f * 0.97, f * 1.03);
    // 545Hz の 2 倍（1090Hz）には何も無く、2.17 倍（1183Hz）に峰がある
    expect(at(545 * 2.17)).toBeGreaterThan(at(545 * 2) * 4);
  });

  it('電鐘式のほうが余韻が長い（鐘は次の打撃まで鳴り続ける）', () => {
    // 打撃と打撃のあいだにどれだけ残っているかは、波形の実効値と最大値の比に出る。
    // 短く切れる音ほど「谷」が深くなり、この比が小さくなる。
    const sustain = (bell: CrossingVoiceParams['bell']): number => {
      const out = render(params({ bell }), 3);
      let peak = 0;
      for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
      return rms(out) / peak;
    };
    expect(sustain('gong')).toBeGreaterThan(sustain('electronic') * 1.3);
  });

  it('音量を 0 にすれば鳴らない', () => {
    expect(rms(render(params({ level: 0 })))).toBe(0);
  });
});
