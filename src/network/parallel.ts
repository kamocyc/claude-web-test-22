import { Vector3 } from 'three';
import { HorizontalCurve, perp } from '../core/curve';
import { clamp } from '../core/units';
import type { NetworkClass } from './classes';
import { placeSegment, type Anchor, type PlacementPreview, type PlaceResult } from './editing';
import type { Network } from './network';

/**
 * 並列敷設。
 *
 * 複線・三線は「1 本の種別」ではなく、**同じ線形を横にずらして並べたもの**
 * として作る。こうすると、片側だけを分岐させる・片側だけ橋にする・途中で
 * 本数を変える、といったことが特別扱いなしにできる。1 本 1 本は普通の
 * セグメントなので、交差点・踏切・構造形式の判定もそのまま働く。
 */

/** 並列敷設の 1 本ぶん。 */
export interface ParallelTrack {
  /** 中心線からの横距 [m] (進行方向の右手が正)。 */
  offset: number;
  /** 線形の向きを反転して敷くか。 */
  reversed: boolean;
}

/** 並べるときの既定の間隔 [m]。舗装 (道床) の縁が触れ合う幅にする。 */
export function defaultSpacing(cls: NetworkClass): number {
  return Math.round((cls.halfWidth * 2 + 0.2) * 10) / 10;
}

/**
 * `count` 本を中心線の左右に振り分ける。
 *
 * 一方通行の種別 (線路・ランプ) を並べたときは、左側通行になるよう右半分を
 * 逆向きに敷く。2 本並べれば複線、3 本なら中央が上り方向の三線になる。
 */
export function parallelTracks(
  cls: NetworkClass,
  count: number,
  spacing = defaultSpacing(cls),
): ParallelTrack[] {
  const n = clamp(Math.round(count), 1, 8);
  const out: ParallelTrack[] = [];
  for (let i = 0; i < n; i++) {
    const offset = (i - (n - 1) / 2) * spacing;
    out.push({ offset, reversed: cls.oneWay && offset > 1e-6 });
  }
  return out;
}

/**
 * 平面線形を横に `offset` [m] ずらした曲線。
 *
 * 端点は法線方向にそのままずらし、制御点の長さは曲率に応じて縮める
 * (半径 R の弧を曲率中心の側へ d ずらすと半径 R - d になる)。この規模の
 * 曲線 (最小半径 45 m 以上、ずらす量は 10 m 程度) では、正確なオフセット
 * 曲線との差は数 cm に収まる。
 */
export function offsetCurve(curve: HorizontalCurve, offset: number): HorizontalCurve {
  if (Math.abs(offset) < 1e-6) return curve;
  const length = curve.length;
  const t0 = curve.tangentAt(0);
  const t1 = curve.tangentAt(length);
  const p0 = curve.pointAt(0).add(perp(t0).multiplyScalar(offset));
  const p1 = curve.pointAt(length).add(perp(t1).multiplyScalar(offset));
  const shrink = (k: number): number => clamp(1 - offset * k, 0.05, 4);
  const h0 = curve.c0.distanceTo(curve.p0) * shrink(curve.curvatureAt(0));
  const h1 = curve.c1.distanceTo(curve.p1) * shrink(curve.curvatureAt(length));
  return new HorizontalCurve(
    p0,
    p0.clone().addScaledVector(t0, h0),
    p1.clone().addScaledVector(t1, -h1),
    p1,
  );
}

/** 並列敷設 1 スパンぶんの接続先。指定がなければ新しいノードを作る。 */
export type TrackAnchors = (Anchor | undefined)[];

export interface ParallelOptions {
  /** 線ごとの始点の接続先。 */
  starts?: TrackAnchors;
  /** 線ごとの終点の接続先。 */
  ends?: TrackAnchors;
  /**
   * 接続先が指定されていない端点で呼ばれる。その位置に既存のノードが
   * あれば繋ぎたい場合に使う (敷設済みの複線の続きを引く、など)。
   */
  snap?: (pos: Vector3) => Anchor | undefined;
}

/**
 * 中心線のプレビューから、並列の各線を実際に敷く。
 *
 * 1 本ずつ `placeSegment` を通すので、既存の線形との自動交差点・取り付きの
 * なめらか化も普通に敷いたときと同じように働く。
 */
export function placeParallel(
  network: Network,
  classId: string,
  tracks: ParallelTrack[],
  preview: PlacementPreview,
  /** 中心線の始点の高さ。 */
  startY: number,
  options: ParallelOptions = {},
): PlaceResult[] {
  const { starts = [], ends = [], snap } = options;
  const results: PlaceResult[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const horizontal = offsetCurve(preview.horizontal, track.offset);
    const startPos = new Vector3(horizontal.p0.x, startY, horizontal.p0.y);
    const endPos = new Vector3(horizontal.p1.x, preview.end.y, horizontal.p1.y);
    const start: Anchor = starts[i] ?? snap?.(startPos) ?? { pos: startPos };
    const end: Anchor = ends[i] ?? snap?.(endPos) ?? { pos: endPos };
    const result = placeSegment(network, classId, start, end, {
      ...preview,
      horizontal,
      end: endPos,
      endTangent: horizontal.tangentAt(horizontal.length),
    });
    // 逆向きの線は、敷いてから向きだけ入れ替える (形は変わらない)。
    if (track.reversed) network.reverseSegment(result.segment);
    results.push(result);
  }
  return results;
}
