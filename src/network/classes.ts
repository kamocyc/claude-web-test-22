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
  /** 一方通行か。ランプなど、全車線が同じ向きに走る種別で true。 */
  oneWay: boolean;
  /**
   * 中央分離帯があるか。
   *
   * 分離帯のある道路では対向車線を横切れないので、左側通行では右折が
   * できない (自動車専用道の出入りがランプに限られるのはこのため)。
   */
  divided: boolean;
  /** 線路の軌道中心オフセット [m]。道路では空。 */
  tracks: number[];

  /** 規格最小曲線半径 [m]。 */
  minRadius: number;
  /** 規格最大縦断勾配 (0.08 = 8%)。 */
  maxGrade: number;
  /** 交差点の隅角部の丸め半径 [m]。 */
  cornerRadius: number;
  /** 設計速度 [km/h]。HUD 表示と規格の目安。 */
  designSpeed: number;

  /** 交差点で信号機を設置しうるか。 */
  signalCapable: boolean;
  /** 交差点に横断歩道を描くか。 */
  crosswalks: boolean;
  /** 建設単価の目安 (HUD 表示のみ)。 */
  costPerMeter: number;

  /** 路面 (バラスト) の基本色。 */
  surfaceColor: readonly [number, number, number];
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
    maxGrade: opts.maxGrade,
    cornerRadius: opts.cornerRadius,
    designSpeed: opts.designSpeed,
    signalCapable: opts.signalCapable,
    crosswalks: opts.crosswalks,
    costPerMeter: opts.costPerMeter,
    surfaceColor: opts.surfaceColor,
  };
}

function rail(opts: {
  id: string;
  label: string;
  tracks: number[];
  shoulder: number;
  minRadius: number;
  maxGrade: number;
  designSpeed: number;
  costPerMeter: number;
}): NetworkClass {
  const extent = Math.max(...opts.tracks.map(Math.abs)) + opts.shoulder;
  return {
    id: opts.id,
    kind: 'rail',
    label: opts.label,
    halfWidth: extent,
    carriagewayHalfWidth: extent,
    sidewalkWidth: 0,
    curbHeight: 0,
    lanes: opts.tracks.map((offset, i) => ({
      offset,
      width: 3.0,
      direction: (opts.tracks.length > 1 && i > 0 ? -1 : 1) as 1 | -1,
    })),
    oneWay: opts.tracks.length <= 1,
    divided: false,
    tracks: opts.tracks,
    minRadius: opts.minRadius,
    maxGrade: opts.maxGrade,
    cornerRadius: 0,
    designSpeed: opts.designSpeed,
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
    minRadius: 12,
    maxGrade: 0.12,
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
    minRadius: 30,
    maxGrade: 0.09,
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
    minRadius: 45,
    maxGrade: 0.07,
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
    minRadius: 120,
    maxGrade: 0.05,
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
    minRadius: 45,
    maxGrade: 0.08,
    cornerRadius: 8,
    designSpeed: 50,
    signalCapable: false,
    crosswalks: false,
    costPerMeter: 180,
    surfaceColor: ASPHALT_DARK,
  }),
  rail({
    id: 'rail_single',
    label: '線路 (単線)',
    tracks: [0],
    shoulder: 2.2,
    minRadius: 120,
    maxGrade: 0.035,
    designSpeed: 100,
    costPerMeter: 150,
  }),
  rail({
    id: 'rail_double',
    label: '線路 (複線)',
    tracks: [-2.1, 2.1],
    shoulder: 2.2,
    minRadius: 160,
    maxGrade: 0.03,
    designSpeed: 130,
    costPerMeter: 260,
  }),
  rail({
    id: 'rail_yard',
    label: '側線 (低規格)',
    tracks: [0],
    shoulder: 1.8,
    minRadius: 50,
    maxGrade: 0.02,
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

/** 分岐器で許容する最大の分岐角。これを超える線路接続は警告になる。 */
export const MAX_TURNOUT_ANGLE = 20 * DEG;

/** 交差点で「直進」とみなす最大偏角。 */
export const STRAIGHT_THROUGH_ANGLE = 35 * DEG;
