import type { Heightfield } from '../heightfield';
import { planTown, type TownPlan } from './layout';
import type { Town } from './site';

/**
 * 町ごとの街路と敷地の控え。
 *
 * 描く側 (`src/render/townView.ts`) と、実際の道路として敷く側
 * (`src/app/townRoads.ts`) が**同じ折れ線**を見るための 1 か所。
 * 別々に組むと、町に近づいた瞬間に街路が動く。
 */
export class TownPlans {
  private readonly cache = new Map<number, TownPlan>();
  private list: Town[] = [];

  constructor(private readonly field: Heightfield) {}

  /** 地形を作り直したら呼ぶ。 */
  setTowns(towns: Town[]): void {
    this.cache.clear();
    this.list = towns;
  }

  get towns(): readonly Town[] {
    return this.list;
  }

  /** その町の平面。初めて訊かれたときに組む。 */
  at(index: number): TownPlan | null {
    const town = this.list[index];
    if (!town) return null;
    let plan = this.cache.get(index);
    if (!plan) {
      plan = planTown(town, this.field);
      this.cache.set(index, plan);
    }
    return plan;
  }
}
