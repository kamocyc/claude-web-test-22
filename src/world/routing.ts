import { clamp } from '../core/units';
import type { Heightfield } from '../terrain/heightfield';

/**
 * 地形の上を「通りやすさ」で結ぶ経路探索。
 *
 * 道路は 2 点を最短で結ぶのではなく、**通りやすい所を選んで遠回りする**。
 * ここでは地形を粗い格子に落とし、格子ごとに
 *
 * - 起伏 (斜面や刻まれた谷は避ける)
 * - 水面下かどうか (橋を架けることになる)
 * - 段差 (規格の勾配を超える登り降りは切土・盛土やトンネルになる)
 *
 * を通行コストにして A* で解く。さらに、**既に道が通っている所は安くする**
 * (`corridor`)。安いので後から引く道は既設路に寄ってきて、峠道や渡河点に
 * 道が束ねられる。都市の近くほど道が集まるのはこの働きによる。
 */

/** 経路探索の格子の 1 辺 [m]。地形格子 (4 m) より粗く、線形の刻みより細かい。 */
export const ROUTE_CELL = 32;

/** 「ふつうの起伏」の目安 [m]。1 セルの中の高低差をこれで割って重みにする。 */
const RELIEF_REFERENCE = 3;

export interface RouteFieldOptions {
  /** 水面の高さ [m]。 */
  waterLevel: number;
  cell?: number;
}

/** 通行コストの元になる、粗い地形の格子。 */
export class RouteField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly waterLevel: number;
  /** 添字 0 のセル中心のワールド座標。 */
  readonly originX: number;
  readonly originZ: number;
  /** セル中心の自然地形高さ [m]。 */
  readonly height: Float32Array;
  /** セルの中の高低差 [m]。 */
  readonly relief: Float32Array;
  /** 既設路の通っている度合い (0 = 無い、1 = 路線の真上)。 */
  readonly corridor: Float32Array;

  constructor(field: Heightfield, options: RouteFieldOptions) {
    this.cell = options.cell ?? ROUTE_CELL;
    this.waterLevel = options.waterLevel;
    const span = field.worldMax - field.worldMin;
    this.cols = Math.max(2, Math.floor(span / this.cell));
    this.rows = this.cols;
    this.originX = field.worldMin + this.cell / 2;
    this.originZ = field.worldMin + this.cell / 2;

    const n = this.cols * this.rows;
    this.height = new Float32Array(n);
    this.relief = new Float32Array(n);
    this.corridor = new Float32Array(n);

    const r = this.cell / 2;
    for (let iz = 0; iz < this.rows; iz++) {
      for (let ix = 0; ix < this.cols; ix++) {
        const x = this.worldX(ix);
        const z = this.worldZ(iz);
        const centre = field.baseHeightAt(x, z);
        let min = centre;
        let max = centre;
        for (const [dx, dz] of CORNERS) {
          const h = field.baseHeightAt(x + dx * r, z + dz * r);
          if (h < min) min = h;
          if (h > max) max = h;
        }
        const i = ix + iz * this.cols;
        this.height[i] = centre;
        this.relief[i] = max - min;
      }
    }
  }

  index(ix: number, iz: number): number {
    return ix + iz * this.cols;
  }

  worldX(ix: number): number {
    return this.originX + ix * this.cell;
  }

  worldZ(iz: number): number {
    return this.originZ + iz * this.cell;
  }

  /** ワールド座標を含むセルの添字。範囲外は端に丸める。 */
  cellOf(x: number, z: number): number {
    const ix = clamp(Math.round((x - this.originX) / this.cell), 0, this.cols - 1);
    const iz = clamp(Math.round((z - this.originZ) / this.cell), 0, this.rows - 1);
    return this.index(ix, iz);
  }

  centreOf(index: number): XZ {
    const ix = index % this.cols;
    const iz = (index - ix) / this.cols;
    return { x: this.worldX(ix), z: this.worldZ(iz) };
  }

  /**
   * 折れ線の通る所を「既設路」として記録する。
   *
   * 真上だけでなく隣のセルにも薄く広げる。格子は 32 m 刻みなので、真上
   * だけを安くすると、1 セル横にずれた経路が割引を受けられない。
   */
  markCorridor(points: readonly XZ[], strength = 1): void {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(length / (this.cell * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const ix = Math.round((x - this.originX) / this.cell);
        const iz = Math.round((z - this.originZ) / this.cell);
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const jx = ix + dx;
            const jz = iz + dz;
            if (jx < 0 || jz < 0 || jx >= this.cols || jz >= this.rows) continue;
            const value = dx === 0 && dz === 0 ? strength : strength * 0.6;
            const j = this.index(jx, jz);
            if (this.corridor[j] < value) this.corridor[j] = value;
          }
        }
      }
    }
  }

  /** その地点に既設路があるか (経路の共用を見分けるのに使う)。 */
  corridorAt(x: number, z: number): number {
    return this.corridor[this.cellOf(x, z)];
  }
}

