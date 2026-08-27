import { DEG } from '../core/units';

export type NetworkKind = 'road' | 'rail';

/** 1 車線の定義。`offset` は中心線からの横方向距離 (右手側が正)。 */
export interface LaneSpec {
  offset: number;
  width: number;
  /** +1 = 線形の進行方向、-1 = 逆方向。 */
  direction: 1 | -1;
}

/** 道路・線路の種別定義。幅員や規格値をここに集約する。 */
export interface NetworkClass {
  id: string;
  kind: NetworkKind;
  label: string;

  /** 舗装 (線路ではバラスト天端) の半幅 [m]。 */
  halfWidth: number;
  /** 車道部の半幅 [m]。歩道はこの外側。 */
  carriagewayHalfWidth: number;
  /** 片側歩道幅 [m]。0 なら歩道なし。 */
  sidewalkWidth: number;
  /** 歩道の高さ (縁石高) [m]。 */
  curbHeight: number;

  /** 車線 (線路では軌道) の一覧。中心線から見て左 (offset が小) の順。 */
  lanes: LaneSpec[];
  /**
   * 一方通行か。ランプなど、全車線が同じ向きに走る種別で true。
   *
   * 線路は一方通行ではない。同じ軌道を両方向に走れるので、対向車線を
   * 持つ道路と同じ扱いになる (ただし車線は左右に分かれず、同じ位置)。
   */
  oneWay: boolean;
  /**
   * 中央分離帯があるか。
   *
   * 分離帯のある道路では対向車線を横切れないので、左側通行では右折が
   * できない (自動車専用道の出入りがランプに限られるのはこのため)。
   */
  divided: boolean;
  /**
   * 軌道の中心オフセット [m]。道路では空。
   * 線路はどの種別も 1 本 ([0]) で、複線は平行に並べて作る。
   */
  tracks: number[];

  /** 規格最小曲線半径 [m]。これを割ると警告になる。 */
  minRadius: number;
  /**
   * 緩和曲線とカントを入れる下限の半径 [m]。
   *
   * 最小半径は「ここまでなら敷ける」限界で、いつもの線形はもっと緩い。
   * この半径までは実物どおり緩和曲線を挟んでカントを付けるが、それより
   * 急な曲線は**徐行区間**として素の円曲線で敷き、カントも付けない
   * (実物でも側線や構内の急曲線はカントを抜いた平らな軌道になる)。
   *
   * 交差点の面の大きさもここから決める (道路で使うのはこれだけ)。面は
   * 「その種別のふつうの曲線で振り分けるのに要る長さ」なので、限界の
   * 急曲線に合わせて縮めると、交差点が実際の取り付きより小さくなる。
   */
  smoothRadius: number;
  /**
   * 規格最大縦断勾配 (0.08 = 8%)。
   *
   * 実際の道路構造令・線路の規格より 5 割ほど緩めてある。地形の起伏に
   * 対して敷地が狭く、実物どおりの勾配では思うように繋げられないため。
   */
  maxGrade: number;
  /**
   * 規格最小縦曲線半径 [m]。勾配をどれだけ急に変えてよいかの上限。
   *
   * 実物の線路は 3000 m 以上だが、この縮尺 (区間長 40〜200 m) では
   * 1 区間で勾配を 1% も変えられなくなり縦断が真っ平らになる。実質
   * 「1 区間で変えてよい勾配の量」として較正した値を入れている。
   * 標準の縦断 (終点勾配 = 平均勾配) では `|Δ勾配| ≤ L / (4·この値)`。
   *
   * 値は**縦方向の加速度の目安から**決める。曲率半径 R の縦曲線を速度 V で
   * 通ると縦加速度は `V²/R` なので、`R = V²/VERTICAL_ACCEL` とすれば種別に
   * よらず同じ乗り心地になる (V は実際に走らせる速度 = 設計速度の 85%)。
   * 実物の道路は 0.05〜0.1 g で設計するが、ここは 1 区画が 40 m の縮尺で、
   * そこまで緩くすると地形に沿った縦断が引けない。
   */
  minVerticalRadius: number;
  /**
   * 緩和曲線 (クロソイド) を入れるか。
   *
   * 線路だけ有効。直線からいきなり円曲線に入らず、曲率を弧長に比例して
   * 立ち上げる区間を挟む。道路は最小半径が 12〜45 m と小さく、30 m の区間に
   * 十数 m の緩和区間を入れても意味がないので入れない。
   */
  easement: boolean;
  /**
   * 規格最大カント [m] (曲線の外側のレールをどれだけ高くするか)。
   *
   * 規格最小半径の曲線でこの値になり、緩やかな曲線では半径に反比例して
   * 小さくなる。曲率から導くので、緩和曲線の区間でそのまま立ち上がる。
   * 道路は 0 (片勾配は付けない)。
   */
  maxCant: number;
  /** 交差点の隅角部の丸め半径 [m]。 */
  cornerRadius: number;
  /** 設計速度 [km/h]。HUD 表示と規格の目安。 */
  designSpeed: number;

