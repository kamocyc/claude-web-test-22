import { describe, expect, it } from 'vitest';
import { TOWN_DENSITY, TOWN_MIN_SPACING } from '../src/core/units';
import { ZONE_SETBACK } from '../src/network/zoning';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { planTown, toBuildingLot } from '../src/terrain/town/layout';
import { TownPlans } from '../src/terrain/town/plans';
import { TownRoads } from '../src/app/townRoads';
import { Network } from '../src/network/network';
import { anchorFromNode, computePlacement, placeSegment } from '../src/network/editing';
import { getClass } from '../src/network/classes';
import { Vector3 } from 'three';
import { testField } from './support/field';

/**
 * 町の位置。
 *
 * 見た目ではなく「置ける所に、散らばって、決まった数だけ」置かれることを見る。
 */

function world(seed = DEFAULT_TERRAIN.seed) {
  const field = testField();
  return { field, ...generateTerrain(field, { ...DEFAULT_TERRAIN, seed }) };
}

describe('町の位置', () => {
  const { field, towns, water, hydro } = world();

  it('広さに応じた数だけ置かれる', () => {
    const extent = field.cells * field.cell;
    const expected = Math.max(1, Math.round(((extent / 1000) ** 2) * TOWN_DENSITY));
    expect(towns.length).toBe(expected);
  });

  it('水の上には置かれない', () => {
    for (const town of towns) {
      expect(water.isWater(town.x, town.z)).toBe(false);
      expect(field.baseHeightAt(town.x, town.z)).toBeGreaterThan(water.seaY);
    }
  });

  it('互いに最小間隔より離れている', () => {
    for (let i = 0; i < towns.length; i++) {
      for (let j = i + 1; j < towns.length; j++) {
        const gap = Math.hypot(towns[i].x - towns[j].x, towns[i].z - towns[j].z);
        expect(gap).toBeGreaterThanOrEqual(TOWN_MIN_SPACING);
      }
    }
  });

  it('マップの外周には置かれない', () => {
    for (const town of towns) {
      expect(field.contains(town.x, town.z)).toBe(true);
      // 水文格子で外周 3 セル (120 m) は候補から外している。
      expect(Math.min(town.x - field.worldMin, field.worldMax - town.x)).toBeGreaterThan(100);
      expect(Math.min(town.z - field.worldMin, field.worldMax - town.z)).toBeGreaterThan(100);
    }
  });

  it('適性の高い所から順に格が決まる', () => {
    const rank = { city: 0, town: 1, village: 2 };
    for (let i = 1; i < towns.length; i++) {
      // 点数の降順に並び、格もその順に落ちていく。
      expect(towns[i].score).toBeLessThanOrEqual(towns[i - 1].score);
      expect(rank[towns[i].kind]).toBeGreaterThanOrEqual(rank[towns[i - 1].kind]);
    }
    expect(towns.some((t) => t.kind === 'city')).toBe(true);
  });

  it('名前と向きと広がりを持つ', () => {
    for (const town of towns) {
      expect(town.name.length).toBeGreaterThan(0);
      expect(town.angle).toBeGreaterThanOrEqual(0);
      expect(town.angle).toBeLessThan(Math.PI / 2);
      expect(town.radiusM).toBeGreaterThan(0);
      expect(town.development).toBeGreaterThan(0);
      expect(town.development).toBeLessThanOrEqual(1);
    }
  });

  it('適性の場のいちばん良い所を外していない', () => {
    // どの町も、その水文セルの適性が候補の下限を超えている。
    for (const town of towns) {
      expect(hydro.suitability[town.cell]).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('同じシードなら同じ町になる', () => {
    const again = world();
    expect(again.towns.map((t) => `${t.name}@${t.x},${t.z}`)).toEqual(
      towns.map((t) => `${t.name}@${t.x},${t.z}`),
    );
  });

  it('シードが違えば違う町になる', () => {
    const other = world(DEFAULT_TERRAIN.seed + 1);
    expect(other.towns.map((t) => `${t.x},${t.z}`)).not.toEqual(towns.map((t) => `${t.x},${t.z}`));
  });
});

describe('町の街路と敷地', () => {
  const { field, towns, water } = world();
  const plans = towns.map((town) => planTown(town, field));

  it('街路と敷地ができる', () => {
    const streets = plans.reduce((n, p) => n + p.streets.length, 0);
    const lots = plans.reduce((n, p) => n + p.lots.length, 0);
    expect(streets).toBeGreaterThan(0);
    expect(lots).toBeGreaterThan(0);
    // どの街路も 2 点以上で、最小の長さを超えている。
    for (const plan of plans) {
      for (const street of plan.streets) {
        expect(street.points.length).toBeGreaterThanOrEqual(2);
        let length = 0;
        for (let i = 1; i < street.points.length; i++) {
          length += Math.hypot(
            street.points[i].x - street.points[i - 1].x,
            street.points[i].z - street.points[i - 1].z,
          );
        }
        expect(length).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it('同じ町なら同じ街路になる (整地の影響を受けない)', () => {
    for (const town of towns) {
      const again = planTown(town, field);
      const before = plans[towns.indexOf(town)];
      expect(again.streets.map((s) => s.points.map((p) => `${p.x},${p.z}`).join(' '))).toEqual(
        before.streets.map((s) => s.points.map((p) => `${p.x},${p.z}`).join(' ')),
      );
      expect(again.lots.length).toBe(before.lots.length);
    }
  });

  it('街路も敷地も水の上に来ない', () => {
    for (const plan of plans) {
      for (const street of plan.streets) {
        for (const p of street.points) {
          expect(field.contains(p.x, p.z)).toBe(true);
          expect(water.isWater(p.x, p.z)).toBe(false);
        }
      }
      for (const lot of plan.lots) {
        expect(water.isWater(lot.center.x, lot.center.z)).toBe(false);
      }
    }
  });

  it('街路の縦断が規格に収まる', () => {
    for (const plan of plans) {
      for (const street of plan.streets) {
        for (let i = 1; i < street.points.length; i++) {
          const a = street.points[i - 1];
          const b = street.points[i];
          const run = Math.hypot(b.x - a.x, b.z - a.z);
          const rise = Math.abs(field.baseHeightAt(b.x, b.z) - field.baseHeightAt(a.x, a.z));
          expect(rise / run).toBeLessThanOrEqual(0.1 + 1e-9);
        }
      }
    }
  });

  it('敷地が街路に食い込まない', () => {
    for (const plan of plans) {
      for (const lot of plan.lots) {
        for (const street of plan.streets) {
          for (let i = 0; i + 1 < street.points.length; i++) {
            const a = street.points[i];
            const b = street.points[i + 1];
            const ex = b.x - a.x;
            const ez = b.z - a.z;
            const lengthSq = ex * ex + ez * ez;
            const t = Math.max(0, Math.min(1, ((lot.center.x - a.x) * ex + (lot.center.z - a.z) * ez) / lengthSq));
            const d = Math.hypot(a.x + ex * t - lot.center.x, a.z + ez * t - lot.center.z);
            expect(d).toBeGreaterThanOrEqual(street.halfWidth + ZONE_SETBACK - 1e-9);
          }
        }
      }
    }
  });

  it('市街地の広がりに収まる', () => {
    for (const plan of plans) {
      for (const street of plan.streets) {
        for (const p of street.points) {
          expect(Math.hypot(p.x - plan.town.x, p.z - plan.town.z)).toBeLessThan(plan.extent * 1.3);
        }
      }
    }
  });

  it('高さは描くときの地形から入る', () => {
    const ground = (x: number, z: number): number => field.heightAt(x, z);
    for (const plan of plans) {
      for (const lot of plan.lots.slice(0, 20)) {
        const built = toBuildingLot(lot, ground);
        // 床は敷地の中の地形の範囲に収まり、基礎はそれより下へ届く。
        expect(built.padY).toBeGreaterThanOrEqual(built.lowY);
        expect(built.center.y).toBe(built.padY);
        expect(Number.isFinite(built.lowY)).toBe(true);
      }
    }
  });
});

describe('近くの町を実際の道路にする', () => {
  function paved() {
    const field = testField();
    const { towns } = generateTerrain(field, DEFAULT_TERRAIN);
    const plans = new TownPlans(field);
    plans.setTowns(towns);
    const network = new Network();
    const events: { index: number; paved: boolean }[] = [];
    const roads = new TownRoads(network, field, plans, (index, on) => events.push({ index, paved: on }));
    // いちばん街路の多い町を選ぶ (村だと 1 本も敷けないことがある)。
    let best = 0;
    for (let i = 0; i < towns.length; i++) {
      if ((plans.at(i)?.streets.length ?? 0) > (plans.at(best)?.streets.length ?? 0)) best = i;
    }
    return { field, towns, plans, network, roads, events, index: best };
  }

  it('町の上に来ると街路が実際の道路になる', () => {
    const { towns, network, roads, index, events } = paved();
    expect(roads.update(towns[index].x, towns[index].z)).toBe(true);
    expect(roads.isPaved(index)).toBe(true);
    expect(network.segments.size).toBeGreaterThan(0);
    expect(events).toContainEqual({ index, paved: true });
    // 敷いたものはすべて町の印を持つ。
    for (const segment of network.segments.values()) expect(segment.town).toBe(index);
  });

  it('交わる街路が同じノードを共有する (交差点になる)', () => {
    const { towns, network, roads, index, plans } = paved();
    roads.update(towns[index].x, towns[index].z);
    if ((plans.at(index)?.streets.length ?? 0) < 2) return;
    let junctions = 0;
    for (const node of network.nodes.values()) if (node.segments.length >= 3) junctions++;
    expect(junctions).toBeGreaterThan(0);
  });

  it('予算を超えない', () => {
    const { towns, roads } = paved();
    for (const town of towns) roads.update(town.x, town.z);
    expect(roads.count).toBeLessThanOrEqual(450);
  });

  it('離れると外れる', () => {
    const { towns, network, roads, index } = paved();
    roads.update(towns[index].x, towns[index].z);
    const placed = network.segments.size;
    expect(placed).toBeGreaterThan(0);
    roads.update(towns[index].x + 9000, towns[index].z + 9000);
    expect(roads.isPaved(index)).toBe(false);
    expect(network.segments.size).toBe(0);
  });

  it('街路どうしの交差で分割されても、印は引き継がれる', () => {
    const { network, towns, roads, index } = paved();
    roads.update(towns[index].x, towns[index].z);
    // 分割されたものも含めて、敷いたものはすべて印を持つ。
    for (const segment of network.segments.values()) expect(segment.town).toBe(index);
    expect(roads.count).toBe(network.segments.size);
  });

  it('プレイヤーが触った町は、離れても残る', () => {
    const { field, towns, network, roads, index } = paved();
    roads.update(towns[index].x, towns[index].z);
    const before = network.segments.size;
    // 街路の端から自分の道路を伸ばす (敷設ツールと同じ手順)。
    const node = [...network.nodes.values()][0];
    const cls = getClass('road_small');
    const start = anchorFromNode(network, node, cls);
    const to = new Vector3(node.pos.x + 40, 0, node.pos.z + 40);
    to.y = field.baseHeightAt(to.x, to.z);
    const preview = computePlacement(start, { pos: to }, { straight: true, cls });
    placeSegment(network, 'road_small', start, { pos: to }, preview);
    const touched = network.segments.size;
    expect(touched).toBeGreaterThan(before);

    roads.update(towns[index].x + 9000, towns[index].z + 9000);
    // 外さない。プレイヤーの手が入ったものを消さない方が大事。
    expect(network.segments.size).toBe(touched);
    expect(roads.isPaved(index)).toBe(true);
  });

  it('reset で覚えている分を捨てる', () => {
    const { towns, network, roads, index } = paved();
    roads.update(towns[index].x, towns[index].z);
    expect(roads.isPaved(index)).toBe(true);
    roads.reset();
    network.clear();
    expect(roads.isPaved(index)).toBe(false);
    expect(roads.count).toBe(0);
  });
});
