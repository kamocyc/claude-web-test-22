import { Vector2, Vector3 } from 'three';
import type { Alignment } from '../core/alignment';
import {
  CLEARANCE_OVER_RAIL,
  CLEARANCE_OVER_ROAD,
  DECK_THICKNESS,
  DEG,
  LEVEL_CROSSING_TOLERANCE,
  clamp,
} from '../core/units';
import { MAX_CROSSING_LIFT } from '../build/crossing';
import type { NetworkClass } from './classes';
import { intersectPolylines, toPolyline, type PolylinePoint } from './crossings';
import { CROSSING_END_MARGIN, MIN_SMOOTHED_DEFLECTION, type Anchor } from './editing';
import {
  CORNER_MARGIN,
  pairTrackBranches,
  railBranchMessage,
  requiredTrims,
  type BranchLike,
} from './junction';
import type { Branch, Network, NodeId, SegmentId } from './network';
import { classify } from './structure';
import { checkAlignmentAgainstStations } from './stationPlacement';
import type { Heightfield } from '../terrain/heightfield';

/**
 * 敷設してよいかの判定。
 *
 * 「作ってから警告を出す」のではなく、**作れないようにする**ための規則を
 * ここにまとめる。プレビューの段階で同じ判定を掛けるので、置けるかどうかは
 * クリックする前に分かる。
 */

/** 交差点として成り立たない浅すぎる交差角。 */
const MIN_CROSSING_ANGLE = 20 * DEG;
/**
 * 線路どうしが同一平面で交わってよい最小の交差角。
 *
 * 線路の平面交差はダイヤモンドクロッシングで、実物も浅い角度で交わる
 * (シーサスクロッシングの中央は 1/8〜1/15 = 7°〜4° ほど)。道路の交差点と
 * 違って隅を丸める必要がないので、ここまで許す。これより浅いと、交差の
 * 中が長くなりすぎて「並走している」のと見分けが付かない。
 *
 * 浅い交差が実際に置けるかは角度ではなく**交差の中が線形に収まるか**で
 * 決まる (`crossingTrim` と `tooClose`)。ここはその手前の足切り。
 */
const MIN_RAIL_CROSSING_ANGLE = 4 * DEG;

/** 同一平面で交わってよい最小の交差角。線路どうしだけ浅い交差を許す。 */
export function minCrossingAngle(a: NetworkClass, b: NetworkClass): number {
  return a.kind === 'rail' && b.kind === 'rail' ? MIN_RAIL_CROSSING_ANGLE : MIN_CROSSING_ANGLE;
}
/** 交差点 1 つが 1 本のセグメントから取れる長さの上限 (区間長に対する比)。 */
const MAX_TRIM_RATIO = 0.45;
/** 交差点 1 つが取り込める長さの上限 [m]。 */
const MAX_TRIM = 40;
/**
 * 路面どうしが重なったとみなす深さ [m]。
 *
 * 平行スナップは舗装の縁が 0.2 m 空くように並べるので、そこは許す。
 */
const OVERLAP_TOLERANCE = 0.15;

export interface PlacementCheck {
  /** 空なら敷設できる。 */
  blockers: string[];
  /**
   * 止めた理由の**場所** (原因になっている既存の交差点・端点)。
   *
   * 「交差点が近すぎます」と言われても、どの交差点の話なのかは文言から
   * 分からない。敷設ツールはここを目印で囲って示す。
   */
  places: Vector3[];
}

/** 止めた理由 1 つぶん。場所の分かるものは、その位置も持つ。 */
interface Blocker {
  message: string;
  /** 原因になっている既存の交差点・端点の位置。 */
  at?: Vector3;
}

/** 場所の分からない理由。 */
function plain(messages: string[]): Blocker[] {
  return messages.map((message) => ({ message }));
}

/** 高さを合わせて平面交差にする交点 1 か所 (合わせた後の値)。 */
export interface MatchedCrossingHint {
  /** 相手のセグメント。 */
  segment: SegmentId;
  /** 敷く線形の側の弧長 [m]。 */
  s: number;
  /** 合わせた後の交点の高さ [m]。 */
  y: number;
  /** 合わせた後の、相手の側の縦断勾配。 */
  grade: number;
}

/** 折れ線の交点が、意図した平面交差かどうか。 */
const MATCH_REACH = 1.5;

function matchedAt(
  ctx: PlacementContext,
  segment: SegmentId,
  s: number,
): MatchedCrossingHint | undefined {
  return ctx.matchedCrossings?.find(
    (m) => m.segment === segment && Math.abs(m.s - s) <= MATCH_REACH,
  );
}

export interface PlacementContext {
  network: Network;
  cls: NetworkClass;
  alignment: Alignment;
  start: Anchor;
  end: Anchor;
  /** 判定から外すセグメント (既存の線形を引き直すときの自分自身)。 */
  ignore?: SegmentId;
  /**
   * この線形が**意図して**平面交差にする相手 (`planCrossingHeights` の結果)。
   *
   * 交点の高さを合わせて敷くときは、合わせた後の高さ・勾配で判定しないと、
   * 合わせる前の高低差で「桁下が足りません」に振れてしまう。同じ種別どうしの
   * 交点は敷く区間の**端**になるので、交差点に使える長さも端までの距離では
   * なく反対の端までで見る。
   */
  matchedCrossings?: readonly MatchedCrossingHint[];
  /**
   * 自然地形。渡すと「トンネルの中の交差点」を止められる。
   * 省略した場合はその判定を行わない。
   */
  field?: Heightfield;
}

/**
 * 敷設できない理由を列挙する。1 つでもあれば置けない。
 *
 * 見るのは次の 5 点。
 *  1. 規格 (最小曲線半径・最大縦断勾配)
 *  2. 繋ぎ目での折り返し (引いてきた線形の上を引き返す)
 *  3. 既存の線形との重なり (浅い角度での交差・並走)
 *  4. 立体交差の建築限界 (桁下が足りない / 同一平面で交差する)
 *  5. 交差点が近すぎる (取り付き長が取れない)
 */
