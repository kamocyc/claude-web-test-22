import type { LanePose } from '../../sim/lanegraph';
import { RampProfile, type RampSegment } from '../core/track/profile.ts';

/**
 * 車線の連なりを距離程の関数へ均す。
 *
 * 移植した物理は**世界座標を一度も要求しない**。距離程 s の関数 —— 曲率 κ(s)、
 * 勾配 i(s)、カント C(s) —— しか見ない。だからこちらの線形を railsim へ渡すのに
 * 必要なのは、走る道筋を s で刻んでこの 3 つを測ることだけである。
 *
 * 測り方は「敷いてある線をなぞる」に徹する。線形の内部表現 (ポリベジェの制御点や
 * 縦断の折れ線) には触れず、`LanePath.poseAt` が返す**実際に車両が通る姿勢**から
 * 読む。踏切のすり付けで舗装が上下する分も、曲線のカントも、`poseAt` には既に
 * 入っている。物理が感じる線路と、目に見える線路が、これで必ず一致する。
 */

/**
 * 方位角 [rad]。
 *
 * railsim の `Alignment` は平面位置を `x = cos θ`, `z = -sin θ` で積むので、
 * 方位角の測り方をそちらに合わせる。こうしておけば曲率の**符号**
 * (正 = 左曲がり) も自動的に揃う。取り違えるとカントが逆に付く。
 */
export function headingOf(dir: { x: number; z: number }): number {
  return Math.atan2(-dir.z, dir.x);
}

/** `to` を `from` に近い側の分枝へ寄せた角度差 [rad]。 */
function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** 距離程で刻んだ線形の諸元。 */
export interface TrackSample {
  /** 距離程 [m] */
  readonly s: number;
  /** 曲率 [1/m]。正 = 左曲がり。 */
  readonly curvature: number;
  /** 勾配 [m/m]。正 = 上り。 */
  readonly grade: number;
  /** カント [m]。正 = 曲線外側のレールが高い。 */
  readonly cant: number;
}

export interface SampleOptions {
  /** 刻み [m]。 */
  readonly step?: number;
  /** 軌間 [m]。横断勾配からカント量へ直すのに使う。 */
  readonly gauge?: number;
}

/**
 * 曲率を読むときに前後を見る距離 [m]。
 *
 * 方位角の差分で曲率を出すので、幅が要る。狭くすると `poseAt` の丸め誤差が
 * 割り算で拡大し、広くすると曲線の出入り口がなまる。半径 200 m の曲線で
 * 前後 0.5 m なら、なまりは 0.5 m ぶん —— 緩和曲線の長さ (数十 m) に対して
 * 十分小さい。
 */
const CURVATURE_HALF_SPAN = 0.5;

/**
 * 道筋を距離程で刻んで、曲率・勾配・カントを測る。
 *
 * 勾配とカントは 1 点で読める (`poseAt` が進行方向と横断勾配をそのまま返す)。
 * 曲率だけは方位角の**変化率**なので、前後を見た中心差分で出す。
 */
export function sampleTrack(
  poseAt: (s: number) => LanePose,
  length: number,
  options: SampleOptions = {},
): TrackSample[] {
  const step = options.step ?? 1;
  const gauge = options.gauge ?? 1.435;
  const count = Math.max(1, Math.round(length / step));
  const out: TrackSample[] = [];
  for (let i = 0; i <= count; i++) {
    const s = Math.min(length, (i * length) / count);
    const pose = poseAt(s);
    const flat = Math.hypot(pose.dir.x, pose.dir.z);

    // 前後の方位角の差 / その間の距離。端では片側だけ見る。
    const back = Math.max(0, s - CURVATURE_HALF_SPAN);
    const ahead = Math.min(length, s + CURVATURE_HALF_SPAN);
    const span = ahead - back;
    const curvature =
      span < 1e-9
        ? 0
        : angleDelta(headingOf(poseAt(back).dir), headingOf(poseAt(ahead).dir)) / span;

    out.push({
      s,
      curvature,
      // `dir` は 3 次元の単位ベクトルなので、水平成分で割れば水平 1 m あたりの
      // 上がりになる。距離程は水平弧長なので、これがそのまま勾配である。
      grade: flat < 1e-9 ? 0 : pose.dir.y / flat,
      // 横断勾配 × 軌間 = 左右レールの高低差。**符号が返る**。
      //
      // `LanePose.roll` が持ち上げるのは車体の局所 +X 側で、こちらの基底は
      // `right = UP × forward` で組んである。進行方向が +x なら
      // `UP × forward = -z`、つまり幾何的には**左**である (真東を向いて
      // 左手は北 = -z)。コードの中でここを「右」と呼んでいるのは局所 +X 軸の
      // 名前であって、方角ではない。
      //
      // 一方 railsim のカントは「曲線**外側**のレールが高いほど正」。左曲線
      // (κ > 0) の外側は幾何的な右なので、`roll` とは逆符号になる。取り違えると
      // 車体が曲線の外側へ倒れ、横加速度もカントのぶんだけ**増える**。
      cant: -pose.roll * gauge,
    });
  }
  return out;
}

/**
 * 刻んだ値を区分線形プロファイルにする。
 *
 * `RampProfile` は要素ごとに始端と終端の値を持ち、そのあいだを線形に結ぶ。
 * 刻んだ点をそのまま節点にすればよい。長さ 0 の要素は作れないので、
 * 距離程が動かない刻みは畳む。
 */
export function rampFromSamples(
  samples: readonly TrackSample[],
  valueOf: (sample: TrackSample) => number,
): RampProfile {
  const segments: RampSegment[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const length = b.s - a.s;
    if (!(length > 1e-9)) continue;
    segments.push({ length, startValue: valueOf(a), endValue: valueOf(b) });
  }
  if (segments.length === 0) {
    const value = samples.length > 0 ? valueOf(samples[0]!) : 0;
    segments.push({ length: 1, startValue: value, endValue: value });
  }
  return new RampProfile(segments);
}
