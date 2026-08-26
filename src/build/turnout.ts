import type { XZ } from '../core/curve';
import { RAIL_GAUGE } from '../core/units';
import type { SurfaceBlend } from './crossing';
import type { Branch, Network, SegmentId } from '../network/network';

/**
 * 分岐器のまわりで、分かれた 2 本の**レール面の高さを揃える**。
 *
 * 分岐器を出てすぐは、分かれた 2 本が同じ所を通っている。右のレールと左の
 * レールが離れるまでは 1 つの軌道なので、そこに高さの違う面が 2 枚あっては
 * ならない。ところが枝ごとの縦断は独立しているので、勾配が違えば分かれた
 * 直後から高さが開いていく (3% と 1.5% の分岐で、レールが重なっている
 * 40 m の間に 20 cm 開く)。
 *
 * 線形そのものは変えず、**描画に使う高さの補正** (`SurfaceBlend`) として
 * 配る。踏切で道路を線路の面に寄せるのと同じ仕組みなので、帯・整地・
 * 交差点の断面・列車の走る高さが、みな揃った面を見ることになる。
 *
 * 合わせる先は**本線の続き**のほう。反対側の枝とまっすぐ繋がっているかで
 * 選ぶので、どちらから引いたかには依らない。
 */

/** 重なりを追う刻み [m]。 */
const STEP = 2;

/** レールの重なりとして扱う長さの上限 [m]。 */
const MAX_OVERLAP = 80;

/** 高さを揃えるのをやめる長さ [m]。これ未満なら元から離れている。 */
const MIN_OVERLAP = 2;

/** 揃えた高さから元の縦断へ戻すときに、足してよい勾配の目安。 */
const RUNOFF_GRADE = 0.012;

/** そのすり付け長の下限・上限 [m]。 */
const RUNOFF_MIN = 12;
const RUNOFF_MAX = 40;

/**
 * 分かれた 2 本が `need` [m] だけ離れるのに要る長さ [m]。
 *
 * 同じ弧長の点どうしの距離を追う。分岐の直後は 2 本がほとんど接している
 * ので、弧長で突き合わせれば向かい合う点どうしを見ていることになる。
 */
export function separationReach(
  network: Network,
  a: Branch,
  b: Branch,
  need: number,
  max: number,
): number {
  const als = [network.alignmentOf(a.segment), network.alignmentOf(b.segment)];
  const brs = [a, b];
  const limit = Math.min(max, als[0].length, als[1].length);
  const at = (i: number, s: number): XZ => {
    const L = als[i].length;
    return als[i].horizontal.pointAt(brs[i].atStart ? Math.min(s, L) : Math.max(0, L - s));
  };
  let s = 0;
  for (; s < limit; s = Math.min(s + STEP, limit)) {
    const next = Math.min(s + STEP, limit);
    if (at(0, next).distanceTo(at(1, next)) >= need) return next;
    if (next >= limit) break;
  }
  return limit;
}

/** レールが重なっている長さ [m] (右のレールと左のレールが離れるまで)。 */
export function railOverlapReach(network: Network, a: Branch, b: Branch): number {
  return separationReach(network, a, b, RAIL_GAUGE, MAX_OVERLAP);
}

/**
 * 分岐器のまわりで、分かれた枝を本線の高さに合わせる補正。
 *
 * セグメントごとの `SurfaceBlend` として返すので、踏切の補正と同じ所へ
 * 混ぜて配れる。
 */
export function computeTurnoutLevels(network: Network): Map<SegmentId, SurfaceBlend[]> {
  const out = new Map<SegmentId, SurfaceBlend[]>();
  for (const node of network.nodes.values()) {
    const branches = network.branchesAt(node.id).filter((b) => b.cls.kind === 'rail');
    // 分岐が無ければ、隣り合う枝は線形の続きどうしで、重なりようがない。
    if (branches.length < 3) continue;
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        // 同じ側へ出ていく枝どうしだけが重なる。向かい合う枝 (線形の続き)
        // は最初から離れていく。
        if (branches[i].dir.dot(branches[j].dir) <= 0) continue;
        const reach = railOverlapReach(network, branches[i], branches[j]);
        if (reach < MIN_OVERLAP) continue;
        const [leader, follower] = order(branches, branches[i], branches[j]);
        const blend = levelBlend(network, leader, follower, reach);
        if (!blend) continue;
        const list = out.get(follower.segment);
        if (list) list.push(blend);
        else out.set(follower.segment, [blend]);
      }
    }
  }
  return out;
}

/**
 * 分かれた 2 本を「合わせる先 (本線の続き)」「合わせるほう」の順に並べる。
 *
 * 反対側の枝といちばんまっすぐ繋がっているほうが本線。同じくらいまっすぐ
 * なら (Y 字の分岐)、規格の高いほうに合わせる。
 */
function order(branches: Branch[], a: Branch, b: Branch): [Branch, Branch] {
  const straightness = (x: Branch): number =>
    Math.min(...branches.filter((o) => o !== x).map((o) => x.dir.dot(o.dir)));
  const diff = straightness(a) - straightness(b);
  if (Math.abs(diff) > 1e-3) return diff < 0 ? [a, b] : [b, a];
  if (a.cls.designSpeed !== b.cls.designSpeed) {
    return a.cls.designSpeed > b.cls.designSpeed ? [a, b] : [b, a];
  }
  return a.segment < b.segment ? [a, b] : [b, a];
}

/** 合わせるほうの枝に付ける補正。 */
function levelBlend(
  network: Network,
  leader: Branch,
  follower: Branch,
  reach: number,
): SurfaceBlend | null {
  const mine = network.alignmentOf(follower.segment);
  const other = network.alignmentOf(leader.segment);
  // 重なりが区間より長いことはないが、すり付けを取る余地は残す。
  const core = Math.min(reach, mine.length * 0.6);
  if (core < MIN_OVERLAP) return null;
  const origin = follower.atStart ? 0 : mine.length;
  const sign = follower.atStart ? 1 : -1;

  /** ノードから `d` [m] 進んだ所での、合わせる先の高さ。 */
  const levelAt = (s: number): number => {
    const d = Math.abs(s - origin);
    const t = leader.atStart ? d : other.length - d;
    return other.sampleAt(Math.min(Math.max(t, 0), other.length)).pos.y;
  };

  const edge = origin + sign * core;
  const at = (s: number) => mine.sampleAt(Math.min(Math.max(s, 0), mine.length));
  // すり付けは、戻す高さの分だけ長く取る。長さを決め打ちにすると、勾配差の
  // 大きい分岐でそこだけ急な坂ができる。
  const gap = Math.abs(levelAt(edge) - at(edge).pos.y);
  const runoff = Math.min(
    Math.max(gap / RUNOFF_GRADE, RUNOFF_MIN),
    RUNOFF_MAX,
    Math.max(0, mine.length - core),
  );
  return {
    s: origin,
    // 高さは `level` から採るので、こちらは平坦部の端の値を入れておく。
    targetY: levelAt(origin),
    targetSlope: 0,
    level: levelAt,
    // 重なりの外では自分の縦断と平行に走らせる (踏切のすり付けと同じ理由で、
    // 相手を追い続けると差が開き続け、すり付けをいくら長くしても緩まない)。
    roadGrade: at(edge).grade,
    roll: 0,
    // 面を上下させるだけなので、道床の断面はそのまま。
    flattenSection: false,
    core,
    halfLength: core + runoff,
  };
}
