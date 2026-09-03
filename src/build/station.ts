import {
  CanvasTexture,
  Group,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import type { AlignmentSample } from '../core/alignment';
import { fillPolygon, type MeshBuilder } from '../core/meshbuilder';
import { getClass } from '../network/classes';
import {
  PLATFORM_HEIGHT,
  stationOutline,
  stationPointOn,
  stationSampleAt,
  type Station,
} from '../network/station';
import { addBox } from './primitives';
import { buildRibbon, type ProfilePoint } from './surface';

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

/**
 * その位置での駅の軸。
 *
 * 駅は 1 つの向きではなく**中心線**を持つ (`Station.path`) ので、軸は場所ごとに
 * 変わる。長い帯 (ホーム・上屋の屋根) は掃引して曲げ、ベンチや柱のような短い
 * ものはその場所の軸で置いた箱のままでよい。
 */
export function stationAxes(station: Station, along = 0): StationAxes {
  const sample = stationSampleAt(station, along);
  return {
    forward: new Vector3(sample.forwardXZ.x, 0, sample.forwardXZ.y),
    right: sample.right.clone(),
    up: UP,
  };
}

export function stationPoint(station: Station, along: number, across: number, y = 0): Vector3 {
  return stationPointOn(station, along, across, y);
}

/** 敷地の外周 (中心線に沿った多角形)。整地とプレビューが使う。 */
export function stationFootprint(station: Station, margin = 0, drop = 0): Vector3[] {
  return stationOutline(station, margin, drop);
}

/** 中心線を刻んだサンプル。局所座標 `from`〜`to` の範囲を掃引するのに使う。 */
function sweepSamples(station: Station, from: number, to: number, spacing = 3): AlignmentSample[] {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / spacing));
  const out: AlignmentSample[] = [];
  for (let i = 0; i <= steps; i++) out.push(stationSampleAt(station, from + ((to - from) * i) / steps));
  return out;
}

/**
 * 断面を中心線に沿って掃引する。
 *
 * `buildRibbon` は道路の路面を作るのと同じ道具で、断面 (`offset`, `height`) の
 * 折れ線をサンプル列に沿って引き伸ばす。同じ `offset` が続けば垂直な壁、違えば
 * 床になるので、ホームの床と側面が 1 回で出る。規格 (`cls`) は診断色にしか
 * 使わないので線路のものを渡す。
 */
function sweep(
  mb: MeshBuilder,
  station: Station,
  from: number,
  to: number,
  profile: ProfilePoint[],
): void {
  buildRibbon(mb, sweepSamples(station, from, to), profile, {
    skirt: false,
    cls: getClass('rail_single'),
  });
}

/** Add platforms, station furniture, station building and elevated supports. */
export function buildStation(
  surface: MeshBuilder,
  overlay: MeshBuilder,
  structure: MeshBuilder,
  station: Station,
  groundY: (x: number, z: number) => number,
): void {
  const platformHalf = station.length / 2;
  const bottom = -0.9;
  const top = PLATFORM_HEIGHT;

  for (const platform of station.platforms) {
    // ホームは全長 80〜200 m の帯なので、1 個の箱では曲げられない。中心線に
    // 沿って断面を掃引する。断面は「左の側面 → 床 → 右の側面」。
    const left = platform.offset - platform.width / 2;
    const right = platform.offset + platform.width / 2;
    sweep(surface, station, -platformHalf, platformHalf, [
      { offset: left, height: bottom, color: PLATFORM },
      { offset: left, height: top, color: PLATFORM },
      { offset: right, height: top, color: PLATFORM },
      { offset: right, height: bottom, color: PLATFORM },
    ]);
    // 掃引は両端が開くので、端だけ薄い箱で塞ぐ。
    for (const end of [-platformHalf, platformHalf]) {
      addBox(
        surface,
        stationPoint(station, end, platform.offset, (top + bottom) / 2),
        stationAxes(station, end).right,
        UP,
        stationAxes(station, end).forward,
        { x: platform.width / 2, y: (top - bottom) / 2, z: 0.05 },
        PLATFORM,
      );
    }

    // Yellow tactile paving and a pale safety edge on every served face.
    for (const track of platform.tracks) {
      const trackOffset = station.tracks[track]?.offset ?? platform.offset;
      const side = Math.sign(trackOffset - platform.offset) || 1;
      const edge = platform.offset + side * (platform.width / 2 - 0.12);
      const tactile = platform.offset + side * (platform.width / 2 - 0.55);
      sweep(overlay, station, -(platformHalf - 1), platformHalf - 1, [
        { offset: edge - 0.12, height: top + 0.025, color: PLATFORM_EDGE },
        { offset: edge + 0.12, height: top + 0.025, color: PLATFORM_EDGE },
      ]);
      sweep(overlay, station, -(platformHalf - 2), platformHalf - 2, [
        { offset: tactile - 0.24, height: top + 0.035, color: TACTILE },
        { offset: tactile + 0.24, height: top + 0.035, color: TACTILE },
      ]);
    }

    buildCanopy(structure, station, platform.offset, platform.width);
    buildFurniture(structure, station, platform.offset, platform.width);
  }

  buildStationBuilding(structure, station);
  if (station.platforms.length > 1 || !hasOuterPlatform(station)) {
    buildFootbridge(structure, station);
  }
  if (station.elevated) buildElevatedSupports(structure, station, groundY);
}

