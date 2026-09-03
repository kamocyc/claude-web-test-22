/**
 * 地形と水系の生成。
 *
 * ctest105_city_terrain_generator (master・有限マップ) の
 * `src/generator/hydrology.ts` の移植。格子の一辺を固定していた定数 `N` を
 * `HydroGrid` に置き換えたほかは、式も定数もそのままである。
 *
 * ここの定数はすべて「セル単位の距離」と「無次元の高さ」で書かれているので、
 * 1 セルの大きさ (40 m) を変えると意味が変わることに注意。
 */
import { DX, DY, IndexQueue, MinHeap, clamp, fbm, hash2, lerp, normalizeLand, quantile } from './grid';
import type { HydroGrid } from './grid';
import type { HydroParams } from './types';

export interface FloodResult {
  filled: Float32Array;
  parent: Int32Array;
  order: Int32Array;
}

export function makeTerrain(g: HydroGrid, p: HydroParams): Float32Array {
  const { n, len } = g;
  const span = p.span ?? 1;
  const h = new Float32Array(len);
  const plains = new Float32Array(len);
  const angle = hash2(p.seed, 11, p.seed) * Math.PI;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  // 盆地は密度で数える。広いマップに 2〜9 個では、ほとんどの所に届かない。
  const basinCount = Math.max(1, Math.round((2 + Math.round(p.basin * 7)) * span * span));
  const basins = Array.from({ length: basinCount }, (_, k) => ({
    x: (0.12 + hash2(k, 31, p.seed) * 0.76) * span,
    y: (0.12 + hash2(k, 57, p.seed) * 0.76) * span,
    r: 0.055 + hash2(k, 73, p.seed) * 0.1,
    d: (0.05 + hash2(k, 97, p.seed) * 0.12) * p.basin,
  }));

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // u, v はメートルに固定した座標 (5,120 m で 1)。cx, cy は外周の
      // フェードと盆地のためのマップ相対の座標で、こちらは常に -0.5..0.5。
      const u = (x / (n - 1)) * span;
      const v = (y / (n - 1)) * span;
      const cx = x / (n - 1) - 0.5;
      const cy = y / (n - 1) - 0.5;
      // 尾根だけ回転した座標で引くので、山脈の向きがシードごとに変わる。
      const rx = cx * ca - cy * sa;
      const ry = cx * sa + cy * ca;
      const continent =
        fbm(u * 1.45, v * 1.45, p.seed + 17, 4) * 0.46 + fbm(u * 0.55, v * 0.55, p.seed + 71, 3) * 0.28;
      const mountainMask = clamp((fbm(u * 1.8, v * 1.8, p.seed + 181, 3) + 0.18) * 1.25);
      const ridge = 1 - Math.abs(fbm(rx * 5.0, ry * 1.8, p.seed + 313, 4));
      const mountain = ridge * ridge * mountainMask * (0.12 + 0.58 * p.rugged);
      const detail = fbm(u * 7.2, v * 7.2, p.seed + 919, 5) * (0.025 + 0.12 * p.rugged);
      plains[i] = fbm(u * 2.0, v * 2.0, p.seed + 1409, 3);
      // 外周は 3.6 乗で落として海に沈める。これが「有限マップ」の作り。
      const edge = Math.pow(Math.max(Math.abs(cx), Math.abs(cy)) * 2, 3.6) * 0.24;
      h[i] = continent + mountain + detail - edge;
    }
  }

  // 盆地は自分の半径の中にしか効かない。全セル × 盆地の数だけ距離を測ると、
  // 広いマップでは盆地の数も比例して増えるので二乗で効いてくる。
  const toCell = (uv: number): number => (uv / span) * (n - 1);
  for (const basin of basins) {
    const cxc = toCell(basin.x);
    const cyc = toCell(basin.y);
    const rc = toCell(basin.r);
    const x0 = Math.max(0, Math.ceil(cxc - rc));
    const x1 = Math.min(n - 1, Math.floor(cxc + rc));
    const y0 = Math.max(0, Math.ceil(cyc - rc));
    const y1 = Math.min(n - 1, Math.floor(cyc + rc));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cxc) / rc;
        const dy = (y - cyc) / rc;
        const dd = dx * dx + dy * dy;
        if (dd < 1) h[y * n + x] -= basin.d * (1 - dd) ** 2;
      }
    }
  }

  // 平地マスク: 別の低周波の場を分位点で切り、そこだけ広い緩斜面へ寄せる。
  // 全体を平滑化するのではなく「平らな一帯」を作るための手。
  const threshold = quantile(plains, 1 - p.flat);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const plainMask = clamp((plains[i] - threshold) * 4 + 0.52);
      const broad = fbm((x / n) * 1.35 * span, (y / n) * 1.35 * span, p.seed + 17, 4) * 0.42;
      h[i] = lerp(h[i], broad, plainMask * (0.46 + p.flat * 0.34));
    }
  }
  return steepenHighGround(g, h, p);
}

