import { Group, Mesh, Vector3 } from 'three';
import type { Alignment } from '../core/alignment';
import { MeshBuilder } from '../core/meshbuilder';
import { lerp, smoothstep } from '../core/units';
import {
  applyRailBlend,
  buildLevelCrossing,
  computeRailBlend,
  type GateSpec,
  type RailBlend,
  type RoadSample,
} from '../build/crossing';
import {
  buildCrossingStopLine,
  buildCrosswalk,
  buildLaneMarkings,
  buildStopLine,
  type ApproachFrame,
} from '../build/markings';
import { buildCatenary, buildTrack, buildTrackConnection } from '../build/rail';
import { buildUtilityPoles } from '../build/streetside';
import {
  alignmentSamplesInRange,
  buildBridge,
  buildTunnel,
  structureFootprintHalfWidth,
} from '../build/structures';
import {
  buildJunctionSurface,
  buildRibbon,
  gradingDrop,
  gradingEdges,
  gradingHalfWidth,
  gradingSection,
  gradingSectionPoints,
  junctionGradingDrop,
  profileFor,
} from '../build/surface';
import type { NetworkClass } from '../network/classes';
import { findCrossings, type Crossing } from '../network/crossings';
import { solveJunctions, type Approach, type Junction } from '../network/junction';
import type { Network, NodeId, SegmentId } from '../network/network';
import { Occupancy } from '../network/occupancy';
import {
  classify,
  computeStructureProfile,
  forceRunMode,
  type StructureRun,
} from '../network/structure';
import { evaluateAlignment, type SegmentDiagnostics } from '../network/validation';
import { TerrainGrading } from '../terrain/grading';
import type { Heightfield } from '../terrain/heightfield';
import type { TerrainMesh } from '../terrain/terrainMesh';
import {
  createCrossingGate,
  createSignal,
  createStopSign,
  setGateState,
  setSignalState,
  type CrossingGate,
  type SignalAssembly,
} from './props';
import {
  createOverlayMaterial,
  createPropMaterial,
  createSurfaceMaterial,
} from './materials';

export interface WorldWarning {
  message: string;
  position?: Vector3;
  severity: 'info' | 'warning' | 'error';
}

export interface WorldStats {
  segments: number;
  nodes: number;
  intersections: number;
  turnouts: number;
  levelCrossings: number;
  bridgeLength: number;
  tunnelLength: number;
  totalLength: number;
  cost: number;
}

export type PropKind = 'signal' | 'stopSign' | 'crossingGate' | 'catenaryPole' | 'utilityPole';

/** 立てた小物の足元。路上に立ててしまっていないかの検証にも使う。 */
export interface PropPlacement {
  kind: PropKind;
  position: Vector3;
  /** 起点となった線形 (あれば)。 */
  segment?: SegmentId;
}

export interface BuildResult {
  warnings: WorldWarning[];
  stats: WorldStats;
  diagnostics: Map<SegmentId, SegmentDiagnostics>;
  /** 交差点でトリムしたあとの、実際に描画された弧長範囲。 */
  ranges: Map<SegmentId, { s0: number; s1: number }>;
  /** 区間ごとの構造形式。 */
  structures: Map<SegmentId, StructureRun[]>;
  /** 立てた小物の一覧。 */
  props: PropPlacement[];
}

/** 小物を立てるときに、路面から確保する余裕 [m]。 */
const PROP_CLEARANCE = 0.35;

/**
 * ネットワーク・地形・描画を繋ぐ組み立て役。
 *
 * 依存関係が一方向に流れるよう、次の順で処理する。
 *   交差点を解く → 交差を調べる → 構造形式を決める → 整地する → メッシュを作る
 * 構造形式の判定に使うのは整地前の自然地形なので、整地が判定に影響を
 * 与えて振動する、といったことは起きない。
 */
export class WorldBuilder {
  readonly group = new Group();
  private readonly surfaceMesh: Mesh;
  private readonly overlayMesh: Mesh;
  private readonly structureMesh: Mesh;
  private readonly propGroup = new Group();
  private readonly grading: TerrainGrading;

