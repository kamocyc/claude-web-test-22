/**
 * 幅を持つ折れ線の再標本化と平滑化。
 *
 * 移植元 (ctest105) では `src/rendering/path-geometry.ts` にあり、three.js を
 * 読むファイルに同居していた。ここで要るのは純粋な 3 関数だけなので、
 * それだけを写している。TrackBuilder の `src/core/curve.ts` はベジェと円弧で、
 * 通過点を補間する曲線は持っていない。
 */

/** 平面上の点と、そこでの幅 [m]。 */
export interface PathPoint {
  x: number;
  z: number;
  w: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 折れ線を一定間隔で取り直す。 */
export function resamplePath(points: PathPoint[], spacing: number): PathPoint[] {
  if (points.length < 2) return points;
  const distance = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    distance[i] = distance[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  const total = distance[distance.length - 1];
  if (total <= spacing) return [points[0], points[points.length - 1]];
  const segments = Math.max(1, Math.ceil(total / spacing));
  const sampled: PathPoint[] = [];
  let edge = 1;
  for (let k = 0; k <= segments; k++) {
    const target = (total * k) / segments;
    while (edge < distance.length - 1 && distance[edge] < target) edge++;
    const a = points[edge - 1];
    const b = points[edge];
    const span = distance[edge] - distance[edge - 1];
    const t = span > 1e-6 ? (target - distance[edge - 1]) / span : 0;
    sampled.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), w: lerp(a.w, b.w, t) });
  }
  return sampled;
}

/**
 * 求心 Catmull-Rom (alpha = 0.5)。
 *
 * 与えた点そのものを通り、接線が連続する。節点の間隔を弦長の平方根で採るのが
 * 肝で、一様な媒介変数だと急な曲がりで尖点や自己交差が出る。両端は動かさない。
 */
export function catmullRom(points: PathPoint[], spacing: number): PathPoint[] {
  if (points.length < 3) return points;
  const pointAt = (i: number): PathPoint => points[Math.max(0, Math.min(points.length - 1, i))];
  const out: PathPoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = pointAt(i - 1);
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = pointAt(i + 2);
    const span = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(1, Math.round(span / spacing));
    const knot = (a: PathPoint, b: PathPoint): number =>
      Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)));
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let k = 0; k < steps; k++) {
      const t = t1 + (t2 - t1) * (k / steps);
      const a1 = blend(p0, p1, t0, t1, t);
      const a2 = blend(p1, p2, t1, t2, t);
      const a3 = blend(p2, p3, t2, t3, t);
      const b1 = blend(a1, a2, t0, t2, t);
      const b2 = blend(a2, a3, t1, t3, t);
      out.push(blend(b1, b2, t1, t2, t));
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function blend(a: PathPoint, b: PathPoint, ta: number, tb: number, t: number): PathPoint {
  const span = tb - ta;
  const u = Math.abs(span) < 1e-9 ? 0 : (t - ta) / span;
  return { x: lerp(a.x, b.x, u), z: lerp(a.z, b.z, u), w: lerp(a.w, b.w, u) };
}

/**
 * 折れ線を、どの頂点も `minRadius` より急に曲がらなくなるまで緩める。
 * もとの位置から `maxDrift` 以上は離さない。
 */
export function limitCurvature(
  points: PathPoint[],
  minRadius: number,
  maxDrift: number,
  iterations = 48,
): PathPoint[] {
  if (points.length < 3) return points;
  const current = points.map((p) => ({ ...p }));
  const origin = points.map((p) => ({ x: p.x, z: p.z }));
  for (let pass = 0; pass < iterations; pass++) {
    let moved = false;
    for (let i = 1; i < current.length - 1; i++) {
      const a = current[i - 1];
      const b = current[i];
      const c = current[i + 1];
      const ab = Math.hypot(b.x - a.x, b.z - a.z);
      const bc = Math.hypot(c.x - b.x, c.z - b.z);
      const ca = Math.hypot(a.x - c.x, a.z - c.z);
      const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) * 0.5;
      // 3 点の外接円の半径。直線なら Infinity。
      const radius = area < 1e-9 ? Infinity : (ab * bc * ca) / (4 * area);
      if (radius >= minRadius) continue;
      const pull = Math.min(0.5, 0.5 * (1 - radius / minRadius));
      let nx = b.x + ((a.x + c.x) * 0.5 - b.x) * pull;
      let nz = b.z + ((a.z + c.z) * 0.5 - b.z) * pull;
      const dx = nx - origin[i].x;
      const dz = nz - origin[i].z;
      const drift = Math.hypot(dx, dz);
      if (drift > maxDrift) {
        nx = origin[i].x + (dx / drift) * maxDrift;
        nz = origin[i].z + (dz / drift) * maxDrift;
      }
      b.x = nx;
      b.z = nz;
      moved = true;
    }
    if (!moved) break;
  }
  return current;
}