/**
 * 陸の起伏のこの割合より上では、山が丘のふるまいをやめる。標高に応じた
 * 持ち上げと岩稜を足すので、勾配が頂上に向かって増していく。谷と平地は
 * 触らないので、尾根越えだけが高くつく。
 */
const ALPINE_START = 0.52;
/** 頂上に足す高さ (急峻化する前の起伏に対する割合)。 */
const ALPINE_LIFT = 0.62;
/** 岩稜の振幅。これも起伏に対する割合。 */
const CRAG_AMPLITUDE = 0.15;
/** 波長およそ 500 m。40 m 格子で尾根と谷筋に読める粗さ。 */
const CRAG_FREQUENCY = 9.5;

function steepenHighGround(g: HydroGrid, h: Float32Array, p: HydroParams): Float32Array {
  const { n, len } = g;
  const span = p.span ?? 1;
  // 順位で採るので、頂上が上がっても基準の高さが動かない。
  const shore = quantile(h, p.sea);
  let hi = -Infinity;
  for (let i = 0; i < len; i++) if (h[i] > hi) hi = h[i];
  const relief = hi - shore;
  if (!(relief > 0)) return h;
  const lift = ALPINE_LIFT * (0.3 + 0.7 * p.rugged);
  const crag = CRAG_AMPLITUDE * (0.25 + 0.75 * p.rugged);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const u = (x / (n - 1)) * span;
      const v = (y / (n - 1)) * span;
      const alpine = clamp(((h[i] - shore) / relief - ALPINE_START) / (1 - ALPINE_START));
      if (alpine <= 0) continue;
      // 2 乗。足す高さが、足される標高より速く増えるようにする。
      const shape = alpine * alpine;
      const rock = 1 - Math.abs(fbm(u * CRAG_FREQUENCY, v * CRAG_FREQUENCY, p.seed + 2711, 4));
      h[i] += relief * (lift * shape + crag * shape * (rock - 0.52));
    }
  }
  return h;
}

