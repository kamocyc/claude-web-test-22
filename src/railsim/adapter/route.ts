import { RAIL_GAUGE } from '../../core/units';
import type { SegmentId } from '../../network/network';
import type { Station, StationId } from '../../network/station';
import type { StructureRun } from '../../network/structure';
import type { LaneGraph, LanePose } from '../../sim/lanegraph';
import { PointTable, SpanTable, StepTable } from '../core/math/table.ts';
import { TrackIrregularity } from '../core/physics/irregularity.ts';
import type { RailJointFeature } from '../core/physics/railJoint.ts';
import type {
  AspectSpeeds,
  BeaconPayload,
  CompiledRoute,
  SafetySystemKind,
  SpeedLimitEntry,
  Station as RouteStation,
  TunnelSection,
} from '../core/route/types.ts';
import { Alignment } from '../core/track/alignment.ts';
import { BridgeTrack } from '../core/track/bridge.ts';
import { LevelCrossingTrack } from '../core/track/levelCrossing.ts';
import { AdjacentTrack } from '../core/track/passingLoop.ts';
import { TurnoutTrack } from '../core/track/turnout.ts';
import { GRAVITY, kmhToMps } from '../core/units.ts';
import { rampFromSamples, sampleTrack, type TrackSample } from './geometry.ts';

/**
 * 敷いた線路を「運転できる 1 本の路線」に均したもの。
 *
 * こちらの世界は網目で、車両は**車線**の上を走る。移植元の世界は 1 本の線で、
 * 物理は**距離程**しか見ない。その 2 つを繋ぐのがこの型である。
 *
 * 繋ぎ方の勘所は 1 つ。**姿勢は railsim に計算させない**。
 * `Alignment.positionAt` は曲率と勾配の二重積分なので、こちらの実際の線形からは
 * 少しずつずれる。ずれた所に列車を置くと、敷いたレールから浮く。だから
 * 距離程から姿勢を引くときは、必ず元の車線 (`LanePath.poseAt`) へ戻って
 * **本物の姿勢**を取る。物理は距離程しか要らないので、これで矛盾しない。
 */
export interface DrivingRoute {
  /** 物理が見る路線。 */
  readonly compiled: CompiledRoute;
  /** もとの車線の並び (Traffic と番地を共有する)。 */
  readonly lanes: readonly number[];
  readonly length: number;
  /** 距離程 → この世界での姿勢。 */
  poseAt(s: number): LanePose;
  /** 距離程 → 経路上の位置 (何番目の車線の、その車線の弧長で何 m か)。 */
  locate(s: number): { readonly index: number; readonly lane: number; readonly s: number };
  /** 駅 (route の駅 id → こちらの駅 id)。 */
  readonly stationIds: ReadonlyMap<string, StationId>;
}

/** 現示ごとの許容速度の既定値 [km/h]。移植元の路線スキーマの既定値と同じ。 */
const DEFAULT_ASPECT_SPEEDS_KMH: Readonly<Record<keyof AspectSpeeds, number>> = {
  R: 0,
  YY: 25,
  Y: 45,
  YG: 75,
  G: 120,
};

/** 許容カント不足 [m]。在来線の一般的な値 (60 mm)。 */
const DEFAULT_MAX_CANT_DEFICIENCY = 0.06;

/** 定尺レールの継目間隔 [m]。 */
const DEFAULT_JOINT_SPACING = 25;

/** 制限速度を切り下げる刻み [km/h]。 */
const LIMIT_STEP_KMH = 5;

export interface DrivingRouteOptions {
  readonly id?: string;
  readonly name?: string;
  /** 距離程の刻み [m]。 */
  readonly step?: number;
  readonly gauge?: number;
  /** 許容カント不足 [m]。曲線の制限速度はこれで決まる。 */
  readonly maxCantDeficiency?: number;
  /** 駅の諸元を引くための一覧。 */
  readonly stations?: ReadonlyMap<StationId, Station>;
  /**
   * 停止位置を求めるのに使う編成長 [m]。
   *
   * ホームの中央に編成の中央を合わせるので、**先頭端**の停止位置は
   * ホーム中央から編成長の半分だけ先になる。
   */
  readonly consistLength?: number;
  /** 停車時分 [s]。 */
  readonly dwellTime?: number;
  /** 区間ごとの構造形式。トンネル区間を拾うのに使う。 */
  readonly structures?: ReadonlyMap<SegmentId, StructureRun[]>;
  /** 定尺レールの継目間隔 [m] (0 = ロングレール)。 */
  readonly jointSpacing?: number;
  /** 決定論のための種。軌道狂いに使う。 */
  readonly seed?: number;
}

/** 経路の車線ごとの入口距離程。 */
interface LaneSpan {
  readonly lane: number;
  readonly start: number;
  readonly length: number;
}

