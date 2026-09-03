import type { Alignment } from '../core/alignment';
import type { Network, SegmentId } from './network';
import {
  planStationLayout,
  stationLocal,
  stationOutline,
  stationSampleAt,
  straightStationPath,
  type Station,
  type StationArea,
  type StationSpec,
} from './station';

const VERTICAL_CLEARANCE = 8;

/**
 * 敷地の判定に要る駅の形だけ。
 *
 * 中心線 (`path`) と横距の範囲で決まるので、直線の駅でも曲線に沿った駅でも
 * 同じ式で判定できる。
 */
type Footprint = StationArea;

/** その点が敷地の中なら局所座標を返す。外なら null。 */
function localInside(
  shape: Footprint,
  x: number,
  z: number,
  margin = 0,
): { along: number; across: number } | null {
  const local = stationLocal(shape, x, z);
  if (Math.abs(local.along) > shape.length / 2 + margin) return null;
  if (local.across < shape.minOffset - margin) return null;
  if (local.across > shape.maxOffset + margin) return null;
  return local;
}

/** 敷地のその位置での路面高さ。勾配のある線路に置いた駅では場所で変わる。 */
function deckY(shape: Footprint, along: number): number {
  return stationSampleAt(shape, along).pos.y;
}

function footprintOf(spec: StationSpec, path: Alignment): Footprint {
  const layout = planStationLayout(spec.trackCount, spec.platformCount);
  return {
    path,
    length: spec.length,
    minOffset: layout.minOffset,
    maxOffset: layout.maxOffset,
  };
}

export interface StationPlacementOptions {
  /** 駅の中心線。省略すると `spec` から直線を作る (空き地に置く駅)。 */
  path?: Alignment;
  /**
   * 敷地に入っていても構わない線形。
   *
   * 既設の線路に駅を置くときの、取り込む当の線路。これを除かないと
   * 「敷地に線形が掛かっています」で必ず弾かれる。
   */
  ignore?: ReadonlySet<SegmentId>;
}

/** 駅を置けるか。置けない理由を並べて返す。 */
export function checkStationPlacement(
  network: Network,
  spec: StationSpec,
  options: StationPlacementOptions = {},
): string[] {
  const candidate = footprintOf(spec, options.path ?? straightStationPath(spec));
  for (const segment of network.segments.values()) {
    if (options.ignore?.has(segment.id)) continue;
    const cls = network.classOf(segment);
    const alignment = network.alignmentOf(segment.id);
    const steps = Math.max(2, Math.ceil(alignment.length / 4));
    for (let i = 0; i <= steps; i++) {
      const p = alignment.sampleAt((alignment.length * i) / steps).pos;
      const local = localInside(candidate, p.x, p.z, cls.halfWidth + 1);
      if (local && Math.abs(p.y - deckY(candidate, local.along)) < VERTICAL_CLEARANCE) {
        return ['駅の敷地が既存の道路・線路と重なっています'];
      }
    }
  }
  for (const other of network.stations.values()) {
    if (overlaps(candidate, other)) return ['駅どうしの敷地が重なっています'];
  }
  return [];
}

/**
 * 2 つの駅の敷地が重なっているか。
 *
 * 曲線に沿った駅は矩形ではないので、外周の点を互いの敷地に掛けて見る。
 * 一方が他方をすっぽり含む場合も、どちらかの外周が相手の中に入る。
 */
function overlaps(a: Footprint, b: Station): boolean {
  const near = (shape: Footprint, other: Footprint, points: readonly { x: number; z: number }[]) =>
    points.some((p) => {
      const local = localInside(other, p.x, p.z);
      if (!local) return false;
      const aLocal = stationLocal(shape, p.x, p.z);
      return Math.abs(deckY(shape, aLocal.along) - deckY(other, local.along)) < VERTICAL_CLEARANCE;
    });
  return (
    near(a, b, outlinePoints(a)) ||
    near(b, a, outlinePoints(b))
  );
}

/** 敷地の外周と中心線を刻んだ点。重なり判定に使う。 */
function outlinePoints(shape: Footprint): { x: number; z: number }[] {
  const points = stationOutline(shape).map((p) => ({ x: p.x, z: p.z }));
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const along = (i / steps - 0.5) * shape.length;
    const p = stationSampleAt(shape, along).pos;
    points.push({ x: p.x, z: p.z });
  }
  return points;
}

/** Prevent later roads and tracks from cutting through an existing station. */
export function checkAlignmentAgainstStations(
  network: Network,
  alignment: Alignment,
  margin = 1,
  ignore?: number,
): string[] {
  const samples = alignment.sample(3);
  for (const station of network.stations.values()) {
    if (ignore !== undefined && station.tracks.some((track) => track.segment === ignore)) continue;
    for (const sample of samples) {
      // Leave a narrow opening at both track ends so ordinary rail can snap to them.
      const local = stationLocal(station, sample.pos.x, sample.pos.z);
      const interior = Math.abs(local.along) < station.length / 2 - 1;
      const across =
        local.across >= station.minOffset - margin && local.across <= station.maxOffset + margin;
      if (
        interior &&
        across &&
        Math.abs(sample.pos.y - deckY(station, local.along)) < VERTICAL_CLEARANCE
      ) {
        return ['駅構内を横切って敷設することはできません。station track の端点へ接続してください。'];
      }
    }
  }
  return [];
}