  /**
   * 沿道に区画 (建物の敷地) を割り付けられるか。
   *
   * 歩道があり、中央分離帯で出入りを絶たれていない道路だけ。自動車専用道と
   * ランプは、沿道から直接出入りできないので割り付けない。
   */
  zonable: boolean;

  /** 交差点で信号機を設置しうるか。 */
  signalCapable: boolean;
  /** 交差点に横断歩道を描くか。 */
  crosswalks: boolean;
  /** 建設単価の目安 (HUD 表示のみ)。 */
  costPerMeter: number;

  /** 路面 (バラスト) の基本色。 */
  surfaceColor: readonly [number, number, number];
}

/**
 * 実際に走らせる速度 / 設計速度。
 *
 * 設計速度は「その線形で出してよい速度」なので、常にそれで走ると規格の
 * 限界をなぞることになる。少し余裕を見た速度で走らせる。
 */
export const SPEED_FACTOR = 0.85;

/**
 * 縦曲線を通るときの縦加速度の目安 [m/s²]。
 *
 * 半径 R の縦曲線を速度 V で通ると縦加速度は `V²/R` なので、
 * `R = V²/VERTICAL_ACCEL` とすれば種別によらず同じ乗り心地になる。
 *
 * 実物の道路は 0.05〜0.1 g (0.5〜1.0 m/s²) で設計するが、この縮尺では
 * 1 区画が 40 m ほどしかなく、そこまで緩くすると地形に沿った縦断が引けない
 * (勾配を変えるのに区画をいくつも使うことになる)。0.25 g まで許す。
 */
const VERTICAL_ACCEL = 2.4;

/**
 * 縦曲線半径の下限 [m]。
 *
 * 遅い種別 (生活道路・側線) では上の式が 20〜40 m まで下がるが、そこまで
 * 行くと縦断の折れ目がはっきり見える。最大勾配のほうが先に効くので、
 * 実質の締まり具合は変わらない。
 */
const MIN_VERTICAL_RADIUS = 50;

/**
 * 標準半径 (`smoothRadius`) / 規格最小半径。
 *
 * 最小半径は「ここまでなら敷ける」限界なので、そこを標準の線形とみなすと
 * どの曲線も限界いっぱいのカントを背負うことになる。ふだん使う半径を
 * その 1.7 倍あたりに置き、限界に近い急曲線は徐行区間として素の円曲線で
 * 敷く (`smoothRadius` を参照)。
 */
const SMOOTH_RADIUS_RATIO = 1.7;

/** 設計速度から縦曲線半径の規格を決める。5 m 刻みに丸める。 */
export function verticalRadiusFor(designSpeed: number): number {
  const v = (designSpeed / 3.6) * SPEED_FACTOR;
  return Math.max(MIN_VERTICAL_RADIUS, Math.round((v * v) / VERTICAL_ACCEL / 5) * 5);
}

