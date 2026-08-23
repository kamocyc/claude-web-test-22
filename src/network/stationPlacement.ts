import type { Alignment } from '../core/alignment';
import type { Network } from './network';
import { planStationLayout, type Station, type StationSpec } from './station';

const VERTICAL_CLEARANCE = 8;

interface BoundsLike {
  center: { x: number; y: number; z: number };
  heading: number;
  length: number;
  minOffset: number;
  maxOffset: number;
}

/** Placement blockers for a station that must initially stand independently. */
export function checkStationPlacement(network: Network, spec: StationSpec): string[] {
  const layout = planStationLayout(spec.trackCount, spec.platformCount);
  const candidate: BoundsLike = { ...spec, minOffset: layout.minOffset, maxOffset: layout.maxOffset };
  for (const segment of network.segments.values()) {
    const cls = network.classOf(segment);
    const alignment = network.alignmentOf(segment.id);
    const steps = Math.max(2, Math.ceil(alignment.length / 4));
    for (let i = 0; i <= steps; i++) {
      const p = alignment.sampleAt((alignment.length * i) / steps).pos;
      if (
        inside(candidate, p.x, p.z, cls.halfWidth + 1) &&
        Math.abs(p.y - spec.center.y) < VERTICAL_CLEARANCE
      ) {
        return ['駅の敷地が既存の道路・線路と重なっています'];
      }
    }
  }
  for (const other of network.stations.values()) {
    if (
      rectanglesOverlap(candidate, other) &&
      Math.abs(other.center.y - spec.center.y) < VERTICAL_CLEARANCE
    ) {
      return ['駅どうしの敷地が重なっています'];
    }
  }
  return [];
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
      const local = localOf(station, sample.pos.x, sample.pos.z);
      const interior = Math.abs(local.along) < station.length / 2 - 1;
      const across =
        local.across >= station.minOffset - margin && local.across <= station.maxOffset + margin;
      if (interior && across && Math.abs(sample.pos.y - station.center.y) < VERTICAL_CLEARANCE) {
        return ['駅構内を横切って敷設することはできません。station track の端点へ接続してください。'];
      }
    }
  }
  return [];
}

function localOf(bounds: Pick<BoundsLike, 'center' | 'heading'>, x: number, z: number): { along: number; across: number } {
  const dx = x - bounds.center.x;
  const dz = z - bounds.center.z;
  const fx = Math.cos(bounds.heading);
  const fz = Math.sin(bounds.heading);
  return { along: dx * fx + dz * fz, across: -dx * fz + dz * fx };
}

function inside(bounds: BoundsLike, x: number, z: number, margin = 0): boolean {
  const p = localOf(bounds, x, z);
  return (
    Math.abs(p.along) <= bounds.length / 2 + margin &&
    p.across >= bounds.minOffset - margin &&
    p.across <= bounds.maxOffset + margin
  );
}

function rectanglesOverlap(a: BoundsLike, b: Station): boolean {
  const corners = (r: BoundsLike): { x: number; z: number }[] => {
    const fx = Math.cos(r.heading);
    const fz = Math.sin(r.heading);
    const rx = -fz;
    const rz = fx;
    const points: { x: number; z: number }[] = [];
    for (const along of [-r.length / 2, r.length / 2]) {
      for (const across of [r.minOffset, r.maxOffset]) {
        points.push({
          x: r.center.x + fx * along + rx * across,
          z: r.center.z + fz * along + rz * across,
        });
      }
    }
    return points;
  };
  const ac = corners(a);
  const bc = corners(b);
  const axes = [a.heading, a.heading + Math.PI / 2, b.heading, b.heading + Math.PI / 2];
  for (const angle of axes) {
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    const ap = ac.map((p) => p.x * x + p.z * z);
    const bp = bc.map((p) => p.x * x + p.z * z);
    if (Math.max(...ap) < Math.min(...bp) || Math.max(...bp) < Math.min(...ap)) return false;
  }
  return true;
}