  private signals: SignalAssembly[] = [];
  private gates: CrossingGate[] = [];
  private props: PropPlacement[] = [];
  /** 直近の rebuild で作った占有索引。小物の位置決めに使う。 */
  private occupancy!: Occupancy;

  /** 最後に解いた交差点情報。ツール側のスナップやハイライトで使う。 */
  junctions = new Map<NodeId, Junction>();
  crossings: Crossing[] = [];

  constructor(
    private readonly network: Network,
    private readonly field: Heightfield,
    private readonly terrainMesh: TerrainMesh,
  ) {
    this.group.name = 'network';
    this.grading = new TerrainGrading(field);

    this.surfaceMesh = new Mesh(new MeshBuilder().build(), createSurfaceMaterial());
    this.surfaceMesh.name = 'surfaces';
    this.surfaceMesh.receiveShadow = true;
    this.overlayMesh = new Mesh(new MeshBuilder().build(), createOverlayMaterial());
    this.overlayMesh.name = 'markings';
    this.structureMesh = new Mesh(new MeshBuilder().build(), createPropMaterial());
    this.structureMesh.name = 'structures';
    this.structureMesh.castShadow = true;
    this.structureMesh.receiveShadow = true;
    this.propGroup.name = 'props';

    this.group.add(this.surfaceMesh, this.overlayMesh, this.structureMesh, this.propGroup);
  }

  rebuild(): BuildResult {
    const network = this.network;
    const warnings: WorldWarning[] = [];

    const { junctions, trims } = solveJunctions(network);
    this.junctions = junctions;
    const crossings = findCrossings(network);
    this.crossings = crossings;

    // 踏切に合わせた線路側の高さ補正をセグメントごとにまとめる。
    const railBlends = new Map<SegmentId, RailBlend[]>();
    for (const crossing of crossings) {
      if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
      const blend = computeRailBlend(crossing, network.alignmentOf(crossing.road.segment));
      const list = railBlends.get(blend.segment) ?? [];
      list.push(blend);
      railBlends.set(blend.segment, list);
    }

    // 区間ごとの構造形式を決める。
    const ranges = new Map<SegmentId, { s0: number; s1: number }>();
    const structures = new Map<SegmentId, StructureRun[]>();
    for (const seg of network.segments.values()) {
      const alignment = network.alignmentOf(seg.id);
      const trim = trims.get(seg.id) ?? { a: 0, b: 0 };
      const range = { s0: trim.a, s1: Math.max(trim.a + 0.5, alignment.length - trim.b) };
      ranges.set(seg.id, range);
      structures.set(seg.id, computeStructureProfile(alignment, this.field, range));
    }

    // 立体交差の上側は、盛土になる高さでも橋にする。そうしないと下をくぐる
    // 線形が盛土に埋まってしまう。
    for (const crossing of crossings) {
      if (crossing.kind !== 'separated' && crossing.kind !== 'insufficient') continue;
      const lowerClass = network.classOf(network.getSegment(crossing.lower));
      this.forceBridgeAround(
        structures,
        ranges,
        crossing.upper,
        crossing.sUpper,
        lowerClass.halfWidth + 10,
      );
    }

    // 踏切のまわりの整地。舗装の下は道路側に任せ、その外側では線路の
    // 断面 (道床の法尻) へ滑らかに戻す。真下だけ譲って外は放置すると、
    // 道路と同じ高さのままの地形に道床が埋まってしまう。
    const crossingZones = new Map<SegmentId, CrossingZone[]>();
    for (const crossing of crossings) {
      if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
      const rail = crossing.rail;
      const road = crossing.road;
      const sinTheta = Math.abs(road.dir.x * rail.dir.y - road.dir.y * rail.dir.x);
      const skew = 1 / Math.max(0.26, sinTheta);
      const inner = road.cls.halfWidth * skew;
      const railSection = profileFor(rail.cls);
      const list = crossingZones.get(rail.segment) ?? [];
      list.push({
        s: rail.s,
        inner,
        shoulder: inner + CROSSING_SHOULDER_RAMP,
        outer: inner + CROSSING_SHOULDER_RAMP + CROSSING_SLOPE_RAMP,
        // 舗装の路端と同じ高さ (踏切では線路の描画高 ≒ 道路面)。
        roadOffset: -gradingDrop(road.cls),
        // 道床天端のすぐ下。ここまで下げればレールと枕木は埋まらない。
        shoulderOffset: railSection[Math.min(1, railSection.length - 1)].height - 0.06,
      });
      crossingZones.set(rail.segment, list);
    }

    this.applyGrading(junctions, structures, crossingZones, railBlends);
    this.terrainMesh.update();

    // 小物を置く前に、どこが道路・線路・交差点に覆われているかを索引にする。
    this.occupancy = new Occupancy(network, { ranges, junctions });

    const surface = new MeshBuilder();
    const overlay = new MeshBuilder();
    const structure = new MeshBuilder();
    this.clearProps();

    const stats: WorldStats = {
      segments: network.segments.size,
      nodes: network.nodes.size,
      intersections: 0,
      turnouts: 0,
      levelCrossings: 0,
      bridgeLength: 0,
      tunnelLength: 0,
      totalLength: 0,
      cost: 0,
    };
    const diagnostics = new Map<SegmentId, SegmentDiagnostics>();

    for (const seg of network.segments.values()) {
      const cls = network.classOf(seg);
      const alignment = network.alignmentOf(seg.id);
      const range = ranges.get(seg.id)!;
      const runs = structures.get(seg.id)!;
      const blends = railBlends.get(seg.id) ?? [];

      const diag = evaluateAlignment(alignment, cls);
      diagnostics.set(seg.id, diag);
      stats.totalLength += alignment.length;
      stats.cost += alignment.length * cls.costPerMeter;
      for (const message of diag.messages) {
        warnings.push({
          message,
          position: alignment.sampleAt(alignment.length / 2).pos,
          severity: 'warning',
        });
      }

      this.buildSegment(surface, structure, seg.id, alignment, cls, runs, blends, stats);
      if (cls.kind === 'road') {
        buildLaneMarkings(overlay, alignment, range, cls);
      }
    }

    for (const junction of junctions.values()) {
      this.buildJunction(surface, overlay, structure, junction, warnings, stats);
    }

    for (const crossing of crossings) {
      this.buildCrossing(overlay, crossing, warnings, stats);
    }

    this.replaceGeometry(this.surfaceMesh, surface);
    this.replaceGeometry(this.overlayMesh, overlay);
    this.replaceGeometry(this.structureMesh, structure);

    return { warnings, stats, diagnostics, ranges, structures, props: this.props };
  }

