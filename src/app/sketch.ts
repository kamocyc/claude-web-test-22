import { Vector3 } from 'three';
import { getClass } from '../network/classes';
import {
  anchorFromNode,
  computePlacement,
  placeSegment,
  type Anchor,
  type PlaceResult,
} from '../network/editing';
import type { Network } from '../network/network';
import {
  parallelTracks,
  placeParallel,
  type TrackAnchors,
} from '../network/parallel';
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
    };
  }
  return results;
}

/**
 * 経由点を順に繋いで、同じ線形を横に並べて引く (複線・三線)。
 *
 * 各スパンで中心線を 1 度だけ解き、その曲線をずらして 1 本ずつ敷くので、
 * 並んだ線どうしの間隔はどこでも同じになる。返り値はスパンごとの結果。
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
    const results = placeParallel(network, classId, tracks, preview, centre.pos.y, {
      starts,
      // 引き始めだけ、その位置にある既存のノードへ繋ぐ (draw と同じ)。
      snap:
        i === 1 && !options.start
          ? (pos) => {
              const node = network.findNodeNear(pos, 3);
              return node ? { pos: node.pos.clone(), node: node.id } : undefined;
            }
          : undefined,
    });
    spans.push(results);
    starts = results.map((result) => {
      const node = network.nodes.get(result.endNode);
      return node ? { pos: node.pos.clone(), node: node.id } : undefined;
    });
    centre = {
      pos: preview.end.clone(),
      tangent: preview.endTangent.clone(),
      grade: preview.endGrade,
    };
  }
  return spans;
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

  // 経由点間の勾配は規格の 9 割までに抑える。区間内の最大勾配は
  // computePlacement 側でも規格に収まるよう調整される。
  const limit = cls.maxGrade * 0.9;
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
