import { Group, Mesh, type Material } from 'three';
import { MeshBuilder } from '../core/meshbuilder';
import { addTree } from '../build/tree';
import type { Occupancy } from '../network/occupancy';
import type { Heightfield } from '../terrain/heightfield';
import type { TownPlans } from '../terrain/town/plans';
import type { Tree, VegetationField } from '../terrain/vegetation';

/**
 * 木の描画。
 *
 * `TownView` と同じ立ち位置で、`WorldBuilder.rebuild()` の**外**にいる。
 * 木は地形のものなので、地形を作り直したときだけ捨てる。編集のたびに
 * 数万本を組み直すわけにはいかない。
 *
 * 区画 1 つ = メッシュ 1 つ。フラスタムカリングが効き、粗さ (LOD) が
 * 変わった区画だけを捨てられる。
 */

/** 区画の一辺 [m]。地形チャンク (512 m) の 1/4。 */
const TILE = 256;

/**
 * ここまでは立体の木にする [m]。
 *
 * これより遠い区画は十字の板 (1 本 8 頂点) になる。境目が見えないよう、
 * 板でも樹冠の色と大きさは立体と同じものから作る。
 */
const NEAR_RADIUS = 384;

/**
 * 濃さを段で落とす距離 [m] と、その割合。
 *
 * 外へ行くほど木を間引く。ぱたりと切れると森の輪郭が直線に見えるので、
 * 3 段に分けて薄れさせる。段にしてあるのは、区画のメッシュを距離の
 * 連続値に依らせないため — カメラが動くたびに組み直さずに済む。
 */
const KEEP_RINGS: readonly { radius: number; keep: number }[] = [
  { radius: 1100, keep: 1 },
  { radius: 1600, keep: 0.66 },
  { radius: 2100, keep: 0.33 },
];

/** 中心がこれだけ動くまで見直さない [m]。 */
const CENTER_STEP = 128;

/** 1 回に組む区画の数。飛んでいる間に何枚もまとめて組むと引っ掛かる。 */
const BUILD_BUDGET = 3;

/**
 * 敷いた線形から木を退ける余裕 [m]。
 *
 * 整地は路肩から `max(GRADING_MARGIN, TERRAIN_CELL * 1.5)` = 6 m まで
 * 均すので、そこまで空ければ木が切土・盛土の上に浮かない。
 */
const TREE_CLEAR = 6;

interface Tile {
  /** 木が 1 本も無い区画は `null`。覚えておかないと毎回組み直しに来る。 */
  mesh: Mesh | null;
  /** 組んだときの粗さと間引き。変わったら組み直す。 */
  near: boolean;
  keep: number;
  /** 組んだときに避けた木の印。線形が動いたかを見るのに使う。 */
  avoided: number;
}

export class VegetationView {
  readonly group = new Group();
  private readonly tiles = new Map<string, Tile>();
  /** プレイヤーが敷いた線形。ここに掛かる木は出さない。 */
  private obstacles: Occupancy | null = null;
  private centerX = Infinity;
  private centerZ = Infinity;

  constructor(
    private readonly field: Heightfield,
    private readonly vegetation: VegetationField,
    private readonly plans: TownPlans,
    private readonly material: Material,
  ) {
    this.group.name = 'vegetation';
  }

  /** 地形を作り直したら呼ぶ。組んだものを全部捨てる。 */
  reset(): void {
    this.dispose();
    this.centerX = Infinity;
    this.centerZ = Infinity;
  }

  /** 見ている点のまわりの木を組む。毎フレーム呼んでよい。 */
  setCenter(x: number, z: number): void {
    if (!this.vegetation.ready) return;
    if (Math.abs(x - this.centerX) < CENTER_STEP && Math.abs(z - this.centerZ) < CENTER_STEP) return;
    this.centerX = x;
    this.centerZ = z;

    const outer = KEEP_RINGS[KEEP_RINGS.length - 1].radius;
    const span = Math.ceil(outer / TILE);
    const cx = Math.floor(x / TILE);
    const cz = Math.floor(z / TILE);

    /** 組みたい区画と、その粗さ。 */
    const wanted: { key: string; tx: number; tz: number; d: number; near: boolean; keep: number }[] = [];
    for (let tz = cz - span; tz <= cz + span; tz++) {
      for (let tx = cx - span; tx <= cx + span; tx++) {
        // 区画の中心までの距離で決める。
        const d = Math.hypot(tx * TILE + TILE / 2 - x, tz * TILE + TILE / 2 - z);
        const keep = keepAt(d);
        if (keep <= 0) continue;
        wanted.push({ key: `${tx},${tz}`, tx, tz, d, near: d <= NEAR_RADIUS, keep });
      }
    }

    // 範囲から出た区画と、粗さが変わった区画を捨てる。
    const keep = new Map(wanted.map((w) => [w.key, w]));
    for (const [key, tile] of [...this.tiles]) {
      const want = keep.get(key);
      if (!want || want.near !== tile.near || want.keep !== tile.keep) this.drop(key);
    }

    let budget = BUILD_BUDGET;
    // 近い順に組む。予算を使い切ったら、次に中心が動いたときに続きを組む。
    wanted.sort((a, b) => a.d - b.d);
    for (const want of wanted) {
      if (this.tiles.has(want.key)) continue;
      if (budget-- <= 0) {
        // まだ組み切れていないので、次のフレームでもう一度見に来る。
        this.centerX = Infinity;
        break;
      }
      this.build(want.key, want.tx, want.tz, want.near, want.keep);
    }
  }

