import { creepAdhesionDerivative } from './adhesion.ts';
import type { AdhesionSpec, RailCondition } from '../vehicle/spec.ts';
import type { Meters, MetersPerSecond, PerMeter, Radians } from '../units.ts';

/**
 * 曲線通過時の輪軸の**アタック角** [rad]。
 *
 * 1 つの台車の 2 本の輪軸は台車枠に平行に保持されているので、曲線では両方を同時に
 * 半径方向へ向けることができない。台車が円弧の弦に沿って落ち着くと考えると、
 * 台車中心から ±a（a = 固定軸距の半分）だけ離れた前後の輪軸は、進行方向に対して
 *
 *   α ≈ a κ = a / R
 *
 * だけ傾く。先頭輪軸は外軌側へ、後尾輪軸は内軌側へ、大きさの等しい逆向きの角を持つ。
 * 固定軸距 2.1m の通勤形なら R400 で 2.6mrad、R145（#8 分岐器のリード）で 7.2mrad。
 *
 * 車輪はこの角度だけ横を向いたまま転がるので、接触面には**横クリープ**
 * `ξ_横 ≈ tan α ≈ α` が生じる。これが曲線での軋み音の駆動源である。
 */
export function curvingAngleOfAttack(curvature: PerMeter, bogieWheelbase: Meters): Radians {
  return (Math.abs(curvature) * bogieWheelbase) / 2;
}

/**
 * 通り狂い（横方向の軌道狂い）が加えるアタック角 [rad]。
 *
 * 曲率が 0 でも、レールが横へ振れていればそこを追う車輪は横を向く。ただしその角度は
 * 狂いの**点での微分**ではない。台車の 2 本の輪軸は ±a にあり、台車のヨー角は
 * その 2 点を結ぶ**弦の傾き**で決まる:
 *
 *   α ≈ |y(s + a) − y(s − a)| / 2a
 *
 * 微分ではなく弦を取ること自体が「台車は固定軸距より短い波長の狂いを追えない」
 * ことを表している。これを微分でやると、波長 1m の細かい狂いが数 mrad の
 * アタック角に化けて、平坦な直線でも軋み音が鳴りっぱなしになってしまう。
 *
 * 弦で取れば直線区間の寄与は 1mrad にも届かず（通り狂いは波長 10〜30m で数 mm）、
 * 軋み音の閾値には遠く及ばない。効いてくるのは分岐器で、トングレールの遊間
 * （4mm を 1.4m で）は軸距に近い長さで効くので数 mrad のアタック角になる。
 * **分岐器を渡るとき一瞬キッと鳴る**のはこれである。
 */
export function lateralChordAngle(
  lateralAt: (s: Meters) => Meters,
  s: Meters,
  bogieWheelbase: Meters,
): Radians {
  const a = bogieWheelbase / 2;
  return Math.abs((lateralAt(s + a) - lateralAt(s - a)) / bogieWheelbase);
}

/**
 * レール踏面の状態ごとの軋み音の出やすさ。
 *
 * 粘着係数の倍率（`RAIL_CONDITION_FACTOR`）とは別の表にしてある。軋み音を決めるのは
 * 摩擦係数の**大きさ**ではなく、すべり速度に対する**傾き**が負であることだからで、
 * 水膜や汚染はこの負勾配をならしてしまう。雨が降ると曲線の軋み音がぱたりと止むのは
 * よく知られた現象で、粘着が 35% 落ちる程度の話では説明がつかない。
 */
export const SQUEAL_RAIL_FACTOR: Readonly<Record<RailCondition, number>> = {
  dry: 1.0,
  wet: 0.12,
  leaves: 0.08,
  snow: 0.08,
};

/**
 * この速度 [m/s] までは軋みが立ち上がりきらない。
 * 転がっていなければ固着と滑りの繰り返しも起きないので、停車前後では消える。
 */
const SQUEAL_FADE_SPEED = 1.5;

/**
 * 振れ幅が飽和する負勾配の深さ（最大の負勾配に対する比）。
 *
 * 負減衰の深さが決めているのは**育つ速さ**であって、行き着く振れ幅ではない。
 * 振れ幅を決めているのは摩擦の非線形（滑りが大きくなれば摩擦が追いつかなくなる）
 * のほうで、いったん自励が始まればすぐ限界サイクルに達する。したがってここでは、
 * 不安定になってから最大の負勾配の 4 割ほどで振れ幅が頭打ちになるものとして扱う。
 */
const LIMIT_CYCLE_MARGIN = 0.4;

/**
 * クリープ曲線の傾きが負へ転じる正規化すべり率 x。
 *
 * `μ(x) = μ_k tanh(2x) + (μ_p − μ_k)·2x/(1+x²)` の傾きが 0 になる点で、ピーク
 * （x = 1 付近）より少し先にある。tanh の項がまだ持ち上げているためで、
 * 「ピークを越えたら即座に負減衰」ではない。滑走比によって動くので数値で解く。
 */
