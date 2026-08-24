import { Vector2, Vector3 } from 'three';
import { Alignment } from '../core/alignment';
import { HorizontalCurve, perp, type XZ } from '../core/curve';
import { VerticalProfile } from '../core/profile';
import { getClass, type NetworkClass } from './classes';
import {
  planStationLayout,
  validateStationSpec,
  type Station,
  type StationId,
  type StationSpec,
} from './station';

export type NodeId = number;
export type SegmentId = number;

/**
 * 高さでの絞り込み。立体交差の上下を選り分けるのに使う。
 * `y` のまわり ±`tolerance` [m] にあるものだけを見る。
 */
export interface NearHeight {
  y: number;
  tolerance: number;
}

export interface NetNode {
  id: NodeId;
  pos: Vector3;
  /** 接続しているセグメント。 */
  segments: SegmentId[];
}

export interface NetSegment {
  id: SegmentId;
  classId: string;
  a: NodeId;
  b: NodeId;
  /** a 側のベジエ制御点 (ワールド XZ)。 */
  ctrlA: Vector2;
  /** b 側のベジエ制御点 (ワールド XZ)。 */
  ctrlB: Vector2;
  /**
   * `ctrlA` と `ctrlB` の間に入る制御点・節点 (ワールド XZ)。
   *
   * 緩和曲線のように 1 本の 3 次ベジエでは表せない線形は、連結ベジエに
   * なる。その中間の点をここに持つ。普通の線形では空 (省略)。
   */
  via?: Vector2[];
  /** a 端の縦断勾配 dy/ds。 */
  gradeA: number;
  /** b 端の縦断勾配 dy/ds。 */
  gradeB: number;
  /** Station ownership for tracks generated as part of a station. */
  stationTrack?: { station: StationId; index: number };
}

/** ノードから見た 1 本の接続枝。交差点の解析はこの形で行う。 */
export interface Branch {
  segment: SegmentId;
  /** このノードがセグメントの a 側か b 側か。 */
  atStart: boolean;
  /** ノードから外向きの単位方向 (水平)。 */
  dir: Vector2;
  /** `atan2(dir.y, dir.x)`。ソート用。 */
  angle: number;
  cls: NetworkClass;
  /** ノードから外向きに測った縦断勾配。 */
  grade: number;
  /** ノードから外向きに測った曲率 [1/m] (右カーブが正)。 */
  curvature: number;
}

/**
 * 道路・線路のネットワークを保持するグラフ。
 *
 * 幾何 (線形) はノード位置と制御点から都度導出する。編集のたびに
 * `version` が上がり、描画側はそれを見て再構築する。
 */
export class Network {
  private nextNodeId = 1;
  private nextSegmentId = 1;
  private nextStationId = 1;
  readonly nodes = new Map<NodeId, NetNode>();
  readonly segments = new Map<SegmentId, NetSegment>();
  readonly stations = new Map<StationId, Station>();
  private alignmentCache = new Map<SegmentId, Alignment>();
  version = 0;

  private touch(): void {
    this.version++;
    this.alignmentCache.clear();
  }

  addNode(pos: Vector3): NetNode {
    const node: NetNode = { id: this.nextNodeId++, pos: pos.clone(), segments: [] };
    this.nodes.set(node.id, node);
    this.touch();
    return node;
  }

  getNode(id: NodeId): NetNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  getSegment(id: SegmentId): NetSegment {
    const s = this.segments.get(id);
    if (!s) throw new Error(`unknown segment ${id}`);
    return s;
  }

  classOf(seg: NetSegment): NetworkClass {
    return getClass(seg.classId);
  }

  addSegment(params: {
    classId: string;
    a: NodeId;
    b: NodeId;
    ctrlA: Vector2;
    ctrlB: Vector2;
    via?: Vector2[];
    gradeA: number;
    gradeB: number;
    stationTrack?: { station: StationId; index: number };
  }): NetSegment {
    const seg: NetSegment = {
      id: this.nextSegmentId++,
      classId: params.classId,
      a: params.a,
      b: params.b,
      ctrlA: params.ctrlA.clone(),
      ctrlB: params.ctrlB.clone(),
      gradeA: params.gradeA,
      gradeB: params.gradeB,
      stationTrack: params.stationTrack,
    };
    if (params.via && params.via.length > 0) seg.via = params.via.map((p) => p.clone());
    this.segments.set(seg.id, seg);
    this.getNode(seg.a).segments.push(seg.id);
    this.getNode(seg.b).segments.push(seg.id);
    this.touch();
    return seg;
  }