export interface XZ {
  x: number;
  z: number;
}

const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/**
 * 隣のセルへの動き。斜め 45 度だけでは経路が階段状になるので、
 * 桂馬 (2:1) も入れて 22.5 度刻みにする。
 */
const MOVES: { dx: number; dz: number; mid: [number, number][] }[] = buildMoves();

function buildMoves(): { dx: number; dz: number; mid: [number, number][] }[] {
  const out: { dx: number; dz: number; mid: [number, number][] }[] = [];
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (dx === 0 && dz === 0) continue;
      if (gcd(Math.abs(dx), Math.abs(dz)) !== 1) continue;
      // 桂馬跳びは間のセルを跨ぐ。川や尾根を「跳び越して」ただで渡らない
      // よう、通過するセルもコストに数える。
      const mid: [number, number][] = [];
      if (Math.abs(dx) === 2) mid.push([dx / 2, 0], [dx / 2, dz]);
      else if (Math.abs(dz) === 2) mid.push([0, dz / 2], [dx, dz / 2]);
      out.push({ dx, dz, mid });
    }
  }
  return out;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export interface RouteOptions {
  /** 種別の最大縦断勾配。これを超える段差は強く嫌う。 */
  maxGrade: number;
  /** 起伏を嫌う強さ。 */
  reliefWeight?: number;
  /** 勾配を嫌う強さ。 */
  gradeWeight?: number;
  /** 規格勾配を超えた分の追加コスト。 */
  steepPenalty?: number;
  /** 水面下を通るコスト (橋)。 */
  waterPenalty?: number;
  /** 既設路に乗ったときの割引 (0〜0.8)。大きいほど道が束ねられる。 */
  corridorDiscount?: number;
}

const DEFAULTS = {
  reliefWeight: 1.6,
  gradeWeight: 2.4,
  steepPenalty: 7,
  waterPenalty: 2.5,
  corridorDiscount: 0.45,
};

/**
 * 2 点を通りやすさで結ぶ。返り値はセル中心を繋いだ折れ線。
 *
 * 見つからない (格子の外) ときは null。
 */
export function findRoute(
  rf: RouteField,
  from: XZ,
  to: XZ,
  options: RouteOptions,
): XZ[] | null {
  const opts = { ...DEFAULTS, ...options };
  const start = rf.cellOf(from.x, from.z);
  const goal = rf.cellOf(to.x, to.z);
  if (start === goal) return [rf.centreOf(start)];

  const n = rf.cols * rf.rows;
  const gScore = new Float32Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();

  // ヒューリスティックは「いちばん安く通れたとき」の値。割引を効かせた分だけ
  // 下げておかないと最適でない経路を返すことがある。
  const cheapest = 1 - opts.corridorDiscount;
  const goalX = goal % rf.cols;
  const goalZ = (goal - goalX) / rf.cols;
  const heuristic = (index: number): number => {
    const ix = index % rf.cols;
    const iz = (index - ix) / rf.cols;
    return Math.hypot(ix - goalX, iz - goalZ) * rf.cell * cheapest;
  };

  gScore[start] = 0;
  heap.push(start, heuristic(start));

  while (heap.size > 0) {
    const current = heap.pop();
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goal) return tracePath(rf, cameFrom, goal);

    const ix = current % rf.cols;
    const iz = (current - ix) / rf.cols;
    for (const move of MOVES) {
      const jx = ix + move.dx;
      const jz = iz + move.dz;
      if (jx < 0 || jz < 0 || jx >= rf.cols || jz >= rf.rows) continue;
      const next = rf.index(jx, jz);
      if (closed[next]) continue;

      const dist = Math.hypot(move.dx, move.dz) * rf.cell;
      // 通るセル (行き先と、跨いだ途中) の平均で地形の通りにくさを見る。
      let terrain = cellCost(rf, next, opts);
      let discount = rf.corridor[next];
      for (const [mx, mz] of move.mid) {
        const m = rf.index(ix + mx, iz + mz);
        terrain += cellCost(rf, m, opts);
        discount += rf.corridor[m];
      }
      const count = 1 + move.mid.length;
      terrain /= count;
      discount /= count;

      const grade = Math.abs(rf.height[next] - rf.height[current]) / dist;
      const ratio = grade / opts.maxGrade;
      let climb = 1 + opts.gradeWeight * ratio * ratio;
      if (ratio > 1) climb += opts.steepPenalty * (ratio - 1);

      const cost = dist * terrain * climb * (1 - opts.corridorDiscount * discount);
      const tentative = gScore[current] + cost;
      if (tentative >= gScore[next]) continue;
      gScore[next] = tentative;
      cameFrom[next] = current;
      heap.push(next, tentative + heuristic(next));
    }
  }
  return null;
}