/** ある高さで外周から浸水させたときの海。 */
export function oceanAtLevel(
  g: HydroGrid,
  terrain: Float32Array,
  level: number,
): { sea: Uint8Array; count: number } {
  const { n, len } = g;
  const sea = new Uint8Array(len);
  const queue = new Int32Array(len);
  let head = 0;
  let tail = 0;
  const add = (i: number): void => {
    if (!sea[i] && terrain[i] <= level) {
      sea[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < n; x++) {
    add(x);
    add((n - 1) * n + x);
  }
  for (let y = 1; y < n - 1; y++) {
    add(y * n);
    add(y * n + n - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % n;
    const y = (i / n) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx >= 0 && ny >= 0 && nx < n && ny < n) add(ny * n + nx);
    }
  }
  return { sea, count: tail };
}

/**
 * 海面を決める。
 *
 * 高さの分位点ではなく**外周と繋がった水面の面積**で二分探索する。
 * こうすると内陸の窪地は海にならず、あとで湖になる。
 */
export function makeSea(g: HydroGrid, terrain: Float32Array, fraction: number): { sea: Uint8Array; level: number } {
  const { len } = g;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < len; i++) {
    if (terrain[i] < lo) lo = terrain[i];
    if (terrain[i] > hi) hi = terrain[i];
  }
  let best: Uint8Array = new Uint8Array(len);
  let bestLevel = lo;
  let bestError = Infinity;
  for (let iteration = 0; iteration < 24; iteration++) {
    const level = (lo + hi) * 0.5;
    const ocean = oceanAtLevel(g, terrain, level);
    const ratio = ocean.count / len;
    const error = Math.abs(ratio - fraction);
    if (error < bestError) {
      bestError = error;
      best = ocean.sea;
      bestLevel = level;
    }
    if (ratio < fraction) lo = level;
    else hi = level;
  }
  return { sea: best, level: bestLevel };
}

/**
 * Priority-Flood + ε (Barnes ら)。
 *
 * 窪地を埋めた面 `filled`、D8 の排水木 `parent` (最初に到達したセルへ流す)、
 * 取り出した順 `order` を一度に得る。`order` を逆にたどれば流量集積が
 * ソート無しの 1 パスで済む。種は海のセルと外周すべて。
 */
export function priorityFlood(g: HydroGrid, terrain: Float32Array, sea: Uint8Array): FloodResult {
  const { n, len } = g;
  const filled = new Float32Array(terrain);
  const parent = new Int32Array(len);
  parent.fill(-2);
  const visited = new Uint8Array(len);
  const heap = new MinHeap(Math.max(1024, n * 8));
  const order = new Int32Array(len);
  let count = 0;
  const add = (i: number): void => {
    if (visited[i]) return;
    visited[i] = 1;
    parent[i] = -1;
    heap.push(filled[i], i);
  };
  for (let i = 0; i < len; i++) if (sea[i]) add(i);
  for (let x = 0; x < n; x++) {
    add(x);
    add((n - 1) * n + x);
  }
  for (let y = 0; y < n; y++) {
    add(y * n);
    add(y * n + n - 1);
  }
  while (heap.length) {
    const i = heap.pop();
    const z = heap.lastKey;
    order[count++] = i;
    const x = i % n;
    const y = (i / n) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (visited[j]) continue;
      visited[j] = 1;
      parent[j] = i;
      if (!sea[j] && filled[j] <= z) filled[j] = z + 0.00001;
      heap.push(filled[j], j);
    }
  }
  return { filled, parent, order: count === len ? order : order.subarray(0, count) };
}

/** 上流のセル数。`order` は Priority-Flood の取り出し順なので、逆順が位相順になる。 */
export function accumulate(g: HydroGrid, parent: Int32Array, order: Int32Array, sea: Uint8Array): Float64Array {
  const acc = new Float64Array(g.len);
  for (let i = 0; i < g.len; i++) acc[i] = sea[i] ? 0 : 1;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    const p = parent[i];
    if (p >= 0) acc[p] += acc[i];
  }
  return acc;
}

/** 中心差分の傾き (高さ / セル)。 */
export function slopeAt(g: HydroGrid, h: Float32Array, x: number, y: number): number {
  const n = g.n;
  const xm = Math.max(0, x - 1);
  const xp = Math.min(n - 1, x + 1);
  const ym = Math.max(0, y - 1);
  const yp = Math.min(n - 1, y + 1);
  return Math.hypot(h[y * n + xp] - h[y * n + xm], h[yp * n + x] - h[ym * n + x]) * 0.5;
}

export function slopeMap(g: HydroGrid, h: Float32Array): Float32Array {
  const { n } = g;
  const result = new Float32Array(g.len);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) result[y * n + x] = slopeAt(g, h, x, y);
  return result;
}

