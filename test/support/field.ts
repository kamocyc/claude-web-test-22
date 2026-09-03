import { TERRAIN_CELL } from '../../src/core/units';
import { Heightfield } from '../../src/terrain/heightfield';

/**
 * テスト用の高さ場の一辺 [m]。
 *
 * 本番のマップ (`MAP_SIZE`) をそのまま作ると、地形メッシュだけで 1 シーン
 * 数十 MB になり、何十シーンも組み立てるテストではメモリが持たない。
 * 見本のネットワークが収まる範囲 (原点から 1 km ほど) に絞る。
 */
export const TEST_MAP_SIZE = 4096;

/**
 * テスト用の高さ場。
 *
 * セルの粗さは本番と同じ (`TERRAIN_CELL`) なので、整地・地形メッシュの
 * 挙動は本番と変わらない。違うのは覆う範囲だけ。
 */
export function testField(): Heightfield {
  return new Heightfield(TEST_MAP_SIZE / TERRAIN_CELL, TERRAIN_CELL);
}
