import { Group, Mesh, type Material } from 'three';
import { VIEW_DISTANCE } from '../core/units';
import { MeshBuilder } from '../core/meshbuilder';
import { drapedRibbon } from '../build/ribbon';
import { buildBuilding } from '../build/buildings';
import type { RGB } from '../build/surface';
import type { Network } from '../network/network';
import type { Occupancy } from '../network/occupancy';
import type { Heightfield } from '../terrain/heightfield';
import { toBuildingLot } from '../terrain/town/layout';
import type { TownPlans } from '../terrain/town/plans';

/**
 * 町の描画。
 *
 * `WaterView` と同じ立ち位置で、`WorldBuilder.rebuild()` の**外**にいる。
 * あちらは編集のたびに全建物を作り直すので、町をそこに載せると 1 万棟が
 * 毎編集で作り直される。町は地形のものなので、地形を作り直したときだけ捨てる。
 *
 * 町 1 つ = メッシュ 1 つ。フラスタムカリングが効き、実際の道路にした町を
 * 隠すのも 1 枚を外すだけで済む。
 */

/** 町を描く半径 [m]。遠クリップ面より少し内側。 */
const DRAW_RADIUS = VIEW_DISTANCE * 1.15;
/** 中心がこれだけ動くまで見直さない [m]。 */
const CENTER_STEP = 250;
/** 1 回に組む町の数。飛んでいる間に何枚もまとめて組むと引っ掛かる。 */
const BUILD_BUDGET = 2;

/** 街路の色 (舗装)。 */
const STREET_COLOR: RGB = [0.44, 0.43, 0.41];

/** 敷いた線形から建物を退ける余裕 [m]。歩道と法面のぶん。 */
const CLEAR_MARGIN = 2;

export class TownView {
  readonly group = new Group();
  private readonly meshes = new Map<number, Mesh>();
  /** 実際の道路として敷いた町。街路は実物が描くので、こちらは建物だけ出す。 */
  private readonly paved = new Set<number>();
  /** 組んだときに避けていた敷地の印。線形が動いたかを見るのに使う。 */
  private readonly avoided = new Map<number, number>();
  /** プレイヤーが敷いた線形。ここに掛かる敷地には建てない。 */
  private obstacles: Occupancy | null = null;
  private centerX = Infinity;
  private centerZ = Infinity;

  constructor(
    private readonly field: Heightfield,
    private readonly network: Network,
    private readonly plans: TownPlans,
    private readonly material: Material,
  ) {
    this.group.name = 'towns';
  }

  /** 地形を作り直したら呼ぶ。組んだものを全部捨てる。 */
  reset(): void {
    this.dispose();
    this.centerX = Infinity;
    this.centerZ = Infinity;
  }

  /**
   * その町の街路を実物が描くかどうか。
   *
   * 実際の道路として敷いた町では、描いた帯と本物の舗装が二重に出る。
   * 建物はそのまま残す — 同じ折れ線から作ってあるので、実物の道路沿いに
   * ちょうど並ぶ。
   */
  setPaved(index: number, paved: boolean): void {
    if (paved === this.paved.has(index)) return;
    if (paved) this.paved.add(index);
    else this.paved.delete(index);
    // 組み直す。次に中心を見たときに拾われる。
    this.drop(index);
    this.centerX = Infinity;
  }

  /**
   * プレイヤーが敷いた線形を知らせる。`rebuild()` のあとに呼ぶ。
   *
   * 町の建物は地形のものなので、線形を敷くたびに全部組み直すことはしない。
   * 代わりに「どの敷地を避けたか」を印にして持っておき、それが変わった町
   * だけを捨てる。線形の無い所では印が変わらないので、何も起きない。
   */
  setObstacles(occupancy: Occupancy | null): void {
    this.obstacles = occupancy;
    let dropped = false;
    for (const index of [...this.meshes.keys()]) {
      const plan = this.plans.at(index);
      if (!plan) continue;
      if (this.avoidMark(plan.lots) === this.avoided.get(index)) continue;
      this.drop(index);
      dropped = true;
    }
    // 捨てた町は、次に中心を見たときに組み直す。
    if (dropped) this.centerX = Infinity;
  }

