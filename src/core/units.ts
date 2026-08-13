/**
 * 単位系とグローバルな定数。
 *
 * ワールド座標は右手系 Y-up、1 単位 = 1 メートル。
 * 平面 (水平) は XZ 平面で、`Vector2` を平面座標として使う場合は
 * `x` = ワールド X、`y` = ワールド Z を意味する (`XZ` 型)。
 */

/** マップ一辺の長さ [m]。原点はマップ中心。 */
export const MAP_SIZE = 1024;

/** ハイトマップ 1 セルの辺長 [m]。 */
export const TERRAIN_CELL = 2;

/** ハイトマップの格子数 (セル数)。頂点数はこれ + 1。 */
export const TERRAIN_CELLS = MAP_SIZE / TERRAIN_CELL;

/** 地形メッシュを分割するチャンクの一辺のセル数。 */
export const TERRAIN_CHUNK_CELLS = 64;

/** 線形をサンプリングする既定間隔 [m]。 */
export const SAMPLE_SPACING = 2.0;

/** 曲率が大きい所で細分するときの最小間隔 [m]。 */
export const SAMPLE_SPACING_MIN = 0.75;

/** 道路面を整地後の地形から持ち上げる量 [m]。Z ファイティング回避。 */
export const SURFACE_LIFT = 0.04;

/** 路面の外側に付ける垂れ壁 (スカート) の深さ [m]。地形との隙間を隠す。 */
export const SURFACE_SKIRT = 0.45;

/** 路面標示を路面から浮かせる量 [m]。 */
export const MARKING_LIFT = 0.012;

/** 切土で許容する法面勾配 (高さ/水平距離)。約 44 度。 */
export const CUT_SLOPE = 0.95;

/** 盛土で許容する法面勾配 (高さ/水平距離)。約 32 度。 */
export const FILL_SLOPE = 0.62;

/** 整地対象に含める路肩の余裕幅 [m]。 */
export const GRADING_MARGIN = 2.0;

/**
 * 小物 (信号・標識・電柱) の足元が、その道路の路面より高くてよい量 [m]。
 *
 * 切土の法面では、路肩のすぐ外の地面が路面より何 m も高い。そこに立てると
 * 小物だけが崖の上に取り残されるので、そういう場所は候補から外す。
 */
export const PROP_MAX_RISE = 1.2;

/**
 * 高架と判定する盛土高さ [m]。
 * これ以下なら盛土で地形を持ち上げ、超えたら橋にする。
 */
export const BRIDGE_THRESHOLD = 8.0;

/**
 * トンネルと判定する土被り [m]。
 * これ以下なら切土 (掘割) で地形を削り、超えたらトンネルにする。
 */
export const TUNNEL_THRESHOLD = 12.0;

/** 橋・トンネル区間として採用する最小延長 [m]。これ未満は前後に吸収する。 */
export const MIN_STRUCTURE_RUN = 25;

/** 平面交差 (踏切) とみなす道路とレールの高低差 [m]。 */
export const LEVEL_CROSSING_TOLERANCE = 0.25;

/** 道路の上を跨ぐ構造物に必要な建築限界 [m]。 */
export const CLEARANCE_OVER_ROAD = 4.5;

/** 線路の上を跨ぐ構造物に必要な建築限界 [m] (架線含む)。 */
export const CLEARANCE_OVER_RAIL = 5.7;

/** 橋桁の構造高 [m]。路面下面から桁下までの厚み。 */
export const DECK_THICKNESS = 1.1;

/** 左側通行かどうか (日本仕様)。信号や停止線の配置に影響する。 */
export const DRIVE_ON_LEFT = true;

/** 標準軌間 [m]。 */
export const RAIL_GAUGE = 1.435;

export const DEG = Math.PI / 180;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** 角度差を -PI..PI に正規化する。 */
export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}
