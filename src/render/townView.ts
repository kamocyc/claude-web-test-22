import { Group, Mesh, type Material } from 'three';
import { VIEW_DISTANCE } from '../core/units';
import { MeshBuilder } from '../core/meshbuilder';
import { drapedRibbon } from '../build/ribbon';
import { buildBuilding } from '../build/buildings';
import type { RGB } from '../build/surface';
import type { Heightfield } from '../terrain/heightfield';
import { planTown, toBuildingLot, type TownPlan } from '../terrain/town/layout';
import type { Town } from '../terrain/town/site';

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

export class TownView {
  readonly group = new Group();
  private readonly meshes = new Map<number, Mesh>();
  private readonly plans = new Map<number, TownPlan>();
  private readonly hidden = new Set<number>();
  private towns: Town[] = [];
  private centerX = Infinity;
  private centerZ = Infinity;

  constructor(
    private readonly field: Heightfield,
    private readonly material: Material,
  ) {
    this.group.name = 'towns';
  }

  /** 地形を作り直したら呼ぶ。組んだものを全部捨てる。 */
  setTowns(towns: Town[]): void {
    this.dispose();
    this.towns = towns;
    this.centerX = Infinity;
    this.centerZ = Infinity;
  }

  /** その町の平面 (街路と敷地)。実際の道路にする側もここから引く。 */
  planOf(index: number): TownPlan | null {
    const town = this.towns[index];
    if (!town) return null;
    let plan = this.plans.get(index);
    if (!plan) {
      plan = planTown(town, this.field);
      this.plans.set(index, plan);
    }
    return plan;
  }

  /**
   * その町を描かない (実際の道路として敷いたとき)。
   * 描画と実物が二重に出るのを防ぐ。
   */
  setHidden(index: number, hidden: boolean): void {
    if (hidden === this.hidden.has(index)) return;
    if (hidden) {
      this.hidden.add(index);
      this.drop(index);
    } else {
      this.hidden.delete(index);
      this.centerX = Infinity;
    }
  }

  /** 見ている点のまわりの町を組む。毎フレーム呼んでよい。 */
  setCenter(x: number, z: number): void {
    if (Math.abs(x - this.centerX) < CENTER_STEP && Math.abs(z - this.centerZ) < CENTER_STEP) return;
    this.centerX = x;
    this.centerZ = z;

    const wanted: number[] = [];
    for (let i = 0; i < this.towns.length; i++) {
      const town = this.towns[i];
      if (this.hidden.has(i)) continue;
      if (Math.hypot(town.x - x, town.z - z) > DRAW_RADIUS) continue;
      wanted.push(i);
    }
    const keep = new Set(wanted);
    for (const index of [...this.meshes.keys()]) if (!keep.has(index)) this.drop(index);

    let budget = BUILD_BUDGET;
    // 近い順に組む。予算を使い切ったら、次に中心が動いたときに続きを組む。
    wanted.sort(
      (a, b) =>
        Math.hypot(this.towns[a].x - x, this.towns[a].z - z) -
        Math.hypot(this.towns[b].x - x, this.towns[b].z - z),
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
    this.plans.clear();
    this.hidden.clear();
  }

  private drop(index: number): void {
    const mesh = this.meshes.get(index);
    if (!mesh) return;
    mesh.geometry.dispose();
    this.group.remove(mesh);
    this.meshes.delete(index);
  }

  private build(index: number): void {
    const plan = this.planOf(index);
    if (!plan) return;
    const field = this.field;
    const ground = (x: number, z: number): number => field.heightAt(x, z);
    const mb = new MeshBuilder();
    for (const street of plan.streets) {
      drapedRibbon(mb, street.points, street.halfWidth, ground, STREET_COLOR);
    }
    for (const lot of plan.lots) buildBuilding(mb, toBuildingLot(lot, ground), ground);
    if (mb.isEmpty) return;
    const mesh = new Mesh(mb.build(), this.material);
    mesh.name = `town-${plan.town.name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.meshes.set(index, mesh);
  }
}
