import { Vector2, Vector3 } from 'three';
import { Alignment } from '../core/alignment';
import { VerticalProfile } from '../core/profile';
import { CROSSING_MATCH_LIMIT, LEVEL_CROSSING_TOLERANCE } from '../core/units';
import type { NetworkClass, NetworkKind } from './classes';
import { toPolyline, intersectPolylines } from './crossings';
import { AUTO_JUNCTION_TOLERANCE, CROSSING_END_MARGIN, solveChainProfile } from './editing';
import type { NetNode, Network, NodeId, SegmentId } from './network';
import { minCrossingAngle, type MatchedCrossingHint } from './rules';

/**
 * 交点の高さ合わせ。
 *
 * 線形どうしが交わる所は、高さがほぼ揃っているときだけ平面交差 (踏切・
 * 交差点・ダイヤモンドクロッシング) になる。少しでもずれていると立体交差
 * 扱いになり、桁下が足りずに敷けない。同じ高さのつもりで引いた人にとっては
 * 「なぜか置けない」だけなので、**あとから引いた方が交点の高さに合わせに行く**。
 *
 * 縦断は 1 セグメントにつき 3 次エルミートが 1 本 (`Network.alignmentOf`) なので、
 * 途中の高さを指定するには**そこで区間を分ける**しかない。分けた節点の高さを
 * 交点の高さに固定し、`solveChainProfile` で節点を通る縦断を解き直す。
 *
 * 線路と道路の交点だけは、どちらをあとから引いても**道路側**が合わせる
 * (レールの高さは列車が走る面そのもので、踏切は路面をレールに合わせるのが実際)。
 * 線路を既設の道路の上に引いたときは、既設の道路の方を曲げる (`RoadEdit`)。
 *
 * ここにある関数はネットワークを変更しない。プレビューと確定で同じ答えが
 * 出るようにするため、立案 (`planCrossingHeights`) と適用 (`splitAtCrossing`,
 * `applyRoadEdit`) を分けている。
 */

/** 高さを合わせる交点 1 か所。 */
export interface MatchedCrossing {
  /** 相手のセグメント。立案時点の ID なので、確定時は位置から引き直す。 */
  segment: SegmentId;
  /** 相手の種別。引き直しで取り違えないため。 */
  kind: NetworkKind;
  /** 相手の側の弧長 [m] (立案時点)。 */
  sOther: number;
  /** 交点の位置 (高さは合わせた後)。 */
  point: Vector3;
  /** 合わせた後の交点の高さ [m]。 */
  y: number;
  /** 合わせた後の、相手の側の縦断勾配。 */
  grade: number;
}

/** 引いている線形を交点で区切った 1 区間。 */
export interface CrossingLeg {
  alignment: Alignment;
  /** この区間の上にある、意図した平面交差 (`checkPlacement` へ渡す)。 */
  matched: MatchedCrossingHint[];
  /** 終端が交点なら、そこで分割する相手。最後の区間では undefined。 */
  joint?: MatchedCrossing;
}

/** 既設の道路に加える変更 (線路を道路の上に引いたとき)。 */
export interface RoadEdit {
  target: MatchedCrossing;
  /** 分割点に与える高さ [m] (= レールの高さ)。 */
  y: number;
  /** 分割してできる 2 本の端点勾配 [始点, 節点, 終点]。 */
  grades: [number, number, number];
}

export interface CrossingHeightPlan {
  legs: CrossingLeg[];
  roadEdits: RoadEdit[];
  /** 空でなければ敷設できない。 */
  blockers: { message: string; at: Vector3 }[];
}

/** 同じ交点を指す重複をまとめる距離 [m] (`dedupeCrossings` と同じ考え方)。 */
const MERGE_DISTANCE = 2.5;

/** 交点を詰めるニュートン法の回数。折れ線の弦誤差 (3 m 刻み) を消すのに使う。 */
const REFINE_STEPS = 3;