/**
 * 車線の連なりから運転できる路線を作る。
 *
 * ここで決まるのは「距離程 s とは何か」である。`lanes` の先頭の入口を 0 として、
 * 車線を順に繋いだ弧長を s とする。以降、物理も信号も駅もこの s だけで話をする。
 */
export function buildDrivingRoute(
  graph: LaneGraph,
  lanes: readonly number[],
  options: DrivingRouteOptions = {},
): DrivingRoute {
  const gauge = options.gauge ?? RAIL_GAUGE;
  const spans = laneSpans(graph, lanes);
  const length = spans.reduce((a, s) => a + s.length, 0);
  if (!(length > 0)) throw new Error('運転する経路の長さが 0 です');

  const locate = (s: number): { index: number; lane: number; s: number } => {
    let rest = Math.max(0, Math.min(s, length));
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!;
      if (rest <= span.length || i === spans.length - 1) {
        return { index: i, lane: span.lane, s: Math.max(0, Math.min(rest, span.length)) };
      }
      rest -= span.length;
    }
    return { index: 0, lane: spans[0]!.lane, s: 0 };
  };

  const poseAt = (s: number): LanePose => {
    const at = locate(s);
    return graph.lanes[at.lane]!.path.poseAt(at.s);
  };

  const samples = sampleTrack(poseAt, length, { step: options.step ?? 1, gauge });
  const alignment = new Alignment({
    curvature: rampFromSamples(samples, (x) => x.curvature),
    grade: rampFromSamples(samples, (x) => x.grade),
    cant: rampFromSamples(samples, (x) => x.cant),
    gauge,
    length,
    // 位置は使わない (姿勢は `poseAt` から取る) ので、刻みは粗くてよい。
    // それでも 0 にはできないので、線路の全長を数百点で見る程度にしておく。
    sampleStep: Math.max(1, length / 512),
  });

  const lineSpeed = Math.max(...spans.map((s) => graph.lanes[s.lane]?.speedLimit ?? 0), kmhToMps(5));
  const maxCantDeficiency = options.maxCantDeficiency ?? DEFAULT_MAX_CANT_DEFICIENCY;
  const { table: speedLimits, entries: speedLimitEntries } = buildSpeedLimits(
    samples,
    spans,
    graph,
    { gauge, lineSpeed, maxCantDeficiency },
  );

  const { stations, stationIds } = buildStations(spans, graph, length, options);

  const tunnels = buildTunnels(spans, graph, options.structures);

  const jointSpacing = options.jointSpacing ?? DEFAULT_JOINT_SPACING;
  const aspectSpeeds: AspectSpeeds = {
    R: kmhToMps(DEFAULT_ASPECT_SPEEDS_KMH.R),
    YY: kmhToMps(DEFAULT_ASPECT_SPEEDS_KMH.YY),
    Y: kmhToMps(DEFAULT_ASPECT_SPEEDS_KMH.Y),
    YG: kmhToMps(DEFAULT_ASPECT_SPEEDS_KMH.YG),
    G: Math.max(lineSpeed, kmhToMps(DEFAULT_ASPECT_SPEEDS_KMH.G)),
  };

  const compiled: CompiledRoute = {
    id: options.id ?? 'driving-route',
    name: options.name ?? '運転経路',
    alignment,
    length,
    maxSpeed: lineSpeed,
    stations,
    // 信号・閉塞・地上子・保安装置の区間は、閉塞を切る段で入れる。
    signals: [],
    blocks: [],
    speedLimits,
    speedLimitEntries,
    tunnels,
    beacons: new PointTable<BeaconPayload>([]),
    safetySections: new SpanTable<SafetySystemKind>([]),
    irregularity: new TrackIrregularity(options.seed ?? 1),
    // 分岐器・橋りょう・踏切・行き違い設備は、音を入れる段でこちらの網目から拾う。
    turnouts: new TurnoutTrack([]),
    bridges: new BridgeTrack([]),
    levelCrossings: new LevelCrossingTrack([]),
    adjacentTrack: new AdjacentTrack([]),
    railJoints: new PointTable<RailJointFeature>([]),
    railJointSpacing: new StepTable<number>([], jointSpacing),
    railCorrugation: new StepTable<number>([], 0),
    maxCantDeficiency,
    aspectSpeeds,
  };

  return { compiled, lanes: spans.map((s) => s.lane), length, poseAt, locate, stationIds };
}

/** 車線ごとの入口距離程と長さ。長さ 0 の車線は落とす。 */
function laneSpans(graph: LaneGraph, lanes: readonly number[]): LaneSpan[] {
  const out: LaneSpan[] = [];
  let start = 0;
  for (const lane of lanes) {
    const path = graph.lanes[lane]?.path;
    if (!path || !(path.length > 1e-6)) continue;
    out.push({ lane, start, length: path.length });
    start += path.length;
  }
  if (out.length === 0) throw new Error('運転できる車線が経路にありません');
  return out;
}