/** 川と見なす流量のしきい値。対数の分位点で採るので、格子の大きさに依らない。 */
export function riverThresholdFor(g: HydroGrid, acc: Float64Array, sea: Uint8Array, density: number): number {
  if (density <= 0.005) return Infinity;
  let count = 0;
  for (let i = 0; i < g.len; i++) if (!sea[i] && acc[i] > 1) count++;
  if (count === 0) return Infinity;
  const values = new Float64Array(count);
  let k = 0;
  for (let i = 0; i < g.len; i++) if (!sea[i] && acc[i] > 1) values[k++] = Math.log1p(acc[i]);
  values.sort();
  const q = lerp(0.992, 0.94, density);
  return Math.expm1(values[Math.floor((count - 1) * q)]);
}

/** 最後の埋め立ての前に、大きな窪地を溢れ口から開削して外へ繋ぐ。 */
export function breachDepressions(
  g: HydroGrid,
  height: Float32Array,
  sea: Uint8Array,
  hydro: FloodResult,
  basinAmount: number,
): { height: Float32Array; breaches: number } {
  const { n, len } = g;
  const out = new Float32Array(height);
  const depression = new Uint8Array(len);
  const seen = new Uint8Array(len);
  const queue = new Int32Array(len);
  let breaches = 0;
  for (let i = 0; i < len; i++) if (!sea[i] && hydro.filled[i] - height[i] > 0.003) depression[i] = 1;
  for (let root = 0; root < len; root++) {
    if (!depression[root] || seen[root]) continue;
    let head = 0;
    let tail = 0;
    let deepest = root;
    let maxDepth = hydro.filled[root] - height[root];
    queue[tail++] = root;
    seen[root] = 1;
    while (head < tail) {
      const i = queue[head++];
      const depth = hydro.filled[i] - height[i];
      if (height[i] < height[deepest]) deepest = i;
      if (depth > maxDepth) maxDepth = depth;
      const x = i % n;
      const y = (i / n) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (depression[j] && !seen[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    if (tail < Math.round(18 - 10 * basinAmount) || maxDepth < 0.008) continue;
    // 最深部から排水木をたどって窪地の外へ抜け、その道筋を単調に下げる。
    const path: number[] = [];
    let current = deepest;
    let guard = 0;
    while (current >= 0 && guard++ < len) {
      path.push(current);
      const next = hydro.parent[current];
      if (next < 0) break;
      current = next;
      if (!depression[current]) {
        path.push(current);
        break;
      }
    }
    if (path.length < 2) continue;
    let z = out[path[0]];
    for (let k = 1; k < path.length; k++) {
      z -= 0.00012;
      const i = path[k];
      if (!sea[i] && out[i] > z) out[i] = z;
    }
    breaches++;
  }
  return { height: out, breaches };
}

/** 流路を横へずらして蛇行させ、その線に沿って河床を刻む。 */
export function meanderChannels(
  g: HydroGrid,
  height: Float32Array,
  sea: Uint8Array,
  hydro: FloodResult,
  acc: Float64Array,
  p: HydroParams,
): Float32Array {
  const { n, len } = g;
  const out = new Float32Array(height);
  if (p.meander <= 0.001 || p.river <= 0.005) return out;
  const threshold = riverThresholdFor(g, acc, sea, p.river);
  if (!Number.isFinite(threshold)) return out;
  const major = threshold * 1.25;
  const displacedPoint = (i: number): [number, number, number, number] => {
    const x = i % n;
    const y = (i / n) | 0;
    let downstream = i;
    let steps = 0;
    while (steps++ < 5 && hydro.parent[downstream] >= 0) downstream = hydro.parent[downstream];
    const dx = (downstream % n) - x;
    const dy = ((downstream / n) | 0) - y;
    const length = Math.hypot(dx, dy) || 1;
    // 平らな所ほど大きく振れる。急斜面の川は真っ直ぐ落ちる。
    const plainness = clamp((0.026 - slopeAt(g, height, x, y)) / 0.022);
    const discharge = clamp(Math.log1p(acc[i] / major) / 3.2);
    const bend = clamp(
      fbm(x / 22, y / 22, p.seed + 7717, 3) * 0.78 + fbm(x / 47, y / 47, p.seed + 17713, 2) * 0.38,
      -1,
      1,
    );
    const amplitude = p.meander * plainness * (1.8 + 10.5 * discharge);
    return [
      clamp(Math.round(x - (dy / length) * bend * amplitude), 1, n - 2),
      clamp(Math.round(y + (dx / length) * bend * amplitude), 1, n - 2),
      plainness,
      discharge,
    ];
  };
  const carveSegment = (
    a: [number, number],
    b: [number, number],
    za: number,
    zb: number,
    depth: number,
  ): void => {
    let x0 = a[0];
    let y0 = a[1];
    const x1 = b[0];
    const y1 = b[1];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let error = dx - dy;
    let step = 0;
    const total = Math.max(dx, dy) || 1;
    for (;;) {
      const i = y0 * n + x0;
      const z = lerp(za, zb, step / total) - depth;
      if (!sea[i]) {
        if (z < out[i]) out[i] = z;
        for (let k = 0; k < 8; k++) {
          const nx = x0 + DX[k];
          const ny = y0 + DY[k];
          if (nx <= 0 || ny <= 0 || nx >= n - 1 || ny >= n - 1) continue;
          const j = ny * n + nx;
          if (!sea[j] && z + depth * 0.42 < out[j]) out[j] = z + depth * 0.42;
        }
      }
      if (x0 === x1 && y0 === y1) break;
      const twice = error * 2;
      if (twice > -dy) {
        error -= dy;
        x0 += sx;
      }
      if (twice < dx) {
        error += dx;
        y0 += sy;
      }
      step++;
    }
  };
  for (let i = 0; i < len; i++) {
    const next = hydro.parent[i];
    if (next < 0 || sea[i] || sea[next] || acc[i] < major) continue;
    const a = displacedPoint(i);
    const b = displacedPoint(next);
    const influence = Math.min(a[2], b[2]);
    if (influence <= 0.03) continue;
    const depth = (0.006 + 0.04 * p.erosion) * influence * (0.5 + 0.5 * Math.max(a[3], b[3]));
    carveSegment(
      [a[0], a[1]],
      [b[0], b[1]],
      hydro.filled[i],
      Math.min(hydro.filled[i] - 0.00004, hydro.filled[next]),
      depth,
    );
  }
  return out;
}

/** 流量に応じて河床を掘り下げ、大河のまわりを氾濫原として均す。 */
export function carveAndFlatten(
  g: HydroGrid,
  height: Float32Array,
  sea: Uint8Array,
  acc: Float64Array,
  p: HydroParams,
): Float32Array {
  const { n, len } = g;
  const out = new Float32Array(height);
  const threshold = riverThresholdFor(g, acc, sea, p.river);
  if (!Number.isFinite(threshold)) return out;
  for (let i = 0; i < len; i++) {
    if (!sea[i] && acc[i] >= threshold) {
      out[i] -= (0.006 + 0.045 * p.erosion) * clamp(Math.log1p(acc[i] / threshold) / 5);
    }
  }
  const major = threshold * 5;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (sea[i] || acc[i] < major) continue;
      const strength = clamp(Math.log1p(acc[i] / major) / 4) * (0.25 + 0.55 * p.flat) * p.erosion;
      const radius = 2 + Math.floor(clamp(Math.log1p(acc[i] / major)) * 3);
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          const distance = Math.hypot(ox, oy);
          if (nx < 1 || ny < 1 || nx >= n - 1 || ny >= n - 1 || distance > radius) continue;
          const j = ny * n + nx;
          if (!sea[j]) {
            out[j] = lerp(out[j], out[i] + distance * 0.00005, (1 - distance / radius) * strength * 0.45);
          }
        }
      }
    }
  }
  return out;
}

