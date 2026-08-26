import { Vector3 } from 'three';
import { clamp } from '../core/units';
import { getClass, type NetworkClass } from '../network/classes';
import {
  anchorFromNode,
  computePlacement,
  placeSegment,
  type Anchor,
  type PlaceResult,
  type PlacementPreview,
} from '../network/editing';
import type { Network } from '../network/network';
import { offsetCurve, parallelSpacing } from '../network/parallel';
import type { Heightfield } from '../terrain/heightfield';

/**
 * 経由点から線形を引くための道具立て。
 *
 * サンプルやインターチェンジのような「あらかじめ用意した町並み」を作る
 * ときに使う。建設ツールとまったく同じ手順 (`computePlacement` →
 * `placeSegment`) を通すので、接線の引き継ぎ・自動交差点・取り付きの
 * なめらか化も手で敷いたときと同じように働く。
 */

export interface Waypoint {
  x: number;
  z: number;
  /** 絶対高さ。省略時は自然地形の高さ。 */
  y?: number;
}

export interface DrawOptions {
  /** 直線で結ぶ (既存の接線を引き継がない)。 */
  straight?: boolean;
  /** 始点の接続先。省略すると近くのノードを探し、無ければ新しく作る。 */
  start?: Anchor;
  /** 終点の接続先。既存の線形の途中に取り付けるときに指定する。 */
  end?: Anchor;
}

/** 経由点を順に繋いで線形を引く。 */
export function draw(
  network: Network,
  field: Heightfield,
  classId: string,
  points: Waypoint[],
  options: DrawOptions = {},
): PlaceResult[] {
  const cls = getClass(classId);
  const toVec = (p: Waypoint): Vector3 =>
    new Vector3(p.x, p.y ?? field.baseHeightAt(p.x, p.z), p.z);

  const first = toVec(points[0]);
  const existing = options.start ? null : network.findNodeNear(first, 3);
  let anchor: Anchor =
    options.start ?? (existing ? anchorFromNode(network, existing, cls) : { pos: first });

  const results: PlaceResult[] = [];
  for (let i = 1; i < points.length; i++) {
    const target = toVec(points[i]);
    const preview = computePlacement(anchor, target, {
      straight: options.straight ?? false,
      cls,
    });
    const last = i === points.length - 1;
    const end: Anchor = last && options.end ? { ...options.end } : { pos: target };
    const result = placeSegment(network, classId, anchor, end, preview);
    results.push(result);
    const endNode = network.nodes.get(result.endNode);
    if (!endNode) break;
    anchor = {
      pos: endNode.pos.clone(),
      node: endNode.id,
      tangent: preview.endTangent.clone(),
      grade: preview.endGrade,
      curvature: preview.endCurvature,
    };
  }
  return results;
}

/** 並べて敷く 1 本ぶん。 */
interface ParallelTrack {
  /** 中心線からの横距 [m] (進行方向の右手が正)。 */
  offset: number;
  /** 線形の向きを反転して敷くか。 */
  reversed: boolean;
}

/**
 * `count` 本を中心線の左右に振り分ける。
 *
 * 一方通行の種別 (ランプ) を並べたときは、左側通行になるよう右半分を逆向きに
 * 敷く。線路に向きは無いので、複線・三線はどれも同じ向きに敷く。
 */
export function parallelTracks(
  cls: NetworkClass,
  count: number,
  spacing = parallelSpacing(cls),
): ParallelTrack[] {
  const n = clamp(Math.round(count), 1, 8);
  const out: ParallelTrack[] = [];
  for (let i = 0; i < n; i++) {
    const offset = (i - (n - 1) / 2) * spacing;
    out.push({ offset, reversed: cls.oneWay && offset > 1e-6 });
  }
  return out;
}

/** 並べて敷くときの、線ごとの接続先。指定がなければ新しいノードを作る。 */
type TrackAnchors = (Anchor | undefined)[];

/**
 * 経由点を順に繋いで、同じ線形を横に並べて引く (複線・三線)。
 *
 * 敷設ツールの平行スナップと違って、**まだ何も無い所に複数の線をまとめて
 * 置く**ためのもの。サンプルやインターチェンジのように、あらかじめ用意した
 * 町並みを組み立てるときに使う。各スパンで中心線を 1 度だけ解き、その曲線を
 * ずらして 1 本ずつ敷くので、並んだ線どうしの間隔はどこでも同じになる。
 * 返り値はスパンごとの結果。
 */