export function checkPlacement(ctx: PlacementContext): PlacementCheck {
  const blockers: string[] = [...evaluate(ctx), ...checkDirection(ctx)];
  const network = ctx.network;

  // 端点で繋がる相手は「重なり」ではないので、判定から外す。
  // 分岐したばかりの所は本線の続きとも近いので、2 ホップ先まで見る。
  // どちらの端で繋がっているかは分けて覚えておく。繋ぎ目から離れた所でも
  // 重なり続けていないかを、`checkRunningAlong` がその端から測るため。
  const sides = [ctx.start, ctx.end].map((anchor) => {
    const found = new Set<SegmentId>();
    const visit = (node: NodeId, depth: number): void => {
      for (const branch of network.branchesAt(node)) {
        // 引き直している自分自身は通り抜けない。ここを辿ると、自分の向こう側に
        // 繋がっている相手まで「両端で繋がる相手」になってしまう (敷く前には
        // 自分がまだ無いので、そんな繋がり方は見えない)。
        if (branch.segment === ctx.ignore) continue;
        if (found.has(branch.segment)) continue;
        found.add(branch.segment);
        if (depth <= 0) continue;
        const seg = network.segments.get(branch.segment);
        if (!seg) continue;
        visit(seg.a === node ? seg.b : seg.a, depth - 1);
      }
    };
    if (anchor.node !== undefined) visit(anchor.node, 1);
    // 途中に取り付く相手も「端点で繋がる相手」。ここを重なりとして数えると、
    // T 字に取り付くだけで必ず「交差点が近すぎます」になってしまう。
    // 取り付きの成否は `checkJunctionSpacing` で分割後の形として見る。
    if (anchor.split) {
      found.add(anchor.split.segment);
      const seg = network.segments.get(anchor.split.segment);
      if (seg) {
        visit(seg.a, 0);
        visit(seg.b, 0);
      }
    }
    return found;
  });
  const connected = new Set<SegmentId>([...sides[0], ...sides[1]]);
  if (ctx.ignore !== undefined) connected.add(ctx.ignore);

  const found: Blocker[] = [
    ...plain(blockers),
    ...plain(checkRailBranches(ctx)),
    ...checkOverlaps(ctx, connected),
    ...plain(checkRunningAlong(ctx, sides[0], sides[1])),
    ...checkJunctionSpacing(ctx),
    ...plain(checkTunnelJunctions(ctx, connected)),
    ...plain(
      checkAlignmentAgainstStations(network, ctx.alignment, ctx.cls.halfWidth + 1, ctx.ignore),
    ),
  ];

  return { blockers: dedupe(found.map((b) => b.message)), places: placesOf(found) };
}

/**
 * 止めた理由の場所を集める。
 *
 * 文言は同じでも、原因の交差点が別なら両方見せたい (「交差点が近すぎます」は
 * 両端で別々に出る)。文言ではなく**位置**で重複を落とす。
 */