interface RawHit {
  segment: SegmentId;
  kind: NetworkKind;
  cls: NetworkClass;
  s: number;
  sOther: number;
  point: Vector3;
  /** 相手の交点の高さ [m]。 */
  otherY: number;
  /** 自分の交点の高さ [m] (合わせる前)。 */
  ownY: number;
  /** 相手の交点の勾配。 */
  otherGrade: number;
  /** 交差角の正弦。 */
  sin: number;
}

/**
 * 交点を線形そのもので詰める。
 *
 * 折れ線は 3 m の弦近似なので、そのままでは交点が数十 cm ずれる。ここで出た
 * 弧長がそのまま分割位置 = ノードの位置になるので、曲線の上では効いてくる。
 * 2 本の接線で 2 元 1 次を解き、ずれを詰める向きへ進める。
 */
function refineHit(
  mine: Alignment,
  other: Alignment,
  s0: number,
  t0: number,
): { s: number; t: number } {
  let s = s0;
  let t = t0;
  for (let i = 0; i < REFINE_STEPS; i++) {
    const a = mine.sampleAt(s);
    const b = other.sampleAt(t);
    const rx = b.pos.x - a.pos.x;
    const rz = b.pos.z - a.pos.z;
    if (Math.hypot(rx, rz) < 1e-4) break;
    const da = a.forwardXZ;
    const db = b.forwardXZ;
    // a.pos + da * ds = b.pos + db * dt を解く。
    const det = da.x * -db.y - da.y * -db.x;
    if (Math.abs(det) < 1e-9) break;
    const ds = (rx * -db.y - rz * -db.x) / det;
    const dt = (da.x * rz - da.y * rx) / det;
    s = Math.max(0, Math.min(mine.length, s + ds));
    t = Math.max(0, Math.min(other.length, t + dt));
  }
  return { s, t };
}

/** 端点で既に繋がっている相手 (交点として扱わない)。 */
function connectedSegments(
  network: Network,
  nodes: readonly (NodeId | undefined)[],
): Set<SegmentId> {
  const out = new Set<SegmentId>();
  for (const id of nodes) {
    if (id === undefined) continue;
    const node = network.nodes.get(id);
    if (!node) continue;
    for (const segment of node.segments) out.add(segment);
  }
  return out;
}

/** 引いている線形と既存の線形の交点のうち、高さを合わせにいくものを集める。 */
function collectHits(
  network: Network,
  cls: NetworkClass,
  alignment: Alignment,
  ignore: ReadonlySet<SegmentId>,
): RawHit[] {
  const mine = toPolyline(alignment);
  const found: RawHit[] = [];

  for (const seg of network.segments.values()) {
    if (ignore.has(seg.id)) continue;
    // 駅構内の線路は分割できない (`Network.splitSegment` が例外を投げる)。
    if (seg.stationTrack) continue;
    const other = network.classOf(seg);
    const otherAlignment = network.alignmentOf(seg.id);
    const hits = intersectPolylines(mine, toPolyline(otherAlignment));

    for (const hit of hits) {
      const { s, t } = refineHit(alignment, otherAlignment, hit.sA, hit.sB);
      // 端に寄りすぎた交点では分割できない。極端に短い区間を作らない。
      if (s < CROSSING_END_MARGIN || s > alignment.length - CROSSING_END_MARGIN) continue;
      if (t < CROSSING_END_MARGIN || t > otherAlignment.length - CROSSING_END_MARGIN) continue;

      const a = alignment.sampleAt(s);
      const b = otherAlignment.sampleAt(t);
      const dy = Math.abs(a.pos.y - b.pos.y);
      if (dy > CROSSING_MATCH_LIMIT) continue;
      // 既に高さが揃っている交点は従来の仕組みに任せる。同じ種別なら敷いた
      // 後に `resolveAutoJunctions` が交差点にまとめ、線路と道路なら
      // `findCrossings` がそのまま踏切にする。ここで手を出すと、今まで
      // どおり置けていた線形 (シーサスクロッシングなど) の敷き方まで変わる。
      const settled = cls.kind === other.kind ? AUTO_JUNCTION_TOLERANCE : LEVEL_CROSSING_TOLERANCE;
      if (dy <= settled) continue;
      const sin = Math.abs(a.forwardXZ.x * b.forwardXZ.y - a.forwardXZ.y * b.forwardXZ.x);
      // 浅すぎる交差は交差点にならない。合わせずに従来の規則へ渡す。
      if (sin < Math.sin(minCrossingAngle(cls, other))) continue;

      found.push({
        segment: seg.id,
        kind: other.kind,
        cls: other,
        s,
        sOther: t,
        point: new Vector3(b.pos.x, b.pos.y, b.pos.z),
        otherY: b.pos.y,
        ownY: a.pos.y,
        otherGrade: b.grade,
        sin,
      });
    }
  }

  // 折れ線の頂点の上で交わると隣り合う辺で二重に当たる。1 か所にまとめる。
  const kept: RawHit[] = [];
  for (const hit of found.sort((p, q) => p.s - q.s)) {
    if (kept.some((k) => k.point.distanceTo(hit.point) < MERGE_DISTANCE)) continue;
    kept.push(hit);
  }
  return kept;
}