  /**
   * ある地点を中心に、前後 `span` [m] を橋にする。
   *
   * 交点がセグメントの端に近いときは、隣接するセグメントへ跨いで続ける。
   * 交点がちょうどノード上にある場合 (跨線橋の中間ノードなど) でも、
   * 下をくぐる線形の上が途切れずに橋になる。
   */
  private forceBridgeAround(
    structures: Map<SegmentId, StructureRun[]>,
    ranges: Map<SegmentId, { s0: number; s1: number }>,
    segment: SegmentId,
    station: number,
    span: number,
  ): void {
    const apply = (id: SegmentId, s0: number, s1: number): { before: number; after: number } => {
      const runs = structures.get(id);
      const range = ranges.get(id);
      if (!runs || !range) return { before: 0, after: 0 };
      const lo = Math.max(range.s0, s0);
      const hi = Math.min(range.s1, s1);
      if (hi > lo) structures.set(id, forceRunMode(runs, lo, hi, 'bridge'));
      return { before: Math.max(0, range.s0 - s0), after: Math.max(0, s1 - range.s1) };
    };

    const leftover = apply(segment, station - span, station + span);
    const seg = this.network.segments.get(segment);
    if (!seg) return;

    // 端からはみ出した分を、そのノードに繋がる同種のセグメントへ引き継ぐ。
    const spill = (nodeId: NodeId, remaining: number): void => {
      if (remaining <= 0.5) return;
      const node = this.network.nodes.get(nodeId);
      if (!node) return;
      for (const other of node.segments) {
        if (other === segment) continue;
        const otherSeg = this.network.segments.get(other);
        const range = ranges.get(other);
        if (!otherSeg || !range) continue;
        if (otherSeg.a === nodeId) apply(other, range.s0, range.s0 + remaining);
        else apply(other, range.s1 - remaining, range.s1);
      }
    };
    spill(seg.a, leftover.before);
    spill(seg.b, leftover.after);
  }