  /**
   * セグメントの制御点・端点勾配を差し替える。
   * 端点の位置は変えないので、繋がっている相手を動かさずに線形だけ曲げられる。
   */
  updateSegment(
    id: SegmentId,
    patch: Partial<Pick<NetSegment, 'ctrlA' | 'ctrlB' | 'via' | 'gradeA' | 'gradeB'>>,
  ): void {
    const seg = this.getSegment(id);
    if (patch.ctrlA) seg.ctrlA = patch.ctrlA.clone();
    if (patch.ctrlB) seg.ctrlB = patch.ctrlB.clone();
    if (patch.via) seg.via = patch.via.length > 0 ? patch.via.map((p) => p.clone()) : undefined;
    if (patch.gradeA !== undefined) seg.gradeA = patch.gradeA;
    if (patch.gradeB !== undefined) seg.gradeB = patch.gradeB;
    this.touch();
  }

  /**
   * セグメントの向きを反転する。端点の位置も形も変わらず、a 側と b 側が
   * 入れ替わるだけ。複線を組み立てるとき、左側通行になるよう片側の線路を逆向きに
   * 敷くのに使う。
   */
  reverseSegment(id: SegmentId): void {
    const seg = this.getSegment(id);
    const a = seg.a;
    seg.a = seg.b;
    seg.b = a;
    const ctrlA = seg.ctrlA;
    seg.ctrlA = seg.ctrlB;
    seg.ctrlB = ctrlA;
    if (seg.via) seg.via = [...seg.via].reverse();
    // 弧長の向きが逆になるので、端点の勾配は入れ替えたうえで符号を反転する。
    const gradeA = seg.gradeA;
    seg.gradeA = -seg.gradeB;
    seg.gradeB = -gradeA;
    this.touch();
  }

  removeSegment(id: SegmentId): void {
    const seg = this.segments.get(id);
    if (!seg) return;
    if (seg.stationTrack) {
      this.removeStation(seg.stationTrack.station);
      return;
    }
    this.removeSegmentOnly(id);
  }