export function drawParallel(
  network: Network,
  field: Heightfield,
  classId: string,
  points: Waypoint[],
  options: DrawOptions & { count: number; spacing?: number },
): PlaceResult[][] {
  const cls = getClass(classId);
  const tracks = parallelTracks(cls, options.count, options.spacing);
  const toVec = (p: Waypoint): Vector3 =>
    new Vector3(p.x, p.y ?? field.baseHeightAt(p.x, p.z), p.z);

  let centre: Anchor = options.start ?? { pos: toVec(points[0]) };
  let starts: TrackAnchors = [];
  const spans: PlaceResult[][] = [];

  for (let i = 1; i < points.length; i++) {
    const preview = computePlacement(centre, toVec(points[i]), {
      straight: options.straight ?? false,
      cls,
    });
    // 引き始めだけ、その位置にある既存のノードへ繋ぐ (draw と同じ)。
    const snap =
      i === 1 && !options.start
        ? (pos: Vector3): Anchor | undefined => {
            const node = network.findNodeNear(pos, 3);
            return node ? { pos: node.pos.clone(), node: node.id } : undefined;
          }
        : undefined;

    const results = placeTracks(network, classId, tracks, preview, centre.pos.y, starts, snap);
    spans.push(results);
    starts = results.map((result) => {
      const node = network.nodes.get(result.endNode);
      return node ? { pos: node.pos.clone(), node: node.id } : undefined;
    });
    centre = {
      pos: preview.end.clone(),
      tangent: preview.endTangent.clone(),
      grade: preview.endGrade,
      curvature: preview.endCurvature,
    };
  }
  return spans;
}

/** 中心線のプレビューから、並べる各線を 1 本ずつ敷く。 */
function placeTracks(
  network: Network,
  classId: string,
  tracks: ParallelTrack[],
  preview: PlacementPreview,
  startY: number,
  starts: TrackAnchors,
  snap?: (pos: Vector3) => Anchor | undefined,
): PlaceResult[] {
  const results: PlaceResult[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const horizontal = offsetCurve(preview.horizontal, track.offset);
    const startPos = new Vector3(horizontal.p0.x, startY, horizontal.p0.y);
    const endPos = new Vector3(horizontal.p1.x, preview.end.y, horizontal.p1.y);
    const start: Anchor = starts[i] ?? snap?.(startPos) ?? { pos: startPos };
    const end: Anchor = snap?.(endPos) ?? { pos: endPos };
    const result = placeSegment(network, classId, start, end, {
      ...preview,
      horizontal,
      start: startPos,
      end: endPos,
      endTangent: horizontal.tangentAt(horizontal.length),
      endCurvature: horizontal.curvatureAt(horizontal.length),
    });
    // 逆向きの線は、敷いてから向きだけ入れ替える (形は変わらない)。
    if (track.reversed) network.reverseSegment(result.segment);
    results.push(result);
  }
  return results;
}

/**
 * 経由点に縦断高さを与える。自然地形をならしたうえで、規格勾配を
 * 超えないよう前後から高さを制限する。
 */
export function smoothProfile(
  field: Heightfield,
  points: Waypoint[],
  classId: string,
  options: {
    passes?: number;
    lift?: number;
    startY?: number;
    /** 高さを固定する経由点 (踏切など、他の線形と高さを合わせたい点)。 */
    fixed?: { index: number; y: number }[];
    /**
     * 経由点間で許す勾配。既定は規格の 9 割。
     * 規格いっぱいまで使うと地形をそのままなぞってしまうので、
     * 「規格は満たすが、もっと緩く通したい」線形はここで抑える。
     */
    grade?: number;
  } = {},
): Waypoint[] {
  const cls = getClass(classId);
  const passes = options.passes ?? 3;
  const lift = options.lift ?? 1.5;
  const heights = points.map((p) => field.baseHeightAt(p.x, p.z));

  for (let pass = 0; pass < passes; pass++) {
    const next = heights.slice();
    for (let i = 1; i + 1 < heights.length; i++) {
      next[i] = (heights[i - 1] + heights[i] * 2 + heights[i + 1]) / 4;
    }
    heights.splice(0, heights.length, ...next);
  }

  // 高さを固定したい点 (接続点や踏切) を反映する。
  const locked = new Set<number>();
  if (options.startY !== undefined) {
    heights[0] = options.startY - lift;
    locked.add(0);
  }
  for (const fix of options.fixed ?? []) {
    heights[fix.index] = fix.y - lift;
    locked.add(fix.index);
  }

  // 経由点間の勾配は指定がなければ規格の 9 割までに抑える。区間内の
  // 最大勾配は computePlacement 側でも規格に収まるよう調整される。
  const limit = Math.min(options.grade ?? cls.maxGrade * 0.9, cls.maxGrade * 0.9);
  const spans = points.map((p, i) =>
    i === 0 ? 0 : Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z),
  );
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 1; i < heights.length; i++) {
      if (locked.has(i)) continue;
      heights[i] = clampDelta(heights[i], heights[i - 1], limit * spans[i]);
    }
    for (let i = heights.length - 2; i >= 0; i--) {
      if (locked.has(i)) continue;
      heights[i] = clampDelta(heights[i], heights[i + 1], limit * spans[i + 1]);
    }
  }

  return points.map((p, i) => ({ ...p, y: heights[i] + lift }));
}

function clampDelta(value: number, reference: number, max: number): number {
  if (value > reference + max) return reference + max;
  if (value < reference - max) return reference - max;
  return value;
}