function road(opts: {
  id: string;
  label: string;
  laneCount: number;
  laneWidth: number;
  sidewalkWidth: number;
  /** 車道の外側に取る路肩幅 [m]。歩道のない種別で舗装に余裕を持たせる。 */
  shoulderWidth?: number;
  /** 一方通行 (全車線が線形の向きに走る)。 */
  oneWay?: boolean;
  /** 中央分離帯があり、対向車線を横切れない。 */
  divided?: boolean;
  minRadius: number;
  maxGrade: number;
  minVerticalRadius?: number;
  cornerRadius: number;
  designSpeed: number;
  signalCapable: boolean;
  crosswalks: boolean;
  costPerMeter: number;
  surfaceColor: readonly [number, number, number];
}): NetworkClass {
  const carriagewayHalfWidth = (opts.laneCount * opts.laneWidth) / 2;
  const lanes: LaneSpec[] = [];
  for (let i = 0; i < opts.laneCount; i++) {
    const offset = -carriagewayHalfWidth + (i + 0.5) * opts.laneWidth;
    // 左側通行では中心線より左 (offset < 0) が進行方向、右が対向。
    // 一方通行では対向がないので、全車線が線形の向きに走る。
    lanes.push({
      offset,
      width: opts.laneWidth,
      direction: opts.oneWay || offset < 0 ? 1 : -1,
    });
  }
  return {
    id: opts.id,
    kind: 'road',
    label: opts.label,
    halfWidth: carriagewayHalfWidth + opts.sidewalkWidth + (opts.shoulderWidth ?? 0),
    carriagewayHalfWidth,
    sidewalkWidth: opts.sidewalkWidth,
    curbHeight: opts.sidewalkWidth > 0 ? 0.15 : 0,
    lanes,
    oneWay: opts.oneWay ?? false,
    divided: opts.divided ?? false,
    tracks: [],
    minRadius: opts.minRadius,
    smoothRadius: Math.round(opts.minRadius * SMOOTH_RADIUS_RATIO),
    maxGrade: opts.maxGrade,
    minVerticalRadius: opts.minVerticalRadius ?? verticalRadiusFor(opts.designSpeed),
    easement: false,
    maxCant: 0,
    cornerRadius: opts.cornerRadius,
    designSpeed: opts.designSpeed,
    zonable: opts.sidewalkWidth > 0 && !(opts.divided ?? false),
    signalCapable: opts.signalCapable,
    crosswalks: opts.crosswalks,
    costPerMeter: opts.costPerMeter,
    surfaceColor: opts.surfaceColor,
  };
}

/**
 * 線路の種別。軌道は 1 本だけで、複線・三線は既存の線路に平行して敷いて
 * 作る (`network/parallel.ts`)。1 本ずつ独立した線形なので、片側だけ
 * 分岐させる・片側だけ橋にするといったことが特別扱いなしにできる。
 *
 * **線路に向きは無い**。1 本の軌道を両方向の車線として持ち、列車は
 * 止まった所で折り返して、入ってきた線路をそのまま戻れる。上り線・下り線を
 * 分けるかどうかは、敷いた形と路線の引き方で決まる。
 */
function rail(opts: {
  id: string;
  label: string;
  shoulder: number;
  minRadius: number;
  /** 緩和曲線とカントを入れる下限の半径 [m]。既定は最小半径の 1.7 倍。 */
  smoothRadius?: number;
  maxGrade: number;
  minVerticalRadius?: number;
  easement?: boolean;
  maxCant?: number;
  designSpeed: number;
  costPerMeter: number;
}): NetworkClass {
  return {
    id: opts.id,
    kind: 'rail',
    label: opts.label,
    halfWidth: opts.shoulder,
    carriagewayHalfWidth: opts.shoulder,
    sidewalkWidth: 0,
    curbHeight: 0,
    // 同じ軌道 (offset 0) を、線形の向きと逆向きの 2 車線として持つ。
    lanes: [
      { offset: 0, width: 3.0, direction: 1 },
      { offset: 0, width: 3.0, direction: -1 },
    ],
    oneWay: false,
    divided: false,
    tracks: [0],
    minRadius: opts.minRadius,
    smoothRadius: opts.smoothRadius ?? Math.round(opts.minRadius * SMOOTH_RADIUS_RATIO),
    maxGrade: opts.maxGrade,
    minVerticalRadius: opts.minVerticalRadius ?? verticalRadiusFor(opts.designSpeed),
    easement: opts.easement ?? true,
    maxCant: opts.maxCant ?? 0.1,
    cornerRadius: 0,
    designSpeed: opts.designSpeed,
    zonable: false,
    signalCapable: false,
    crosswalks: false,
    costPerMeter: opts.costPerMeter,
    surfaceColor: [0.36, 0.34, 0.32],
  };
}