  /** 見ている点のまわりの町を組む。毎フレーム呼んでよい。 */
  setCenter(x: number, z: number): void {
    if (Math.abs(x - this.centerX) < CENTER_STEP && Math.abs(z - this.centerZ) < CENTER_STEP) return;
    this.centerX = x;
    this.centerZ = z;

    const towns = this.plans.towns;
    const wanted: number[] = [];
    for (let i = 0; i < towns.length; i++) {
      if (Math.hypot(towns[i].x - x, towns[i].z - z) > DRAW_RADIUS) continue;
      wanted.push(i);
    }
    const keep = new Set(wanted);
    for (const index of [...this.meshes.keys()]) if (!keep.has(index)) this.drop(index);

    let budget = BUILD_BUDGET;
    // 近い順に組む。予算を使い切ったら、次に中心が動いたときに続きを組む。
    wanted.sort(
      (a, b) =>
        Math.hypot(towns[a].x - x, towns[a].z - z) - Math.hypot(towns[b].x - x, towns[b].z - z),
    );
    for (const index of wanted) {
      if (this.meshes.has(index)) continue;
      if (budget-- <= 0) {
        // まだ組み切れていないので、次のフレームでもう一度見に来る。
        this.centerX = Infinity;
        break;
      }
      this.build(index);
    }
  }

  setUndergroundView(active: boolean): void {
    this.group.visible = !active;
  }

  dispose(): void {
    for (const index of [...this.meshes.keys()]) this.drop(index);
    this.paved.clear();
    this.avoided.clear();
  }

  private drop(index: number): void {
    this.avoided.delete(index);
    const mesh = this.meshes.get(index);
    if (!mesh) return;
    mesh.geometry.dispose();
    this.group.remove(mesh);
    this.meshes.delete(index);
  }

  /**
   * その敷地が、プレイヤーの敷いた線形に掛かっているか。
   *
   * 町の街路そのものは数えない。実物にした町では自分の街路が敷地のすぐ前に
   * あるので、そこまで数えると町じゅうの建物が消えてしまう。敷地が街路に
   * 食い込まないことは区割りの側で保証している。
   */
  private blocked(lot: { center: { x: number; z: number }; halfFrontage: number; depth: number }): boolean {
    const occupancy = this.obstacles;
    if (!occupancy) return false;
    const hit = occupancy.at(lot.center.x, lot.center.z, {
      margin: Math.max(lot.halfFrontage, lot.depth / 2) + CLEAR_MARGIN,
    });
    if (!hit) return false;
    return !this.isStreet(hit.segment, hit.node);
  }

  /** その占有が町の街路のものか (交差点はそこに集まる線形で見る)。 */
  private isStreet(segment?: number, node?: number): boolean {
    if (segment !== undefined) return this.network.segments.get(segment)?.town !== undefined;
    if (node === undefined) return false;
    const n = this.network.nodes.get(node);
    if (!n || n.segments.length === 0) return false;
    return n.segments.every((id) => this.network.segments.get(id)?.town !== undefined);
  }

  /** 避けた敷地の並びを 1 つの数にしたもの。並びが変われば必ず変わる。 */
  private avoidMark(lots: readonly { center: { x: number; z: number }; halfFrontage: number; depth: number }[]): number {
    let mark = 0;
    for (let i = 0; i < lots.length; i++) {
      if (this.blocked(lots[i])) mark = (mark * 31 + i + 1) | 0;
    }
    return mark;
  }

  private build(index: number): void {
    const plan = this.plans.at(index);
    if (!plan) return;
    const field = this.field;
    const ground = (x: number, z: number): number => field.heightAt(x, z);
    const mb = new MeshBuilder();
    if (!this.paved.has(index)) {
      for (const street of plan.streets) {
        drapedRibbon(mb, street.points, street.halfWidth, ground, STREET_COLOR);
      }
    }
    let mark = 0;
    for (let i = 0; i < plan.lots.length; i++) {
      const lot = plan.lots[i];
      // プレイヤーが敷いた線形に掛かる敷地には建てない。
      if (this.blocked(lot)) {
        mark = (mark * 31 + i + 1) | 0;
        continue;
      }
      buildBuilding(mb, toBuildingLot(lot, ground), ground);
    }
    this.avoided.set(index, mark);
    if (mb.isEmpty) return;
    const mesh = new Mesh(mb.build(), this.material);
    mesh.name = `town-${plan.town.name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.meshes.set(index, mesh);
  }
}