/** 勾配制限を超えたときの文言。 */
function gradeMessage(cls: NetworkClass, grade: number): string {
  return (
    `交点の高さに合わせると ${cls.label} の勾配が ${(grade * 100).toFixed(1)}% になり、` +
    `最大勾配 ${(cls.maxGrade * 100).toFixed(1)}% を超えます。`
  );
}

/** 区間の縦断の最大勾配。 */
function chainMaxGrade(heights: number[], lengths: number[], grades: number[]): number {
  let worst = 0;
  for (let i = 0; i < lengths.length; i++) {
    const profile = new VerticalProfile(
      heights[i],
      heights[i + 1],
      grades[i],
      grades[i + 1],
      lengths[i],
    );
    worst = Math.max(worst, profile.maxGrade(32));
  }
  return worst;
}

/**
 * 交点の高さに合わせた敷設を立案する。ネットワークは一切変更しない。
 *
 * 合わせる交点が無ければ `null` (従来どおり 1 本の線形で敷く)。
 *
 * @param ends 端の勾配。`endGrade` が null なら平均勾配に任せる。
 */
export function planCrossingHeights(
  network: Network,
  cls: NetworkClass,
  alignment: Alignment,
  ends: { startGrade: number; endGrade: number | null },
  options: { ignore?: ReadonlySet<SegmentId>; startNode?: NodeId; endNode?: NodeId } = {},
): CrossingHeightPlan | null {
  if (alignment.length < CROSSING_END_MARGIN * 2) return null;

  const skip = new Set<SegmentId>(options.ignore ?? []);
  for (const id of connectedSegments(network, [options.startNode, options.endNode])) skip.add(id);

  const hits = collectHits(network, cls, alignment, skip);
  if (hits.length === 0) return null;

  // 線路を道路の上に引いたときだけ、動くのは**既設の道路**。それ以外は
  // 引いている自分が合わせる。
  const railOverRoad = hits.filter((h) => cls.kind === 'rail' && h.kind === 'road');
  const mine = hits.filter((h) => !(cls.kind === 'rail' && h.kind === 'road'));

  const blockers: { message: string; at: Vector3 }[] = [];
  const roadEdits: RoadEdit[] = [];

  // --- 自分が合わせる分 -----------------------------------------------------
  // 先に自分の縦断を解く。道路側を合わせる高さは、**合わせ終わった後の**
  // レールの高さでないといけない (同じ線形が線路とも道路とも交わる場合)。
  let legs: CrossingLeg[] = [{ alignment, matched: [] }];
  let stations: number[] = [0, alignment.length];
  let matchedSelf = false;

  if (mine.length > 0) {
    // 交点で平面を切り分ける。長さは切った後の制御点から測り直した値を使う
    // (確定後に `Network.alignmentOf` が組み直すのと同じ値になる)。
    stations = [0, ...mine.map((h) => h.s), alignment.length];
    const pieces = [];
    for (let i = 0; i + 1 < stations.length; i++) {
      const sub = alignment.subAlignment(stations[i], stations[i + 1]);
      if (sub.horizontal.length < CROSSING_END_MARGIN) return null;
      pieces.push(sub.horizontal);
    }
    const lengths = pieces.map((h) => h.length);
    const heights = [alignment.vertical.y0, ...mine.map((h) => h.otherY), alignment.vertical.y1];

    const solved = solveChainProfile(
      heights,
      lengths,
      { start: ends.startGrade, end: ends.endGrade },
      cls,
    );
    if (!solved.feasible) {
      // 合わせられないなら、脚には分けず元の 1 本を返す。理由をここで足すので、
      // 「合わせようとしたが勾配が足りない」と「そのままでは桁下が足りない」の
      // 2 つが並ぶ。どちらも本当のことで、直し方 (高さを変える) も同じ。
      return {
        legs: [{ alignment, matched: [] }],
        roadEdits: [],
        blockers: [
          {
            message: gradeMessage(cls, chainMaxGrade(heights, lengths, solved.grades)),
            at: mine[0].point.clone(),
          },
        ],
      };
    }

    legs = pieces.map((horizontal, i) => {
      const leg = new Alignment(
        horizontal,
        new VerticalProfile(
          heights[i],
          heights[i + 1],
          solved.grades[i],
          solved.grades[i + 1],
          horizontal.length,
        ),
      );
      const hit = mine[i];
      // 相手と**同じ種別**のときだけ、そこで相手も分割してノードを共有する
      // (交差点・クロッシングになる)。線路と道路はノードを共有してはいけない。
      // `findCrossings` はノードを共有する組を飛ばすので、共有すると踏切に
      // ならなくなる。道路の方は交点で分けて高さを合わせるだけでよい。
      const joint: MatchedCrossing | undefined =
        hit && hit.kind === cls.kind
          ? {
              segment: hit.segment,
              kind: hit.kind,
              sOther: hit.sOther,
              point: new Vector3(hit.point.x, hit.otherY, hit.point.z),
              y: hit.otherY,
              grade: hit.otherGrade,
            }
          : undefined;
      // この脚に載る交点は、始端 (前の脚との境目) と終端 (自分の交点)。
      const matched: MatchedCrossingHint[] = [];
      if (i > 0) {
        const before = mine[i - 1];
        matched.push({ segment: before.segment, s: 0, y: before.otherY, grade: before.otherGrade });
      }
      if (hit) {
        matched.push({
          segment: hit.segment,
          s: horizontal.length,
          y: hit.otherY,
          grade: hit.otherGrade,
        });
      }
      return { alignment: leg, matched, joint };
    });
    matchedSelf = true;
  }

  // --- 既設の道路を曲げる分 -------------------------------------------------
  for (const hit of railOverRoad) {
    // 合わせる高さは、**解き終わった後の**レールの高さ。同じ線形が線路とも
    // 道路とも交わるときは、線路との交点に合わせて縦断が変わっているので、
    // 元の線形から読むと合わない。
    const found = legs.findIndex((_, i) => hit.s <= stations[i + 1] + 1e-6);
    const index = found < 0 ? legs.length - 1 : found;
    const local = Math.max(0, Math.min(legs[index].alignment.length, hit.s - stations[index]));
    const railY = legs[index].alignment.sampleAt(local).pos.y;

    const roadAlignment = network.alignmentOf(hit.segment);
    const seg = network.getSegment(hit.segment);
    const lengths = [hit.sOther, roadAlignment.length - hit.sOther];
    const heights = [roadAlignment.vertical.y0, railY, roadAlignment.vertical.y1];
    // 両端の勾配は動かさない。折れが隣のセグメントへ伝わらないようにする。
    const solved = solveChainProfile(
      heights,
      lengths,
      { start: seg.gradeA, end: seg.gradeB },
      hit.cls,
    );
    if (!solved.feasible) {
      blockers.push({
        message: gradeMessage(hit.cls, chainMaxGrade(heights, lengths, solved.grades)),
        at: new Vector3(hit.point.x, railY, hit.point.z),
      });
      continue;
    }
    const target: MatchedCrossing = {
      segment: hit.segment,
      kind: hit.kind,
      sOther: hit.sOther,
      point: new Vector3(hit.point.x, railY, hit.point.z),
      y: railY,
      grade: solved.grades[1],
    };
    roadEdits.push({
      target,
      y: railY,
      grades: [solved.grades[0], solved.grades[1], solved.grades[2]],
    });
    // 判定は「合わせた後の道路」で行う。合わせる前の高低差で見ると、必ず
    // 「桁下が足りません」になってしまう。
    const hint: MatchedCrossingHint = {
      segment: hit.segment,
      s: hit.s - stations[index],
      y: railY,
      grade: solved.grades[1],
    };
    legs[index].matched.push(hint);
  }

  if (!matchedSelf && roadEdits.length === 0 && blockers.length === 0) return null;
  return { legs, roadEdits, blockers };
}