  /**
   * プレイヤーが敷いた線形を知らせる。`rebuild()` のあとに呼ぶ。
   *
   * `TownView.setObstacles` と同じ手。「どの木を避けたか」を印にして持ち、
   * それが変わった区画だけを捨てる。線形の無い所では印が変わらないので、
   * 森の奥まで組み直すことはない。
   */
  setObstacles(occupancy: Occupancy | null): void {
    this.obstacles = occupancy;
    let dropped = false;
    for (const [key, tile] of [...this.tiles]) {
      const [tx, tz] = key.split(',').map(Number);
      const trees = this.treesFor(tx, tz, tile.keep);
      if (this.avoidMark(trees) === tile.avoided) continue;
      this.drop(key);
      dropped = true;
    }
    if (dropped) this.centerX = Infinity;
  }

  setUndergroundView(active: boolean): void {
    this.group.visible = !active;
  }

  dispose(): void {
    for (const key of [...this.tiles.keys()]) this.drop(key);
  }

  /** いま木を出している区画の数 (空の区画は数えない)。 */
  get tileCount(): number {
    let count = 0;
    for (const tile of this.tiles.values()) if (tile.mesh) count++;
    return count;
  }

  private drop(key: string): void {
    const tile = this.tiles.get(key);
    if (!tile) return;
    if (tile.mesh) {
      tile.mesh.geometry.dispose();
      this.group.remove(tile.mesh);
    }
    this.tiles.delete(key);
  }

  private treesFor(tx: number, tz: number, keep: number): Tree[] {
    return this.vegetation.treesIn(
      { minX: tx * TILE, minZ: tz * TILE, size: TILE },
      this.field,
      this.plans.towns,
      keep,
    );
  }

  /** その木が、プレイヤーの敷いた線形に掛かっているか。 */
  private blocked(tree: Tree): boolean {
    const occupancy = this.obstacles;
    if (!occupancy) return false;
    return !occupancy.isFree(tree.x, tree.z, { margin: TREE_CLEAR });
  }

  /** 避けた木の並びを 1 つの数にしたもの。並びが変われば必ず変わる。 */
  private avoidMark(trees: readonly Tree[]): number {
    let mark = 0;
    for (let i = 0; i < trees.length; i++) {
      if (this.blocked(trees[i])) mark = (mark * 31 + i + 1) | 0;
    }
    return mark;
  }

  private build(key: string, tx: number, tz: number, near: boolean, keep: number): void {
    const trees = this.treesFor(tx, tz, keep);
    if (trees.length === 0) {
      // 木の無い区画も覚える。覚えないと、中心が動くたびに予算を食い続ける。
      this.tiles.set(key, { mesh: null, near, keep, avoided: 0 });
      return;
    }
    const mb = new MeshBuilder();
    let avoided = 0;
    for (let i = 0; i < trees.length; i++) {
      // 敷いた線形に掛かる木は出さない。
      if (this.blocked(trees[i])) {
        avoided = (avoided * 31 + i + 1) | 0;
        continue;
      }
      addTree(mb, trees[i], near ? 'full' : 'far');
    }
    if (mb.isEmpty) {
      this.tiles.set(key, { mesh: null, near, keep, avoided });
      return;
    }
    const mesh = new Mesh(mb.build(), this.material);
    mesh.name = `trees-${key}`;
    // 近景だけ影を落とす。遠景の板が影を落とすと、影の解像度を食うだけで
    // 形も分からない。
    mesh.castShadow = near;
    mesh.receiveShadow = false;
    this.group.add(mesh);
    this.tiles.set(key, { mesh, near, keep, avoided });
  }
}

/** その距離で残す割合。範囲の外は 0。 */
function keepAt(distance: number): number {
  for (const ring of KEEP_RINGS) if (distance <= ring.radius) return ring.keep;
  return 0;
}