/**
 * 曲線の制限速度 [m/s]。
 *
 *   カント不足 Cd = G v² / (g R) − C を Cd_max 以下に保つ条件から
 *   v_max = √((C + Cd_max) g R / G)
 *
 * 実際の線路の曲線制限も同じ考え方 (許容カント不足) で決まっている。
 */
function curveSpeedLimit(
  curvature: number,
  cant: number,
  gauge: number,
  maxCantDeficiency: number,
): number {
  const k = Math.abs(curvature);
  if (!(k > 1e-9)) return Infinity;
  // カントは曲線の向きに付いているので、大きさで見る。
  return Math.sqrt(((Math.abs(cant) + maxCantDeficiency) * GRAVITY) / (gauge * k));
}

/** 制限速度を刻みで切り下げる [m/s]。 */
function roundDownSpeed(speed: number, stepKmh: number): number {
  return kmhToMps(Math.floor((speed * 3.6) / stepKmh) * stepKmh);
}

/**
 * 距離程 → 制限速度の階段関数。
 *
 * 曲線の制限は**曲線ごと**に決める。刻んだ点の半径からその点の制限を出して
 * そのまま並べると、緩和曲線の途中は半径が大きいぶん制限が緩くなり、円曲線に
 * 入る手前でいったん上げてすぐ落とす、という運転できない階段になる。そこで
 * 「線区の最高速度を割る点が続いている範囲」を 1 つの曲線とみなし、その中の
 * **最も低い制限**を範囲の全体に適用する。緩和曲線も曲線の一部として扱う実際の
 * 取扱と同じになる。
 */
function buildSpeedLimits(
  samples: readonly TrackSample[],
  spans: readonly LaneSpan[],
  graph: LaneGraph,
  options: { gauge: number; lineSpeed: number; maxCantDeficiency: number },
): { table: StepTable<number>; entries: SpeedLimitEntry[] } {
  const { gauge, lineSpeed, maxCantDeficiency } = options;
  interface LimitSpanEntry {
    id: string;
    start: number;
    end: number;
    speed: number;
    reason: SpeedLimitEntry['reason'];
  }
  const limitSpans: LimitSpanEntry[] = [];

  // --- 曲線 ---
  const raw = samples.map((x) =>
    roundDownSpeed(curveSpeedLimit(x.curvature, x.cant, gauge, maxCantDeficiency), LIMIT_STEP_KMH),
  );
  let curve = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]! >= lineSpeed) continue;
    let j = i;
    let lowest = raw[i]!;
    while (j + 1 < raw.length && raw[j + 1]! < lineSpeed) {
      j++;
      lowest = Math.min(lowest, raw[j]!);
    }
    limitSpans.push({
      id: `curve-${curve++}`,
      start: samples[i]!.s,
      end: samples[j]!.s,
      speed: lowest,
      reason: 'curve',
    });
    i = j;
  }

  // --- 車線そのものの制限 (種別の設計速度、交差点の中を通る進路) ---
  for (const span of spans) {
    const speed = graph.lanes[span.lane]?.speedLimit ?? lineSpeed;
    if (speed >= lineSpeed) continue;
    limitSpans.push({
      id: `lane-${span.lane}`,
      start: span.start,
      end: span.start + span.length,
      speed,
      // 交差点の中を通る進路は、こちらの網目では分岐器にあたる。
      reason: graph.lanes[span.lane]?.kind === 'connector' ? 'turnout' : 'line',
    });
  }

  return buildSpeedLimitTable(limitSpans, samples[samples.length - 1]?.s ?? 0, lineSpeed);
}

function buildSpeedLimitTable(
  spans: readonly { id: string; start: number; end: number; speed: number; reason: SpeedLimitEntry['reason'] }[],
  routeLength: number,
  lineSpeed: number,
): { table: StepTable<number>; entries: SpeedLimitEntry[] } {
  const breakpoints = new Set<number>([0]);
  for (const sp of spans) {
    breakpoints.add(Math.max(0, sp.start));
    breakpoints.add(Math.min(routeLength, sp.end));
  }
  // 同じ点を指しているつもりの切替点が丸め誤差で僅かにずれると、幅 0 の制限区間が
  // できる。1 μm 以内に固まっているものは最後の 1 つに寄せる。
  const sorted = [...breakpoints]
    .sort((a, b) => a - b)
    .filter((b, i, all) => i === all.length - 1 || all[i + 1]! - b > 1e-6);

  const stepEntries: { s: number; value: number }[] = [];
  const entries: SpeedLimitEntry[] = [];
  let previous = Number.NaN;
  for (const b of sorted) {
    if (b > routeLength) break;
    let speed = lineSpeed;
    let winner: (typeof spans)[number] | undefined;
    for (const sp of spans) {
      if (sp.start <= b && b < sp.end && sp.speed < speed) {
        speed = sp.speed;
        winner = sp;
      }
    }
    if (speed !== previous) {
      stepEntries.push({ s: b, value: speed });
      entries.push({
        id: winner?.id ?? `line-${b}`,
        start: b,
        speed,
        reason: winner?.reason ?? 'line',
      });
      previous = speed;
    }
  }
  return { table: new StepTable(stepEntries, lineSpeed), entries };
}

