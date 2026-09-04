import { describe, expect, it } from 'vitest';
import { BridgeVoice, RollingVoice, SILENT_BRIDGE, type BridgeVoiceParams } from '../../src/railsim/audio/index.ts';
import { bridgeAcoustics, type Bridge } from '../../src/railsim/core/index.ts';
import { aWeightedRms, bandPower, rms } from './spectrum.ts';

const SAMPLE_RATE = 48_000;
const SPEED = 25;

/** 支間 30m の上路プレートガーダー橋（無道床）— 「橋を渡る音」の基準 */
const plateGirder = (over: Partial<Bridge> = {}): Bridge => ({
  id: 'br',
  name: '橋',
  start: 0,
  end: 100,
  kind: 'plate-girder',
  deck: 'open',
  spanLength: 30,
  girderDepth: 2.5,
  panel: { thickness: 0.012, height: 2.5, width: 1.75 },
  sleeperSpacing: 0.58,
  ...over,
});

const params = (bridge: Bridge, over: Partial<BridgeVoiceParams> = {}): BridgeVoiceParams => {
  const acoustics = bridgeAcoustics(bridge);
  return {
    ...SILENT_BRIDGE,
    speed: SPEED,
    coverage: 1,
    radiation: acoustics.radiation,
    reflection: acoustics.reflection,
    modes: acoustics.modes,
    weights: acoustics.weights,
    damping: acoustics.damping,
    sleeperSpacing: bridge.sleeperSpacing,
    level: 1,
    ...over,
  };
};

function render(p: BridgeVoiceParams, seconds = 1): Float32Array {
  const voice = new BridgeVoice(SAMPLE_RATE);
  voice.setParams(p);
  const out = new Float32Array(Math.floor(SAMPLE_RATE * seconds));
  voice.render(out);
  return out;
}

/** 比較の物差し。同じ速度の転動音（明かり区間の走行音）。 */
function rollingReference(speed = SPEED): number {
  const voice = new RollingVoice(SAMPLE_RATE);
  voice.setParams({ speed, corrugation: 0.2, level: 1 });
  const out = new Float32Array(SAMPLE_RATE);
  voice.render(out);
  return aWeightedRms(out, SAMPLE_RATE);
}

const loudness = (p: BridgeVoiceParams): number =>
  aWeightedRms(render(p, 1.5).subarray(SAMPLE_RATE) as unknown as Float32Array, SAMPLE_RATE);

describe('橋りょうの音', () => {
  it('桁に乗っていなければ鳴らない', () => {
    expect(rms(render(params(plateGirder(), { coverage: 0 })))).toBe(0);
  });

  it('止まっていれば鳴らない（音源は車輪とレールの粗さなので）', () => {
    expect(rms(render(params(plateGirder(), { speed: 0 })))).toBe(0);
  });

  it('無道床の鋼橋は明かり区間の走行音より大きい', () => {
    const bridge = loudness(params(plateGirder()));
    // 実測でも無道床鋼橋は明かり区間より 10〜20dB 高い。転動音が残ることも考えると
    // 音源単体でこの程度にならないと「橋に入った瞬間に音が変わる」にならない。
    expect(bridge).toBeGreaterThan(rollingReference() * 2);
    expect(bridge).toBeLessThan(rollingReference() * 8);
  });

  it('同じ桁でも道床を入れれば 10dB 以上静かになる', () => {
    const open = loudness(params(plateGirder()));
    const ballasted = loudness(params(plateGirder({ deck: 'ballasted' })));
    expect(ballasted).toBeLessThan(open * 0.32);
  });

  it('コンクリート桁はほとんど音が変わらない（厚い床版は動かない）', () => {
    const concrete = plateGirder({
      kind: 'concrete',
      deck: 'ballasted',
      panel: { thickness: 0.25, height: 3.6, width: 25 },
      sleeperSpacing: 25 / 44,
    });
    expect(loudness(params(concrete))).toBeLessThan(rollingReference() * 0.4);
  });

  it('板が小さく薄いほど音程が高い（トラスの床組と上路桁の腹板）', () => {
    const truss = plateGirder({
      kind: 'truss',
      panel: { thickness: 0.009, height: 0.9, width: 1.4 },
    });
    const low = (x: Float32Array): number => bandPower(x, SAMPLE_RATE, 40, 160);
    const high = (x: Float32Array): number => bandPower(x, SAMPLE_RATE, 300, 700);
    const girderOut = render(params(plateGirder()), 1);
    const trussOut = render(params(truss), 1);
    // 帯域の重心が上がる（同じ「橋の音」でも「ゴー」と「ガーッ」の違いになる）
    expect(high(trussOut) / low(trussOut)).toBeGreaterThan((high(girderOut) / low(girderOut)) * 5);
  });

  it('桁に乗っている編成の割合で音量が決まる', () => {
    const full = loudness(params(plateGirder()));
    const quarter = loudness(params(plateGirder(), { coverage: 0.25 }));
    expect(quarter).toBeGreaterThan(0);
    expect(quarter).toBeLessThan(full * 0.4);
  });

  it('速度が上がると大きくなる（加振力は転動音と同じ速度依存）', () => {
    const slow = loudness(params(plateGirder(), { speed: 10 }));
    const fast = loudness(params(plateGirder(), { speed: 30 }));
    // v^1.5 なら 3 倍の速度で 5.2 倍。接触フィルタのぶんだけ上乗せされる。
    expect(fast).toBeGreaterThan(slow * 4);
  });

  it('音量を 0 にすれば鳴らない', () => {
    expect(rms(render(params(plateGirder(), { level: 0 })))).toBe(0);
  });
});
