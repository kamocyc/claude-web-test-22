/**
 * 単位系とグローバルな定数。
 *
 * ワールド座標は右手系 Y-up、1 単位 = 1 メートル。
 * 平面 (水平) は XZ 平面で、`Vector2` を平面座標として使う場合は
 * `x` = ワールド X、`y` = ワールド Z を意味する (`XZ` 型)。
 */

/** マップ一辺の長さ [m]。原点はマップ中心。 */
export const MAP_SIZE = 20480;

/**
 * ハイトマップ 1 セルの辺長 [m]。
 *
 * 格子点は `(MAP_SIZE / TERRAIN_CELL + 1)^2` 個あり、20,480 m 四方では
 * 2,621 万点になる。高さ場だけで 210 MB だが、粗くはしない: 整地の
 * footprint (`gradingHalfWidth`) も、量子化を逃がすための路肩の下げ量も
 * セル長に比例するので、8 m にすると道路 1 本が均す幅が左右 12 m ずつに
 * 広がり、路端で地形が路面に食い込む量も倍になる。
 * 広さの代償は、**全面に持たない**方で払う — 整地の作業配列は触った矩形
 * だけ (`grading.ts`)、地形メッシュはカメラのまわりだけ (`terrainMesh.ts`)。
 */
export const TERRAIN_CELL = 4;

/** ハイトマップの格子数 (セル数)。頂点数はこれ + 1。 */
export const TERRAIN_CELLS = MAP_SIZE / TERRAIN_CELL;

/**
 * 地形メッシュを分割するチャンクの一辺のセル数。
 *
 * 4 m 格子では 512 m 角。20,480 m 四方をカメラのまわりだけ持つと、
 * これで常駐 200 枚ほどになる。64 (256 m 角) にすると 1 枚あたりの
 * 書き換えは軽くなるが、常駐が 800 枚を超えて描画呼び出しの方が重くなる。
 */
export const TERRAIN_CHUNK_CELLS = 128;

/**
 * 地形を作る水文格子の 1 セルの辺長 [m]。
 *
 * 埋め立て・流量集積・河床の掘り込みはこの格子で解く。移植元と同じ 40 m を
 * 保つ: あちらの定数は「セル何個ぶん」で書かれているので、ここを変えると
 * 蛇行の振れ幅も氾濫原の広がりも意味が変わる。マップを広げるときは
 * セルを粗くするのではなく、格子の数を増やす。
 */
export const HYDRO_CELL = 40;

/**
 * 地形ノイズの基準となる長さ [m]。
 *
 * 移植元はノイズの座標をマップ全体で 0..1 に正規化していた。そのまま広い
 * マップに使うと、山も谷も**マップの大きさに比例して横に伸びる**。
 * 岩稜の波長 500 m のような定数はメートルで意味づけられているので、
 * ここを基準にして固定し、広いマップにはその分だけ多くの地形が入るようにする。
 */
export const NOISE_SPAN = 5120;

/**
 * 無次元の地形の高さをメートルに直す倍率。
 *
 * 移植元は 700 で、海面上のいちばん高い所が 500 m ほどになる。ただしそれは
 * 眺めるための地形で、勾配は低地の平均でも 16% あり、道路 (最大 13.5%) も
 * 線路 (最大 5.5%) も敷けない。ここでは敷ける地形にしたいので下げてある。
 * 390 で、海面上の最高点が 440 m ほど、陸の勾配は中央値 8%・上位 5% で 29%。
 * 平地と谷は敷けて、尾根越えにはトンネルが要る。
 */
export const TERRAIN_RELIEF = 390;

/**
 * 町の密度 [件/km²]。
 *
 * 移植元は 5.1 km 四方に 19 件 (0.95 件/km²) 置いていたが、20,480 m 四方に
 * そのまま当てると 400 件になる。町 1 つは街路と建物を持つので、地図として
 * 自然に見える範囲で落としてある。0.25 で 20,480 m 四方に 105 件。
 */
export const TOWN_DENSITY = 0.25;

/** 町どうしの最小間隔 [m]。これより詰めては置かない。 */
export const TOWN_MIN_SPACING = 400;

/** 海面の高さ [m]。地形はここが 0 になるように作る。 */
export const SEA_LEVEL_Y = 0;

/** 海底の下限 [m]。これより深くは掘らない。起伏の倍率に比例させる。 */
export const SEA_FLOOR_Y = -78;

/**
 * 水面の上に桁下を確保する量 [m]。
 * 水の上は地表区間にできないので、これを満たさない線形は敷けない。
 */
export const WATER_CLEARANCE = 0.5;

/**
 * 見通す距離 [m]。遠クリップ面・引ける上限・空の大きさをここから決める。
 *
 * マップの広さではなく**見える距離**の話なので、`MAP_SIZE` からは切り離す。
 * マップに比例させると、広いマップでは端まで引けてしまう。
 * 20,480 m 四方に広げたぶん、地形を見渡せるところまでは伸ばしてある
 * (遠くの地形は `terrainMesh` が間引くので、頂点数は距離の 2 乗では効かない)。
 */
export const VIEW_DISTANCE = 3600;

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
 * 小物の足元が、その道路の路面より低くてよい量 [m]。
 *
 * 路肩の地形は、格子の量子化を吸収するため路面よりわずかに低く均される
 * (`gradingSectionPoints` の shift = 勾配 × セル長)。急勾配で格子が粗いと
 * その差が 0.5 m 近くなり、遮断機や標識だけが路面から沈んで見える。
 * 路肩として自然に見える範囲で止める。
 */
export const PROP_MAX_DROP = 0.3;

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

/**
 * 交点の高さを合わせにいく高低差の上限 [m]。
 *
 * あとから引いた線形は、先にある線形との交点でこの範囲までなら自分の縦断を
 * 変えて高さを合わせ、平面交差 (踏切・交差点・クロッシング) になる。超えたら
 * 何もせず、従来どおり立体交差として扱う。
 *
 * 高さ設定の刻み (3 m) より小さいので、1 段上げれば必ず立体交差にできる。
 * ここから建築限界 + 床版 (道路で 5.6 m、線路で 6.8 m) までの間は、合わせも
 * せず桁下も足りない**谷間**で、今までどおり「桁下が足りません」で止まる。
 */
export const CROSSING_MATCH_LIMIT = 2.0;

/** 道路の上を跨ぐ構造物に必要な建築限界 [m]。 */
export const CLEARANCE_OVER_ROAD = 4.5;

/** 線路の上を跨ぐ構造物に必要な建築限界 [m] (架線含む)。 */
export const CLEARANCE_OVER_RAIL = 5.7;

/** 橋桁の構造高 [m]。路面下面から桁下までの厚み。 */
export const DECK_THICKNESS = 1.1;

/** 左側通行かどうか (日本仕様)。信号や停止線の配置に影響する。 */
export const DRIVE_ON_LEFT = true;

/** 交差点端から横断歩道までの離隔と、横断歩道の奥行き [m]。 */
export const CROSSWALK_OFFSET = 0.6;
export const CROSSWALK_DEPTH = 3.6;
/**
 * 交差点端から停止線までの距離 [m]。
 *
 * 描画 (`build/markings.ts`) と走行 (`sim/`) の両方が見る。車が止まる
 * 位置は路面に描いた停止線でなければならないので、同じ値を共有する。
 */
export const STOP_LINE_OFFSET = CROSSWALK_OFFSET + CROSSWALK_DEPTH + 0.6;

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
