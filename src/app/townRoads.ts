import { Vector3 } from 'three';
import { getClass } from '../network/classes';
import { anchorFromNode, computePlacement, placeSegment, type Anchor } from '../network/editing';
import type { Network } from '../network/network';
import type { SegmentId } from '../network/network';
import type { Heightfield } from '../terrain/heightfield';
import type { TownPlans } from '../terrain/town/plans';
import { smoothProfile, type Waypoint } from './sketch';

/**
 * 近くの町の街路を、実際の道路として敷く。
 *
 * 100 町ぶんの街路 (約 3,000 セグメント) を一度にネットワークへ入れることは
 * できない。`rebuild()` は編集のたびに全体を作り直し、交差判定は総当たりで、
 * 整地の作業配列は敷いた全セグメントを含む矩形に確保する。そこで
 * **視点の近くの町だけ**を実物にし、離れたら外す。離れた町は
 * `TownView` が描いた帯で見せる。
 *
 * 外すのは「プレイヤーが触っていない町」だけ。触られていたらそのまま残す
 * (`adopt`) — 敷いたものを勝手に消さないことの方が、予算より大事。
 */

/** 実物にする半径 [m]。 */
const PAVE_RADIUS = 900;
/** 外す半径 [m]。行き来で付いたり消えたりしないよう広く取る。 */
const RELEASE_RADIUS = 1400;
/** 同時に入れてよいセグメント数。編集 1 回の重さがここで決まる。 */
const BUDGET = 450;
/** 中心がこれだけ動くまで見直さない [m]。 */
const CENTER_STEP = 120;
/** 街路の種別。 */
const STREET_CLASS = 'road_small';
/** 街路の縦断で許す勾配。規格 (18%) よりずっと緩く通す。 */
const STREET_GRADE = 0.08;

interface Paved {
  /** プレイヤーが触ったので、もう外さない。 */
  adopted: boolean;
}

export class TownRoads {
  private readonly paved = new Map<number, Paved>();
  private centerX = Infinity;
  private centerZ = Infinity;

  constructor(
    private readonly network: Network,
    private readonly field: Heightfield,
    private readonly plans: TownPlans,
    /** 実物にした町を知らせる先 (描画の街路を止める)。 */
    private readonly onPaved: (index: number, paved: boolean) => void,
  ) {}

  /** その町は実物になっているか。 */
  isPaved(index: number): boolean {
    return this.paved.has(index);
  }

  /**
   * いま入れているセグメントの数。
   *
   * 覚えた id ではなく印で数える。街路どうしが交わると分割で id が
   * 変わるので、覚えた id の数は実際とずれる。
   */
  get count(): number {
    let total = 0;
    for (const segment of this.network.segments.values()) {
      if (segment.town !== undefined && this.paved.has(segment.town)) total++;
    }
    return total;
  }

  /** その町の印を持つセグメント。 */
  private segmentsOf(index: number): SegmentId[] {
    const ids: SegmentId[] = [];
    for (const segment of this.network.segments.values()) {
      if (segment.town === index) ids.push(segment.id);
    }
    return ids;
  }