  // ---------------------------------------------------------------- 整地

  private applyGrading(
    junctions: Map<NodeId, Junction>,
    structures: Map<SegmentId, StructureRun[]>,
    /** 踏切のまわりで整地目標を道路側に寄せる範囲。 */
    crossingZones: Map<SegmentId, CrossingZone[]>,
    railBlends: Map<SegmentId, RailBlend[]>,
  ): void {
    const grading = this.grading;
    grading.reset();

    // 先に橋・トンネルの範囲で伝播を遮断し、そのあと地表区間を焼き込む。
    for (const seg of this.network.segments.values()) {
      const cls = this.network.classOf(seg);
      const alignment = this.network.alignmentOf(seg.id);
      for (const run of structures.get(seg.id) ?? []) {
        if (run.mode === 'ground') continue;
        const half = structureFootprintHalfWidth(cls, run.mode);
        const samples = alignmentSamplesInRange(alignment, run.s0, run.s1, 4);
        for (let i = 0; i + 1 < samples.length; i++) {
          const a = gradingEdges(samples[i], half, 0);
          const b = gradingEdges(samples[i + 1], half, 0);
          grading.blockQuad(a.left, b.left, b.right, a.right);
        }
      }
    }

    for (const seg of this.network.segments.values()) {
      const cls = this.network.classOf(seg);
      const alignment = this.network.alignmentOf(seg.id);
      const section = gradingSection(cls);
      const naturalDrop = gradingDrop(cls);
      const zones = crossingZones.get(seg.id) ?? [];
      const blends = railBlends.get(seg.id) ?? [];
      for (const run of structures.get(seg.id) ?? []) {
        if (run.mode !== 'ground') continue;
        // 描画と同じ高さを整地の目標にする。踏切に寄せた分を無視すると、
        // 道床が地形からわずかに浮いたり沈んだりする。
        const samples = applyRailBlend(
          alignmentSamplesInRange(alignment, run.s0, run.s1, 3),
          blends,
        );
        for (let i = 0; i + 1 < samples.length; i++) {
          const mid = (samples[i].s + samples[i + 1].s) / 2;
          const drop = crossingDrop(zones, mid, naturalDrop);
          if (drop === null) continue;
          // 踏切に寄せる分は断面全体を平行移動する。
          const shift = drop - naturalDrop;
          const a = gradingSectionPoints(samples[i], section, shift);
          const b = gradingSectionPoints(samples[i + 1], section, shift);
          for (let k = 0; k + 1 < section.length; k++) {
            grading.stampQuad(a[k], b[k], b[k + 1], a[k + 1]);
          }
        }
      }
    }

    for (const junction of junctions.values()) {
      if (junction.ring.length < 3) continue;
      const cls = junction.approaches[0]?.branch.cls;
      if (!cls) continue;
      const node = this.network.getNode(junction.node);
      const terrain = this.field.baseHeightAt(node.pos.x, node.pos.z);
      const mode = classify(node.pos.y, terrain);
      if (mode === 'ground') {
        this.stampJunction(grading, junction, cls);
      } else {
        const blocked = expandRing(junction.ring, 3);
        for (let i = 1; i + 1 < blocked.length; i++) {
          grading.block(blocked[0], blocked[i], blocked[i + 1]);
        }
      }
    }

    grading.apply();
  }