function buildCanopy(
  mb: MeshBuilder,
  station: Station,
  offset: number,
  width: number,
): void {
  const halfLength = Math.max(14, station.length * 0.28);
  const roofY = PLATFORM_HEIGHT + 4.1;
  const half = Math.max(1.2, width / 2 - 0.35);
  // 屋根もホームと同じ長さの帯。断面を閉じて (最後に始点へ戻して) 下面も張る。
  sweep(mb, station, -halfLength, halfLength, [
    { offset: offset - half, height: roofY - 0.16, color: ROOF },
    { offset: offset - half, height: roofY + 0.16, color: ROOF },
    { offset: offset + half, height: roofY + 0.16, color: ROOF },
    { offset: offset + half, height: roofY - 0.16, color: ROOF },
    { offset: offset - half, height: roofY - 0.16, color: ROOF },
  ]);
  for (let along = -halfLength + 4; along <= halfLength - 4; along += 12) {
    const axes = stationAxes(station, along);
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
): void {
  for (const along of [-station.length * 0.18, station.length * 0.18]) {
    const axes = stationAxes(station, along);
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
  const axes = stationAxes(station, 0);
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

function buildStationBuilding(mb: MeshBuilder, station: Station): void {
  const outside = station.minOffset + 5.2;
  const along = -station.length * 0.18;
  // 駅舎は曲げない。その位置の軸で置いた 1 つの建物のまま。
  const axes = stationAxes(station, along);
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

function buildFootbridge(mb: MeshBuilder, station: Station): void {
  const y = PLATFORM_HEIGHT + 5.4;
  // 跨線橋は線路を横切る短い桁なので、その位置の軸で置いた箱でよい。
  const axes = stationAxes(station, 12);
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
      const stepAxes = stationAxes(station, 12 + 9 * (t - 0.5));
      addBox(
        mb,
        stationPoint(station, 12 + 9 * (t - 0.5), platform.offset, PLATFORM_HEIGHT + 0.45 + t * 4.4),
        stepAxes.right,
        stepAxes.up,
        stepAxes.forward,
        { x: Math.min(1.15, platform.width * 0.3), y: 0.12, z: 0.8 },
        STEEL,
      );
    }
  }
}

function buildElevatedSupports(
  mb: MeshBuilder,
  station: Station,
  groundY: (x: number, z: number) => number,
): void {
  const left = Math.min(...station.platforms.map((p) => p.offset - p.width / 2));
  const right = Math.max(...station.platforms.map((p) => p.offset + p.width / 2));
  for (let along = -station.length / 2 + 8; along <= station.length / 2 - 8; along += 20) {
    const axes = stationAxes(station, along);
    for (const across of [left + 0.5, right - 0.5]) {
      // 桁の高さは場所で変わる (勾配のある高架駅)。中心線の高さから取る。
      const top = stationSampleAt(station, along).pos.y - 0.35;
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
  fillPolygon(mb, stationFootprint(station, 0, -0.08), [0.36, 0.7, 0.92]);
  for (const platform of station.platforms) {
    const half = station.length / 2;
    sweep(mb, station, -half, half, [
      { offset: platform.offset - platform.width / 2, height: 0, color: PLATFORM },
      { offset: platform.offset - platform.width / 2, height: 0.36, color: PLATFORM },
      { offset: platform.offset + platform.width / 2, height: 0.36, color: PLATFORM },
      { offset: platform.offset + platform.width / 2, height: 0, color: PLATFORM },
    ]);
  }
}
