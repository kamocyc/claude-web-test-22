import { Group, Mesh, Vector3 } from 'three';
import type { Alignment } from '../core/alignment';
import { MeshBuilder, fillPolygon } from '../core/meshbuilder';
import { SURFACE_LIFT } from '../core/units';
import {
  applyRailBlend,
  buildLevelCrossing,
  computeRailBlend,
  type GateSpec,
  type RailBlend,
} from '../build/crossing';
import {
  buildCrossingStopLine,
  buildCrosswalk,
  buildLaneMarkings,
  buildStopLine,
  type ApproachFrame,
} from '../build/markings';
import { buildCatenary, buildTrack, buildTrackConnection } from '../build/rail';
import {
  alignmentSamplesInRange,
  buildBridge,
  buildRetainingWalls,
  buildTunnel,
  cutDepthAt,
  structureFootprintHalfWidth,
} from '../build/structures';
import {
  buildRibbon,
  gradingDrop,
  gradingEdges,
  gradingHalfWidth,
  junctionGradingDrop,
  junctionSurfaceOffset,
  profileFor,
  ringSkirt,
} from '../build/surface';
import type { NetworkClass } from '../network/classes';
import { findCrossings, type Crossing } from '../network/crossings';
import { solveJunctions, type Approach, type Junction } from '../network/junction';
import type { Network, NodeId, SegmentId } from '../network/network';
import { computeStructureProfile, classify, type StructureRun } from '../network/structure';
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

export interface BuildResult {
  warnings: WorldWarning[];
  stats: WorldStats;
  diagnostics: Map<SegmentId, SegmentDiagnostics>;
}

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

    this.applyGrading(junctions, structures);
    this.terrainMesh.update();

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

      this.buildSegment(surface, structure, alignment, cls, runs, blends, stats);
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

    return { warnings, stats, diagnostics };
  }

  // ---------------------------------------------------------------- 整地

  private applyGrading(
    junctions: Map<NodeId, Junction>,
    structures: Map<SegmentId, StructureRun[]>,
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
      const half = gradingHalfWidth(cls);
      const drop = gradingDrop(cls);
      for (const run of structures.get(seg.id) ?? []) {
        if (run.mode !== 'ground') continue;
        const samples = alignmentSamplesInRange(alignment, run.s0, run.s1, 3);
        for (let i = 0; i + 1 < samples.length; i++) {
          const a = gradingEdges(samples[i], half, drop);
          const b = gradingEdges(samples[i + 1], half, drop);
          grading.stampQuad(a.left, b.left, b.right, a.right);
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
      const ring = expandRing(junction.ring, gradingHalfWidth(cls) - cls.halfWidth);
      if (mode === 'ground') {
        const drop = junctionGradingDrop(cls);
        grading.stampPolygon(ring.map((p) => new Vector3(p.x, p.y - drop, p.z)));
      } else {
        const blocked = expandRing(junction.ring, 3);
        for (let i = 1; i + 1 < blocked.length; i++) {
          grading.block(blocked[0], blocked[i], blocked[i + 1]);
        }
      }
    }

    grading.apply();
  }

  // ------------------------------------------------------------ セグメント

  private buildSegment(
    surface: MeshBuilder,
    structure: MeshBuilder,
    alignment: Alignment,
    cls: NetworkClass,
    runs: StructureRun[],
    blends: RailBlend[],
    stats: WorldStats,
  ): void {
    const profile = profileFor(cls);

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
      } else {
        // 深い切土は法面ではなく擁壁にして、掘割らしい見た目にする。
        const deep = samples.some((sample) => cutDepthAt(sample, this.field) > 3.0);
        if (deep) buildRetainingWalls(structure, samples, cls, this.field);
      }

      if (cls.kind === 'rail' && run.mode !== 'tunnel') {
        buildCatenary(structure, samples, cls);
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

    if (junction.ring.length >= 3) {
      const dy = SURFACE_LIFT + junctionSurfaceOffset(cls);
      const lifted = junction.ring.map((p) => new Vector3(p.x, p.y + dy, p.z));
      fillPolygon(surface, lifted, cls.surfaceColor, 0.12, 0);
      ringSkirt(surface, lifted, [0.3, 0.28, 0.26]);
    }

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
      const outward = new Vector3(approach.dir.x, 0, approach.dir.y);
      const right = new Vector3(-approach.dir.y, 0, approach.dir.x);
      const alignment = this.network.alignmentOf(approach.branch.segment);
      const distance = approach.trim + 1.4;
      const s = approach.branch.atStart ? distance : alignment.length - distance;
      if (s < 0 || s > alignment.length) return;
      const sample = alignment.sampleAt(s);
      const base = new Vector3(
        sample.pos.x + right.x * (cls.halfWidth + 0.4),
        sample.pos.y,
        sample.pos.z + right.z * (cls.halfWidth + 0.4),
      );
      const assembly = createSignal({
        base,
        facing: outward,
        inward: right.clone().negate(),
        armLength: cls.carriagewayHalfWidth + 1.0,
        phase: index % 2,
      });
      this.signals.push(assembly);
      this.propGroup.add(assembly.object);
    });
  }

  private placeStopSigns(junction: Junction): void {
    for (const approach of junction.approaches) {
      const cls = approach.branch.cls;
      const outward = new Vector3(approach.dir.x, 0, approach.dir.y);
      const right = new Vector3(-approach.dir.y, 0, approach.dir.x);
      const alignment = this.network.alignmentOf(approach.branch.segment);
      const distance = approach.trim + 1.2;
      const s = approach.branch.atStart ? distance : alignment.length - distance;
      if (s < 0 || s > alignment.length) continue;
      const sample = alignment.sampleAt(s);
      const base = new Vector3(
        sample.pos.x + right.x * (cls.halfWidth + 0.4),
        sample.pos.y,
        sample.pos.z + right.z * (cls.halfWidth + 0.4),
      );
      this.propGroup.add(createStopSign(base, outward));
    }
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
    const roadAlignment = this.network.alignmentOf(crossing.road.segment);
    const build = buildLevelCrossing(
      overlay,
      crossing,
      roadAlignment,
      crossing.road.cls,
      crossing.rail.cls,
    );

    for (const stop of build.stopStations) {
      buildCrossingStopLine(overlay, roadAlignment, stop.s, crossing.road.cls, stop.forward);
    }
    for (const spec of build.gates) this.placeGate(spec);
  }

  private placeGate(spec: GateSpec): void {
    const gate = createCrossingGate({
      base: spec.base,
      across: spec.across,
      facing: spec.facing,
      length: spec.length,
    });
    this.gates.push(gate);
    this.propGroup.add(gate.object);
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