/** そのセルを通ることの、地形としての通りにくさ (1 = 平地)。 */
function cellCost(rf: RouteField, index: number, opts: Required<RouteOptions>): number {
  let m = 1 + opts.reliefWeight * (rf.relief[index] / RELIEF_REFERENCE);
  if (rf.height[index] <= rf.waterLevel) m += opts.waterPenalty;
  return m;
}

function tracePath(rf: RouteField, cameFrom: Int32Array, goal: number): XZ[] {
  const cells: number[] = [];
  let at = goal;
  for (let guard = 0; guard < cameFrom.length + 4 && at >= 0; guard++) {
    cells.push(at);
    at = cameFrom[at];
  }
  cells.reverse();
  return cells.map((index) => rf.centreOf(index));
}

// ------------------------------------------------------------ 折れ線の整形

/**
 * 格子の経路を、道路の経由点として使える形に均す。
 *
 * 格子から出てきた折れ線は 22.5 度刻みで階段状になっている。移動平均で
 * 均してから、形の変わらない点を間引き、経由点の間隔を揃える。
 */
export function smoothRoute(
  points: readonly XZ[],
  options: { passes?: number; tolerance?: number; minSpacing?: number; maxSpacing?: number } = {},
): XZ[] {
  const passes = options.passes ?? 3;
  const tolerance = options.tolerance ?? 10;
  const minSpacing = options.minSpacing ?? 90;
  const maxSpacing = options.maxSpacing ?? 240;
  if (points.length <= 2) return points.map((p) => ({ ...p }));

  let work = points.map((p) => ({ ...p }));
  for (let pass = 0; pass < passes; pass++) {
    const next = work.map((p) => ({ ...p }));
    for (let i = 1; i + 1 < work.length; i++) {
      next[i] = {
        x: (work[i - 1].x + work[i].x * 2 + work[i + 1].x) / 4,
        z: (work[i - 1].z + work[i].z * 2 + work[i + 1].z) / 4,
      };
    }
    work = next;
  }

  const simplified = douglasPeucker(work, tolerance);
  return respace(simplified, minSpacing, maxSpacing);
}

/** 形をほとんど変えない点を間引く (Douglas–Peucker)。 */
export function douglasPeucker(points: readonly XZ[], tolerance: number): XZ[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  let worst = 0;
  let index = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i + 1 < points.length; i++) {
    const d = pointLineDistance(points[i], a, b);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tolerance) return [{ ...a }, { ...b }];
  const head = douglasPeucker(points.slice(0, index + 1), tolerance);
  const tail = douglasPeucker(points.slice(index), tolerance);
  return head.slice(0, -1).concat(tail);
}

function pointLineDistance(p: XZ, a: XZ, b: XZ): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return Math.hypot(p.x - a.x, p.z - a.z);
  return Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / length;
}

/**
 * 経由点の間隔を揃える。
 *
 * 詰まりすぎた点は落とす (短い区間が並ぶと交差点や構造物が収まらない)。
 * 空きすぎた所は割って足す (縦断が地形から浮いてしまう)。
 */
function respace(points: readonly XZ[], minSpacing: number, maxSpacing: number): XZ[] {
  const kept: XZ[] = [{ ...points[0] }];
  for (let i = 1; i + 1 < points.length; i++) {
    const last = kept[kept.length - 1];
    if (Math.hypot(points[i].x - last.x, points[i].z - last.z) < minSpacing) continue;
    kept.push({ ...points[i] });
  }
  const end = points[points.length - 1];
  // 最後の点は必ず残す。詰まっていたら手前を落として置き換える。
  while (
    kept.length > 1 &&
    Math.hypot(end.x - kept[kept.length - 1].x, end.z - kept[kept.length - 1].z) < minSpacing
  ) {
    kept.pop();
  }
  kept.push({ ...end });

  const out: XZ[] = [kept[0]];
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1];
    const b = kept[i];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const cuts = Math.ceil(span / maxSpacing);
    for (let c = 1; c <= cuts; c++) {
      const t = c / cuts;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

/** 経路探索用の二分ヒープ。 */
class MinHeap {
  private readonly ids: number[] = [];
  private readonly costs: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, cost: number): void {
    this.ids.push(id);
    this.costs.push(cost);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent] <= this.costs[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): number {
    const id = this.ids[0];
    const lastId = this.ids.pop() as number;
    const lastCost = this.costs.pop() as number;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.costs[0] = lastCost;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let small = i;
        if (left < this.ids.length && this.costs[left] < this.costs[small]) small = left;
        if (right < this.ids.length && this.costs[right] < this.costs[small]) small = right;
        if (small === i) break;
        this.swap(small, i);
        i = small;
      }
    }
    return id;
  }

  private swap(a: number, b: number): void {
    const id = this.ids[a];
    this.ids[a] = this.ids[b];
    this.ids[b] = id;
    const cost = this.costs[a];
    this.costs[a] = this.costs[b];
    this.costs[b] = cost;
  }
}
