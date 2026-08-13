import { Group, Mesh, Vector3, type Vector2 } from 'three';
import type { Alignment } from '../core/alignment';
import { MeshBuilder, signedAreaXZ } from '../core/meshbuilder';
import { perp } from '../core/curve';
import { PROP_MAX_RISE, TERRAIN_CELL, lerp, smoothstep } from '../core/units';
import {
  applySurfaceBlend,
  buildFlangeways,
  buildLevelCrossing,
  computeCrossingBlend,
  surfaceBlendAt,
  surfaceHeightScale,
  type GateSpec,
  type RoadSample,
  type SurfaceBlend,
} from '../build/crossing';
import {
  buildCrossingStopLine,
  buildCrosswalk,
  buildLaneMarkings,
  buildStopLine,
  type ApproachFrame,
  type SurfacePath,
} from '../build/markings';
import { buildCatenary, buildTrack, buildTrackConnection } from '../build/rail';
import {
  buildPowerLine,
  planUtilityPoles,
  POLE_PITCH,
  type PolePlan,
  type PowerSpan,
} from '../build/streetside';
import {
  alignmentSamplesInRange,
  buildBridge,
  buildJunctionDeck,
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
  surfaceHeightAt,
  type RGB,
} from '../build/surface';
import type { NetworkClass } from '../network/classes';
import { findCrossings, type Crossing } from '../network/crossings';
import { solveJunctions, type Approach, type Junction } from '../network/junction';
import type { Network, NodeId, SegmentId } from '../network/network';
import { buildConnectivity, type Connectivity } from '../network/connectivity';
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
  /** 行き来できるひと繋がりの系統の数。 */
  roadNetworks: number;
  railNetworks: number;
  powerNetworks: number;
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
  /** 道路・線路の接続関係 (交通の判定に使える)。 */
  connectivity: Connectivity;
  /** 配電線の接続関係。 */
  power: { poles: PolePlan[]; spans: PowerSpan[] };
  /**
   * 踏切に合わせた高さ補正。描画に使った実際の高さを知りたいとき
   * (検証や当たり判定) はこれを線形の高さに足す。
   */
  blends: Map<SegmentId, SurfaceBlend[]>;
}