  /**
   * 交差点まわりを整地する。
   *
   * 交差点面もセグメントと同じで、断面の帯ごとに目標高さが違う。外周の
   * リングだけで平らに均すと、車道面 (縁石の分だけ低い) が地形に埋まって
   * しまい、交差点の真ん中に地面が顔を出す。リングの間を 1 段ずつ焼き込み、
   * 外周より高い所 (線路の道床など) は外周の高さで止める。
   */
  private stampJunction(grading: TerrainGrading, junction: Junction, cls: NetworkClass): void {
    const drop = junctionGradingDrop();
    const outer = junction.rings[0];
    if (!outer || outer.length < 3) return;
    const rings = junction.rings.map((ring) =>
      ring.map(
        (p, i) => new Vector3(p.x, Math.min(p.y, outer[i]?.y ?? p.y) - drop, p.z),
      ),
    );
    const bands = [expandRing(rings[0], gradingHalfWidth(cls) - cls.halfWidth), ...rings];

    for (let k = 0; k + 1 < bands.length; k++) {
      const a = bands[k];
      const b = bands[k + 1];
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        grading.stampQuad(a[i], a[j], b[j], b[i]);
      }
    }
    grading.stampPolygon(bands[bands.length - 1]);
  }

  // ------------------------------------------------------------ セグメント

  private buildSegment(
    surface: MeshBuilder,
    structure: MeshBuilder,
    segment: SegmentId,
    alignment: Alignment,
    cls: NetworkClass,
    runs: StructureRun[],
    blends: RailBlend[],
    stats: WorldStats,
  ): void {
    const profile = profileFor(cls);
    // 自分自身の上には当然乗るので、判定からは外す。
    const canPlace = (x: number, z: number): boolean =>
      this.occupancy.isFree(x, z, { exceptSegments: [segment], margin: PROP_CLEARANCE });
    let poleSerial = 0;

    for (const run of runs) {
      const raw = alignmentSamplesInRange(alignment, run.s0, run.s1, 2.5);
      if (raw.length < 2) continue;
      const samples = cls.kind === 'rail' ? applyRailBlend(raw, blends) : raw;

      buildRibbon(surface, samples, profile, { skirt: run.mode === 'ground', cls });

      if (run.mode === 'bridge') {
        stats.bridgeLength += run.s1 - run.s0;
        buildBridge(structure, samples, cls, this.field);
      } else if (run.mode === 'tunnel') {
        stats.tunnelLength += run.s1 - run.s0;
        buildTunnel(structure, samples, cls, this.field);
      }

      if (cls.kind === 'rail' && run.mode !== 'tunnel') {
        for (const base of buildCatenary(structure, samples, cls, { canPlace })) {
          this.props.push({ kind: 'catenaryPole', position: base, segment });
        }
      }

      // 電柱は地面に立てるものなので、橋・トンネルには置かない。
      if (cls.kind === 'road' && run.mode === 'ground') {
        const poles = buildUtilityPoles(structure, samples, cls, {
          canPlace,
          groundY: (x, z, surfaceY) =>
            Math.max(this.field.heightAt(x, z), surfaceY + cls.curbHeight),
          serial: poleSerial,
        });
        poleSerial += Math.max(1, Math.ceil((run.s1 - run.s0) / 38));
        for (const pole of poles) {
          this.props.push({ kind: 'utilityPole', position: pole.base, segment });
        }
      }
    }

    if (cls.kind === 'rail') {
      const first = runs[0];
      const last = runs[runs.length - 1];
      if (first && last) {
        const raw = alignmentSamplesInRange(alignment, first.s0, last.s1, 1.5);
        const samples = applyRailBlend(raw, blends);
        buildTrack(structure, samples, cls.tracks.length ? cls.tracks : [0]);
      }
    }
  }

  // -------------------------------------------------------------- 交差点

  private buildJunction(
    surface: MeshBuilder,
    overlay: MeshBuilder,
    structure: MeshBuilder,
    junction: Junction,
    warnings: WorldWarning[],
    stats: WorldStats,
  ): void {
    const node = this.network.getNode(junction.node);
    for (const message of junction.warnings) {
      warnings.push({ message, position: node.pos.clone(), severity: 'warning' });
    }

    if (junction.kind === 'intersection') stats.intersections++;
    if (junction.kind === 'railSwitch' && junction.approaches.length >= 3) stats.turnouts++;

    const cls = junction.approaches[0]?.branch.cls;
    if (!cls) return;

    buildJunctionSurface(surface, junction.rings, cls);

    if (cls.kind === 'rail') {
      for (const connection of junction.connections) {
        const from = junction.approaches.find((a) => a.branch.segment === connection.from);
        const to = junction.approaches.find((a) => a.branch.segment === connection.to);
        if (from && to) buildTrackConnection(structure, from, to, connection.through);
      }
      return;
    }

    if (junction.kind !== 'intersection' && junction.kind !== 'joint') return;

    for (const approach of junction.approaches) {
      const frame = this.approachFrame(approach);
      if (junction.kind === 'intersection') {
        buildCrosswalk(overlay, frame);
        buildStopLine(overlay, frame);
      }
    }

    if (junction.kind === 'intersection') {
      if (junction.signalized) this.placeSignals(junction);
      else this.placeStopSigns(junction);
    }
  }

  private approachFrame(approach: Approach): ApproachFrame {
    const alignment = this.network.alignmentOf(approach.branch.segment);
    return {
      alignment,
      atStart: approach.branch.atStart,
      length: alignment.length,
      trim: approach.trim,
      cls: approach.branch.cls,
    };
  }

  /**
   * 信号機を各枝に立てる。左側通行なので、交差点に向かう車線は外向き
   * 方向から見て正の側にある。支柱をその側に立て、アームを車道上へ張る。
   */
  private placeSignals(junction: Junction): void {
    junction.approaches.forEach((approach, index) => {
      const cls = approach.branch.cls;
      const post = this.roadsidePost(approach, 1.4);
      if (!post) return;
      const assembly = createSignal({
        base: post.base,
        facing: post.outward,
        inward: post.right.clone().negate(),
        armLength: cls.carriagewayHalfWidth + 1.0,
        phase: index % 2,
      });
      this.signals.push(assembly);
      this.propGroup.add(assembly.object);
      this.props.push({
        kind: 'signal',
        position: post.base,
        segment: approach.branch.segment,
      });
    });
  }

  private placeStopSigns(junction: Junction): void {
    for (const approach of junction.approaches) {
      const post = this.roadsidePost(approach, 1.2);
      if (!post) continue;
      this.propGroup.add(createStopSign(post.base, post.outward));
      this.props.push({
        kind: 'stopSign',
        position: post.base,
        segment: approach.branch.segment,
      });
    }
  }

  /**
   * 交差点の枝の路側に、支柱を立てられる場所を探す。
   *
   * 交差点の手前は他の枝が横切っているので、素直に「トリム位置から
   * 少し戻った路側」に置くと、交差する道路の真ん中に立ってしまう。
   * 塞がっていれば交差点から遠ざかる向きに探し直す。
   */
  private roadsidePost(
    approach: Approach,
    setback: number,
  ): { base: Vector3; outward: Vector3; right: Vector3 } | null {
    const cls = approach.branch.cls;
    const alignment = this.network.alignmentOf(approach.branch.segment);
    const lateral = cls.halfWidth + 0.5;

    for (const extra of [0, 1.5, 3, 5, 7.5, 10.5]) {
      const distance = approach.trim + setback + extra;
      const s = approach.branch.atStart ? distance : alignment.length - distance;
      if (s < 0.2 || s > alignment.length - 0.2) continue;
      const sample = alignment.sampleAt(s);
      const sign = approach.branch.atStart ? 1 : -1;
      const right = sample.right.clone().multiplyScalar(sign).setY(0).normalize();
      const x = sample.pos.x + right.x * lateral;
      const z = sample.pos.z + right.z * lateral;
      if (
        !this.occupancy.isFree(x, z, {
          exceptSegments: [approach.branch.segment],
          margin: PROP_CLEARANCE,
        })
      ) {
        continue;
      }
      const outward = sample.forward.clone().multiplyScalar(sign).setY(0).normalize();
      const base = new Vector3(x, this.propGroundY(x, z, sample.pos.y + cls.curbHeight), z);
      return { base, outward, right };
    }
    return null;
  }

  /** 小物の足元の高さ。整地後の地形と路肩の高い方に合わせ、少し埋める。 */
  private propGroundY(x: number, z: number, surfaceY: number): number {
    return Math.max(this.field.heightAt(x, z), surfaceY) - 0.05;
  }

  // ---------------------------------------------------------------- 踏切

  private buildCrossing(
    overlay: MeshBuilder,
    crossing: Crossing,
    warnings: WorldWarning[],
    stats: WorldStats,
  ): void {
    if (crossing.message) {
      warnings.push({
        message: crossing.message,
        position: crossing.point.clone(),
        severity: crossing.kind === 'conflict' ? 'error' : 'warning',
      });
    }
    if (crossing.kind !== 'level' || !crossing.road || !crossing.rail) return;

    stats.levelCrossings++;
    const road = crossing.road;
    const roadAlignment = this.network.alignmentOf(road.segment);
    const build = buildLevelCrossing(
      overlay,
      crossing,
      { sampleAt: (s) => this.roadSampleAt(road.segment, s) },
      road.cls,
      crossing.rail.cls,
      {
        canPlace: (x, z) =>
          this.occupancy.isFree(x, z, {
            exceptSegments: [road.segment],
            margin: PROP_CLEARANCE,
          }),
        groundY: (x, z, surfaceY) => this.propGroundY(x, z, surfaceY),
      },
    );

    for (const stop of build.stopStations) {
      const alignment =
        stop.segment === road.segment ? roadAlignment : this.network.alignmentOf(stop.segment);
      buildCrossingStopLine(overlay, alignment, stop.s, road.cls, stop.forward);
    }
    for (const spec of build.gates) this.placeGate(spec, road.segment);
  }

  /**
   * 道路上の 1 点を弧長で取る。範囲を外れたらノードを越えて隣の
   * セグメントへ続ける。踏切がちょうどノードの上にあるとき、片側の
   * 遮断機と停止線が丸ごと落ちてしまうのを防ぐ。
   */
  private roadSampleAt(segment: SegmentId, s: number, depth = 0): RoadSample | null {
    const alignment = this.network.alignmentOf(segment);
    if (s >= 0 && s <= alignment.length) {
      const sample = alignment.sampleAt(s);
      return {
        pos: sample.pos.clone(),
        right: sample.right.clone(),
        forward: sample.forward.clone(),
        segment,
        s,
      };
    }
    if (depth >= 2) return null;

    const seg = this.network.segments.get(segment);
    if (!seg) return null;
    const kind = this.network.classOf(seg).kind;
    const past = s > alignment.length;
    const nodeId = past ? seg.b : seg.a;
    const remaining = past ? s - alignment.length : -s;
    const node = this.network.nodes.get(nodeId);
    if (!node) return null;

    for (const otherId of node.segments) {
      if (otherId === segment) continue;
      const other = this.network.segments.get(otherId);
      if (!other || this.network.classOf(other).kind !== kind) continue;
      const startsHere = other.a === nodeId;
      const otherLength = this.network.alignmentOf(otherId).length;
      const found = this.roadSampleAt(
        otherId,
        startsHere ? remaining : otherLength - remaining,
        depth + 1,
      );
      if (!found) continue;
      // 隣のセグメントの弧長が逆向きに繋がっていれば、進行方向を反転する。
      if (past === startsHere) return found;
      return {
        ...found,
        right: found.right.negate(),
        forward: found.forward.negate(),
      };
    }
    return null;
  }

  private placeGate(spec: GateSpec, segment: SegmentId): void {
    const gate = createCrossingGate({
      base: spec.base,
      across: spec.across,
      facing: spec.facing,
      length: spec.length,
    });
    this.gates.push(gate);
    this.propGroup.add(gate.object);
    this.props.push({ kind: 'crossingGate', position: spec.base.clone(), segment });
  }

  // ------------------------------------------------------------ ユーティリティ

  private replaceGeometry(mesh: Mesh, builder: MeshBuilder): void {
    const old = mesh.geometry;
    mesh.geometry = builder.build();
    old.dispose();
  }

  /** 小物はジオメトリ・マテリアルを共有しているので、外すだけでよい。 */
  private clearProps(): void {
    this.propGroup.clear();
    this.signals = [];
    this.gates = [];
    this.props = [];
  }

  /** 信号・遮断機のアニメーションを進める。 */
  animate(time: number): void {
    const signalPeriod = 26;
    const t = time % signalPeriod;
    for (const signal of this.signals) {
      const local = (t + signal.phase * (signalPeriod / 2)) % signalPeriod;
      const state: 0 | 1 | 2 = local < 10 ? 0 : local < 12.5 ? 1 : 2;
      setSignalState(signal, state);
    }

    const gatePeriod = 34;
    const g = time % gatePeriod;
    // 8 秒かけて降り、12 秒閉じ、8 秒かけて上がる。
    let closed = 0;
    if (g < 4) closed = g / 4;
    else if (g < 16) closed = 1;
    else if (g < 20) closed = 1 - (g - 16) / 4;
    const blink = Math.floor(time * 1.6) % 2 === 0;
    for (const gate of this.gates) setGateState(gate, closed, blink);
  }
}