function placesOf(found: Blocker[]): Vector3[] {
  const out: Vector3[] = [];
  const seen = new Set<string>();
  for (const blocker of found) {
    if (!blocker.at) continue;
    const key = `${blocker.at.x.toFixed(1)},${blocker.at.z.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(blocker.at);
  }
  return out;
}

function evaluate(ctx: PlacementContext): string[] {
  const { alignment, cls } = ctx;
  const out: string[] = [];
  const { minRadius } = alignment.horizontal.extremeCurvature(48);
  const maxGrade = alignment.vertical.maxGrade(32);
  if (minRadius < cls.minRadius - 1e-6) {
    out.push(
      `曲線半径 ${minRadius.toFixed(0)} m は ${cls.label} の最小半径 ${cls.minRadius} m を下回ります。`,
    );
  }
  if (maxGrade > cls.maxGrade + 1e-6) {
    out.push(
      `勾配 ${(maxGrade * 100).toFixed(1)}% は ${cls.label} の最大勾配 ${(cls.maxGrade * 100).toFixed(1)}% を超えます。`,
    );
  }
  return out;
}

/**
 * 接続先の向きに逆らっていないか。
 *
 * 端点から続きを引くとき、カーソルを**真後ろ**に置くと、接線に沿った円弧が
 * 解けない (接線に接し、真後ろの点を通る円は存在しない)。今の解き方はそこで
 * 直線を返すので、**引いてきた道の上をそのまま引き返す**線形ができてしまう。
 * 繋ぎ目で 180° 折り返す線形は道路にも線路にもならないので、ここで止める。
 *
 * 見るのは折り返しだけ。ヘアピンのように鋭く曲がる繋ぎ方 (折れ点) は
 * 交差点の側で扱えるので、`MAX_FOLD_ANGLE` までは通す。
 *
 * 途中接続 (`bidirectional`) は正逆どちらへも出られるので見ない。向きは
 * `computePlacement` がカーソル側に合わせて選んでいる。
 */
function checkDirection(ctx: PlacementContext): string[] {
  const { alignment } = ctx;
  const out: string[] = [];
  const folded = Math.cos(MAX_FOLD_ANGLE);
  if (ctx.start.tangent && !ctx.start.bidirectional) {
    // 始点は接線の向きに出ていくはず。
    if (alignment.sampleAt(0).forwardXZ.dot(ctx.start.tangent) < folded) out.push(REVERSED);
  }
  if (ctx.end.tangent && !ctx.end.bidirectional) {
    // 終点アンカーの接線は「そこから先へ延びる向き」。線形はそれに
    // 向かって入ってくるので、同じ向きに抜けていたら折り返している。
    if (alignment.sampleAt(alignment.length).forwardXZ.dot(ctx.end.tangent) > -folded) {
      out.push(REVERSED);
    }
  }

  // 真後ろに近い所を指すと、接線に接する円弧が大きく回り込み、掃引角の
  // 制限で線形は指した所まで届かない。そこは止めずに**届いた所で切って**
  // 敷く (`reachedAnchor`)。届いた所が端点になるので、置いた線形は
  // プレビューと同じ形のまま残る。
  return out;
}

const REVERSED = '接続先の向きと逆に折り返しています (既存の線形の上に重なります)。';

/** 繋ぎ目で折り返したとみなす角度。これを超えると、相手の上を戻ることになる。 */
const MAX_FOLD_ANGLE = 150 * DEG;

type Sample = PolylinePoint;

function polyline(alignment: Alignment, step = 3): Sample[] {
  return toPolyline(alignment, step);
}

/** 干渉を見る相手 (近くにある既存の線形)。 */
interface Candidate {
  /** 相手のセグメント (意図した平面交差かどうかを引くのに使う)。 */
  segment: SegmentId;
  cls: NetworkClass;
  line: Sample[];
  alignment: Alignment;
  hits: ReturnType<typeof intersectPolylines>;
  /** 中心線どうしの粗い当たり判定に使う距離 [m]。 */
  reach: number;
}

/**
 * 線路の分岐が、既存の線路の接線に合っているか。
 *
 * 線路の交差点には中身が無い (`junction.ts` の冒頭の説明) ので、折れたまま
 * 枝が集まると、その角がそのまま残る。交差点の中で振り分ける余地が無く、
 * 置いてから直すことができないので、置く前に止める。
 *
 * 見るのは**枝が 3 本以上になる所**だけ。2 本で終わる継ぎ目の折れは、置いた
 * 直後に `smoothJoint` が両側を振って均す。
 */
function checkRailBranches(ctx: PlacementContext): string[] {
  const { network, cls, alignment } = ctx;
  if (cls.kind !== 'rail') return [];
  const out: string[] = [];

  const ends: [Anchor, boolean][] = [
    [ctx.start, true],
    [ctx.end, false],
  ];
  for (const [anchor, atStart] of ends) {
    // ノードから外向きに見た、これから敷く線形の向き。
    const mine = atStart
      ? alignment.sampleAt(0).forwardXZ.clone()
      : alignment.sampleAt(alignment.length).forwardXZ.clone().negate();

    const dirs: Vector2[] = [];
    if (anchor.node !== undefined) {
      for (const branch of network.branchesAt(anchor.node)) {
        if (branch.segment === ctx.ignore) continue;
        if (branch.cls.kind !== 'rail') continue;
        dirs.push(branch.dir.clone());
      }
    } else if (anchor.split) {
      const seg = network.segments.get(anchor.split.segment);
      if (!seg || network.classOf(seg).kind !== 'rail') continue;
      const split = network.alignmentOf(anchor.split.segment);
      const tangent = split.sampleAt(clamp(anchor.split.s, 0, split.length)).forwardXZ;
      // 分割すると、切った点から前後へ 1 本ずつの枝ができる。
      dirs.push(tangent.clone(), tangent.clone().negate());
    } else {
      continue;
    }
    if (dirs.length < 2) continue;

    // 交差点を解くときと同じ組み方で、自分が加わる進路の分岐角を見る。
    const index = dirs.length;
    dirs.push(mine);
    for (const pair of pairTrackBranches(dirs)) {
      if (pair.i !== index && pair.j !== index) continue;
      if (pair.deflection <= MIN_SMOOTHED_DEFLECTION) continue;
      out.push(railBranchMessage(pair.deflection));
    }
  }
  return out;
}

/**
 * 既存の線形との干渉を見る。
 *
 * - 同じ高さで重なって走っている (並走・浅い角度の交差) → 置けない
 * - 同じ高さで交差する道路どうし・線路どうし → 交差点にできないので置けない
 * - 立体交差だが桁下が足りない → 置けない
 */
function checkOverlaps(ctx: PlacementContext, connected: Set<SegmentId>): Blocker[] {
  const { network, cls } = ctx;
  const mine = polyline(ctx.alignment);
  const bounds = boundsOf(mine);
  const out: Blocker[] = [];

  // まず近くの線形と交点を集める。同一平面で交わる所 (交差点・踏切になる
  // 所) では路面が重なって当たり前なので、あとの重なり判定から外す「窓」を
  // 先に作っておく。窓を相手 1 本ごとではなく全体で持つのは、交差点の中では
  // **交わる相手に繋がっている別のセグメント**の路面とも重なるため。
  const candidates: Candidate[] = [];
  const windows: { s: number; reach: number }[] = [];
  const myChords = chordsOf(mine, cls.halfWidth);
  for (const seg of network.segments.values()) {
    if (connected.has(seg.id)) continue;
    const other = network.classOf(seg);
    const alignment = network.alignmentOf(seg.id);
    const line = polyline(alignment);
    const reach = cls.halfWidth + other.halfWidth;
    // 遠い線形は見るまでもない。
    const otherBounds = boundsOf(line);
    if (
      bounds.maxX + reach < otherBounds.minX ||
      otherBounds.maxX + reach < bounds.minX ||
      bounds.maxZ + reach < otherBounds.minZ ||
      otherBounds.maxZ + reach < bounds.minZ
    ) {
      continue;
    }
    const hits = intersectPolylines(mine, line);
    // 高さを合わせて交差させる相手は、合わせた後の高さで見る。折れ線は縦断
    // 曲線を弦で近似しているので、合わせてあっても数 cm ずれる。ここで揃えて
    // おかないと、踏切・交差点になるはずの所が「桁下不足」に振れる。
    for (const hit of hits) {
      const match = matchedAt(ctx, seg.id, hit.sA);
      if (match) hit.yB = match.y;
    }
    // 高さを合わせた交点は、この区間の**端**に来ることがある (そこで分けて
    // 相手と繋ぐため)。折れ線どうしは端で触れるだけになり、交点として拾え
    // ない。立案が「ここで交わる」と言っているので、交点をここで補う。
    // こうすると窓も交差角も交差点の取り付き長も、ふつうの交点と同じ規則で
    // 見られる。
    for (const match of ctx.matchedCrossings ?? []) {
      if (match.segment !== seg.id) continue;
      if (hits.some((hit) => Math.abs(hit.sA - match.s) <= MATCH_REACH)) continue;
      const at = ctx.alignment.sampleAt(match.s);
      const near = nearestOn(line, at.pos.x, at.pos.z);
      if (!near || near.distance > TOUCH) continue;
      hits.push({
        sA: match.s,
        sB: near.s,
        x: at.pos.x,
        z: at.pos.z,
        yA: at.pos.y,
        yB: match.y,
        dirA: at.forwardXZ.clone(),
        dirB: new Vector2(near.dx, near.dz),
      });
    }
    candidates.push({ segment: seg.id, cls: other, line, alignment, hits, reach });

    /** s (自分の弧長) のまわりを「交差点・踏切の中」として覚える。 */
    const addWindow = (
      s: number,
      a: { dx: number; dz: number },
      b: { dx: number; dz: number },
    ): void => {
      const sin = Math.abs(a.dx * b.dz - a.dz * b.dx);
      const cos = Math.abs(a.dx * b.dx + a.dz * b.dz);
      // 浅すぎる角度は交差点にならない (別の規則が止める)。ここで
      // 窓を開けると、重なって並走しているだけの線形まで見逃す。
      if (sin < Math.sin(minCrossingAngle(cls, other))) return;
      windows.push({ s, reach: crossingTrim(cls, other, sin, cos) + CORNER_MARGIN });
    };

    for (const hit of hits) {
      if (Math.abs(hit.yA - hit.yB) > LEVEL_CROSSING_TOLERANCE) continue;
      addWindow(hit.sA, { dx: hit.dirA.x, dz: hit.dirA.y }, { dx: hit.dirB.x, dz: hit.dirB.y });
    }

    // 交点がちょうど端に来る所 (線が節で分かれていて、その節の上で交わる)
    // では、交点が隣のセグメントの側にだけ立つ。節の先に線が続いている
    // なら、そこも交差点・踏切の中として扱う。
    for (const atStart of [true, false]) {
      const anchor = atStart ? ctx.start : ctx.end;
      if (anchor.node === undefined) continue;
      // 端が行き止まりなら、そこに交差点はない。
      const beyond = network
        .branchesAt(anchor.node)
        .filter((branch) => branch.segment !== ctx.ignore);
      if (beyond.length === 0) continue;
      const p = atStart ? mine[0] : mine[mine.length - 1];
      const dir = endDirection(mine, atStart);
      const near = nearestOn(line, p.x, p.z);
      if (!dir || !near) continue;
      if (near.distance > TOUCH || Math.abs(p.y - near.y) > LEVEL_CROSSING_TOLERANCE) continue;
      addWindow(p.s, dir, near);
    }
    for (const atStart of [true, false]) {
      const node = atStart ? seg.a : seg.b;
      if (network.branchesAt(node).length < 2) continue;
      const p = atStart ? line[0] : line[line.length - 1];
      const dir = endDirection(line, atStart);
      const near = nearestOn(mine, p.x, p.z);
      if (!dir || !near) continue;
      if (near.distance > TOUCH || Math.abs(p.y - near.y) > LEVEL_CROSSING_TOLERANCE) continue;
      addWindow(near.s, near, dir);
    }
  }

  for (const candidate of candidates) {
    const other = candidate.cls;
    const otherLine = candidate.line;
    const otherAlignment = candidate.alignment;
    const hits = candidate.hits;
    const reach = candidate.reach;

    let shallowLimit = 0;
    let tooClose = 0;
    /** その交差点が詰まっている原因の位置 (近い方の既存の端点)。 */
    let tooCloseAt: Vector3 | null = null;
    let worstClearance = Infinity;
    let worstCrossing = 0;
    let lowerKindOfWorst: 'road' | 'rail' = other.kind;

    // 交点での高さで判定する。横にずれた点どうしを比べると、勾配のある
    // 道路では実際より低い / 高い桁下を読んでしまう。
    for (const hit of hits) {
      const match = matchedAt(ctx, candidate.segment, hit.sA);
      const dy = hit.yA - hit.yB;
      const sin = Math.abs(hit.dirA.x * hit.dirB.y - hit.dirA.y * hit.dirB.x);
      if (Math.abs(dy) <= LEVEL_CROSSING_TOLERANCE) {
        // 同一平面。道路 × 線路は踏切、同じ種別どうしは交差点になる。
        const floor = minCrossingAngle(cls, other);
        if (sin < Math.sin(floor)) shallowLimit = Math.max(shallowLimit, floor);
        if (cls.kind !== other.kind) {
          // 踏切。路面を線路の面に合わせるので、交差角が浅く道路の勾配が
          // 急だと、道路に何十 m もの平坦部を刻むことになる。
          const need = crossingDeformation(
            cls.kind === 'road' ? cls : other,
            cls.kind === 'road' ? other : cls,
            sin,
            cls.kind === 'road'
              ? ctx.alignment.vertical.gradeAt(hit.sA)
              : (match?.grade ?? otherAlignment.vertical.gradeAt(hit.sB)),
            cls.kind === 'rail'
              ? ctx.alignment.vertical.gradeAt(hit.sA)
              : (match?.grade ?? otherAlignment.vertical.gradeAt(hit.sB)),
          );
          if (need > MAX_CROSSING_LIFT) worstCrossing = Math.max(worstCrossing, need);
        }
        if (cls.kind === other.kind) {
          // 道路の交差点は取り付き部の分だけ両側の線形を食べる。取り付きが
          // 端からはみ出すようなら、交差点の形が崩れるので置かせない。
          // (「余裕をもって離す」ではなく、**実際に要る長さ**で判定する。)
          // 交差点はここで両方を分割するので、飲み込めるかは分割してできる
          // **短い方**の長さで決まる。
          //
          // 線路の交差点は面を持たず、区間を食べない (`crossingRoom`)。
          // トリムの上限 (`roomFor`) も掛からないので、端までの距離を
          // そのまま使う。
          const cos = Math.abs(hit.dirA.x * hit.dirB.x + hit.dirA.y * hit.dirB.y);
          const railPair = cls.kind === 'rail' && other.kind === 'rail';
          const available = (toEnd: number): number => (railPair ? toEnd : roomFor(toEnd, 0));
          // 高さを合わせた線路の交点は、敷く区間の**端でノードを共有する**
          // (`placeCrossingRun` が先に相手を分割し、そのノードへ向けて敷く)。
          // そこでは自分を分けないので、差し出す長さは要らない。
          const sharedNode = railPair && match !== undefined;
          // 道路の交点は区間の端でも交差点の面を作るので、取り付き長がそのまま
          // 要る。端までの距離 (= 0) ではなく、反対の端までを見る。
          const mySide = match
            ? Math.max(hit.sA, ctx.alignment.length - hit.sA)
            : Math.min(hit.sA, ctx.alignment.length - hit.sA);
          const shortfalls: [number, Vector3][] = [
            [
              (sharedNode ? 0 : crossingRoom(cls, other, sin, cos)) - available(mySide),
              // 自分の側が足りないときは、詰まっている自分の端。
              endNear(ctx.alignment, hit.sA),
            ],
            [
              crossingRoom(other, cls, sin, cos) -
                available(Math.min(hit.sB, otherAlignment.length - hit.sB)),
              // 相手の側が足りないときは、相手の近い方の端 (= 既存の交差点)。
              endNear(otherAlignment, hit.sB),
            ],
          ];
          for (const [shortfall, at] of shortfalls) {
            if (shortfall <= tooClose) continue;
            tooClose = shortfall;
            tooCloseAt = at;
          }
        }
        continue;
      }
      const lowerKind = dy > 0 ? other.kind : cls.kind;
      const required = lowerKind === 'rail' ? CLEARANCE_OVER_RAIL : CLEARANCE_OVER_ROAD;
      const clearance = Math.abs(dy) - DECK_THICKNESS;
      if (clearance < required && clearance < worstClearance) {
        worstClearance = clearance;
        lowerKindOfWorst = lowerKind;
      }
    }

    // 中心線が交わらなくても、**幅の分だけ**重なることはある (突き当たり・
    // すれ違い・並走)。ここは路面を長方形の帯として見て、重なった所を
    // 拾う。同じ高さで重なれば置けないし、上下に分かれていても、重なって
    // いる所には桁下が要る。
    const otherChords = chordsOf(otherLine, other.halfWidth);
    let overlapLength = 0;
    let overlapDepth = 0;
    for (const chord of myChords) {
      let depth = 0;
      for (const b of otherChords) {
        if (Math.abs(chord.cx - b.cx) > chord.reach + b.reach) continue;
        if (Math.abs(chord.cz - b.cz) > chord.reach + b.reach) continue;
        depth = Math.max(depth, rectOverlap(chord, b));
      }
      if (depth <= OVERLAP_TOLERANCE) continue;
      // 交差点・踏切の中は、路面が重なるのも高さが動くのも当たり前。
      if (windows.some((w) => Math.abs(w.s - chord.s) <= w.reach + chord.halfLength)) continue;
      const near = nearestOn(otherLine, chord.cx, chord.cz);
      if (!near) continue;
      const dy = chord.cy - near.y;
      if (Math.abs(dy) <= LEVEL_CROSSING_TOLERANCE) {
        overlapDepth = Math.max(overlapDepth, depth);
        overlapLength += chord.length;
        continue;
      }
      const lowerKind = dy > 0 ? other.kind : cls.kind;
      const required = lowerKind === 'rail' ? CLEARANCE_OVER_RAIL : CLEARANCE_OVER_ROAD;
      const clearance = Math.abs(dy) - DECK_THICKNESS;
      if (clearance < required && clearance < worstClearance) {
        worstClearance = clearance;
        lowerKindOfWorst = lowerKind;
      }
    }

    if (tooClose > 0.05) {
      out.push({ message: tooCloseMessage(tooClose), at: tooCloseAt ?? undefined });
    }
    if (shallowLimit > 0) {
      out.push({ message: `交差角が浅すぎます (${(shallowLimit / DEG).toFixed(0)}° 以上必要)。` });
    }
    if (worstCrossing > 0) {
      out.push({
        message:
          `踏切にできません。路面を線路に合わせるのに ±${worstCrossing.toFixed(1)} m の` +
          `すり付けが要ります (交差角を大きくするか、道路の勾配を緩めてください)。`,
      });
    }
    if (shallowLimit === 0 && overlapDepth > 0) {
      out.push({
        message:
          overlapLength > reach * 2.5
            ? '既存の線形と重なって並走しています。'
            : `既存の線形と路面が重なります (あと ${Math.max(0.5, overlapDepth).toFixed(1)} m 離すか、` +
              '中心線どうしを交わらせて交差点にしてください)。',
      });
    }
    if (Number.isFinite(worstClearance)) {
      const required =
        lowerKindOfWorst === 'rail' ? CLEARANCE_OVER_RAIL : CLEARANCE_OVER_ROAD;
      out.push({
        message: `桁下 ${worstClearance.toFixed(1)} m は建築限界 ${required.toFixed(1)} m に足りません。高さを変えてください。`,
      });
    }
  }
  return out;
}

/**
 * 繋がっている相手の上を走っていないか。
 *
 * 端点で繋がる相手は重なりの判定から外している。分かれたばかりの所は必ず
 * 路面が重なるからで、そこは交差点・分岐器の中として扱ってよい。ただし
 * 外しっぱなしにすると、**引いてきた道の上をそのまま引き返す**線形まで
 * 通ってしまう。
 *
 * 見るのは**両端とも同じ 1 本に繋がる**線形だけ。分岐器やランプのように
 * 浅い角度で分かれて別の所へ抜ける線形は、離れきるまで何十 m も路盤を
 * 共有するのが当たり前なので、ここでは触らない。逆に、出た所へ戻って
 * くる線形は、その間ずっと相手から離れていなければならない。
 *
 * 繋ぎ目として許す長さは
 *
 *  - 規格最小半径で曲がって幅の分だけ横に逃げる弧長 √(2Rw)
 *  - その交差点の面の広がり (`junctionReach`)
 *
 * の大きい方。
 */
function checkRunningAlong(
  ctx: PlacementContext,
  atStart: Set<SegmentId>,
  atEnd: Set<SegmentId>,
): string[] {
  const { network, cls, alignment } = ctx;
  const length = alignment.length;
  const mine = polyline(alignment);
  const myChords = chordsOf(mine, cls.halfWidth);
  const bounds = boundsOf(mine);
  let along = 0;

  for (const id of atStart) {
    if (id === ctx.ignore || !atEnd.has(id)) continue;
    const seg = network.segments.get(id);
    if (!seg) continue;
    const other = network.classOf(seg);
    const line = polyline(network.alignmentOf(id));
    const reach = cls.halfWidth + other.halfWidth;
    const otherBounds = boundsOf(line);
    if (
      bounds.maxX + reach < otherBounds.minX ||
      otherBounds.maxX + reach < bounds.minX ||
      bounds.maxZ + reach < otherBounds.minZ ||
      otherBounds.maxZ + reach < bounds.minZ
    ) {
      continue;
    }
    // 繋ぎ目として許す長さ。繋がっていない端からは測らない。
    const joint = (anchor: Anchor): number => {
      const spread = anchor.node !== undefined ? junctionReach(network, anchor.node) : 0;
      return Math.max(Math.sqrt(2 * cls.smoothRadius * reach), spread) + CORNER_MARGIN;
    };
    const fromStart = joint(ctx.start);
    const fromEnd = joint(ctx.end);

    // 相手と**交わる**所は「戻ってきて重なっている」のではない (渡り線
    // どうしが交わるシーサスクロッシングがこれにあたる)。交差点・踏切の
    // 中と同じように、交差の中は判定から外す。
    const windows: { s: number; reach: number }[] = [];
    for (const hit of intersectPolylines(mine, line)) {
      if (Math.abs(hit.yA - hit.yB) > LEVEL_CROSSING_TOLERANCE) continue;
      const sin = Math.abs(hit.dirA.x * hit.dirB.y - hit.dirA.y * hit.dirB.x);
      const cos = Math.abs(hit.dirA.x * hit.dirB.x + hit.dirA.y * hit.dirB.y);
      if (sin < Math.sin(minCrossingAngle(cls, other))) continue;
      windows.push({ s: hit.sA, reach: crossingTrim(cls, other, sin, cos) + CORNER_MARGIN });
    }

    const otherChords = chordsOf(line, other.halfWidth);
    for (const chord of myChords) {
      if (chord.s <= fromStart || length - chord.s <= fromEnd) continue;
      if (windows.some((w) => Math.abs(w.s - chord.s) <= w.reach + chord.halfLength)) continue;
      let depth = 0;
      for (const b of otherChords) {
        if (Math.abs(chord.cx - b.cx) > chord.reach + b.reach) continue;
        if (Math.abs(chord.cz - b.cz) > chord.reach + b.reach) continue;
        depth = Math.max(depth, rectOverlap(chord, b));
      }
      if (depth <= OVERLAP_TOLERANCE) continue;
      // 上下に分かれていて桁下が足りているなら、立体交差として成り立つ。
      const near = nearestOn(line, chord.cx, chord.cz);
      if (!near) continue;
      const dy = chord.cy - near.y;
      const lower = dy > 0 ? other.kind : cls.kind;
      const required = lower === 'rail' ? CLEARANCE_OVER_RAIL : CLEARANCE_OVER_ROAD;
      if (Math.abs(dy) - DECK_THICKNESS >= required) continue;
      along += chord.length;
    }
  }

  return along > ALONG_TOLERANCE
    ? ['出てきた線形の上に戻って重なっています (離れるように引いてください)。']
    : [];
}

/** 繋ぎ目の先で重なってよい長さ [m]。折れ線の刻み 2 つ分。 */
const ALONG_TOLERANCE = 6;

/**
 * 踏切で道路をどれだけ変形させることになるか [m]。
 *
 * 舗装が線路に接するのは、道路の弧長で見て「線路の半幅 / sin + 道路の
 * 半幅 / tan」の範囲。その端で、道路の本来の縦断と線路の面がどれだけ
 * 離れるかを見る。交差角が浅いほど、道路の勾配が急なほど大きくなる。
 */
function crossingDeformation(
  roadCls: NetworkClass,
  railCls: NetworkClass,
  sin: number,
  roadGrade: number,
  railGrade: number,
): number {
  const s = Math.max(0.26, sin);
  const cos = Math.sqrt(Math.max(0, 1 - s * s));
  const reach = railCls.halfWidth / s + roadCls.halfWidth * (cos / s);
  // 道路の弧長方向に見た、線路の面の勾配との差。
  const slope = Math.abs(railGrade * cos - roadGrade);
  return reach * slope;
}

function boundsOf(line: Sample[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of line) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * 中心線の 1 区間を、幅を持った長方形として見たもの。
 *
 * 帯は円ではないので、中心線どうしの距離だけで重なりを測ると、突き当たる
 * 形 (T 字) の端で実際より近いと判定してしまう。長方形として扱えば、
 * 並走・突き当たり・斜めのすれ違いを同じ式で見られる。
 */
interface Chord {
  cx: number;
  cz: number;
  cy: number;
  /** 単位方向。 */
  dx: number;
  dz: number;
  halfLength: number;
  /** 半幅 (舗装・道床の縁まで)。 */
  half: number;
  /** 粗い当たり判定用の外接半径 [m]。 */
  reach: number;
  /** 中央の弧長 [m]。 */
  s: number;
  length: number;
}

function chordOf(a: Sample, b: Sample, half: number): Chord | null {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return null;
  return {
    cx: (a.x + b.x) / 2,
    cz: (a.z + b.z) / 2,
    cy: (a.y + b.y) / 2,
    dx: dx / length,
    dz: dz / length,
    halfLength: length / 2,
    half,
    reach: length / 2 + half,
    s: (a.s + b.s) / 2,
    length,
  };
}

function chordsOf(line: Sample[], half: number): Chord[] {
  const out: Chord[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const chord = chordOf(line[i], line[i + 1], half);
    if (chord) out.push(chord);
  }
  return out;
}

/**
 * 幅を持った 2 区間 (長方形) の重なりの深さ [m]。0 なら離れている。
 *
 * 分離軸で見る。どれか 1 つの軸で離れていれば重なっておらず、どの軸でも
 * 重なっていれば、いちばん浅い重なりが「あと何 m 離せばよいか」になる。
 */
function rectOverlap(a: Chord, b: Chord): number {
  const axes: [number, number][] = [
    [a.dx, a.dz],
    [-a.dz, a.dx],
    [b.dx, b.dz],
    [-b.dz, b.dx],
  ];
  const ex = b.cx - a.cx;
  const ez = b.cz - a.cz;
  let depth = Infinity;
  for (const [ux, uz] of axes) {
    const ra =
      a.halfLength * Math.abs(a.dx * ux + a.dz * uz) + a.half * Math.abs(-a.dz * ux + a.dx * uz);
    const rb =
      b.halfLength * Math.abs(b.dx * ux + b.dz * uz) + b.half * Math.abs(-b.dz * ux + b.dx * uz);
    const gap = ra + rb - Math.abs(ex * ux + ez * uz);
    if (gap <= 0) return 0;
    if (gap < depth) depth = gap;
  }
  return depth;
}

/** 線形上のいちばん近い点。 */
interface Near {
  distance: number;
  y: number;
  /** その点の弧長 [m]。 */
  s: number;
  /** その点での単位方向。 */
  dx: number;
  dz: number;
}

function nearestOn(line: Sample[], x: number, z: number): Near | null {
  let best: Near | null = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 1e-12) continue;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const distance = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (best && distance >= best.distance) continue;
    const length = Math.sqrt(lengthSq);
    best = {
      distance,
      y: a.y + (b.y - a.y) * t,
      s: a.s + (b.s - a.s) * t,
      dx: dx / length,
      dz: dz / length,
    };
  }
  return best;
}

/** 端点が相手の中心線に乗っているとみなす距離 [m]。 */
const TOUCH = 0.5;

/** 線形の端での単位方向 (始点は前向き、終点も前向き)。 */
function endDirection(line: Sample[], atStart: boolean): { dx: number; dz: number } | null {
  const a = atStart ? line[0] : line[line.length - 2];
  const b = atStart ? line[1] : line[line.length - 1];
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-9) return null;
  return { dx: dx / length, dz: dz / length };
}

/**
 * 交差点として形が保てるか。
 *
 * 「何 m 離す」という一律の余裕ではなく、**交差点が実際に食べる長さ**
 * (トリム) が取れるかどうかで判定する。トリムは交差点を解くときと同じ
 * 計算 (`requiredTrims`) なので、通った配置は必ず形が保たれ、形が乱れる
 * ほど詰まった配置は必ず止まる。
 *
 * 見るのは 3 通り。
 *  - 既存ノードに繋ぐ … 集まる枝それぞれがトリムを飲み込めるか
 *  - 既存セグメントの途中に繋ぐ … 分割してできる 2 本が飲み込めるか
 *  - 新しいノードを作る … その点が既存の交差点の中に入っていないか
 */
function checkJunctionSpacing(ctx: PlacementContext): Blocker[] {
  const { network, cls, alignment } = ctx;
  const out: Blocker[] = [];
  const length = alignment.length;
  const mineAt: number[] = [0, 0];

  const ends: [Anchor, boolean][] = [
    [ctx.start, true],
    [ctx.end, false],
  ];
  ends.forEach(([anchor, atStart], index) => {
    const dir = atStart
      ? alignment.sampleAt(0).forwardXZ.clone()
      : alignment.sampleAt(length).forwardXZ.clone().negate();
    const mine: BranchLike = { dir, cls };

    if (anchor.node !== undefined) {
      const branches = network
        .branchesAt(anchor.node)
        .filter((b) => b.segment !== ctx.ignore);
      const trims = requiredTrims([...branches, mine]);
      mineAt[index] = trims[trims.length - 1];
      branches.forEach((branch, k) => {
        if (trims[k] < 1e-3) return; // 一直線に繋がる枝はトリムしない
        const shortfall = trims[k] + CORNER_MARGIN - branchRoom(network, branch);
        // 詰まっているのは、その枝の**向こう端**にある交差点。
        if (shortfall > 0.05) {
          out.push({ message: tooCloseMessage(shortfall), at: farEnd(network, branch) });
        }
      });
      return;
    }

    if (anchor.split) {
      const seg = network.segments.get(anchor.split.segment);
      if (!seg) return;
      const split = network.alignmentOf(anchor.split.segment);
      const s = clamp(anchor.split.s, 0, split.length);
      const tangent = split.sampleAt(s).forwardXZ;
      const splitCls = network.classOf(seg);
      // 分割すると、切った点から両側へ 1 本ずつの枝ができる。
      const halves: { branch: BranchLike; length: number; far: NodeId }[] = [
        { branch: { dir: tangent.clone().negate(), cls: splitCls }, length: s, far: seg.a },
        {
          branch: { dir: tangent.clone(), cls: splitCls },
          length: split.length - s,
          far: seg.b,
        },
      ];
      const trims = requiredTrims([...halves.map((h) => h.branch), mine]);
      mineAt[index] = trims[trims.length - 1];
      halves.forEach((half, k) => {
        if (trims[k] < 1e-3) return;
        const far = trimAt(network, half.far, anchor.split!.segment);
        const shortfall =
          trims[k] + CORNER_MARGIN - roomFor(half.length, far + CORNER_MARGIN);
        if (shortfall > 0.05) {
          out.push({
            message: tooCloseMessage(shortfall),
            at: network.nodes.get(half.far)?.pos.clone(),
          });
        }
      });
      return;
    }

    // 新しいノードを作る場合。既存の交差点の**面の中**に端点を置くと、
    // 舗装どうしが重なって形が乱れる。逆に交差点の外なら、多少近くても
    // 形は保たれるので止めない。
    for (const node of network.nodes.values()) {
      const distance = node.pos.distanceTo(anchor.pos);
      if (distance > 60) continue;
      const reach = junctionReach(network, node.id) + cls.halfWidth * 0.5;
      if (distance < reach) {
        out.push({
          message:
            `交差点の中に端点があります (あと ${Math.max(1, reach - distance).toFixed(0)} m 離すか、` +
            `交差点のノードに繋いでください)。`,
          at: node.pos.clone(),
        });
      }
    }
  });

  // 新しい線形自身が、両端の取り付きを飲み込めるか。
  // (トリムのいらない端 = 交差点にならない端は見ない。引き始めの
  //  長さ 0 のプレビューで「区間長が足りない」と言わないため。)
  mineAt.forEach((trim, index) => {
    if (trim < 1e-3) return;
    const shortfall =
      trim + CORNER_MARGIN - roomFor(length, mineAt[1 - index] + CORNER_MARGIN);
    if (shortfall > 0.05) {
      out.push({
        message:
          `交差点の取り付きに ${(trim + CORNER_MARGIN).toFixed(0)} m 必要ですが、` +
          `区間長が ${length.toFixed(0)} m しかありません。`,
      });
    }
  });
  return out;
}

function tooCloseMessage(shortfall: number): string {
  return `交差点が近すぎます (あと ${Math.max(1, shortfall).toFixed(0)} m 離すか、既存のノードに繋いでください)。`;
}

/** 線形の、弧長 `s` に近い方の端の位置。 */
function endNear(alignment: Alignment, s: number): Vector3 {
  return alignment.sampleAt(s * 2 <= alignment.length ? 0 : alignment.length).pos.clone();
}

/**
 * 長さ `length` のセグメントが、反対の端で `farTrim` を取られたうえで
 * こちらの端に差し出せる長さ [m]。
 *
 * 交差点を解くときに掛かる上限 (区間長の 45%・40 m・両端の合計) と
 * 同じ条件にしてある。これを超える配置は、必ずトリムが頭打ちになって
 * 形が乱れる。
 */
function roomFor(length: number, farTrim: number): number {
  return Math.min(length * MAX_TRIM_RATIO, MAX_TRIM, length - farTrim - 1);
}

/** その枝がノード側に差し出せる長さ [m]。 */
function branchRoom(network: Network, branch: Branch): number {
  const seg = network.segments.get(branch.segment);
  if (!seg) return 0;
  const length = network.alignmentOf(branch.segment).length;
  const far = trimAt(network, branch.atStart ? seg.b : seg.a, branch.segment);
  return roomFor(length, far + CORNER_MARGIN);
}

/** その枝の、ノードと反対側の端の位置。 */
function farEnd(network: Network, branch: Branch): Vector3 | undefined {
  const seg = network.segments.get(branch.segment);
  if (!seg) return undefined;
  return network.nodes.get(branch.atStart ? seg.b : seg.a)?.pos.clone();
}

/** そのノードで、指定したセグメントの枝に必要なトリム量 [m]。 */
function trimAt(network: Network, node: NodeId, segment: SegmentId): number {
  const branches = network.branchesAt(node);
  const index = branches.findIndex((b) => b.segment === segment);
  if (index < 0) return 0;
  return requiredTrims(branches)[index];
}

/**
 * その交差点の面が広がっている範囲 [m] (端点・継ぎ目なら 0)。
 *
 * 敷設ツールも同じ値を見る (面の中を指したらその交差点に繋ぐ)。判定と
 * 操作が同じ範囲を見るので、「指せるのに置けない」所ができない。
 */
export function junctionReach(network: Network, node: NodeId): number {
  const branches = network.branchesAt(node);
  if (branches.length < 2) return 0;
  const trims = requiredTrims(branches);
  const trim = Math.max(...trims);
  if (trim < 1e-3) return 0;
  return Math.min(trim + CORNER_MARGIN, MAX_TRIM);
}

/**
 * 同一平面で交差してできる交差点のために、片方が空けておく長さ [m]。
 *
 * 道路は交差点の面を作るので、路端線の交点までのトリムがそのまま要る
 * (`crossingTrim`)。**線路の交差点は面を持たない** (`junction.ts` の冒頭の
 * 説明) のでトリムは 0。ノードどうしが重ならないだけの最小限を見る。
 */
function crossingRoom(
  own: NetworkClass,
  other: NetworkClass,
  sin: number,
  cos: number,
): number {
  if (own.kind === 'rail' && other.kind === 'rail') return RAIL_CROSSING_ROOM;
  return crossingTrim(own, other, sin, cos);
}

/**
 * 線路の交点を作るのに、端まで要る長さ [m]。
 *
 * 線路の交差点は面を持たない (`junction.ts` の冒頭の説明) ので、道路のような
 * 取り付き長は要らない。要るのは**そこで双方を分けられること**だけで、
 * 交点で双方を分けるのは `resolveAutoJunctions` と `splitAtCrossing`。
 * どちらも端から `CROSSING_END_MARGIN` 以内では分けないので、判定も同じ
 * 足切りで見る (折れ線の弦誤差のぶんだけ厳しくしておく)。ここを緩くすると、
 * 「置けたのに繋がらず、同一平面で交差しています」と言われる交差ができる。
 *
 * **幅から決めてはいけない。** 複線の中心間隔は `parallelSpacing` =
 * 半幅の和 + 0.2 m なので、半幅の和より長い余裕を求めると、複線を横切った
 * ときに必ず足りなくなる (交点が複線の間隔で並ぶため)。以前はここが
 * 半幅の和 + 0.6 m だったので、**複線はどの線路とも交差できなかった**。
 */
const RAIL_CROSSING_ROOM = CROSSING_END_MARGIN + 0.5;

/**
 * 同一平面で交差する 2 本のうち、片方が交差点に差し出す長さ [m]。
 * 交差点を解くときの路端線の交点と同じ式。
 */
function crossingTrim(
  own: NetworkClass,
  other: NetworkClass,
  sin: number,
  cos: number,
): number {
  return (other.halfWidth + own.halfWidth * cos) / Math.max(0.05, sin) + CORNER_MARGIN;
}

/** 坑門が交差点の外に立つために要る余裕 [m] (柱の奥行き + 隅の丸め)。 */
const PORTAL_STANDOFF = 3;

/**
 * 坑口にかかる交差点を止める。
 *
 * トンネルの中の交差点そのものは作れる (交差点面を地中の空洞として囲い、
 * 枝のトンネルはそこへ開く)。作れないのは**坑口にかかる**交差点で、
 * 交差点の口に坑門が立って曲がってきた車がぶつかる。地形と線形の高さで
 * 決まることなので、「掘ってから直す」ことができない。置く前に止める。
 *
 * 判定は交差点になる点 (既存ノード・取り付き・同一平面の交差) のまわりで、
 * **交差点が食べる長さ + 坑門の余裕**の範囲を線形に沿って歩き、そこに
 * トンネルと地表の**境目**があるかどうかを見る。全部トンネル (空洞) でも
 * 全部地表でも構わない。地形を横に見ないのは、山腹を走っているだけの
 * 道路を巻き込まないため。
 */
function checkTunnelJunctions(ctx: PlacementContext, connected: Set<SegmentId>): string[] {
  const field = ctx.field;
  if (!field) return [];
  const { network, cls, alignment } = ctx;
  const out: string[] = [];

  /** 線形の s0 から前後 `reach` の範囲に、坑口 (トンネルと地表の境目) があるか。 */
  const portalNear = (line: Alignment, s0: number, reach: number): boolean => {
    let tunnel = false;
    let open = false;
    for (let d = 0; d <= reach; d += 2) {
      for (const s of d === 0 ? [s0] : [s0 - d, s0 + d]) {
        if (s < 0 || s > line.length) continue;
        const p = line.sampleAt(s).pos;
        if (classify(p.y, field.baseHeightAt(p.x, p.z)) === 'tunnel') tunnel = true;
        else open = true;
      }
    }
    return tunnel && open;
  };

  const blocked = (): void => {
    out.push('トンネルの坑口には交差点を作れません (坑口から離してください)。');
  };

  // 1. 既存の線形と同じ高さで交わる所 (新しくできる交差点)。
  const mine = polyline(alignment);
  for (const seg of network.segments.values()) {
    if (connected.has(seg.id)) continue;
    const other = network.classOf(seg);
    if (other.kind !== cls.kind) continue;
    const otherAlignment = network.alignmentOf(seg.id);
    for (const hit of intersectPolylines(mine, polyline(otherAlignment))) {
      if (Math.abs(hit.yA - hit.yB) > LEVEL_CROSSING_TOLERANCE) continue;
      const sin = Math.abs(hit.dirA.x * hit.dirB.y - hit.dirA.y * hit.dirB.x);
      const cos = Math.abs(hit.dirA.x * hit.dirB.x + hit.dirA.y * hit.dirB.y);
      if (
        portalNear(alignment, hit.sA, crossingTrim(cls, other, sin, cos) + PORTAL_STANDOFF) ||
        portalNear(otherAlignment, hit.sB, crossingTrim(other, cls, sin, cos) + PORTAL_STANDOFF)
      ) {
        blocked();
        return dedupe(out);
      }
    }
  }

  // 2. 端点が既存のノード・既存の線形の途中に取り付く所。
  const ends: [Anchor, number][] = [
    [ctx.start, 0],
    [ctx.end, alignment.length],
  ];
  for (const [anchor, s] of ends) {
    const neighbours: { line: Alignment; s: number; cls: NetworkClass }[] = [];
    if (anchor.node !== undefined) {
      for (const branch of network.branchesAt(anchor.node)) {
        if (branch.segment === ctx.ignore) continue;
        const seg = network.segments.get(branch.segment);
        if (!seg) continue;
        const line = network.alignmentOf(branch.segment);
        neighbours.push({
          line,
          s: branch.atStart ? 0 : line.length,
          cls: network.classOf(seg),
        });
      }
    } else if (anchor.split) {
      const seg = network.segments.get(anchor.split.segment);
      if (seg) {
        const line = network.alignmentOf(anchor.split.segment);
        neighbours.push({
          line,
          s: clamp(anchor.split.s, 0, line.length),
          cls: network.classOf(seg),
        });
      }
    }
    // 交差点にならない端は見ない。行き止まり (枝なし) と、繋いでも
    // 2 枝にしかならない端 (道の延伸・折れ点) には交差点の面ができず、
    // 坑門と喧嘩する口もない。トンネルの中の道はこうして延ばせる。
    if (neighbours.length < 2) continue;
    for (const neighbour of neighbours) {
      // 直角に取り付く場合のトリム。斜めの取り付きはこれより長くなるが、
      // 足りない分は「止めない側」に外れるので誤検知にならない。
      const reach = cls.halfWidth + neighbour.cls.halfWidth + CORNER_MARGIN + PORTAL_STANDOFF;
      if (portalNear(alignment, s, reach) || portalNear(neighbour.line, neighbour.s, reach)) {
        blocked();
        return dedupe(out);
      }
    }
  }

  return out;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/** 撤去してよいか (今は常に許す)。将来の拡張のために口を開けておく。 */
export function checkRemoval(_network: Network, _segment: SegmentId): PlacementCheck {
  return { blockers: [], places: [] };
}

/** デバッグ用: 判定に使った点を可視化したいとき向け。 */
export function placementSamples(alignment: Alignment): Vector3[] {
  return polyline(alignment).map((p) => new Vector3(p.x, p.y, p.z));
}