function unstableThreshold(kineticRatio: number): number {
  let low = 1;
  let high = 4;
  if (creepAdhesionDerivative(high, 1, kineticRatio) >= 0) return high;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (creepAdhesionDerivative(mid, 1, kineticRatio) >= 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * 曲線の軋み音の駆動の強さ 0..1。
 *
 * 軋り（curve squeal）は摩擦の**自励振動**である。輪軸が横を向いて転がると接触面に
 * 横クリープが生じ、その量が飽和を越えると摩擦係数がすべりに対して**下がりはじめる**。
 * 傾きが負ということは減衰が負ということなので、車輪の軸方向の固有振動が自分で
 * 育っていく。純音に近い大きな音になるのはこのためで、単に擦れているのとは違う。
 *
 * 判定にはブレーキの鳴きや空気ばねのきしみのような「遅いときだけ」という当てはめを
 * 使わず、**この模型が空転・滑走にも使っているクリープ曲線そのもの**の傾きを見る。
 *
 * ```
 * x = α / ξ_飽和                                  横クリープを飽和すべり率で正規化
 * 駆動 = max(0, −dμ/dx) / (最大の負勾配 × 飽和比)   1 で頭打ち
 * ```
 *
 * 負勾配は `x = √3` 付近で最大 `0.25 (μ_p − μ_k)` を取り、それより先ではまた 0 へ
 * 戻る。完全な滑りに入れば摩擦が一定値へ漸近するので負勾配が消える、という当たり前の
 * ことがそのまま出ている。したがって**軋るのは半径のある帯**であって、いくら急でも
 * 鳴るわけではない。この模型の範囲（在来線の曲線と分岐器）はその帯の中に収まる。
 */
export function curveSquealDrive(
  adhesion: AdhesionSpec,
  angleOfAttack: Radians,
  speed: MetersPerSecond,
  rail: RailCondition,
): number {
  const saturation = adhesion.lateralCreepSaturation;
  if (saturation <= 0) return 0;
  const x = angleOfAttack / saturation;
  const slope = creepAdhesionDerivative(x, 1, adhesion.kineticRatio);
  if (slope >= 0) return 0;
  // 負勾配の最大値。x = √3 のときの 0.25 (1 − 滑走比)。
  const worst = 0.25 * (1 - adhesion.kineticRatio);
  if (worst <= 0) return 0;
  const margin = Math.min(1, -slope / (worst * LIMIT_CYCLE_MARGIN));
  const rolling = Math.min(1, Math.abs(speed) / SQUEAL_FADE_SPEED);
  return margin * rolling * SQUEAL_RAIL_FACTOR[rail];
}

/** 1 つの台車の軋みを決める量 */
export interface BogieSquealInput {
  readonly adhesion: AdhesionSpec;
  /** 台車中心の位置での曲率 [1/m] */
  readonly curvature: PerMeter;
  /** 距離程 -> 通り狂い [m]（軌道狂いと分岐器を足したもの） */
  readonly lateralAt: (s: Meters) => Meters;
  /** 台車中心の距離程 [m] */
  readonly position: Meters;
  readonly bogieWheelbase: Meters;
  readonly speed: MetersPerSecond;
  readonly rail: RailCondition;
}

/**
 * 台車 1 つぶんの軋みの駆動の強さ 0..1。
 *
 * アタック角は曲線による分と通り狂いによる分の和である。**分岐器を特別扱いする
 * 分岐は 1 つも要らない**のが要点で、トングレールの遊間も護輪軌条の押し戻しも
 * 通り狂いとして書かれているため、曲線とまったく同じ経路を通って出てくる。
 */
export function bogieSquealDrive(input: BogieSquealInput): number {
  const angle =
    curvingAngleOfAttack(input.curvature, input.bogieWheelbase) +
    lateralChordAngle(input.lateralAt, input.position, input.bogieWheelbase);
  return curveSquealDrive(input.adhesion, angle, input.speed, input.rail);
}

/**
 * 軋み音が出はじめる曲線半径 [m]。
 *
 * アタック角 `a/R` がクリープ曲線の負勾配域へ入る半径そのもので、諸元から一意に
 * 決まる。固定軸距 2.1m・飽和 3mrad・滑走比 0.6 なら 300m 前後になり、
 * 「曲線半径が固定軸距の 100〜200 倍を下回ると鳴きはじめる」という現場の目安と
 * 桁が合う。試験線の本線（R600・R400）はこれより緩いので、**曲線ぶんだけでは鳴かない**
 * （R400 は通り狂いが乗ったところで越えるので断続的に鳴る）。
 */
export function squealOnsetRadius(adhesion: AdhesionSpec, bogieWheelbase: Meters): Meters {
  const threshold = adhesion.lateralCreepSaturation * unstableThreshold(adhesion.kineticRatio);
  return threshold > 0 ? bogieWheelbase / 2 / threshold : Infinity;
}