/** 8 近傍の多始点 BFS による距離場 (セル単位、斜めも 1)。 */
export function distanceField(g: HydroGrid, mask: Uint8Array): Int16Array {
  const { n, len } = g;
  const dist = new Int16Array(len);
  dist.fill(32767);
  const queue = new IndexQueue(Math.max(1024, n * 4));
  for (let i = 0; i < len; i++) {
    if (mask[i]) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  while (queue.length) {
    const i = queue.shift();
    const x = i % n;
    const y = (i / n) | 0;
    const d = dist[i] + 1;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (d < dist[j]) {
        dist[j] = d;
        queue.push(j);
      }
    }
  }
  return dist;
}

/** 距離場と、いちばん近い始点の添字。 */
export function distanceAndNearest(g: HydroGrid, mask: Uint8Array): { dist: Int16Array; nearest: Int32Array } {
  const { n, len } = g;
  const dist = new Int16Array(len);
  dist.fill(32767);
  const nearest = new Int32Array(len);
  nearest.fill(-1);
  const queue = new IndexQueue(Math.max(1024, n * 4));
  for (let i = 0; i < len; i++) {
    if (mask[i]) {
      dist[i] = 0;
      nearest[i] = i;
      queue.push(i);
    }
  }
  while (queue.length) {
    const i = queue.shift();
    const x = i % n;
    const y = (i / n) | 0;
    const distance = dist[i] + 1;
    const source = nearest[i];
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (distance < dist[j]) {
        dist[j] = distance;
        nearest[j] = source;
        queue.push(j);
      }
    }
  }
  return { dist, nearest };
}