const ASPHALT: readonly [number, number, number] = [0.26, 0.26, 0.28];
const ASPHALT_DARK: readonly [number, number, number] = [0.22, 0.22, 0.24];

export const NETWORK_CLASSES: NetworkClass[] = [
  road({
    id: 'road_small',
    label: '生活道路 (2 車線)',
    laneCount: 2,
    laneWidth: 3.0,
    sidewalkWidth: 1.6,
    minRadius: 7,
    maxGrade: 0.18,
    cornerRadius: 5,
    designSpeed: 30,
    signalCapable: false,
    crosswalks: true,
    costPerMeter: 40,
    surfaceColor: ASPHALT,
  }),
  road({
    id: 'road_medium',
    label: '幹線道路 (4 車線)',
    laneCount: 4,
    laneWidth: 3.25,
    sidewalkWidth: 2.4,
    minRadius: 18,
    maxGrade: 0.135,
    cornerRadius: 8,
    designSpeed: 50,
    signalCapable: true,
    crosswalks: true,
    costPerMeter: 120,
    surfaceColor: ASPHALT,
  }),
  road({
    id: 'road_large',
    label: '大通り (6 車線)',
    laneCount: 6,
    laneWidth: 3.4,
    sidewalkWidth: 3.0,
    minRadius: 26,
    maxGrade: 0.105,
    cornerRadius: 11,
    designSpeed: 60,
    signalCapable: true,
    crosswalks: true,
    costPerMeter: 220,
    surfaceColor: ASPHALT,
  }),
  road({
    id: 'road_highway',
    label: '自動車専用道 (4 車線)',
    laneCount: 4,
    laneWidth: 3.5,
    sidewalkWidth: 0,
    divided: true,
    minRadius: 70,
    maxGrade: 0.075,
    cornerRadius: 15,
    designSpeed: 100,
    signalCapable: false,
    crosswalks: false,
    costPerMeter: 300,
    surfaceColor: ASPHALT_DARK,
  }),
  road({
    id: 'road_ramp',
    label: 'ランプ (1 車線・一方通行)',
    laneCount: 1,
    laneWidth: 4.5,
    sidewalkWidth: 0,
    shoulderWidth: 1.5,
    oneWay: true,
    minRadius: 26,
    maxGrade: 0.12,
    cornerRadius: 8,
    designSpeed: 50,
    signalCapable: false,
    crosswalks: false,
    costPerMeter: 180,
    surfaceColor: ASPHALT_DARK,
  }),
  rail({
    id: 'rail_single',
    label: '線路',
    shoulder: 2.2,
    minRadius: 50,
    // 標準半径は既定 (最小半径の 1.7 倍 = 85 m) を使わず、最小半径を下げる
    // 前と同じ所に置く。ここはカントが最大になる半径なので、下げると**既に
    // ある緩い曲線のカントまで一律に減る** (R=200 で 0.060 → 0.043)。
    // 急曲線を敷けるようにしたいだけなので、徐行区間 (緩和曲線もカントも
    // 入れない素の円弧) の範囲が 50〜120 m に広がるだけにする。
    smoothRadius: 120,
    maxGrade: 0.05,
    designSpeed: 100,
    costPerMeter: 150,
  }),
  rail({
    id: 'rail_yard',
    label: '側線 (低規格)',
    shoulder: 1.8,
    minRadius: 30,
    maxGrade: 0.03,
    maxCant: 0.05,
    designSpeed: 40,
    costPerMeter: 90,
  }),
];

const BY_ID = new Map(NETWORK_CLASSES.map((c) => [c.id, c]));

export function getClass(id: string): NetworkClass {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown network class: ${id}`);
  return c;
}

/** 交差点で「直進」とみなす最大偏角。 */
export const STRAIGHT_THROUGH_ANGLE = 35 * DEG;