  /**
   * 見ている点から、実物にする町を決め直す。
   * ネットワークが変わったら true (呼び側は再生成が要る)。
   */
  update(x: number, z: number): boolean {
    if (Math.abs(x - this.centerX) < CENTER_STEP && Math.abs(z - this.centerZ) < CENTER_STEP) {
      return false;
    }
    this.centerX = x;
    this.centerZ = z;
    let changed = false;

    // 離れた町を外す。触られていたら残す。
    for (const [index, entry] of [...this.paved]) {
      const town = this.plans.towns[index];
      if (!town) continue;
      if (Math.hypot(town.x - x, town.z - z) <= RELEASE_RADIUS) continue;
      const segments = this.segmentsOf(index);
      if (entry.adopted || !this.untouched(segments)) {
        // 触られた町は、離れてもそのまま残す。
        entry.adopted = true;
        continue;
      }
      for (const id of segments) this.network.removeSegment(id);
      this.paved.delete(index);
      this.onPaved(index, false);
      changed = true;
    }

    // 近い順に実物にする。
    const near: { index: number; distance: number }[] = [];
    for (let i = 0; i < this.plans.towns.length; i++) {
      if (this.paved.has(i)) continue;
      const town = this.plans.towns[i];
      const distance = Math.hypot(town.x - x, town.z - z);
      if (distance <= PAVE_RADIUS) near.push({ index: i, distance });
    }
    near.sort((a, b) => a.distance - b.distance);
    for (const { index } of near) {
      const plan = this.plans.at(index);
      if (!plan) continue;
      // 予算に入らない町は描いたままにする。
      if (this.count + estimate(plan.streets) > BUDGET) continue;
      if (this.pave(index) === 0) continue;
      this.paved.set(index, { adopted: false });
      this.onPaved(index, true);
      changed = true;
    }
    return changed;
  }

  /** ネットワークを空にしたときなど、覚えている分を捨てる。 */
  reset(): void {
    for (const index of this.paved.keys()) this.onPaved(index, false);
    this.paved.clear();
    this.centerX = Infinity;
    this.centerZ = Infinity;
  }

  /**
   * その町の街路に、プレイヤーの手が入っていないか。
   *
   * 端点に印のない線形が繋がっていたら「触られた」と見る。繋ぐ・
   * 突き当てる・交差させる — 敷設ツールの操作はどれもこの形になる。
   */
  private untouched(segments: SegmentId[]): boolean {
    const owned = new Set(segments);
    for (const id of segments) {
      const segment = this.network.segments.get(id);
      if (!segment) continue;
      for (const nodeId of [segment.a, segment.b]) {
        const node = this.network.nodes.get(nodeId);
        if (!node) return false;
        for (const other of node.segments) if (!owned.has(other)) return false;
      }
    }
    return true;
  }

  /** 町 1 つぶんの街路を敷く。入れたセグメントの数を返す。 */
  private pave(index: number): number {
    const plan = this.plans.at(index);
    if (!plan) return 0;
    const cls = getClass(STREET_CLASS);
    let placed = 0;
    // 幹線から敷く。予算で切られても骨格は残る。
    const streets = [...plan.streets].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'collector' ? -1 : 1));
    for (const street of streets) {
      const waypoints: Waypoint[] = street.points.map((p) => ({ x: p.x, z: p.z }));
      const profile = smoothProfile(this.field, waypoints, STREET_CLASS, {
        passes: 3,
        lift: 0,
        grade: STREET_GRADE,
      });
      for (let i = 0; i + 1 < profile.length; i++) {
        const a = this.anchorAt(profile[i], cls);
        const b = this.anchorAt(profile[i + 1], cls);
        if (a.node !== undefined && a.node === b.node) continue;
        const preview = computePlacement(a, b, { straight: true, cls });
        placeSegment(this.network, STREET_CLASS, a, b, preview, index);
        placed++;
      }
    }
    return placed;
  }

  /**
   * 経由点の接続先。
   *
   * 既にノードがあればそこへ繋ぐ。街路の折れ線は格子点だけを通るので、
   * 縦横の街路はここで同じノードを共有し、交差点になる。
   */
  private anchorAt(point: Waypoint, cls: ReturnType<typeof getClass>): Anchor {
    const pos = new Vector3(point.x, point.y ?? this.field.baseHeightAt(point.x, point.z), point.z);
    const node = this.network.findNodeNear(pos, 3);
    return node ? anchorFromNode(this.network, node, cls) : { pos };
  }
}

/** その町を敷くと増えるセグメントの見込み。交差点での分割を見込んで少し多めに。 */
function estimate(streets: { points: unknown[] }[]): number {
  let spans = 0;
  for (const street of streets) spans += Math.max(0, street.points.length - 1);
  return Math.ceil(spans * 1.1);
}