/** 踏切のまわりで、整地目標を道路側に寄せる範囲。 */
interface CrossingZone {
  /** 踏切の弧長 (線路側)。 */
  s: number;
  /** 舗装の下。ここまでは道路側に完全に譲る [m]。 */
  inner: number;
  /** ここまでで道床天端の高さまで下げる [m]。 */
  shoulder: number;
  /** ここまでで断面 (法尻) に戻す [m]。 */
  outer: number;
  /** 舗装の路端の高さ (線形 Y からのオフセット)。 */
  roadOffset: number;
  /** 道床天端のすぐ下の高さ (線形 Y からのオフセット)。 */
  shoulderOffset: number;
}

/** 舗装の端から道床天端の高さまで下げるのにかける距離 [m]。 */
const CROSSING_SHOULDER_RAMP = 3;
/** さらに法尻まで戻すのにかける距離 [m]。 */
const CROSSING_SLOPE_RAMP = 6;

/**
 * 踏切を考慮した整地目標。`null` なら道路側に任せて何も焼き込まない。
 *
 * 舗装の下だけを譲って外側を放置すると、道路と同じ高さの地形がそのまま
 * 残ってレールまで埋まる。逆に舗装のすぐ脇で線路の断面 (法尻) まで
 * 落とすと、路端の下が 1 m 近く掘られて道路が浮く。そこで
 *   舗装の端 → 道床天端 → 法尻
 * と 2 段階で戻し、路端では道路と同じ高さ、数メートル先ではレールが
 * 顔を出している状態にする。
 */
