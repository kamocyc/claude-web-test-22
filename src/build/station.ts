import {
  CanvasTexture,
  Group,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { fillPolygon, type MeshBuilder } from '../core/meshbuilder';
import type { Station } from '../network/station';
import { PLATFORM_HEIGHT } from '../network/station';
import { addBox } from './primitives';

const PLATFORM: readonly [number, number, number] = [0.58, 0.6, 0.62];
const PLATFORM_EDGE: readonly [number, number, number] = [0.92, 0.78, 0.28];
const TACTILE: readonly [number, number, number] = [0.95, 0.72, 0.12];
const ROOF: readonly [number, number, number] = [0.2, 0.34, 0.48];
const STEEL: readonly [number, number, number] = [0.48, 0.53, 0.57];
const BUILDING: readonly [number, number, number] = [0.72, 0.76, 0.78];
const WINDOW: readonly [number, number, number] = [0.16, 0.34, 0.45];
const SIGN: readonly [number, number, number] = [0.92, 0.94, 0.92];
const BENCH: readonly [number, number, number] = [0.35, 0.2, 0.12];
const UP = new Vector3(0, 1, 0);

export interface StationAxes {
  forward: Vector3;
  right: Vector3;
  up: Vector3;
}

export function stationAxes(station: Pick<Station, 'heading'>): StationAxes {
  const forward = new Vector3(Math.cos(station.heading), 0, Math.sin(station.heading));
  return { forward, right: new Vector3(-forward.z, 0, forward.x), up: UP };
}

export function stationPoint(station: Pick<Station, 'center' | 'heading'>, along: number, across: number, y = 0): Vector3 {
  const axes = stationAxes(station);
  return station.center
    .clone()
    .addScaledVector(axes.forward, along)
    .addScaledVector(axes.right, across)
    .addScaledVector(UP, y);
}

/** Rectangular XZ footprint used by placement and terrain grading. */
export function stationFootprint(
  station: Pick<Station, 'center' | 'heading' | 'length' | 'minOffset' | 'maxOffset'>,
  margin = 0,
  y = station.center.y,
): Vector3[] {
  const half = station.length / 2 + margin;
  return [
    stationPoint(station, -half, station.minOffset - margin).setY(y),
    stationPoint(station, half, station.minOffset - margin).setY(y),
    stationPoint(station, half, station.maxOffset + margin).setY(y),
    stationPoint(station, -half, station.maxOffset + margin).setY(y),
  ];
}

/** Add platforms, station furniture, station building and elevated supports. */
export function buildStation(
  surface: MeshBuilder,
  overlay: MeshBuilder,
  structure: MeshBuilder,
  station: Station,
  groundY: (x: number, z: number) => number,
): void {
  const axes = stationAxes(station);
  const platformHalf = station.length / 2;
  const bottom = -0.9;
  const top = PLATFORM_HEIGHT;
  const halfHeight = (top - bottom) / 2;

  for (const platform of station.platforms) {
    const center = stationPoint(station, 0, platform.offset, (top + bottom) / 2);
    addBox(
      surface,
      center,
      axes.right,
      axes.up,
      axes.forward,
      { x: platform.width / 2, y: halfHeight, z: platformHalf },
      PLATFORM,
    );

    // Yellow tactile paving and a pale safety edge on every served face.
    for (const track of platform.tracks) {
      const trackOffset = station.tracks[track]?.offset ?? platform.offset;
      const side = Math.sign(trackOffset - platform.offset) || 1;
      const edge = platform.offset + side * (platform.width / 2 - 0.12);
      const tactile = platform.offset + side * (platform.width / 2 - 0.55);
      addBox(
        overlay,
        stationPoint(station, 0, edge, top + 0.025),
        axes.right,
        axes.up,
        axes.forward,
        { x: 0.12, y: 0.025, z: platformHalf - 1 },
        PLATFORM_EDGE,
      );
      addBox(
        overlay,
        stationPoint(station, 0, tactile, top + 0.035),
        axes.right,
        axes.up,
        axes.forward,
        { x: 0.24, y: 0.035, z: platformHalf - 2 },
        TACTILE,
      );
    }

    buildCanopy(structure, station, platform.offset, platform.width, axes);
    buildFurniture(structure, station, platform.offset, platform.width, axes);
  }

  buildStationBuilding(structure, station, axes);
  if (station.platforms.length > 1 || !hasOuterPlatform(station)) {
    buildFootbridge(structure, station, axes);
  }
  if (station.elevated) buildElevatedSupports(structure, station, axes, groundY);
}

function buildCanopy(
  mb: MeshBuilder,
  station: Station,
  offset: number,
  width: number,
  axes: StationAxes,
): void {
  const halfLength = Math.max(14, station.length * 0.28);
  const roofY = PLATFORM_HEIGHT + 4.1;
  addBox(
    mb,
    stationPoint(station, 0, offset, roofY),
    axes.right,
    axes.up,
    axes.forward,
    { x: Math.max(1.2, width / 2 - 0.35), y: 0.16, z: halfLength },
    ROOF,
  );
  for (let along = -halfLength + 4; along <= halfLength - 4; along += 12) {
    addBox(
      mb,
      stationPoint(station, along, offset, PLATFORM_HEIGHT + 2.05),
      axes.right,
      axes.up,
      axes.forward,
      { x: 0.09, y: 2.05, z: 0.09 },
      STEEL,
    );
  }
}

function buildFurniture(
  mb: MeshBuilder,
  station: Station,
  offset: number,
  width: number,
  axes: StationAxes,
): void {
  for (const along of [-station.length * 0.18, station.length * 0.18]) {
    addBox(
      mb,
      stationPoint(station, along, offset, PLATFORM_HEIGHT + 0.45),
      axes.right,
      axes.up,
      axes.forward,
      { x: Math.min(0.7, width * 0.18), y: 0.35, z: 1.2 },
      BENCH,
    );
  }
  // Name-board body. Text is a lightweight sprite added separately.
  addBox(
    mb,
    stationPoint(station, 0, offset, PLATFORM_HEIGHT + 2.15),
    axes.right,
    axes.up,
    axes.forward,
    { x: Math.min(1.8, width * 0.38), y: 0.55, z: 0.08 },
    SIGN,
  );
}

function buildStationBuilding(mb: MeshBuilder, station: Station, axes: StationAxes): void {
  const outside = station.minOffset + 5.2;
  const along = -station.length * 0.18;
  addBox(
    mb,
    stationPoint(station, along, outside, 2.4),
    axes.right,
    axes.up,
    axes.forward,
    { x: 4.6, y: 2.4, z: 7 },
    BUILDING,
  );
  addBox(
    mb,
    stationPoint(station, along + 7.05, outside, 2.1),
    axes.right,
    axes.up,
    axes.forward,
    { x: 3.6, y: 1.15, z: 0.08 },
    WINDOW,
  );
  addBox(
    mb,
    stationPoint(station, along, outside, 5.05),
    axes.right,
    axes.up,
    axes.forward,
    { x: 5.1, y: 0.18, z: 7.5 },
    ROOF,
  );
}

function buildFootbridge(mb: MeshBuilder, station: Station, axes: StationAxes): void {
  const y = PLATFORM_HEIGHT + 5.4;
  const min = Math.min(station.minOffset + 8, ...station.platforms.map((p) => p.offset));
  const max = Math.max(station.maxOffset - 2, ...station.platforms.map((p) => p.offset));
  addBox(
    mb,
    stationPoint(station, 12, (min + max) / 2, y),
    axes.right,
    axes.up,
    axes.forward,
    { x: (max - min) / 2 + 1.2, y: 0.22, z: 1.35 },
    STEEL,
  );
  for (const platform of station.platforms) {
    // A compact stepped ramp indicates platform access without blocking the track clearance.
    for (let i = 0; i < 6; i++) {
      const t = (i + 0.5) / 6;
      addBox(
        mb,
        stationPoint(station, 12 + 9 * (t - 0.5), platform.offset, PLATFORM_HEIGHT + 0.45 + t * 4.4),
        axes.right,
        axes.up,
        axes.forward,
        { x: Math.min(1.15, platform.width * 0.3), y: 0.12, z: 0.8 },
        STEEL,
      );
    }
  }
}

function buildElevatedSupports(
  mb: MeshBuilder,
  station: Station,
  axes: StationAxes,
  groundY: (x: number, z: number) => number,
): void {
  const left = Math.min(...station.platforms.map((p) => p.offset - p.width / 2));
  const right = Math.max(...station.platforms.map((p) => p.offset + p.width / 2));
  for (let along = -station.length / 2 + 8; along <= station.length / 2 - 8; along += 20) {
    for (const across of [left + 0.5, right - 0.5]) {
      const top = station.center.y - 0.35;
      const p = stationPoint(station, along, across);
      const ground = groundY(p.x, p.z);
      const height = top - ground;
      if (height <= 0.6) continue;
      addBox(
        mb,
        new Vector3(p.x, ground + height / 2, p.z),
        axes.right,
        axes.up,
        axes.forward,
        { x: 0.34, y: height / 2, z: 0.34 },
        STEEL,
      );
    }
  }
}

function hasOuterPlatform(station: Station): boolean {
  const leftTrack = Math.min(...station.tracks.map((t) => t.offset));
  const rightTrack = Math.max(...station.tracks.map((t) => t.offset));
  return station.platforms.some((p) => p.offset < leftTrack || p.offset > rightTrack);
}

/** Browser-only station name sprites; headless geometry tests receive an empty group. */
export function createStationLabels(station: Station): Group {
  const group = new Group();
  group.name = `station-${station.id}-labels`;
  if (typeof document === 'undefined') return group;
  for (const platform of station.platforms) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.fillStyle = '#f5f7f4';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#244866';
    ctx.fillRect(0, 0, canvas.width, 14);
    ctx.fillRect(0, canvas.height - 14, canvas.width, 14);
    ctx.fillStyle = '#17222c';
    ctx.font = 'bold 56px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(station.name, canvas.width / 2, canvas.height / 2, canvas.width - 28);
    const texture = new CanvasTexture(canvas);
    texture.minFilter = LinearFilter;
    const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: true });
    const sprite = new Sprite(material);
    sprite.position.copy(stationPoint(station, 0, platform.offset, PLATFORM_HEIGHT + 2.15));
    sprite.scale.set(4.2, 1.05, 1);
    group.add(sprite);
  }
  return group;
}

/** Add a translucent-looking footprint to the normal preview mesh. */
export function buildStationPreview(mb: MeshBuilder, station: Station): void {
  const ring = stationFootprint(station, 0, station.center.y + 0.08);
  fillPolygon(mb, ring, [0.36, 0.7, 0.92]);
  for (const platform of station.platforms) {
    const axes = stationAxes(station);
    addBox(
      mb,
      stationPoint(station, 0, platform.offset, 0.18),
      axes.right,
      axes.up,
      axes.forward,
      { x: platform.width / 2, y: 0.18, z: station.length / 2 },
      PLATFORM,
    );
  }
}
