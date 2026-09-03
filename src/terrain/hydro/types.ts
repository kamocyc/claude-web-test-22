import type { HydroGrid } from './grid';

/**
 * 地形生成のパラメータ。
 *
 * すべて 0..1 の無次元量で、移植元 (ctest105) のスライダーと同じ意味を持つ。
 * 高さも無次元で、メートルへの換算は `relief` で行う (`generator.ts`)。
 */
export interface HydroParams {
  seed: number;
  /** 海になる面積の割合。 */
  sea: number;
  /** 険しさ。山の高さと岩稜の粗さ。 */
  rugged: number;
  /** 平地の割合。 */
  flat: number;
  /** 盆地の量。 */
  basin: number;
  /** 河川の密度。0 にすると川を作らない。 */
  river: number;
  /** 蛇行の強さ。 */
  meander: number;
  /** 侵食の強さ。河床の掘り込みと氾濫原の広がり。 */
  erosion: number;
  /**
   * ノイズの倍率 = マップの一辺 / `NOISE_SPAN` (5,120 m)。
   *
   * 移植元は地形ノイズをマップ全体で 0..1 に正規化していた。そのまま広い
   * マップに使うと、山も谷も**マップの大きさに比例して横に伸びる**。
   * 岩稜の `CRAG_FREQUENCY = 9.5` に「波長およそ 500 m」と注記があるとおり、
   * これらの定数は 5,120 m の地図を前提にメートルで意味づけられているので、
   * 座標をメートルに固定して、広いマップには**その分だけ多くの地形が入る**
   * ようにする。1 なら移植元と同一。
   */
  span?: number;
}

/** 水文計算の結果。すべて格子 (`grid`) と同じ並びの配列。 */
export interface HydroWorld {
  grid: HydroGrid;
  params: HydroParams;
  /** 最終的な高さ (無次元)。窪地は埋められている (`filled` と同じ配列)。 */
  terrain: Float32Array;
  /** 1 = 海。外周と繋がった水面だけが海になる。 */
  sea: Uint8Array;
  /** 海面の高さ (無次元)。 */
  seaLevel: number;
  /** 窪地を埋めた面。`terrain` と同一。 */
  filled: Float32Array;
  /** 排水木。-1 = 流出口 (海か外周)。 */
  parent: Int32Array;
  /** 上流のセル数。 */
  accumulation: Float64Array;
  /** 1 = 川。 */
  rivers: Uint8Array;
  /** 川と判定する `accumulation` のしきい値。 */
  riverThreshold: number;
  /** 傾き (高さ / セル)。 */
  slope: Float32Array;
  /** 開削した盆地の数。 */
  breaches: number;
  /** 河川地形の区分 (0 なし / 1 氾濫原 / 2 自然堤防 / 3 後背湿地 / 4 河岸段丘)。 */
  landform: Uint8Array;
  /** 集落の置きやすさ。見本の配置と初期視点に使う。 */
  suitability: Float32Array;
  /** 海岸からの距離 (セル)。 */
  coastDistance: Int16Array;
  /** 川からの距離 (セル)。 */
  riverDistance: Int16Array;
}