function crossingDrop(zones: CrossingZone[], s: number, naturalDrop: number): number | null {
  if (zones.length === 0) return naturalDrop;
  const naturalOffset = -naturalDrop;
  let offset = naturalOffset;
  for (const zone of zones) {
    const distance = Math.abs(s - zone.s);
    if (distance <= zone.inner) return null;
    if (distance >= zone.outer) continue;
    const zoneOffset =
      distance < zone.shoulder
        ? lerp(
            zone.roadOffset,
            zone.shoulderOffset,
            smoothstep((distance - zone.inner) / (zone.shoulder - zone.inner)),
          )
        : lerp(
            zone.shoulderOffset,
            naturalOffset,
            smoothstep((distance - zone.shoulder) / (zone.outer - zone.shoulder)),
          );
    // 重なった場合は高い方を採る。低い方に合わせると路端の下が掘られる。
    offset = Math.max(offset, zoneOffset);
  }
  return -offset;
}

/** リングを重心から外向きに広げる。整地の footprint を路面より広く取るため。 */
function expandRing(ring: Vector3[], margin: number): Vector3[] {
  if (ring.length === 0 || margin <= 0) return ring.map((p) => p.clone());
  const centroid = new Vector3();
  for (const p of ring) centroid.add(p);
  centroid.divideScalar(ring.length);
  return ring.map((p) => {
    const dir = new Vector3(p.x - centroid.x, 0, p.z - centroid.z);
    const len = dir.length();
    if (len < 1e-4) return p.clone();
    dir.divideScalar(len);
    return new Vector3(p.x + dir.x * margin, p.y, p.z + dir.z * margin);
  });
}