/** 氾濫原・自然堤防・後背湿地・河岸段丘の判定。 */
export function classifyRiverLandforms(
  g: HydroGrid,
  terrain: Float32Array,
  sea: Uint8Array,
  rivers: Uint8Array,
  acc: Float64Array,
  threshold: number,
  p: HydroParams,
): { landform: Uint8Array; riverDist: Int16Array; nearestRiver: Int32Array; riverRelief: Float32Array } {
  const { n, len } = g;
  const proximity = distanceAndNearest(g, rivers);
  const landform = new Uint8Array(len);
  const riverRelief = new Float32Array(len);
  if (!Number.isFinite(threshold)) {
    return { landform, riverDist: proximity.dist, nearestRiver: proximity.nearest, riverRelief };
  }
  for (let y = 2; y < n - 2; y++) {
    for (let x = 2; x < n - 2; x++) {
      const i = y * n + x;
      const source = proximity.nearest[i];
      const distance = proximity.dist[i];
      if (sea[i] || rivers[i] || source < 0 || distance > 18) continue;
      const power = clamp(Math.log1p(acc[source] / Math.max(1, threshold)) / 4);
      const reach = 4 + Math.round(power * 10);
      if (distance > reach) continue;
      const relief = terrain[i] - terrain[source];
      const slope = slopeAt(g, terrain, x, y);
      riverRelief[i] = relief;
      const broad = fbm(x / 19, y / 19, p.seed + 84521, 2) * 0.5 + 0.5;
      if (distance <= Math.max(2, Math.round(2 + power * 2)) && relief >= -0.002 && relief < 0.014 + power * 0.01 && slope < 0.009) landform[i] = 1;
      if (distance >= 1 && distance <= Math.max(2, Math.round(2 + power * 2.4)) && relief >= 0.004 && relief < 0.025 + power * 0.012 && slope < 0.01) landform[i] = 2;
      if (distance >= 3 && distance <= Math.max(5, Math.round(6 + power * 5)) && relief < 0.021 + power * 0.01 && slope < 0.0055 && broad < 0.66) landform[i] = 3;
      if (distance >= 4 && distance <= Math.max(8, Math.round(10 + power * 5)) && relief >= 0.02 && relief < 0.085 && slope < 0.0115) landform[i] = 4;
    }
  }
  return { landform, riverDist: proximity.dist, nearestRiver: proximity.nearest, riverRelief };
}