/** 配電線の系統数 (地中区間も繋がっているものとして数える)。 */
function countPowerNetworks(poles: PolePlan[], spans: PowerSpan[]): number {
  const index = new Map<PolePlan, number>();
  poles.forEach((pole, i) => index.set(pole, i));
  const parent = poles.map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  for (const span of spans) {
    const a = index.get(span.a);
    const b = index.get(span.b);
    if (a === undefined || b === undefined) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const roots = new Set(poles.map((_, i) => find(i)));
  return roots.size;
}

/** 系統の色分けに使う色。隣り合う番号どうしが紛らわしくない並びにする。 */
const COMPONENT_TINTS: RGB[] = [
  [0.34, 0.66, 0.95],
  [0.96, 0.72, 0.28],
  [0.46, 0.85, 0.52],
  [0.9, 0.45, 0.75],
  [0.55, 0.5, 0.95],
  [0.95, 0.5, 0.38],
];

/** 小物を立てるときに、路面から確保する余裕 [m]。 */
const PROP_CLEARANCE = 0.35;

/** 架空線で飛ばせる径間の上限 (電柱の間隔の何倍まで)。 */
const MAX_AERIAL_SPANS = 1.6;

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
  /** 直近の rebuild で使った、踏切に合わせた高さ補正。 */
  private blends = new Map<SegmentId, SurfaceBlend[]>();

  /**
   * 面の塗り方。`connectivity` にすると、行き来できる系統ごとに色を変える。
   * どこがどこと繋がっているのかを一目で確かめるための表示。
   */
  colorMode: 'normal' | 'connectivity' = 'normal';

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

    const crossings = findCrossings(network);
    this.crossings = crossings;

    // 踏切に合わせた道路側の高さ補正をセグメントごとにまとめる。
    // 交差点の断面もこの高さで作る必要があるので、交差点を解く前に用意する。
    const blends = this.collectCrossingBlends(crossings);
    this.blends = blends;
    const blendAt = (segment: SegmentId, s: number) => ({
      ...surfaceBlendAt(
        blends.get(segment) ?? [],
        s,
        network.alignmentOf(segment).sampleAt(s).pos.y,
      ),
      heightScale: surfaceHeightScale(blends.get(segment) ?? [], s),
    });

    const { junctions, trims } = solveJunctions(network, blendAt);
    this.junctions = junctions;
    const connectivity = buildConnectivity(network, junctions);

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
      const railSection = profileFor(rail.cls);
      // 舗装の下は道路のもの。そこから道路に直交する向きに、線路の断面へ戻す。
      const roadHalfWidth = road.cls.halfWidth;
      const list = crossingZones.get(rail.segment) ?? [];
      list.push({
        x: crossing.point.x,
        z: crossing.point.z,
        roadDir: road.dir.clone(),
        roadNormal: perp(road.dir),
        // 線路の footprint が道路を横切る長さ。斜めなら長くなる。
        railExtent: gradingHalfWidth(rail.cls) * skew + 4,
        roadHalfWidth,
        shoulder: roadHalfWidth + CROSSING_SHOULDER_RAMP,
        outer: roadHalfWidth + CROSSING_SHOULDER_RAMP + CROSSING_SLOPE_RAMP,
        // 舗装の路端と同じ高さ (踏切では線路の描画高 ≒ 道路面)。
        // ただしレール頭頂面 (オフセット 0) より上には決してしない。
        // 舗装の外に出た所でレールが土に埋まって見えてしまう。
        roadOffset: Math.min(-gradingDrop(road.cls), -0.03),
        // 道床天端のすぐ下。ここまで下げればレールと枕木は埋まらない。
        shoulderOffset: railSection[Math.min(1, railSection.length - 1)].height - 0.06,
      });
      crossingZones.set(rail.segment, list);
    }

    this.applyGrading(junctions, structures, crossingZones, blends);
    this.terrainMesh.update();

    // 小物を置く前に、どこが道路・線路・交差点に覆われているかを索引にする。
    this.occupancy = new Occupancy(network, {
      junctions,
      heightOffset: (segment, s, y) => surfaceBlendAt(blends.get(segment) ?? [], s, y).dy,
    });

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
      roadNetworks: 0,
      railNetworks: 0,
      powerNetworks: 0,
    };
    const diagnostics = new Map<SegmentId, SegmentDiagnostics>();

    for (const seg of network.segments.values()) {
      const cls = network.classOf(seg);
      const alignment = network.alignmentOf(seg.id);
      const range = ranges.get(seg.id)!;
      const runs = structures.get(seg.id)!;

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

      this.buildSegment(
        surface,
        structure,
        seg.id,
        alignment,
        cls,
        runs,
        blends.get(seg.id) ?? [],
        stats,
        this.tintFor(connectivity, seg.id),
      );
      if (cls.kind === 'road') {
        buildLaneMarkings(overlay, this.surfacePath(seg.id), range, cls);
      }
    }

    for (const junction of junctions.values()) {
      const branch = junction.approaches[0]?.branch.segment;
      this.buildJunction(
        surface,
        overlay,
        structure,
        junction,
        structures,
        warnings,
        stats,
        branch === undefined ? undefined : this.tintFor(connectivity, branch),
      );
    }

    for (const crossing of crossings) {
      this.buildCrossing(overlay, crossing, structures, warnings, stats);
    }

    const power = this.buildPower(structure, structures, ranges);
    const powerNetworks = countPowerNetworks(power.poles, power.spans);
    stats.roadNetworks = connectivity.components.filter((c) => c.kind === 'road').length;
    stats.railNetworks = connectivity.components.filter((c) => c.kind === 'rail').length;
    stats.powerNetworks = powerNetworks;

    this.replaceGeometry(this.surfaceMesh, surface);
    this.replaceGeometry(this.overlayMesh, overlay);
    this.replaceGeometry(this.structureMesh, structure);

    return {
      warnings,
      stats,
      diagnostics,
      ranges,
      structures,
      props: this.props,
      connectivity,
      power,
      blends,
    };
  }

  /** 系統ごとの色。`colorMode` が `normal` のときは色を変えない。 */
  private tintFor(connectivity: Connectivity, segment: SegmentId): RGB | undefined {
    if (this.colorMode !== 'connectivity') return undefined;
    const component = connectivity.componentOf.get(segment);
    return component === undefined ? undefined : COMPONENT_TINTS[component % COMPONENT_TINTS.length];
  }

  /**
   * 配電線を組み立てる。
   *
   * 電柱はセグメントごとに間隔を割り付けるが、**線は途切れさせない**。
   * 建てられなかった所 (橋・トンネル・線路の架線・他の線形と支障する所)
   * では地中に潜り、向こう側でまた立ち上がる。ノードを越えて隣のセグメント
   * へも繋ぐので、交差点を跨いでも 1 本の系統として繋がる。
   */
  private buildPower(
    structure: MeshBuilder,
    structures: Map<SegmentId, StructureRun[]>,
    ranges: Map<SegmentId, { s0: number; s1: number }>,
  ): { poles: PolePlan[]; spans: PowerSpan[] } {
    const bySegment = new Map<SegmentId, PolePlan[]>();
    const all: PolePlan[] = [];

    for (const seg of this.network.segments.values()) {
      const cls = this.network.classOf(seg);
      if (cls.kind !== 'road') continue;
      const range = ranges.get(seg.id);
      const runs = structures.get(seg.id) ?? [];
      if (!range) continue;

      const alignment = this.network.alignmentOf(seg.id);
      const segmentBlends = this.blends.get(seg.id) ?? [];
      // 踏切のまわりでは路面が線路に合わせて動くので、描画に使ったのと
      // 同じ高さで柱を建てる。生の線形で建てると路面から浮く。
      const samples = applySurfaceBlend(
        alignmentSamplesInRange(alignment, range.s0, range.s1, 4),
        segmentBlends,
      );
      if (samples.length < 2) continue;

      const poles = planUtilityPoles(samples, cls, {
        // 橋・トンネルの区間には建てない。地面がない / 地中にある。
        canPlace: (x, z, y) =>
          this.occupancy.isFree(x, z, {
            exceptSegments: [seg.id],
            margin: PROP_CLEARANCE,
            y,
          }),
        groundY: (x, z, surfaceY) =>
          Math.max(this.field.heightAt(x, z), surfaceY + this.curbHeightAt(cls, seg.id, 0)),
      }).filter((pole) => modeAt(runs, pole.station) === 'ground');

      if (poles.length > 0) bySegment.set(seg.id, poles);
      all.push(...poles);
    }

    // 橋・トンネルの footprint。架空線はこの上を跨げない。
    const obstacles = this.structureFootprints(structures);

    const spans: PowerSpan[] = [];
    // 既に繋がっている柱どうしを二重に繋がないよう、union-find で追う。
    const parent = new Map<PolePlan, PolePlan>();
    const find = (p: PolePlan): PolePlan => {
      let root = p;
      while (parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    for (const pole of all) parent.set(pole, pole);

    const link = (a: PolePlan, b: PolePlan, continuous: boolean): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      parent.set(ra, rb);
      const underground = !continuous || this.spanBlocked(a.base, b.base, obstacles);
      spans.push({ a, b, underground });
    };

    // セグメント内で隣り合う柱を繋ぐ。番号が飛んでいれば地中。
    for (const poles of bySegment.values()) {
      for (let i = 0; i + 1 < poles.length; i++) {
        link(poles[i], poles[i + 1], poles[i + 1].index === poles[i].index + 1);
      }
    }

    /**
     * その枝の、ノードにいちばん近い電柱。柱の無いセグメント (橋・トンネル
     * など) は通り抜けて先を探す。そうしないと、そこで系統が切れてしまう。
     */
    const nearestPole = (segment: SegmentId, atStart: boolean, depth = 0): PolePlan | null => {
      const poles = bySegment.get(segment);
      if (poles && poles.length > 0) return atStart ? poles[0] : poles[poles.length - 1];
      if (depth >= 3) return null;
      const seg = this.network.segments.get(segment);
      if (!seg) return null;
      const junction = this.junctions.get(atStart ? seg.b : seg.a);
      const self = junction?.approaches.find((a) => a.branch.segment === segment);
      if (!junction || !self) return null;
      for (const other of junction.approaches) {
        if (other.branch.segment === segment) continue;
        if (other.branch.cls.kind !== 'road') continue;
        if (self.dir.dot(other.dir) > -0.5) continue;
        const found = nearestPole(other.branch.segment, other.branch.atStart, depth + 1);
        if (found) return found;
      }
      return null;
    };

    // ノードを越えて隣のセグメントへ繋ぐ。まず、ほぼ直進する組を本線として
    // 繋ぎ、そのあと交差点に集まる残りの枝を分岐 (引き込み) として繋ぐ。
    // こうすると 1 つの道路網が 1 つの電力系統になる。
    for (const junction of this.junctions.values()) {
      const branches = junction.approaches.filter((a) => a.branch.cls.kind === 'road');
      const poles = branches
        .map((b) => nearestPole(b.branch.segment, b.branch.atStart))
        .filter((p): p is PolePlan => p !== null);

      for (let i = 0; i < branches.length; i++) {
        for (let j = i + 1; j < branches.length; j++) {
          if (branches[i].dir.dot(branches[j].dir) > -0.5) continue; // 直進に近い組
          const a = nearestPole(branches[i].branch.segment, branches[i].branch.atStart);
          const b = nearestPole(branches[j].branch.segment, branches[j].branch.atStart);
          if (a && b) link(a, b, a.base.distanceTo(b.base) < POLE_PITCH * 2.5);
        }
      }
      for (let i = 1; i < poles.length; i++) {
        link(poles[0], poles[i], poles[0].base.distanceTo(poles[i].base) < POLE_PITCH * 2.5);
      }
    }

    buildPowerLine(structure, all, spans);
    for (const [segment, poles] of bySegment) {
      for (const pole of poles) {
        this.props.push({ kind: 'utilityPole', position: pole.base, segment });
      }
    }
    return { poles: all, spans };
  }

  /**
   * 橋・トンネル区間の footprint を、点と半径の列として集める。
   *
   * 柱を建てられない区間なので、その上を架空線で跨いではいけない。区間が
   * 電柱の間隔より短いと柱の候補地が 1 つも落ちず、番号の連続だけでは
   * 「跨いでしまった」ことに気づけないため、形として持っておく。
   */
  private structureFootprints(
    structures: Map<SegmentId, StructureRun[]>,
  ): { x: number; z: number; y: number; radius: number }[] {
    const out: { x: number; z: number; y: number; radius: number }[] = [];
    for (const [id, runs] of structures) {
      const seg = this.network.segments.get(id);
      if (!seg) continue;
      const cls = this.network.classOf(seg);
      const alignment = this.network.alignmentOf(id);
      for (const run of runs) {
        if (run.mode === 'ground') continue;
        // 構造物の**本体**の幅だけを見る。整地の footprint (法面を含む) で
        // 見ると、脇を並走しているだけの配電線まで地中に潜ってしまう。
        for (const sample of alignmentSamplesInRange(alignment, run.s0, run.s1, 4)) {
          out.push({
            x: sample.pos.x,
            z: sample.pos.z,
            y: sample.pos.y,
            radius: cls.halfWidth,
          });
        }
      }
    }
    return out;
  }

  /**
   * 2 本の柱の間に架空線を張れるか。
   * 線路 (架線) の上や、橋・トンネルの構造物の上は跨げない。
   */
  private spanBlocked(
    a: Vector3,
    b: Vector3,
    obstacles: { x: number; z: number; y: number; radius: number }[],
  ): boolean {
    // 支持物なしで飛ばせる長さには限りがある。橋・トンネルを丸ごと
    // 跨ぐような径間は、構造物に当たっていなくても地中で繋ぐ。
    if (a.distanceTo(b) > POLE_PITCH * MAX_AERIAL_SPANS) return true;

    const steps = Math.max(2, Math.ceil(a.distanceTo(b) / 4));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t;
      const hit = this.occupancy.at(x, z, { kinds: ['rail'], margin: 2 });
      // 高さが大きく違えば (掘割の上、高架の下) 支障しない。
      if (hit && Math.abs(y - hit.y) < 8) return true;
      for (const o of obstacles) {
        const dx = x - o.x;
        const dz = z - o.z;
        if (dx * dx + dz * dz > o.radius * o.radius) continue;
        // 桁の上を通るときだけ支障する。遥か下のトンネル・遥か上の
        // 高架は、架空線の邪魔にならない。
        if (Math.abs(y - o.y) < 8) return true;
      }
    }
    return false;
  }

  /**
   * 踏切に合わせた道路側の高さ補正を集める。
   *
   * 踏切がセグメントの端の近くにあるときは、ノードを越えて隣のセグメントへも
   * 同じ補正を伝える。そうしないと継ぎ目で帯どうしに段差ができる。
   */
  private collectCrossingBlends(crossings: Crossing[]): Map<SegmentId, SurfaceBlend[]> {
    const network = this.network;
    const blends = new Map<SegmentId, SurfaceBlend[]>();
    const add = (segment: SegmentId, blend: SurfaceBlend): void => {
      const list = blends.get(segment) ?? [];
      list.push(blend);
      blends.set(segment, list);
    };

    const spills: { segment: SegmentId; blend: SurfaceBlend }[] = [];
    for (const crossing of crossings) {
      if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
      const blend = computeCrossingBlend(
        crossing,
        network.alignmentOf(crossing.rail.segment),
        network.alignmentOf(crossing.road.segment),
      );
      add(blend.segment, blend);

      const seg = network.segments.get(blend.segment);
      if (!seg) continue;
      const length = network.alignmentOf(blend.segment).length;

      const spill = (nodeId: NodeId, distance: number): void => {
        if (distance >= blend.halfLength) return;
        const node = network.nodes.get(nodeId);
        if (!node) return;
        for (const otherId of node.segments) {
          if (otherId === blend.segment) continue;
          const other = network.segments.get(otherId);
          if (!other || network.classOf(other).kind !== 'road') continue;
          // 隣のセグメントから見た踏切の弧長 (範囲外の値になる)。
          const otherAlignment = network.alignmentOf(otherId);
          const startsHere = other.a === nodeId;
          const s = startsHere ? -distance : otherAlignment.length + distance;
          // 2 本が同じノードから同じ向きに出ていれば、弧長の向きは逆。
          // 傾きの符号もそのぶん反転させないと、隣で逆向きに傾く。
          const reversed = (seg.a === nodeId) === startsHere;
          const sign = reversed ? -1 : 1;
          spills.push({
            segment: otherId,
            blend: {
              ...blend,
              s,
              // 目標面は絶対高さなので、弧長の向きが逆になる分だけ
              // 勾配と横断勾配の符号を反転させればよい。
              targetSlope: blend.targetSlope * sign,
              roll: blend.roll * sign,
            },
          });
        }
      };
      spill(seg.a, blend.s);
      spill(seg.b, length - blend.s);
    }
    for (const { segment, blend } of spills) add(segment, blend);
    return blends;
  }

  /** 描画に使った高さ (踏切の補正込み) で線形をたどる経路。標示用。 */
  private surfacePath(segment: SegmentId): SurfacePath {
    const alignment = this.network.alignmentOf(segment);
    const blends = this.blends.get(segment);
    if (!blends || blends.length === 0) return alignment;
    return {
      length: alignment.length,
      sampleAt: (s) => applySurfaceBlend([alignment.sampleAt(s)], blends)[0],
    };
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
    blends: Map<SegmentId, SurfaceBlend[]>,
  ): void {
    const grading = this.grading;
    grading.reset();

    // 踏切の舗装の下は道路のもの。線路や分岐器の整地が入り込まないよう
    // 保護しておく (分岐器の交差点面が踏切を飲み込む配置があるため)。
    for (const zones of crossingZones.values()) {
      for (const zone of zones) {
        grading.protect(zone.x, zone.z, zone.roadDir, zone.railExtent, zone.roadHalfWidth);
      }
    }

    // 路肩の余裕幅は、他の線形の舗装を掘らないよう最後にまとめて焼く。
    const margins: { quad: Vector3[]; }[] = [];

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
      const segmentBlends = blends.get(seg.id) ?? [];
      for (const run of structures.get(seg.id) ?? []) {
        if (run.mode !== 'ground') continue;
        // 描画と同じ高さを整地の目標にする。踏切に寄せた分を無視すると、
        // 道床が地形からわずかに浮いたり沈んだりする。
        const samples = applySurfaceBlend(
          alignmentSamplesInRange(alignment, run.s0, run.s1, 3),
          segmentBlends,
        );
        for (let i = 0; i + 1 < samples.length; i++) {
          // 勾配のある所では、格子の量子化で地形が路端より高く出ることが
          // ある。1 マス分の高低差だけ余計に下げて逃げる。
          const grade = Math.abs(samples[i].grade + samples[i + 1].grade) / 2;
          const shift = grade * TERRAIN_CELL;
          // 段差を潰す係数は点ごとに違う (踏切の前後で戻っていく)。
          const a = gradingSectionPoints(
            samples[i],
            section,
            shift,
            surfaceHeightScale(segmentBlends, samples[i].s),
          );
          const b = gradingSectionPoints(
            samples[i + 1],
            section,
            shift,
            surfaceHeightScale(segmentBlends, samples[i + 1].s),
          );
          // 踏切のまわりでは、点ごとに道路からの垂距で目標を持ち上げる。
          if (zones.length > 0) {
            liftForCrossings(a, samples[i].pos.y, zones, naturalDrop);
            liftForCrossings(b, samples[i + 1].pos.y, zones, naturalDrop);
          }
          for (let k = 0; k + 1 < section.length; k++) {
            const quad = [a[k], b[k], b[k + 1], a[k + 1]];
            const o0 = section[k].offset;
            const o1 = section[k + 1].offset;
            const isCore =
              Math.abs(o0) <= cls.halfWidth + 1e-6 && Math.abs(o1) <= cls.halfWidth + 1e-6;
            if (isCore) {
              grading.stampQuad(quad[0], quad[1], quad[2], quad[3], {
                ignoreProtected: cls.kind === 'road',
                distance: bandDistance(o0, o1),
              });
            } else {
              margins.push({ quad });
            }
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
        this.stampJunction(grading, junction, cls, margins);
      } else {
        const blocked = expandRing(junction.ring, 3);
        for (let i = 1; i + 1 < blocked.length; i++) {
          grading.block(blocked[0], blocked[i], blocked[i + 1]);
        }
      }
    }

    for (const margin of margins) {
      grading.stampQuad(margin.quad[0], margin.quad[1], margin.quad[2], margin.quad[3], {
        core: false,
      });
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
  private stampJunction(
    grading: TerrainGrading,
    junction: Junction,
    cls: NetworkClass,
    margins: { quad: Vector3[] }[],
  ): void {
    // 取り付く枝の勾配の分だけ余計に下げる (セグメント側と同じ理由)。
    let grade = 0;
    for (const approach of junction.approaches) {
      const alignment = this.network.alignmentOf(approach.branch.segment);
      const s = approach.branch.atStart ? approach.trim : alignment.length - approach.trim;
      grade = Math.max(grade, Math.abs(alignment.sampleAt(s).grade));
    }
    const drop = junctionGradingDrop() + grade * TERRAIN_CELL;
    const outer = junction.rings[0];
    if (!outer || outer.length < 3) return;
    const rings = junction.rings.map((ring) =>
      ring.map(
        (p, i) => new Vector3(p.x, Math.min(p.y, outer[i]?.y ?? p.y) - drop, p.z),
      ),
    );
    const bands = [expandRing(rings[0], gradingHalfWidth(cls) - cls.halfWidth), ...rings];
    const ignoreProtected = cls.kind === 'road';
    // 帯ごとの「中心線からの距離」は、断面のオフセットで近似する。
    const profile = profileFor(cls);
    const offsetOf = (level: number): number =>
      Math.abs(profile[Math.min(level, profile.length - 1)]?.offset ?? 0);

    for (let k = 0; k + 1 < bands.length; k++) {
      const a = bands[k];
      const b = bands[k + 1];
      const n = Math.min(a.length, b.length);
      const distance = k === 0 ? cls.halfWidth : offsetOf(k);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const quad = [a[i], a[j], b[j], b[i]];
        // いちばん外側の帯は路肩の余裕幅なので、他の舗装より後で焼く。
        if (k === 0) margins.push({ quad });
        else grading.stampQuad(quad[0], quad[1], quad[2], quad[3], { ignoreProtected, distance });
      }
    }
    grading.stampPolygon(bands[bands.length - 1], { ignoreProtected, distance: 0 });
  }

  // ------------------------------------------------------------ セグメント

  private buildSegment(
    surface: MeshBuilder,
    structure: MeshBuilder,
    segment: SegmentId,
    alignment: Alignment,
    cls: NetworkClass,
    runs: StructureRun[],
    blends: SurfaceBlend[],
    stats: WorldStats,
    tint?: RGB,
  ): void {
    const profile = profileFor(cls);
    const ground = (x: number, z: number): number => this.field.heightAt(x, z);
    // 自分自身の上には当然乗るので、判定からは外す。
    const canPlace = (x: number, z: number, y?: number): boolean =>
      this.occupancy.isFree(x, z, { exceptSegments: [segment], margin: PROP_CLEARANCE, y });

    for (const run of runs) {
      const raw = alignmentSamplesInRange(alignment, run.s0, run.s1, 2.5);
      if (raw.length < 2) continue;
      const samples = applySurfaceBlend(raw, blends);

      buildRibbon(surface, samples, profile, {
        skirt: run.mode === 'ground',
        cls,
        groundY: ground,
        tint,
        // 踏切の上では縁石・歩道の段差を潰す。レールが歩道の帯に潜って
        // 途切れて見えるのを防ぐ (実物の踏切でも縁石は切り下げられている)。
        heightScale: (s) => surfaceHeightScale(blends, s),
      });

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

    }

    if (cls.kind === 'rail') {
      const first = runs[0];
      const last = runs[runs.length - 1];
      if (first && last) {
        const samples = alignmentSamplesInRange(alignment, first.s0, last.s1, 1.5);
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
    structures: Map<SegmentId, StructureRun[]>,
    warnings: WorldWarning[],
    stats: WorldStats,
    tint?: RGB,
  ): void {
    const node = this.network.getNode(junction.node);
    for (const message of junction.warnings) {
      warnings.push({ message, position: node.pos.clone(), severity: 'warning' });
    }

    if (junction.kind === 'intersection') stats.intersections++;
    if (junction.kind === 'railSwitch' && junction.approaches.length >= 3) stats.turnouts++;

    const cls = junction.approaches[0]?.branch.cls;
    if (!cls) return;

    buildJunctionSurface(
      surface,
      junction.rings,
      cls,
      junction.openEdge,
      (x, z) => this.field.heightAt(x, z),
      tint,
    );

    // 高い所にある交差点には床版と橋脚を付ける。付けないと路面だけが宙に浮く。
    const terrain = this.field.baseHeightAt(node.pos.x, node.pos.z);
    if (classify(node.pos.y, terrain) === 'bridge' && junction.rings.length > 0) {
      buildJunctionDeck(structure, junction.rings[0], cls, this.field);
    }

    if (cls.kind === 'rail') {
      // 交差点面 (道床天端) は、いちばん内側のリングを塗ったもの。
      const ballast = junction.rings[junction.rings.length - 1];
      const ballastY =
        ballast && ballast.length >= 3
          ? (x: number, z: number): number | null => surfaceHeightAt(ballast, x, z)
          : undefined;
      for (const connection of junction.connections) {
        const from = junction.approaches.find((a) => a.branch.segment === connection.from);
        const to = junction.approaches.find((a) => a.branch.segment === connection.to);
        if (from && to) buildTrackConnection(structure, from, to, connection.through, { ballastY });
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
      if (junction.signalized) this.placeSignals(junction, structures);
      else this.placeStopSigns(junction, structures);
    }
  }

  private approachFrame(approach: Approach): ApproachFrame {
    const alignment = this.network.alignmentOf(approach.branch.segment);
    return {
      alignment: this.surfacePath(approach.branch.segment),
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
  private placeSignals(junction: Junction, structures: Map<SegmentId, StructureRun[]>): void {
    junction.approaches.forEach((approach, index) => {
      const cls = approach.branch.cls;
      const post = this.roadsidePost(approach, 1.4, structures.get(approach.branch.segment));
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

  private placeStopSigns(junction: Junction, structures: Map<SegmentId, StructureRun[]>): void {
    for (const approach of junction.approaches) {
      const post = this.roadsidePost(approach, 1.2, structures.get(approach.branch.segment));
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
    runs: StructureRun[] = [],
  ): { base: Vector3; outward: Vector3; right: Vector3 } | null {
    const cls = approach.branch.cls;
    const alignment = this.network.alignmentOf(approach.branch.segment);

    for (const extra of [0, 1.5, 3, 5, 7.5, 10.5]) {
      const distance = approach.trim + setback + extra;
      const s = approach.branch.atStart ? distance : alignment.length - distance;
      if (s < 0.2 || s > alignment.length - 0.2) continue;
      const mode = modeAt(runs, s);
      // トンネルの中には立てない。地表に合わせると山の上に信号が生える。
      if (mode === 'tunnel') continue;
      // 橋の上では床版の外に地面がない。高欄の内側に寄せて立てる。
      // 歩道のない種別では寄せる余地がないので、その枝には立てない。
      const onBridge = mode === 'bridge';
      if (onBridge && cls.halfWidth - 0.6 <= cls.carriagewayHalfWidth + 0.2) continue;
      const lateral = onBridge ? cls.halfWidth - 0.6 : cls.halfWidth + 0.5;
      const sample = applySurfaceBlend(
        [alignment.sampleAt(s)],
        this.blends.get(approach.branch.segment) ?? [],
      )[0];
      const sign = approach.branch.atStart ? 1 : -1;
      const right = sample.right.clone().multiplyScalar(sign).setY(0).normalize();
      const x = sample.pos.x + right.x * lateral;
      const z = sample.pos.z + right.z * lateral;
      const surfaceY =
        sample.pos.y +
        this.curbHeightAt(cls, approach.branch.segment, s) +
        lateral * (sample.roll ?? 0) * sign;
      // 桁の上では地形を見ない (地面は遥か下にある)。
      const baseY = onBridge ? surfaceY : this.propGroundY(x, z, surfaceY);
      // 切土の法面の上には立てない。地面には接していても、路面から
      // 何 m も高い所に信号や標識が浮いて見えてしまう。
      if (baseY - surfaceY > PROP_MAX_RISE) continue;
      if (
        !this.occupancy.isFree(x, z, {
          exceptSegments: [approach.branch.segment],
          margin: PROP_CLEARANCE,
          y: baseY,
        })
      ) {
        continue;
      }
      const outward = sample.forward.clone().multiplyScalar(sign).setY(0).normalize();
      return { base: new Vector3(x, baseY, z), outward, right };
    }
    return null;
  }

  /** その地点の縁石高さ。踏切の上では段差が潰れているので 0 に近づく。 */
  private curbHeightAt(cls: NetworkClass, segment: SegmentId, s: number): number {
    return cls.curbHeight * surfaceHeightScale(this.blends.get(segment) ?? [], s);
  }

  /**
   * 小物の足元の高さ。
   *
   * 基本は整地後の地形に合わせる (路肩が路面より少し低い所でも浮かない)。
   * 桁の上など地面が遠い所だけ、路面の高さに載せる。
   */
  private propGroundY(x: number, z: number, surfaceY: number): number {
    const terrain = this.field.heightAt(x, z);
    if (surfaceY - terrain > 1.5) return surfaceY - 0.05;
    return terrain - 0.05;
  }

  // ---------------------------------------------------------------- 踏切

  private buildCrossing(
    overlay: MeshBuilder,
    crossing: Crossing,
    structures: Map<SegmentId, StructureRun[]>,
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
    const build = buildLevelCrossing(
      overlay,
      crossing,
      { sampleAt: (s) => this.roadSampleAt(road.segment, s) },
      road.cls,
      crossing.rail.cls,
      {
        canPlace: (x, z, y) =>
          this.occupancy.isFree(x, z, {
            exceptSegments: [road.segment],
            margin: PROP_CLEARANCE,
            y,
          }),
        groundY: (x, z, surfaceY) => this.propGroundY(x, z, surfaceY),
        modeAt: (sample) => modeAt(structures.get(sample.segment) ?? [], sample.s),
      },
    );

    // 踏切の中だけ、レールの内側にフランジ溝を敷く。線路が舗装から
    // わずかしか出ていないので、これが無いとどこが線路か分かりにくい。
    const railAlignment = this.network.alignmentOf(crossing.rail.segment);
    // 舗装の中だけ。外まで伸ばすと、道床の上に溝が浮いてしまう。
    const sin = Math.max(
      0.26,
      Math.abs(road.dir.x * crossing.rail.dir.y - road.dir.y * crossing.rail.dir.x),
    );
    const reach = Math.max(1, road.cls.halfWidth / sin - 0.5);
    // 溝の高さは舗装から取る。道路の枠 (弧長・横距) に直してから、
    // 描画に使ったのと同じ路面 (踏切の傾き込み) を引く。
    const atCrossing = this.roadSampleAt(road.segment, road.s);
    const pavementY = (x: number, z: number): number | null => {
      if (!atCrossing) return null;
      const dx = x - atCrossing.pos.x;
      const dz = z - atCrossing.pos.z;
      const station = road.s + dx * atCrossing.forward.x + dz * atCrossing.forward.z;
      const lateral = dx * atCrossing.right.x + dz * atCrossing.right.z;
      if (Math.abs(lateral) > road.cls.halfWidth) return null;
      const sample = this.roadSampleAt(road.segment, station);
      return sample ? sample.pos.y + lateral * sample.roll : null;
    };
    buildFlangeways(
      overlay,
      alignmentSamplesInRange(
        railAlignment,
        Math.max(0, crossing.rail.s - reach),
        Math.min(railAlignment.length, crossing.rail.s + reach),
        1.5,
      ),
      crossing.rail.cls,
      pavementY,
    );

    for (const stop of build.stopStations) {
      buildCrossingStopLine(
        overlay,
        this.surfacePath(stop.segment),
        stop.s,
        road.cls,
        stop.forward,
      );
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
      const sample = applySurfaceBlend(
        [alignment.sampleAt(s)],
        this.blends.get(segment) ?? [],
      )[0];
      return {
        pos: sample.pos.clone(),
        right: sample.right.clone(),
        forward: sample.forward.clone(),
        segment,
        s,
        roll: sample.roll ?? 0,
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
        // 弧長が逆向きなら、右手側も反転するので横断勾配の符号も変わる。
        roll: -found.roll,
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

/**
 * 踏切のまわりで、整地断面の各点を道路側の高さへ持ち上げる。
 *
 * 点ごとに見るのが肝心で、線路の弧長だけで判定すると、斜め踏切の鋭角側に
 * できる楔形 (舗装には覆われていないのに、線路に沿って測ると踏切のすぐ
 * そば) を取りこぼし、そこだけ道床が地面に沈む。
 */
function liftForCrossings(
  points: Vector3[],
  centreY: number,
  zones: CrossingZone[],
  naturalDrop: number,
): void {
  const naturalOffset = -naturalDrop;
  // レール頭頂面より上には決して持ち上げない。勾配のある道路が斜めに
  // 横切る踏切では、路端の高さが交点のレール高より上にあるため。
  const ceiling = centreY - 0.03;
  for (const p of points) {
    const offset = crossingOffsetAt(zones, p.x, p.z, naturalOffset);
    if (offset > naturalOffset) p.y = Math.min(ceiling, Math.max(p.y, centreY + offset));
  }
}

/** その弧長がどの構造形式の区間に入るか。 */
function modeAt(runs: StructureRun[], s: number): StructureRun['mode'] {
  for (const run of runs) {
    if (s >= run.s0 && s <= run.s1) return run.mode;
  }
  return 'ground';
}

/** 断面の帯が中心線からどれだけ離れているか (中心線をまたぐ帯は 0)。 */
function bandDistance(a: number, b: number): number {
  if (a * b <= 0) return 0;
  return Math.min(Math.abs(a), Math.abs(b));
}

/**
 * 踏切のまわりで、整地目標を道路側に寄せる範囲。
 *
 * 判定は「道路の中心線からの垂距」で行う。線路の弧長で測ると、斜め踏切の
 * 鋭角側にできる楔形 (舗装には覆われていないのに、線路の弧長で見ると
 * 踏切のすぐ近く) を取りこぼし、そこだけ道床が埋まってしまう。
 */
interface CrossingZone {
  /** 踏切の位置。 */
  x: number;
  z: number;
  /** 道路の向き / 道路に直交する向き。 */
  roadDir: Vector2;
  roadNormal: Vector2;
  /** 踏切として扱う、道路に沿った範囲 [m]。 */
  railExtent: number;
  /** 舗装の半幅。ここまでは道路のもの。 */
  roadHalfWidth: number;
  /** 舗装の端からここまでで道床天端の高さまで下げる [m]。 */
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
 * 踏切を考慮した、その一点での整地目標 (線形 Y からのオフセット)。
 *
 * 舗装の下だけを譲って外側を放置すると、道路と同じ高さの地形がそのまま
 * 残ってレールまで埋まる。逆に舗装のすぐ脇で線路の断面 (法尻) まで
 * 落とすと、路端の下が 1 m 近く掘られて道路が浮く。そこで
 *   舗装の端 → 道床天端 → 法尻
 * と 2 段階で戻す。舗装の下は道路が焼く (`TerrainGrading.protect`)。
 */
function crossingOffsetAt(
  zones: CrossingZone[],
  x: number,
  z: number,
  naturalOffset: number,
): number {
  let offset = naturalOffset;
  for (const zone of zones) {
    const dx = x - zone.x;
    const dz = z - zone.z;
    if (Math.abs(dx * zone.roadDir.x + dz * zone.roadDir.y) > zone.railExtent) continue;
    const across = Math.abs(dx * zone.roadNormal.x + dz * zone.roadNormal.y);
    if (across >= zone.outer) continue;
    const zoneOffset =
      across < zone.shoulder
        ? lerp(
            zone.roadOffset,
            zone.shoulderOffset,
            smoothstep(
              (across - zone.roadHalfWidth) / Math.max(1e-6, zone.shoulder - zone.roadHalfWidth),
            ),
          )
        : lerp(
            zone.shoulderOffset,
            naturalOffset,
            smoothstep((across - zone.shoulder) / Math.max(1e-6, zone.outer - zone.shoulder)),
          );
    // 重なった場合は高い方を採る。低い方に合わせると路端の下が掘られる。
    offset = Math.max(offset, zoneOffset);
  }
  return offset;
}

/**
 * リングを外向きに `margin` [m] 広げる。整地の footprint を路面より広く
 * 取るため。
 *
 * 重心から放射状に広げると、細長いリングでは辺に対して垂直な余裕が
 * margin より狭くなり、路端のすぐ外の格子点が整地されずに残る。そこで
 * 辺の法線を使ったオフセット (マイター) にする。
 */
function expandRing(ring: Vector3[], margin: number): Vector3[] {
  const n = ring.length;
  if (n < 3 || margin <= 0) return ring.map((p) => p.clone());
  const sign = signedAreaXZ(ring) > 0 ? 1 : -1;
  return ring.map((p, i) => {
    const normal = edgeNormal(ring[(i - 1 + n) % n], p, sign).add(
      edgeNormal(p, ring[(i + 1) % n], sign),
    );
    const len = normal.length();
    if (len < 1e-6) return p.clone();
    normal.divideScalar(len);
    // 鋭角の頂点で伸びすぎないよう、マイター長に上限を設ける。
    const miter = margin / Math.max(0.4, normal.dot(edgeNormal(p, ring[(i + 1) % n], sign)));
    return new Vector3(p.x + normal.x * miter, p.y, p.z + normal.z * miter);
  });
}

/** XZ 平面での辺の外向き法線 (リングが反時計回りなら sign = 1)。 */
function edgeNormal(a: Vector3, b: Vector3, sign: number): Vector3 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return new Vector3();
  return new Vector3((dz / len) * sign, 0, (-dx / len) * sign);
}