  private removeSegmentOnly(id: SegmentId): void {
    const seg = this.segments.get(id);
    if (!seg) return;
    this.segments.delete(id);
    for (const nodeId of [seg.a, seg.b]) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      node.segments = node.segments.filter((s) => s !== id);
      if (node.segments.length === 0) this.nodes.delete(nodeId);
    }
    this.touch();
  }

  /** 孤立ノードを削除する。 */
  pruneOrphanNodes(): void {
    let removed = false;
    for (const [id, node] of [...this.nodes]) {
      if (node.segments.length === 0) {
        this.nodes.delete(id);
        removed = true;
      }
    }
    if (removed) this.touch();
  }

  /** セグメントの線形 (3 次元) を返す。結果は version 単位でキャッシュされる。 */
  alignmentOf(id: SegmentId): Alignment {
    const cached = this.alignmentCache.get(id);
    if (cached) return cached;
    const seg = this.getSegment(id);
    const a = this.getNode(seg.a);
    const b = this.getNode(seg.b);
    const h = new HorizontalCurve([
      new Vector2(a.pos.x, a.pos.z),
      seg.ctrlA,
      ...(seg.via ?? []),
      seg.ctrlB,
      new Vector2(b.pos.x, b.pos.z),
    ]);
    const v = new VerticalProfile(a.pos.y, b.pos.y, seg.gradeA, seg.gradeB, h.length);
    const al = new Alignment(h, v);
    this.alignmentCache.set(id, al);
    return al;
  }

  /** ノードから外向きに見た接続枝を、方位角順 (昇順) で返す。 */
  branchesAt(nodeId: NodeId): Branch[] {
    const node = this.getNode(nodeId);
    const out: Branch[] = [];
    for (const segId of node.segments) {
      const seg = this.segments.get(segId);
      if (!seg) continue;
      const al = this.alignmentOf(segId);
      const atStart = seg.a === nodeId;
      // 自己ループは扱わない。
      if (seg.a === seg.b) continue;
      const t = atStart ? al.horizontal.tangentAt(0) : al.horizontal.tangentAt(al.length);
      const dir = atStart ? t.clone() : t.clone().negate();
      const grade = atStart ? seg.gradeA : -seg.gradeB;
      // 外向きに辿ると弧長の向きが逆になるので、曲率の符号も反転する。
      const curvature = atStart
        ? al.horizontal.curvatureAt(0)
        : -al.horizontal.curvatureAt(al.length);
      out.push({
        segment: segId,
        atStart,
        dir,
        angle: Math.atan2(dir.y, dir.x),
        cls: this.classOf(seg),
        curvature,
        grade,
      });
    }
    out.sort((p, q) => p.angle - q.angle);
    return out;
  }

  /**
   * セグメントを弧長 `s` の位置で 2 本に分割し、新しいノードを返す。
   * 分割点の位置・接線・勾配は元の線形から引き継ぐので形状は変わらない。
   */
  splitSegment(id: SegmentId, s: number): NetNode {
    const seg = this.getSegment(id);
    if (seg.stationTrack) throw new Error('駅構内の線路は分割できません');
    const al = this.alignmentOf(id);
    const L = al.length;
    const cut = Math.max(0.5, Math.min(L - 0.5, s));
    const first = al.subAlignment(0, cut);
    const second = al.subAlignment(cut, L);

    const mid = al.sampleAt(cut);
    const node = this.addNode(mid.pos);

    const classId = seg.classId;
    const a = seg.a;
    const b = seg.b;
    this.removeSegment(id);
    // removeSegment は孤立したノードを消すので、端点が生きているか確認する。
    const keepA = this.nodes.get(a) ?? this.restoreNode(a, first.horizontal.p0, first.vertical.y0);
    const keepB = this.nodes.get(b) ?? this.restoreNode(b, second.horizontal.p1, second.vertical.y1);

    this.addSegment({
      classId,
      a: keepA.id,
      b: node.id,
      ctrlA: first.horizontal.c0,
      ctrlB: first.horizontal.c1,
      via: first.horizontal.via,
      gradeA: first.vertical.m0,
      gradeB: first.vertical.m1,
    });
    this.addSegment({
      classId,
      a: node.id,
      b: keepB.id,
      ctrlA: second.horizontal.c0,
      ctrlB: second.horizontal.c1,
      via: second.horizontal.via,
      gradeA: second.vertical.m0,
      gradeB: second.vertical.m1,
    });
    return node;
  }

  /**
   * 2 つのノードを 1 つに統合する。自動交差点生成で、両方のセグメントを
   * 分割してできた 2 つのノードを 1 つにまとめるのに使う。
   */
  mergeNodes(keep: NodeId, drop: NodeId): NetNode {
    if (keep === drop) return this.getNode(keep);
    const target = this.getNode(keep);
    const source = this.nodes.get(drop);
    if (!source) return target;

    target.pos.lerp(source.pos, 0.5);
    for (const segId of source.segments) {
      const seg = this.segments.get(segId);
      if (!seg) continue;
      if (seg.a === drop) seg.a = keep;
      if (seg.b === drop) seg.b = keep;
      if (!target.segments.includes(segId)) target.segments.push(segId);
    }
    this.nodes.delete(drop);
    this.touch();
    return target;
  }

  private restoreNode(id: NodeId, xzPos: XZ, y: number): NetNode {
    const node: NetNode = { id, pos: new Vector3(xzPos.x, y, xzPos.y), segments: [] };
    this.nodes.set(id, node);
    return node;
  }

  /** 指定半径内で最も近いノードを返す。 */
  findNodeNear(point: Vector3, radius: number, height?: NearHeight): NetNode | null {
    let best: NetNode | null = null;
    let bestDist = radius * radius;
    for (const node of this.nodes.values()) {
      if (height && Math.abs(node.pos.y - height.y) > height.tolerance) continue;
      const dx = node.pos.x - point.x;
      const dz = node.pos.z - point.z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = node;
      }
    }
    return best;
  }

  /**
   * 指定半径内で最も近いセグメント上の点を返す。
   *
   * `height` を渡すと、その高さのあたりを通っている所だけを見る。
   * 立体交差では平面で見ると上下の線形が重なるので、これが無いと
   * 「地上の道を指しているのに橋に吸い付く」ことになる。
   */
  findSegmentNear(
    point: Vector3,
    radius: number,
    height?: NearHeight,
  ): { segment: SegmentId; s: number; pos: Vector3; dir: Vector2 } | null {
    let best: { segment: SegmentId; s: number; pos: Vector3; dir: Vector2 } | null = null;
    let bestDist = radius * radius;
    const p = new Vector2(point.x, point.z);
    for (const seg of this.segments.values()) {
      const al = this.alignmentOf(seg.id);
      const L = al.length;
      const steps = Math.max(4, Math.ceil(L / 2));
      let localS = 0;
      let localDist = Infinity;
      const atHeight = (s: number): boolean =>
        !height || Math.abs(al.vertical.yAt(s) - height.y) <= height.tolerance;
      for (let i = 0; i <= steps; i++) {
        const s = (i / steps) * L;
        if (!atHeight(s)) continue;
        const q = al.horizontal.pointAt(s);
        const d = q.distanceToSquared(p);
        if (d < localDist) {
          localDist = d;
          localS = s;
        }
      }
      if (localDist === Infinity) continue;
      // 2 m 刻みの粗探索だけでは、クリック位置が線路上でも最大 1 m ずれる。
      // 最良点の前後を2段階で詰め、分岐の接点を実際のマウス位置へ合わせる。
      let span = L / steps;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = -4; i <= 4; i++) {
          const s = clampStation(localS + (span * i) / 4, L);
          if (!atHeight(s)) continue;
          const d = al.horizontal.pointAt(s).distanceToSquared(p);
          if (d < localDist) {
            localDist = d;
            localS = s;
          }
        }
        span /= 4;
      }
      if (localDist < bestDist) {
        bestDist = localDist;
        const sample = al.sampleAt(localS);
        best = { segment: seg.id, s: localS, pos: sample.pos, dir: sample.forwardXZ };
      }
    }
    return best;
  }

  /** ノード位置を動かす。接続セグメントの制御点は相対関係を保って追従する。 */
  moveNode(id: NodeId, pos: Vector3): void {
    const node = this.getNode(id);
    const delta = new Vector2(pos.x - node.pos.x, pos.z - node.pos.z);
    node.pos.copy(pos);
    for (const segId of node.segments) {
      const seg = this.segments.get(segId);
      if (!seg) continue;
      if (seg.a === id) seg.ctrlA.add(delta);
      if (seg.b === id) seg.ctrlB.add(delta);
      // 中間の点は両端からの距離に応じて動かす。片端だけを動かしたときに
      // 緩和曲線が引き伸ばされるだけで済み、途中で折れない。
      if (seg.via) {
        const n = seg.via.length + 1;
        seg.via.forEach((p, i) => {
          const w = seg.a === id ? 1 - (i + 1) / n : (i + 1) / n;
          p.addScaledVector(delta, w);
        });
      }
    }
    this.touch();
  }

  /** ネットワーク全体を空にする。 */
  clear(): void {
    this.nodes.clear();
    this.segments.clear();
    this.stations.clear();
    this.nextNodeId = 1;
    this.nextSegmentId = 1;
    this.nextStationId = 1;
    this.touch();
  }

  /** Create a complete station and its independently connectable straight tracks. */
  addStation(spec: StationSpec): Station {
    const errors = validateStationSpec(spec);
    if (errors.length > 0) throw new Error(errors.join(' / '));
    const id = this.nextStationId++;
    const layout = planStationLayout(spec.trackCount, spec.platformCount);
    const forward = new Vector2(Math.cos(spec.heading), Math.sin(spec.heading));
    const right = perp(forward);
    const half = spec.length / 2;
    const tracks = layout.tracks.map((track) => {
      const center = new Vector2(spec.center.x, spec.center.z).addScaledVector(right, track.offset);
      const low = center.clone().addScaledVector(forward, -half);
      const high = center.clone().addScaledVector(forward, half);
      // 線路に向きは無いので、構内線はどれも駅の向きに揃えて敷く。
      const p0 = low;
      const p1 = high;
      const a = this.addNode(new Vector3(p0.x, spec.center.y, p0.y));
      const b = this.addNode(new Vector3(p1.x, spec.center.y, p1.y));
      const segment = this.addSegment({
        classId: 'rail_single',
        a: a.id,
        b: b.id,
        ctrlA: p0.clone().lerp(p1, 1 / 3),
        ctrlB: p0.clone().lerp(p1, 2 / 3),
        gradeA: 0,
        gradeB: 0,
        stationTrack: { station: id, index: track.index },
      });
      return { ...track, segment: segment.id };
    });
    const station: Station = {
      id,
      name: spec.name.trim(),
      center: spec.center.clone(),
      heading: spec.heading,
      length: spec.length,
      trackCount: spec.trackCount,
      platformCount: spec.platformCount,
      elevated: spec.elevated,
      tracks,
      platforms: layout.platforms,
      minOffset: layout.minOffset,
      maxOffset: layout.maxOffset,
    };
    this.stations.set(id, station);
    this.touch();
    return station;
  }

  renameStation(id: StationId, name: string): void {
    const station = this.stations.get(id);
    if (!station) throw new Error(`unknown station ${id}`);
    const next = name.trim();
    if (next.length === 0 || next.length > 40) throw new Error('駅名は1〜40文字で指定してください');
    if (station.name === next) return;
    station.name = next;
    this.touch();
  }

  removeStation(id: StationId): void {
    const station = this.stations.get(id);
    if (!station) return;
    this.stations.delete(id);
    for (const track of station.tracks) this.removeSegmentOnly(track.segment);
    this.pruneOrphanNodes();
    this.touch();
  }

  stationForSegment(id: SegmentId): Station | null {
    const ref = this.segments.get(id)?.stationTrack;
    return ref ? this.stations.get(ref.station) ?? null : null;
  }

  /** 接続枝の外向き法線 (右手側)。 */
  static branchNormal(branch: Branch): Vector2 {
    return perp(branch.dir);
  }
}

function clampStation(s: number, length: number): number {
  return s < 0 ? 0 : s > length ? length : s;
}
