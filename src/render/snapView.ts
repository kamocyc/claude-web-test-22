import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector2,
  Vector3,
  type BufferGeometry,
} from 'three';
import { MeshBuilder, UP } from '../core/meshbuilder';

/**
 * スナップ位置の表示。
 *
 * どこに吸い付いているかは、線形の形からは読み取りにくい (交差点に繋がった
 * のか、1 m 手前で終わっているのか、平行に乗っているのか)。**吸い付いた点**
 * そのものを目印として描き、繋ぐ相手も一緒に光らせる。
 *
 * 地形や舗装に隠れると意味がないので、深度テストを切って常に手前に描く。
 */

export type SnapKind = 'none' | 'node' | 'segment' | 'parallel' | 'crossing';

export interface SnapMarker {
  kind: 'node' | 'segment' | 'parallel' | 'inspect' | 'crossing' | 'focus' | 'blocked';
  /** 吸い付いた点。 */
  pos: Vector3;
  /** 目印の半径 [m] (交差点なら面の広がり)。 */
  radius: number;
  /** 輪の太さ [m]。省略すると細い既定の太さ。大きな輪を目立たせるのに使う。 */
  width?: number;
  /** 取り付く相手を横切る棒の半分のベクトル (ここで分割することを示す)。 */
  bar?: Vector2;
  /** 平行スナップの基準線 (中心線をなぞる)。 */
  guide?: Vector3[];
  /** 基準線から吸い付いた点へ渡す線 (間隔が一定であることを示す)。 */
  tie?: [Vector3, Vector3];
  /** 確定済み (引き始めた点) なら控えめに描く。 */
  fixed?: boolean;
  /** 種別ごとの既定色を上書きする (確認モードで規格比の色にする)。 */
  tint?: readonly [number, number, number];
}

/** 種別ごとの色。舗装の上でも草の上でも見えるように明るくする。 */
const COLORS: Record<SnapMarker['kind'], readonly [number, number, number]> = {
  node: [0.25, 0.85, 1.0],
  segment: [1.0, 0.78, 0.28],
  parallel: [0.4, 1.0, 0.55],
  inspect: [0.85, 0.95, 1.0],
  // 踏切。遮断機と同じ赤で、繋ぐ (水色・黄) のではないことを示す。
  crossing: [1.0, 0.45, 0.38],
  // 警告から飛んできた所。敷設の目印のどれとも混ざらない色にする。
  focus: [1.0, 0.35, 0.95],
  // 敷設を止めている交差点。繋ぐ相手 (水色・黄) ではないことを赤で示す。
  blocked: [1.0, 0.2, 0.2],
};

/** 目印を浮かせる高さ [m]。 */
const LIFT = 0.3;
/** 輪の太さ [m]。 */
const RING_WIDTH = 0.7;
/** 案内線の太さ [m]。 */
const GUIDE_WIDTH = 0.5;

export class SnapView {
  readonly group = new Group();
  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;

  constructor(name = 'snap') {
    this.group.name = name;
    this.material = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    this.mesh = new Mesh(new MeshBuilder().build(), this.material);
    this.mesh.frustumCulled = false;
    // 半透明の他のものより後に描く。
    this.mesh.renderOrder = 20;
    this.group.add(this.mesh);
  }

  /** 目印を描き直す。空なら何も描かない。 */
  update(markers: readonly SnapMarker[]): void {
    const mb = new MeshBuilder();
    for (const marker of markers) addMarker(mb, marker);
    this.replace(mb.build());
  }

  private replace(geometry: BufferGeometry): void {
    const old = this.mesh.geometry;
    this.mesh.geometry = geometry;
    old.dispose();
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}

function addMarker(mb: MeshBuilder, marker: SnapMarker): void {
  const color = marker.tint ?? COLORS[marker.kind];
  const dim: [number, number, number] = [color[0] * 0.6, color[1] * 0.6, color[2] * 0.6];
  const tint = marker.fixed ? dim : color;
  const at = new Vector3(marker.pos.x, marker.pos.y + LIFT, marker.pos.z);

  if (marker.guide) addPolyline(mb, marker.guide, GUIDE_WIDTH, tint);
  if (marker.tie) addPolyline(mb, marker.tie, GUIDE_WIDTH * 0.7, tint);

  const radius = Math.max(1.5, marker.radius);
  const width = Math.max(RING_WIDTH, marker.width ?? RING_WIDTH);
  addRing(mb, at, radius, width, tint);
  // 中心の点。輪だけだと、広い交差点でどこに付くのか分かりにくい。
  // 輪を太くしたときは点も一緒に大きくする (でないと点が消えて見える)。
  const dot = Math.max(0.9, width);
  addRing(mb, at, dot, dot, tint);

  if (marker.bar && marker.bar.lengthSq() > 1e-6) {
    // 取り付く相手を横切る棒。ここで分割することを示す。
    const { x, y, z } = marker.pos;
    addPolyline(
      mb,
      [
        new Vector3(x - marker.bar.x, y, z - marker.bar.y),
        new Vector3(x + marker.bar.x, y, z + marker.bar.y),
      ],
      GUIDE_WIDTH,
      tint,
    );
  }
}

/** 水平な輪 (内外の半径差が太さ)。 */
function addRing(
  mb: MeshBuilder,
  center: Vector3,
  radius: number,
  width: number,
  color: readonly [number, number, number],
  steps = 40,
): void {
  const inner: number[] = [];
  const outer: number[] = [];
  const r0 = Math.max(0, radius - width / 2);
  const r1 = radius + width / 2;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const u = i / steps;
    inner.push(
      mb.vertex(
        new Vector3(center.x + cos * r0, center.y, center.z + sin * r0),
        UP,
        u,
        0,
        color,
      ),
    );
    outer.push(
      mb.vertex(
        new Vector3(center.x + cos * r1, center.y, center.z + sin * r1),
        UP,
        u,
        1,
        color,
      ),
    );
  }
  mb.strip(inner, outer);
}

/** 折れ線を一定の太さの帯にする。 */
function addPolyline(
  mb: MeshBuilder,
  points: readonly Vector3[],
  width: number,
  color: readonly [number, number, number],
): void {
  if (points.length < 2) return;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const nx = (-dz / length) * (width / 2);
    const nz = (dx / length) * (width / 2);
    const y = p.y + LIFT;
    left.push(mb.vertex(new Vector3(p.x + nx, y, p.z + nz), UP, 0, i, color));
    right.push(mb.vertex(new Vector3(p.x - nx, y, p.z - nz), UP, 1, i, color));
  }
  mb.strip(left, right);
}
