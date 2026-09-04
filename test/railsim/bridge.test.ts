import { describe, expect, it } from 'vitest';
import { BridgeTrack, bridgeAcoustics, bridgeLength, type Bridge } from '../../src/railsim/core/index.ts';

/** 支間 30m の上路プレートガーダー橋（無道床）*/
const girder = (over: Partial<Bridge> = {}): Bridge => ({
  id: 'br',
  name: '橋',
  start: 100,
  end: 200,
  kind: 'plate-girder',
  deck: 'open',
  spanLength: 30,
  girderDepth: 2.5,
  panel: { thickness: 0.012, height: 2.5, width: 1.75 },
  sleeperSpacing: 0.58,
  ...over,
});

describe('橋りょう', () => {
  it('板の曲げモードは板厚に比例する', () => {
    const thin = bridgeAcoustics(girder());
    const thick = bridgeAcoustics(
      girder({ panel: { thickness: 0.024, height: 2.5, width: 1.75 } }),
    );
    // f ∝ t（板厚を 2 倍にすれば周波数も 2 倍）
    expect(thick.modes[0]).toBeCloseTo(thin.modes[0] * 2, 6);
    expect(thick.modes[2]).toBeCloseTo(thin.modes[2] * 2, 6);
  });

  it('板の曲げモードは寸法の 2 乗に反比例する', () => {
    const large = bridgeAcoustics(girder());
    const half = bridgeAcoustics(
      girder({ panel: { thickness: 0.012, height: 1.25, width: 0.875 } }),
    );
    // f ∝ 1/a²（板を半分の大きさにすれば 4 倍の周波数になる）
    expect(half.modes[0]).toBeCloseTo(large.modes[0] * 4, 6);
  });

  it('上路プレートガーダー橋の卓越帯域は 60〜250Hz になる', () => {
    const acoustics = bridgeAcoustics(girder());
    expect(acoustics.modes[0]).toBeGreaterThan(40);
    expect(acoustics.modes[0]).toBeLessThan(80);
    expect(acoustics.modes[2]).toBeGreaterThan(180);
    expect(acoustics.modes[2]).toBeLessThan(280);
  });

  it('トラスの床組は上路桁の腹板より高く鳴る（板が小さく薄いので）', () => {
    const truss = bridgeAcoustics(
      girder({ kind: 'truss', panel: { thickness: 0.009, height: 0.9, width: 1.4 } }),
    );
    expect(truss.modes[0]).toBeGreaterThan(bridgeAcoustics(girder()).modes[0] * 2);
  });

  it('道床を入れると桁へ届く力が減り、減衰も増える', () => {
    const open = bridgeAcoustics(girder());
    const ballasted = bridgeAcoustics(girder({ deck: 'ballasted' }));
    expect(ballasted.radiation).toBeLessThan(open.radiation * 0.5);
    expect(ballasted.damping).toBeGreaterThan(open.damping);
    // 板そのものは変わらないので、音程は変わらない（変わるのは大きさだけ）
    expect(ballasted.modes[0]).toBeCloseTo(open.modes[0], 9);
  });

  it('コンクリート床版は鋼板より 2 桁動きにくい', () => {
    const concrete = bridgeAcoustics(
      girder({
        kind: 'concrete',
        deck: 'ballasted',
        panel: { thickness: 0.25, height: 3.6, width: 25 },
      }),
    );
    expect(concrete.radiation).toBeLessThan(bridgeAcoustics(girder()).radiation * 0.05);
  });

  it('無道床のプレートガーダー橋が放射の基準（1）になる', () => {
    expect(bridgeAcoustics(girder()).radiation).toBeCloseTo(1, 6);
  });

  it('下路トラスは列車を囲むのでよく反響する', () => {
    const truss = bridgeAcoustics(girder({ kind: 'truss' }));
    expect(truss.reflection).toBeGreaterThan(bridgeAcoustics(girder()).reflection * 2);
  });

  it('区間として引ける', () => {
    const track = new BridgeTrack([girder(), girder({ id: 'br2', start: 500, end: 560 })]);
    expect(track.at(150)?.id).toBe('br');
    expect(track.at(99)).toBeUndefined();
    expect(track.at(300)).toBeUndefined();
    expect(track.overlapping(150, 520).map((b) => b.id)).toEqual(['br', 'br2']);
    expect(bridgeLength(girder())).toBe(100);
  });
});
