import type { Meters } from '../units.ts';
import type { VehicleSpec } from '../vehicle/spec.ts';

/**
 * 継目の種類。
 *
 * 定尺レールの継目（`standard`）は距離程の周期として持てば足りるが、
 * ロングレール区間にも**そこだけに置かれる継目**がある。置かれる理由が違えば
 * 構造も違い、構造が違えば音も違う。
 *
 * | 種類        | どこに           | なぜ要るか                       | 構造 | 音 |
 * | ----------- | ---------------- | -------------------------------- | ---- | -- |
 * | `standard`  | 定尺レールの端   | 25m ごとにレールが終わるから     | 突合せ。遊間があり段差と折れ角が付く | ガタン |
 * | `insulated` | 分岐器・踏切の前後 | 軌道回路の境目（列車検知の区切り） | 接着絶縁レール。遊間は樹脂で埋まり段差はほぼ無い | タン |
 * | `expansion` | 橋りょうの両端   | 桁が伸び縮みしてもレールを切らないため | レール端を斜めに削いで重ねる（トングレール状） | シャッ |
 *
 * ロングレール区間でも橋の前後・分岐器の前後だけ「継目の音がする」のはこのためで、
 * 継目が無い区間に無理やり音を足しているのではなく、**そこには実際に継目がある**。
 */
export type RailJointKind = 'standard' | 'insulated' | 'expansion';

/** 個別に置かれた継目（周期的な定尺の継目とは別に、距離程で 1 つずつ持つ） */
export interface RailJointFeature {
  readonly kind: RailJointKind;
  /** 衝撃の相対的な強さ 0..1（定尺の突合せ継目を 1 とする） */
  readonly strength: number;
  /** 何のために置かれているか（表示・検証用） */
  readonly reason: string;
}

/**
 * 種類ごとの衝撃の強さ（定尺の突合せ継目を 1 とする）。
 *
 * 接着絶縁レールは端面のあいだに厚さ数 mm の樹脂板を挟んで**接着**してあるので、
 * 遊間が無く段差もほとんど無い。伸縮継目はレール端を斜めに削いで重ねてあり、
 * 車輪は段差を踏まずに片方からもう片方へ乗り移る（トングレールと同じ考え方）。
 * どちらも「継目を無くせない場所で、継目の衝撃をできるだけ小さくする」ための
 * 構造なので、突合せ継目より弱いのは設計どおりである。
 */
export const RAIL_JOINT_STRENGTH: Readonly<Record<RailJointKind, number>> = {
  standard: 1,
  insulated: 0.5,
  expansion: 0.35,
};

/**
 * 車両の中心から見た各軸の位置 [m]（正 = 前方）。
 *
 * 台車中心は車両中心から `台車中心間距離 / 2` の位置にあり、各軸はさらに
 * 台車中心から `固定軸距 / 2` ずれる。軸の並び順は `computeAxleLoads()` と
 * 同じ（前台車から順、各台車の中では前軸から順）にそろえてある。
 */
export function axleOffsets(spec: VehicleSpec, out: number[] = []): number[] {
  out.length = 0;
  const n = spec.axleCount;
  if (n < 2) {
    out.push(0);
    return out;
  }
  const perBogie = Math.max(1, Math.floor(n / 2));
  for (let i = 0; i < n; i++) {
    const front = i < perBogie;
    const bogieCentre = front ? spec.bogieSpacing / 2 : -spec.bogieSpacing / 2;
    const indexInBogie = front ? i : i - perBogie;
    // 台車内で前軸が正、後軸が負になるよう配分する
    const rel = perBogie > 1 ? 0.5 - indexInBogie / (perBogie - 1) : 0;
    out.push(bogieCentre + rel * spec.bogieWheelbase);
  }
  return out;
}

/**
 * 定尺レールの継目を跨いだ位置を求める。
 *
 * 「いまの距離程が継目と一致したか」ではなく、**前ステップの位置と今ステップの
 * 位置のあいだを跨いだか**で判定する。地上子の通過判定（`PointTable.crossing`）と
 * 同じ考え方で、こうしないと高速走行や大きな描画間隔で継目を取りこぼす。
 *
 * 戻り値は区間内の位置 `u ∈ (0, 1]` で、`s = sPrev + u (sNow - sPrev)` が継目に
 * あたる。呼び出し側はこれをフレーム内の時刻へ直して、サンプル精度で音を
 * 鳴らせる。60fps でも「ガタン…ゴトン」の間隔が固定軸距・台車中心間距離
 * どおりになるのはこのためである。
 *
 * @param spacing 継目の間隔 [m]。0 以下ならロングレール（継目なし）。
 */
export function jointCrossings(
  sPrev: Meters,
  sNow: Meters,
  spacing: Meters,
  out: number[] = [],
): number[] {
  out.length = 0;
  if (spacing <= 0 || sPrev === sNow) return out;
  const delta = sNow - sPrev;
  if (delta > 0) {
    const first = Math.floor(sPrev / spacing) + 1;
    const last = Math.floor(sNow / spacing);
    for (let n = first; n <= last; n++) {
      out.push((n * spacing - sPrev) / delta);
    }
  } else {
    const first = Math.ceil(sPrev / spacing) - 1;
    const last = Math.ceil(sNow / spacing);
    for (let n = first; n >= last; n--) {
      out.push((n * spacing - sPrev) / delta);
    }
  }
  return out;
}