/** 集落 (と見本の敷設) を置くのに向いた土地の点数。 */
export function buildSuitability(
  g: HydroGrid,
  terrain: Float32Array,
  sea: Uint8Array,
  rivers: Uint8Array,
  landform: Uint8Array,
  riverDistance: Int16Array,
  p: HydroParams,
): { suitability: Float32Array; coastDistance: Int16Array; coast: Uint8Array } {
  const { n, len } = g;
  const coast = new Uint8Array(len);
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (sea[i]) continue;
      for (let k = 0; k < 8; k++) {
        if (sea[(y + DY[k]) * n + (x + DX[k])]) {
          coast[i] = 1;
          break;
        }
      }
    }
  }
  const coastDistance = distanceField(g, coast);
  const suitability = new Float32Array(len);
  const [lo, hi] = normalizeLand(terrain, sea);
  for (let y = 2; y < n - 2; y++) {
    for (let x = 2; x < n - 2; x++) {
      const i = y * n + x;
      if (sea[i] || rivers[i]) continue;
      const flat = Math.exp(-slopeAt(g, terrain, x, y) * 115);
      const rd = riverDistance[i];
      const cd = coastDistance[i];
      const riverAccess = rd < 30 ? Math.exp(-Math.pow((rd - 4) / 6, 2)) : 0;
      const coastAccess = cd < 22 ? Math.exp(-Math.pow((cd - 4) / 9, 2)) : 0;
      const elevation = clamp((terrain[i] - lo) / (hi - lo || 1));
      const lowland = 1 - clamp(Math.abs(elevation - 0.24) / 0.55);
      const edgePenalty = clamp((7 - Math.min(x, y, n - 1 - x, n - 1 - y)) / 7);
      const lf = landform[i];
      const landformBonus = lf === 2 ? 0.2 : lf === 4 ? 0.18 : lf === 1 ? -0.24 : lf === 3 ? -0.3 : 0;
      const floodPenalty = rd <= 1 ? 0.72 : rd <= 2 ? 0.18 : 0;
      suitability[i] = clamp(
        0.39 * flat +
          0.17 * riverAccess +
          0.12 * coastAccess +
          0.1 * lowland +
          0.12 * (fbm(x / 26, y / 26, p.seed + 28411, 3) * 0.5 + 0.5) +
          landformBonus -
          floodPenalty -
          0.45 * edgePenalty,
      );
    }
  }
  return { suitability, coastDistance, coast };
}

/** 埋め立てが実際の地面より上に持ち上げたセル = 溜まり水 (湖)。 */
export function findLakes(
  g: HydroGrid,
  terrain: Float32Array,
  filled: Float32Array,
  sea: Uint8Array,
  minCells = 4,
): Uint8Array {
  const { n, len } = g;
  const lake = new Uint8Array(len);
  for (let i = 0; i < len; i++) if (!sea[i] && filled[i] - terrain[i] > 0.0035) lake[i] = 1;
  const seen = new Uint8Array(len);
  const queue = new Int32Array(len);
  for (let root = 0; root < len; root++) {
    if (!lake[root] || seen[root]) continue;
    let head = 0;
    let tail = 0;
    const cells: number[] = [];
    queue[tail++] = root;
    seen[root] = 1;
    while (head < tail) {
      const i = queue[head++];
      cells.push(i);
      const x = i % n;
      const y = (i / n) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (lake[j] && !seen[j]) {
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    if (cells.length < minCells) for (const i of cells) lake[i] = 0;
  }
  return lake;
}