/**
 * 経路の上にある駅を拾う。
 *
 * 車線が持っている `stationStop` は**ホームの中央**なので、停止位置 (先頭端を
 * 合わせる距離程) はそこから編成長の半分だけ先になる。
 */
function buildStations(
  spans: readonly LaneSpan[],
  graph: LaneGraph,
  routeLength: number,
  options: DrivingRouteOptions,
): { stations: RouteStation[]; stationIds: Map<string, StationId> } {
  const consistLength = options.consistLength ?? 0;
  const stations: RouteStation[] = [];
  const stationIds = new Map<string, StationId>();
  for (const span of spans) {
    const stop = graph.lanes[span.lane]?.stationStop;
    if (!stop) continue;
    const centre = span.start + stop.s;
    const station = options.stations?.get(stop.station);
    const platformHalf = (station?.length ?? 200) / 2;
    const id = `station-${stop.station}`;
    if (stationIds.has(id)) continue;
    stationIds.set(id, stop.station);
    stations.push({
      id,
      name: station?.name ?? `駅 ${stop.station}`,
      stopPosition: Math.min(routeLength, centre + consistLength / 2),
      platformStart: Math.max(0, centre - platformHalf),
      platformEnd: Math.min(routeLength, centre + platformHalf),
      isPass: false,
      dwellTime: options.dwellTime ?? 30,
      stopTolerance: 1,
    });
  }
  stations.sort((a, b) => a.stopPosition - b.stopPosition);
  return { stations, stationIds };
}

/** 区間ごとの構造形式から、経路上のトンネル区間を拾う。 */
function buildTunnels(
  spans: readonly LaneSpan[],
  graph: LaneGraph,
  structures: ReadonlyMap<SegmentId, StructureRun[]> | undefined,
): SpanTable<TunnelSection> {
  if (!structures) return new SpanTable<TunnelSection>([]);
  const out: { start: number; end: number; value: TunnelSection }[] = [];
  for (const span of spans) {
    const lane = graph.lanes[span.lane];
    if (!lane || lane.segment === undefined) continue;
    for (const run of structures.get(lane.segment) ?? []) {
      if (run.mode !== 'tunnel') continue;
      // 車線は線形の一部を切り取ったもの。構造区間も同じ弧長で測ってあるが、
      // 逆向きに走る車線では距離程が反転する。
      const { start, end } = laneRange(lane, run.s0, run.s1);
      if (!(end > start)) continue;
      const a = span.start + start;
      const b = span.start + Math.min(span.length, end);
      const id = `tunnel-${out.length}`;
      out.push({ start: a, end: b, value: { id, start: a, end: b } });
    }
  }
  return new SpanTable(mergeSpans(out));
}

/**
 * 線形の弧長 [s0, s1] を、その車線の弧長へ直す。
 *
 * 車線は交差点の中を抜いた範囲だけを走り、向き違いの車線では弧長が反転する。
 * どちらも `GraphLane.trim` に控えてある。
 */
function laneRange(
  lane: LaneGraph['lanes'][number],
  s0: number,
  s1: number,
): { start: number; end: number } {
  const trim = lane.trim;
  const span = lane.path.length;
  if (!trim) return { start: Math.max(0, s0), end: Math.min(span, s1) };
  const a = s0 - trim.s0;
  const b = s1 - trim.s0;
  return trim.forward
    ? { start: Math.max(0, a), end: Math.min(span, b) }
    : { start: Math.max(0, span - b), end: Math.min(span, span - a) };
}

/** 重なり・隣り合う区間を 1 つに畳む。 */
function mergeSpans(
  spans: readonly { start: number; end: number; value: TunnelSection }[],
): { start: number; end: number; value: TunnelSection }[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number; value: TunnelSection }[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span.start <= last.end + 1e-6) {
      const end = Math.max(last.end, span.end);
      out[out.length - 1] = {
        start: last.start,
        end,
        value: { id: last.value.id, start: last.start, end },
      };
      continue;
    }
    out.push(span);
  }
  return out;
}
