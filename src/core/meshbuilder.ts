import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import earcut from 'earcut';

/**
 * 位置・法線・UV・頂点カラー・診断値を貯めて `BufferGeometry` に変換する
 * シンプルなビルダ。道路・線路・構造物のメッシュ生成は全てこれを通す。
 *
 * `diag` は「診断表示」用の 2 成分アトリビュートで、x に縦断勾配、
 * y に曲率半径由来の危険度を入れる。シェーダ側で色分けに使う。
 */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly colors: number[] = [];
  private readonly diag: number[] = [];
  private readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get isEmpty(): boolean {
    return this.indices.length === 0;
  }

  vertex(
    p: Vector3,
    n: Vector3,
    u: number,
    v: number,
    color: readonly [number, number, number] = WHITE,
    grade = 0,
    curveRisk = 0,
  ): number {
    this.positions.push(p.x, p.y, p.z);
    this.normals.push(n.x, n.y, n.z);
    this.uvs.push(u, v);
    this.colors.push(color[0], color[1], color[2]);
    this.diag.push(grade, curveRisk);
    return this.vertexCount - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** 4 頂点を反時計回り (a→b→c→d) で受け取り 2 三角形にする。 */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  /**
   * 2 本の頂点列を帯状に繋ぐ。`left[i]`/`right[i]` は同じ断面の 2 点。
   * 法線は各断面の情報から与える。
   */
  strip(left: number[], right: number[]): void {
    const n = Math.min(left.length, right.length);
    for (let i = 0; i + 1 < n; i++) {
      this.quad(left[i], left[i + 1], right[i + 1], right[i]);
    }
  }

  /** 別のビルダの内容を取り込む。 */
  append(other: MeshBuilder): void {
    const offset = this.vertexCount;
    pushAll(this.positions, other.positions);
    pushAll(this.normals, other.normals);
    pushAll(this.uvs, other.uvs);
    pushAll(this.colors, other.colors);
    pushAll(this.diag, other.diag);
    for (const i of other.indices) this.indices.push(i + offset);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    g.setAttribute('diag', new BufferAttribute(new Float32Array(this.diag), 2));
    g.setIndex(this.indices);
    g.computeBoundingSphere();
    return g;
  }
}

function pushAll(dst: number[], src: readonly number[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

const WHITE: readonly [number, number, number] = [1, 1, 1];
export const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);

/** XZ 平面上のリングの符号付き面積。正なら (X, Z) 平面で反時計回り。 */
export function signedAreaXZ(ring: readonly Vector3[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

/**
 * 上向きの多角形 (XZ 平面のリング) を三角形分割して積む。頂点の Y は
 * そのまま使われるので、リングの高さがそのまま面の高さになる。穴は扱わない。
 */
export function fillPolygon(
  mb: MeshBuilder,
  ring: Vector3[],
  color: readonly [number, number, number],
  uvScale = 0.1,
  grade = 0,
  /** 下向きの面にする (橋桁の底面など)。 */
  downward = false,
): void {
  if (ring.length < 3) return;
  const flat: number[] = [];
  for (const p of ring) flat.push(p.x, p.z);
  const tris = earcutXZ(flat);
  if (tris.length === 0) return;
  const base = mb.vertexCount;
  const normal = downward ? DOWN : UP;
  for (const p of ring) {
    mb.vertex(p, normal, p.x * uvScale, p.z * uvScale, color, grade, 0);
  }
  // earcut の出力はリングの巻き方向に従うため、狙った向きになるよう揃える。
  const flipAll = signedAreaXZ(ring) > 0 !== downward;
  for (let i = 0; i < tris.length; i += 3) {
    if (flipAll) mb.triangle(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
    else mb.triangle(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
  }
}

/**
 * リングを下方向に押し出して側壁 (スカート) を作る。
 * 路面の外周に付けることで、整地した地形との継ぎ目に隙間が見えなくなる。
 */
export function extrudeSkirt(
  mb: MeshBuilder,
  ring: Vector3[],
  depth: number,
  color: readonly [number, number, number],
  closed = true,
): void {
  extrudeSkirtTo(
    mb,
    ring,
    ring.map((p) => p.y - depth),
    color,
    closed,
  );
}

/** 頂点ごとに下端の高さを指定して押し出す。地面まで届かせたいときに使う。 */
export function extrudeSkirtTo(
  mb: MeshBuilder,
  ring: Vector3[],
  bottom: number[],
  color: readonly [number, number, number],
  closed = true,
  /** 辺 i を作るか (交差点の枝の口を飛ばすのに使う)。 */
  include: (i: number) => boolean = () => true,
): void {
  const n = ring.length;
  if (n < 2 || bottom.length < n) return;
  const outward = signedAreaXZ(ring) > 0 ? 1 : -1;
  const normal = new Vector3();
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    if (!include(i)) continue;
    const j = (i + 1) % n;
    const a = ring[i];
    const b = ring[j];
    normal.set((b.z - a.z) * outward, 0, -(b.x - a.x) * outward);
    if (normal.lengthSq() < 1e-12) continue;
    normal.normalize();
    const t = mb.vertexCount;
    mb.vertex(a, normal, 0, 0, color);
    mb.vertex(b, normal, 1, 0, color);
    mb.vertex(new Vector3(b.x, bottom[j], b.z), normal, 1, 1, color);
    mb.vertex(new Vector3(a.x, bottom[i], a.z), normal, 0, 1, color);
    mb.quad(t, t + 1, t + 2, t + 3);
  }
}

export function earcutXZ(flatXZ: number[]): number[] {
  return earcut(flatXZ, undefined, 2);
}

/**
 * 多角形 (リング) を塗り潰した面の高さを引く関数を作る。
 *
 * 描画とまったく同じ三角形分割を使うので、「その面より上か下か」を
 * 確実に判定できる。分割は 1 度だけ行い、あとは引くだけにする。
 * リングの外では null を返す。
 */
export function polygonHeightSampler(
  ring: readonly Vector3[],
): (x: number, z: number) => number | null {
  if (ring.length < 3) return () => null;
  const flat: number[] = [];
  for (const p of ring) flat.push(p.x, p.z);
  const tris = earcutXZ(flat);
  return (x: number, z: number): number | null => {
    for (let i = 0; i + 2 < tris.length; i += 3) {
      const y = heightInTriangleXZ(ring[tris[i]], ring[tris[i + 1]], ring[tris[i + 2]], x, z);
      if (y !== null) return y;
    }
    return null;
  };
}

/** 三角形の内側なら重心座標で高さを返す。外側なら null。 */
export function heightInTriangleXZ(
  a: Vector3,
  b: Vector3,
  c: Vector3,
  x: number,
  z: number,
): number | null {
  const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  if (Math.abs(d) < 1e-12) return null;
  const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d;
  const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d;
  const w = 1 - u - v;
  const eps = -1e-6;
  if (u < eps || v < eps || w < eps) return null;
  return u * a.y + v * b.y + w * c.y;
}
