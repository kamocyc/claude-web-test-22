import { TERRAIN_CELL } from '../../src/core/units';
import { Heightfield } from '../../src/terrain/heightfield';

/**
 * テスト用の高さ場の一辺 [m]。
 *
 * 本番のマップ (`MAP_SIZE`) をそのまま作ると、地形メッシュだけで 1 シーン
 * 数十 MB になり、何十シーンも組み立てるテストではメモリが持たない。
 * 試験に要る範囲 (線形はどれも原点から数百 m 以内) に絞る。
 */
export const TEST_MAP_SIZE = 2048;

/**
 * テスト用の高さ場。
 *
 * セルの粗さは本番と同じ (`TERRAIN_CELL`) なので、整地・地形メッシュの
 * 挙動は本番と変わらない。違うのは覆う範囲だけ。
 */
export function testField(): Heightfield {
  return new Heightfield(TEST_MAP_SIZE / TERRAIN_CELL, TERRAIN_CELL);
}
