import { Vector3 } from 'three';
import type { MeshBuilder } from '../core/meshbuilder';
import type { RGB } from './surface';

const CORNERS: readonly [number, number, number][] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, -1, 1],
  [-1, -1, 1],
  [-1, 1, -1],
  [1, 1, -1],
  [1, 1, 1],
  [-1, 1, 1],
];

const FACES: readonly {
  idx: readonly [number, number, number, number];
  normal: readonly [number, number, number];
}[] = [
  { idx: [4, 5, 6, 7], normal: [0, 1, 0] },
  { idx: [3, 2, 1, 0], normal: [0, -1, 0] },
  { idx: [0, 1, 5, 4], normal: [0, 0, -1] },
  { idx: [2, 3, 7, 6], normal: [0, 0, 1] },
  { idx: [1, 2, 6, 5], normal: [1, 0, 0] },
  { idx: [3, 0, 4, 7], normal: [-1, 0, 0] },
];

/**
 * 任意の姿勢の直方体を積む。
 * `right`/`up`/`forward` は正規直交とみなし、`half` はそれぞれの方向の半径。
 */
export function addBox(
  mb: MeshBuilder,
  center: Vector3,
  right: Vector3,
  up: Vector3,
  forward: Vector3,
  half: { x: number; y: number; z: number },
  color: RGB,
): void {
  const p = new Vector3();
  const n = new Vector3();
  for (const face of FACES) {
    n.set(0, 0, 0)
      .addScaledVector(right, face.normal[0])
      .addScaledVector(up, face.normal[1])
      .addScaledVector(forward, face.normal[2])
      .normalize();
    const base = mb.vertexCount;
    for (const ci of face.idx) {
      const c = CORNERS[ci];
      p.copy(center)
        .addScaledVector(right, c[0] * half.x)
        .addScaledVector(up, c[1] * half.y)
        .addScaledVector(forward, c[2] * half.z);
      mb.vertex(p, n, 0, 0, color);
    }
    mb.quad(base, base + 1, base + 2, base + 3);
  }
}

/** 軸に平行な直方体。 */
export function addAxisBox(
  mb: MeshBuilder,
  center: Vector3,
  half: { x: number; y: number; z: number },
  color: RGB,
): void {
  addBox(mb, center, AXIS_X, AXIS_Y, AXIS_Z, half, color);
}

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/**
 * 2 つの断面リング (同じ頂点数) を側面で繋ぐ。
 * トンネル覆工や橋桁のように、断面が一定で経路に沿って動く形状に使う。
 */
export function addTube(
  mb: MeshBuilder,
  sections: Vector3[][],
  color: RGB,
  closeLoop = false,
): void {
  if (sections.length < 2) return;
  const rows: number[][] = [];
  const normal = new Vector3();
  const along = new Vector3();
  const across = new Vector3();

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const prevSec = sections[Math.max(0, i - 1)];
    const nextSec = sections[Math.min(sections.length - 1, i + 1)];
    const row: number[] = [];
    for (let k = 0; k < sec.length; k++) {
      along.subVectors(nextSec[k], prevSec[k]);
      if (along.lengthSq() < 1e-12) along.set(0, 0, 1);
      const kPrev = sec[Math.max(0, k - 1)];
      const kNext = sec[Math.min(sec.length - 1, k + 1)];
      across.subVectors(kNext, kPrev);
      normal.crossVectors(across, along).normalize();
      if (!Number.isFinite(normal.x)) normal.set(0, 1, 0);
      row.push(mb.vertex(sec[k], normal, k, i, color));
    }
    rows.push(row);
  }

  const count = sections[0].length;
  const last = closeLoop ? count : count - 1;
  for (let i = 0; i + 1 < rows.length; i++) {
    for (let k = 0; k < last; k++) {
      const k2 = (k + 1) % count;
      mb.quad(rows[i][k], rows[i][k2], rows[i + 1][k2], rows[i + 1][k]);
    }
  }
}