/** 位置・種別・高さから、いまのネットワークで交点に当たるセグメントを探す。 */
function locate(
  network: Network,
  match: MatchedCrossing,
  exclude: ReadonlySet<SegmentId>,
): { segment: SegmentId; s: number } | null {
  let best: { segment: SegmentId; s: number; distance: number } | null = null;
  const point = new Vector2(match.point.x, match.point.z);

  for (const seg of network.segments.values()) {
    if (exclude.has(seg.id) || seg.stationTrack) continue;
    if (network.classOf(seg).kind !== match.kind) continue;
    const alignment = network.alignmentOf(seg.id);
    const L = alignment.length;
    const steps = Math.max(4, Math.ceil(L / 2));
    let bestS = 0;
    let bestDistance = Infinity;
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * L;
      const d = alignment.horizontal.pointAt(s).distanceTo(point);
      if (d < bestDistance) {
        bestDistance = d;
        bestS = s;
      }
    }
    // 粗探索のあとで 2 分ずつ詰める。
    let span = L / steps;
    for (let i = 0; i < 12; i++) {
      span /= 2;
      for (const s of [bestS - span, bestS + span]) {
        if (s < 0 || s > L) continue;
        const d = alignment.horizontal.pointAt(s).distanceTo(point);
        if (d < bestDistance) {
          bestDistance = d;
          bestS = s;
        }
      }
    }
    if (bestDistance > MERGE_DISTANCE) continue;
    if (Math.abs(alignment.vertical.yAt(bestS) - match.y) > CROSSING_MATCH_LIMIT) continue;
    if (bestS < CROSSING_END_MARGIN || bestS > L - CROSSING_END_MARGIN) continue;
    if (!best || bestDistance < best.distance) {
      best = { segment: seg.id, s: bestS, distance: bestDistance };
    }
  }
  return best ? { segment: best.segment, s: best.s } : null;
}

/**
 * 交点で相手を分割して、共有するノードを返す。
 *
 * 相手の ID は分割のたびに変わるので、立案時の ID は使わずに位置・種別・
 * 高さから引き直す。既に敷いた自分の区間を拾わないよう `exclude` を渡す。
 */
export function splitAtCrossing(
  network: Network,
  match: MatchedCrossing,
  exclude: ReadonlySet<SegmentId>,
): NetNode | null {
  const found = locate(network, match, exclude);
  if (!found) return null;
  return network.splitSegment(found.segment, found.s);
}

/**
 * 既設の道路を交点の高さへ曲げる。
 *
 * 分割してできたノードの高さをレールの高さにし、前後の縦断を解き直す。
 * 両端の勾配は変えないので、隣のセグメントへ折れが伝わらない。
 *
 * **元に戻す仕組みは無い** (このアプリに undo は無く、線路を撤去しても
 * 道路の縦断は変わったまま残る)。
 */
export function applyRoadEdit(
  network: Network,
  edit: RoadEdit,
  exclude: ReadonlySet<SegmentId>,
): NodeId | null {
  const node = splitAtCrossing(network, edit.target, exclude);
  if (!node) return null;
  network.moveNode(node.id, new Vector3(node.pos.x, edit.y, node.pos.z));
  for (const id of node.segments) {
    const seg = network.segments.get(id);
    if (!seg) continue;
    if (seg.a === node.id) {
      network.updateSegment(id, { gradeA: edit.grades[1], gradeB: edit.grades[2] });
    } else {
      network.updateSegment(id, { gradeA: edit.grades[0], gradeB: edit.grades[1] });
    }
  }
  return node.id;
}
