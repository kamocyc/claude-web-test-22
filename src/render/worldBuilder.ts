import {
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Material,
  type Texture,
  type Vector2,
} from 'three';
import type { Alignment, AlignmentSample } from '../core/alignment';
import { MeshBuilder, signedAreaXZ } from '../core/meshbuilder';
import { perp } from '../core/curve';
import {
  DECK_THICKNESS,
  PROP_MAX_DROP,
  PROP_MAX_RISE,
  TERRAIN_CELL,
  TUNNEL_THRESHOLD,
  clamp,
  lerp,
  smoothstep,
} from '../core/units';
import {
  GENTLE_CROSSING_LIFT,
  applySurfaceBlend,
  buildFlangeways,
  buildLevelCrossing,
  panelHalfLength,
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
  buildTurnArrows,
  type ApproachFrame,
  type SurfacePath,
} from '../build/markings';
import { buildBuilding, buildZoneGrid } from '../build/buildings';
import { buildCatenary, buildTrack } from '../build/rail';
import { TURNOUT_STEP, buildTurnouts, reverseSamples } from '../build/turnout';
import { buildStation, createStationLabels, stationFootprint } from '../build/station';
import { computeCant, type CantProfile } from '../build/cant';
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
  buildJunctionChamber,
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
  type RGB,
} from '../build/surface';
import { getClass, type NetworkClass } from '../network/classes';
import { findCrossings, type Crossing } from '../network/crossings';
import { solveJunctions, type Approach, type Junction } from '../network/junction';
import { solveApproachLanes } from '../network/lanes';
import type { Network, NodeId, SegmentId } from '../network/network';
import { buildLaneGraph, signalPhaseOf, type LaneGraph } from '../sim/lanegraph';
import { planLines, type LinePlan } from '../sim/lineRoute';
import { signalStateAt } from '../sim/signals';
import { Traffic } from '../sim/traffic';
import { VehicleView } from './vehicles';
import { buildConnectivity, type Connectivity } from '../network/connectivity';
import { Occupancy } from '../network/occupancy';
import {
  classify,
  clearStructureAtJunction,
  computeStructureProfile,
  forceRunMode,
  modeAt,
  unifyParallelRuns,
  type StructureMode,
  type StructureRun,
} from '../network/structure';
import {
  findParallelGroups,
  lateralOffsetAt,
  stationOf,
  type ParallelGroup,
} from '../network/parallel';
import {
  evaluateAlignment,
  curveBreakMessage,
  findCurveBreaks,
  findGradeBreaks,
  gradeBreakMessage,
  type SegmentDiagnostics,
} from '../network/validation';
import { TerrainGrading, type GridRegion } from '../terrain/grading';
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
import { ZoneMap, planZoning, type Lot, type ZoneCell } from '../network/zoning';
import { LineMap } from '../network/line';
import { buildLineOverlay } from '../build/lineOverlay';

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
  stations: number;
  bridgeLength: number;
  tunnelLength: number;
  totalLength: number;
  cost: number;
  /** 行き来できるひと繋がりの系統の数。 */
  roadNetworks: number;
  railNetworks: number;
  powerNetworks: number;
  /** 沿道に割り付けた区画のマスの数。 */
  zoneCells: number;
  /** マスをまとめて建てた建物の数。 */
  buildings: number;
  /** 引いた路線の数。 */
  lines: number;
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
  /** 平行に並んでいると判定した線形のまとまり。 */
  parallelGroups: ParallelGroup[];
  /** 沿道に割り付けた区画のマス目。 */
  zoneCells: ZoneCell[];
  /** マスをまとめた、建物 1 棟ぶんの敷地。 */
  lots: Lot[];
  /** 路線ごとの運転計画 (経路・折り返し・繋がっていない区間)。 */
  lines: LinePlan[];
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

/**
 * 橋の下で地形を抑える高さ (路面からの下げ量) [m]。
 * 桁の下面 (床版厚) より少し下に取り、桁と地形の間を空ける。
 */
const DECK_CLEARANCE = DECK_THICKNESS + 0.3;

/** 架空線で飛ばせる径間の上限 (電柱の間隔の何倍まで)。 */
const MAX_AERIAL_SPANS = 1.6;

/** 上を越す線形が跨ぐ範囲に、さらに足す余裕 [m]。 */
const CROSSING_TUNNEL_MARGIN = 8;

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
  /**
   * 路面 (舗装・交差点面) のメッシュ。
   *
   * カーソルの当たり判定に使う。地形だけを見ていると、橋の上を指しても
   * 橋の下の地面を指したことになってしまう。
   */
  readonly surfaceMesh: Mesh;
  private readonly overlayMesh: Mesh;
  private readonly structureMesh: Mesh;
  /**
   * 地下区間を地表へ投影して見せる影。
   *
   * 地上を見ているときに出すと、地面の下を通っているだけの線形が
   * 地表に描かれてしまう。地下ビューのときだけ出し、実深度の X-ray と
   * 組にして「地表から見てどこを通っているか」を示す。
   */
  private readonly undergroundShadowMesh: Mesh;
  /** 地下ビューで実際の深さに重ねる X-ray 表示。 */
  private readonly undergroundHighlightMesh: Mesh;
  /** 沿道の区画 (マス目)。区画ツールを使っている間だけ出す。 */
  private readonly zoneGridMesh: Mesh;
  /** 路線の経路。路線ツールを使っている間だけ出す。 */
  private readonly lineMesh: Mesh;
  /** 区画に建った建物。 */
  private readonly buildingMesh: Mesh;
  private readonly propGroup = new Group();
  private readonly grading: TerrainGrading;

  private signals: SignalAssembly[] = [];
  private gates: CrossingGate[] = [];
  private props: PropPlacement[] = [];
  /** 直近の rebuild で作った占有索引。小物の位置決めに使う。 */
  private occupancy!: Occupancy;
  /** 直近の rebuild で使った、踏切に合わせた高さ補正。 */
  private blends = new Map<SegmentId, SurfaceBlend[]>();
  private cant = new Map<SegmentId, CantProfile>();
  private structureRuns = new Map<SegmentId, StructureRun[]>();

  /**
   * 面の塗り方。`connectivity` にすると、行き来できる系統ごとに色を変える。
   * どこがどこと繋がっているのかを一目で確かめるための表示。
   */
  colorMode: 'normal' | 'connectivity' = 'normal';

  /** 最後に解いた交差点情報。ツール側のスナップやハイライトで使う。 */
  junctions = new Map<NodeId, Junction>();
  crossings: Crossing[] = [];
  /** 最後に見つけた、平行に並んでいる線形のまとまり。 */
  parallelGroups: ParallelGroup[] = [];

  /** 最後に組み立てた車線グラフ。 */
  laneGraph: LaneGraph = { lanes: [], spawnable: [] };
  /** 車両のシミュレーション。 */
  readonly traffic = new Traffic(this.laneGraph);
  private readonly vehicleView = new VehicleView();
  /** 車両を走らせるか。 */
  showVehicles = true;
  /**
   * 沿道に塗った用途。
   *
   * 区画そのものは毎回ネットワークから作り直すが、「どこに何を塗ったか」は
   * ここに残る。道路を引き直しても塗りが消えない。
   */
  readonly zones = new ZoneMap();
  /** 区画のマス目を表示するか (区画ツールを使っている間)。 */
  showZones = false;
  /**
   * 引いた路線。
   *
   * 区画と同じで、持っているのは「どの駅にどの順で停まるか」だけ。経路は
   * 敷き直すたびに引き直すので、線路を付け替えても路線は生き続ける。
   */
  readonly lines = new LineMap();
  /** 直近の rebuild で引いた運転計画。 */
  linePlans: LinePlan[] = [];
  /** 路線の経路を表示するか (路線ツールを使っている間)。 */
  showLines = false;
  /** 地下ビューの最中か。地上の表示を出すかどうかの判断に使う。 */
  private undergroundView = false;
  /** 直近の rebuild で割り付けた区画。 */
  zoneCells: ZoneCell[] = [];
  lots: Lot[] = [];
  /** 選択色で塗る車両の番号 (乗る車両を選んでいるとき)。 */
  highlightVehicle: number | null = null;

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
    this.undergroundShadowMesh = new Mesh(
      new MeshBuilder().build(),
      new MeshBasicMaterial({
        color: 0x173d59,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: -12,
        side: DoubleSide,
      }),
    );
    this.undergroundShadowMesh.name = 'underground-shadows';
    this.undergroundShadowMesh.renderOrder = 4;
    this.undergroundShadowMesh.visible = false;
    this.undergroundHighlightMesh = new Mesh(
      new MeshBuilder().build(),
      new MeshBasicMaterial({
        color: 0x5bd8ff,
        transparent: true,
        opacity: 0.72,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    this.undergroundHighlightMesh.name = 'underground-xray';
    this.undergroundHighlightMesh.renderOrder = 12;
    this.undergroundHighlightMesh.visible = false;
    this.zoneGridMesh = new Mesh(
      new MeshBuilder().build(),
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: -10,
        side: DoubleSide,
      }),
    );
    this.zoneGridMesh.name = 'zones';
    this.zoneGridMesh.renderOrder = 5;
    this.zoneGridMesh.visible = false;
    this.lineMesh = new Mesh(
      new MeshBuilder().build(),
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 0,
        polygonOffsetUnits: -14,
        side: DoubleSide,
      }),
    );
    this.lineMesh.name = 'lines';
    this.lineMesh.renderOrder = 6;
    this.lineMesh.visible = false;
    this.buildingMesh = new Mesh(new MeshBuilder().build(), createPropMaterial());
    this.buildingMesh.name = 'buildings';
    this.buildingMesh.castShadow = true;
    this.buildingMesh.receiveShadow = true;
    this.propGroup.name = 'props';

    this.group.add(
      this.surfaceMesh,
      this.overlayMesh,
      this.structureMesh,
      this.undergroundShadowMesh,
      this.undergroundHighlightMesh,
      this.zoneGridMesh,
      this.lineMesh,
      this.buildingMesh,
      this.propGroup,
      this.vehicleView.group,
    );
  }

  /** 区画のマス目の表示を切り替える。 */
  setZoneView(active: boolean): void {
    this.showZones = active;
    // 地下を見ている間は地上の表示を伏せる (地下ビューを抜けたら戻す)。
    this.zoneGridMesh.visible = active && !this.undergroundView;
  }

  /** 路線の経路の表示を切り替える。 */
  setLineView(active: boolean): void {
    this.showLines = active;
    this.lineMesh.visible = active && !this.undergroundView;
  }

  /** 地形を透かし、地下区間だけを実際の深さで強調する。 */
  setUndergroundView(active: boolean): void {
    this.undergroundView = active;
    this.terrainMesh.setUndergroundView(active);
    this.undergroundShadowMesh.visible = active;
    this.undergroundHighlightMesh.visible = active;

    setMeshFade(this.surfaceMesh, active ? 0.24 : 1, active);
    setMeshFade(this.overlayMesh, active ? 0.18 : 1, active);
    setMeshFade(this.structureMesh, active ? 0.28 : 1, active);
    this.buildingMesh.visible = !active;
    this.zoneGridMesh.visible = this.showZones && !active;
    this.lineMesh.visible = this.showLines && !active;
    this.propGroup.visible = !active;
    this.vehicleView.group.visible = !active;
  }

  rebuild(): BuildResult {
    const network = this.network;
    const warnings: WorldWarning[] = [];

    const crossings = findCrossings(network);
    this.crossings = crossings;

    // 線路のカント。曲率から導くので、緩和曲線でそのまま立ち上がる。
    // 交差点の面と踏切の手前では 0 に戻る (面がねじれないように)。
    // 踏切の目標面がカントを見るので、踏切の補正より先に用意する。
    this.cant = computeCant(network, crossings);

    // 踏切に合わせた道路側の高さ補正をセグメントごとにまとめる。
    // 交差点の断面もこの高さで作る必要があるので、交差点を解く前に用意する。
    const blends = this.collectCrossingBlends(crossings, warnings);
    this.blends = blends;
    // 帯・交差点の取り付き断面・標示・当たり判定が、みな同じ点を通るように
    // 「描画に使う高さの補正」をここ 1 か所から配る。
    const blendAt = (segment: SegmentId, s: number) => {
      const blend = surfaceBlendAt(
        blends.get(segment) ?? [],
        s,
        network.alignmentOf(segment).sampleAt(s).pos.y,
      );
      return {
        dy: blend.dy,
        roll: blend.roll + this.cantAt(segment, s),
        heightScale: surfaceHeightScale(blends.get(segment) ?? [], s),
      };
    };

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

    // All tracks in a station share the selected ground/elevated structure.
    for (const station of network.stations.values()) {
      for (const track of station.tracks) {
        const range = ranges.get(track.segment);
        if (range) {
          structures.set(track.segment, [
            { mode: station.elevated ? 'bridge' : 'ground', s0: range.s0, s1: range.s1 },
          ]);
        }
      }
    }

    // 平行に並んでいる線形どうしは、橋・トンネルの区間を揃える。並んだ
    // 線が同じ谷を渡っているのに桁の始まりが数 m ずれる、といったことを
    // 防ぐ (揃えれば桁も坑門も横に並んで 1 つの構造物に見える)。
    const parallelGroups = findParallelGroups(network);
    this.parallelGroups = parallelGroups;
    for (const group of parallelGroups) {
      const members = group.members.map((id) => ({
        alignment: network.alignmentOf(id),
        runs: structures.get(id)!,
        range: ranges.get(id)!,
      }));
      unifyParallelRuns(members).forEach((runs, i) => structures.set(group.members[i], runs));
    }

    // 交差点の口に坑門・橋台が食い込まないよう、地形の上で地表になる分は
    // 地表に戻す。トンネルの中に交差点がある配置は敷設規則が止めるので、
    // ここで戻せない配置は残らない。
    for (const seg of network.segments.values()) {
      const runs = structures.get(seg.id);
      const range = ranges.get(seg.id);
      if (!runs || !range) continue;
      const ends = {
        start: (junctions.get(seg.a)?.rings.length ?? 0) > 0,
        end: (junctions.get(seg.b)?.rings.length ?? 0) > 0,
      };
      if (!ends.start && !ends.end) continue;
      structures.set(
        seg.id,
        clearStructureAtJunction(network.alignmentOf(seg.id), this.field, runs, range, ends),
      );
    }

    // 立体交差の上側は、盛土になる高さでも橋にする。そうしないと下をくぐる
    // 線形が盛土に埋まってしまう。ただし下がトンネルの中なら埋まりようが
    // ないので、上は素直に地表のままにする。
    for (const crossing of crossings) {
      if (crossing.kind !== 'separated' && crossing.kind !== 'insufficient') continue;
      if (this.crossesOverTunnel(structures, crossing)) continue;
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

    // 整地は「触った範囲」を返す。地形メッシュもそこだけ書き換える。
    this.terrainMesh.update(this.applyGrading(junctions, structures, crossingZones, blends));

    // 小物を置く前に、どこが道路・線路・交差点に覆われているかを索引にする。
    this.occupancy = new Occupancy(network, {
      junctions,
      heightOffset: (segment, s, y) => surfaceBlendAt(blends.get(segment) ?? [], s, y).dy,
    });

    const surface = new MeshBuilder();
    const overlay = new MeshBuilder();
    const structure = new MeshBuilder();
    const undergroundShadow = new MeshBuilder();
    const undergroundHighlight = new MeshBuilder();
    this.clearProps();

    const stats: WorldStats = {
      segments: network.segments.size,
      nodes: network.nodes.size,
      intersections: 0,
      turnouts: 0,
      levelCrossings: 0,
      stations: network.stations.size,
      lines: 0,
      bridgeLength: 0,
      tunnelLength: 0,
      totalLength: 0,
      cost: 0,
      roadNetworks: 0,
      railNetworks: 0,
      powerNetworks: 0,
      zoneCells: 0,
      buildings: 0,
    };
    const diagnostics = new Map<SegmentId, SegmentDiagnostics>();

    // トンネルの中で線形が繋がるノード。ここにはトンネルの端があるが、
    // 坑口ではない (先にもトンネルが続く)。坑門を建てると、長いトンネルの
    // 途中に壁が立ち、交差点では枝の口を塞いでしまう。
    const underground = new Set<NodeId>();
    for (const node of network.nodes.values()) {
      if (network.branchesAt(node.id).length < 2) continue;
      if (classify(node.pos.y, this.field.baseHeightAt(node.pos.x, node.pos.z)) === 'tunnel') {
        underground.add(node.id);
      }
    }

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
        {
          range,
          openEnds: { start: underground.has(seg.a), end: underground.has(seg.b) },
        },
      );
      this.buildUndergroundGuides(
        undergroundShadow,
        undergroundHighlight,
        alignment,
        cls,
        runs,
        blends.get(seg.id) ?? [],
        seg.id,
      );
      if (cls.kind === 'road') {
        buildLaneMarkings(overlay, this.surfacePath(seg.id), range, cls);
      }
    }

    for (const station of network.stations.values()) {
      buildStation(surface, overlay, structure, station, (x, z) => this.field.heightAt(x, z));
      this.propGroup.add(createStationLabels(station));
    }

    // 継ぎ目で縦断が折れている所。均しは規格の範囲でしか動かせないので、
    // 詰めきれずに残ることがある。黙って作らずに報せる。
    for (const brk of findGradeBreaks(network)) {
      warnings.push({
        message: gradeBreakMessage(brk),
        position: brk.pos.clone(),
        severity: 'warning',
      });
    }

    // 継ぎ目で平面線形が切れている所 (線路)。レールは曲がり角にも曲率の
    // 飛びにも折り合えないので、残っていたら同じように報せる。
    for (const brk of findCurveBreaks(network)) {
      warnings.push({
        message: curveBreakMessage(brk),
        position: brk.pos.clone(),
        severity: 'warning',
      });
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

    this.buildCatenaries(structure, structures, parallelGroups);

    for (const crossing of crossings) {
      if (crossing.message) {
        warnings.push({
          message: crossing.message,
          position: crossing.point.clone(),
          severity: crossing.kind === 'conflict' ? 'error' : 'warning',
        });
      }
    }

    // 並んだ線路を渡る所は、1 か所の踏切としてまとめて作る。線路ごとに
    // 作ると、線路と線路の間に遮断機と停止線が入り込んでしまう。
    for (const group of groupLevelCrossings(crossings)) {
      this.buildCrossing(overlay, group, structures, stats);
    }

    // 沿道の区画と建物。道路・線路・交差点の索引ができたあとに割り付ける。
    const zoneGrid = new MeshBuilder();
    const buildings = new MeshBuilder();
    const zoning = planZoning({
      network,
      structures,
      ranges,
      occupancy: this.occupancy,
      field: this.field,
      zones: this.zones,
    });
    this.zoneCells = zoning.cells;
    this.lots = zoning.lots;
    const groundAt = (x: number, z: number): number => this.field.heightAt(x, z);
    buildZoneGrid(zoneGrid, this.zoneCells, groundAt);
    for (const lot of this.lots) buildBuilding(buildings, lot, groundAt);
    stats.zoneCells = this.zoneCells.length;
    stats.buildings = this.lots.length;

    const power = this.buildPower(structure, structures, ranges);
    const powerNetworks = countPowerNetworks(power.poles, power.spans);
    stats.roadNetworks = connectivity.components.filter((c) => c.kind === 'road').length;
    stats.railNetworks = connectivity.components.filter((c) => c.kind === 'rail').length;
    stats.powerNetworks = powerNetworks;

    this.replaceGeometry(this.surfaceMesh, surface);
    this.replaceGeometry(this.overlayMesh, overlay);
    this.replaceGeometry(this.structureMesh, structure);
    this.replaceGeometry(this.undergroundShadowMesh, undergroundShadow);
    this.replaceGeometry(this.undergroundHighlightMesh, undergroundHighlight);
    this.replaceGeometry(this.zoneGridMesh, zoneGrid);
    this.replaceGeometry(this.buildingMesh, buildings);

    // 車線グラフは形が変わるたびに作り直す。走っている車両は捨てる
    // (通れなくなった車線に取り残された車が残り続けるのを防ぐ)。
    // 車が走る高さは、描画に使った路面と同じにする。踏切のまわりで
    // 舗装が上下する分を無視すると、車が路面の下を通ることになる。
    // 走る高さも傾きも、描画に使った路面と同じ (`blendAt`) を見る。踏切の
    // 上下だけでなくカントも通るので、曲線では車体がカントのぶん傾く。
    this.laneGraph = buildLaneGraph(network, junctions, ranges, { surface: blendAt });
    this.traffic.reset(this.laneGraph);
    this.vehicleView.clear();
    this.structureRuns = structures;

    // 路線の経路は車線グラフの上に引くので、グラフを組み立てたあとに引き直す。
    // 撤去された駅は停車駅から落とす。
    this.lines.prune(new Set(network.stations.keys()));
    this.linePlans = planLines(this.laneGraph, this.lines.all, network.stations);
    this.traffic.setLines(this.linePlans);
    stats.lines = this.linePlans.length;
    const lineOverlay = new MeshBuilder();
    buildLineOverlay(lineOverlay, this.linePlans, this.laneGraph, network.stations);
    this.replaceGeometry(this.lineMesh, lineOverlay);

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
      parallelGroups,
      zoneCells: this.zoneCells,
      lots: this.lots,
      lines: this.linePlans,
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
  private collectCrossingBlends(
    crossings: Crossing[],
    warnings: WorldWarning[],
  ): Map<SegmentId, SurfaceBlend[]> {
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
        this.cantAt(crossing.rail.segment, crossing.rail.s),
      );
      add(blend.segment, blend);
      if (blend.lift > GENTLE_CROSSING_LIFT) {
        warnings.push({
          message:
            `踏切に合わせて道路を ±${blend.lift.toFixed(1)} m すり付けています ` +
            '(交差角を大きくするか、道路の勾配を緩めると穏やかになります)。',
          position: crossing.point.clone(),
          severity: 'warning',
        });
      }

      const seg = network.segments.get(blend.segment);
      if (!seg) continue;
      const length = network.alignmentOf(blend.segment).length;

      // すり付けは隣のセグメントへはみ出す。区間が短ければその先へも続く
      // ので、届く範囲まで道路を辿って配る (1 つ隣までで止めると、そこで
      // 補正が切れて段差になる)。
      const seen = new Set<SegmentId>([blend.segment]);
      const spill = (fromId: SegmentId, nodeId: NodeId, distance: number, sign: number): void => {
        if (distance >= blend.halfLength) return;
        const node = network.nodes.get(nodeId);
        const from = network.segments.get(fromId);
        if (!node || !from) return;
        for (const otherId of [...node.segments]) {
          if (seen.has(otherId)) continue;
          const other = network.segments.get(otherId);
          if (!other || network.classOf(other).kind !== 'road') continue;
          seen.add(otherId);
          // 隣のセグメントから見た踏切の弧長 (範囲外の値になる)。
          const otherAlignment = network.alignmentOf(otherId);
          const startsHere = other.a === nodeId;
          const s = startsHere ? -distance : otherAlignment.length + distance;
          // 2 本が同じノードから同じ向きに出ていれば、弧長の向きは逆。
          // 傾きの符号もそのぶん反転させないと、隣で逆向きに傾く。
          const next = (from.a === nodeId) === startsHere ? -sign : sign;
          spills.push({
            segment: otherId,
            blend: {
              ...blend,
              s,
              // 目標面は絶対高さなので、弧長の向きが逆になる分だけ
              // 勾配と横断勾配の符号を反転させればよい。
              targetSlope: blend.targetSlope * next,
              roadGrade: blend.roadGrade * next,
              roll: blend.roll * next,
            },
          });
          spill(otherId, startsHere ? other.b : other.a, distance + otherAlignment.length, next);
        }
      };
      spill(seg.id, seg.a, blend.s, 1);
      spill(seg.id, seg.b, length - blend.s, 1);
    }
    for (const { segment, blend } of spills) add(segment, blend);
    return blends;
  }

  /**
   * その弧長の構造形式。まだ組み立てていなければ地表とみなす。
   * 確認モードの読み取りに使う。
   */
  structureModeAt(segment: SegmentId, s: number): StructureMode {
    return modeAt(this.structureRuns.get(segment) ?? [], s);
  }

  /** その区間の構造形式の並び。まだ組み立てていなければ空。 */
  structureRunsOf(segment: SegmentId): readonly StructureRun[] {
    return this.structureRuns.get(segment) ?? [];
  }

  /** サンプル列にカントを乗せる (踏切の補正の上に重ねる)。 */
  private withCant(samples: AlignmentSample[], segment: SegmentId): AlignmentSample[] {
    const profile = this.cant.get(segment);
    if (!profile) return samples;
    return samples.map((sample) => {
      const roll = profile(sample.s);
      return roll === 0 ? sample : { ...sample, roll: (sample.roll ?? 0) + roll };
    });
  }

  /**
   * その弧長で描画に使ったカント (横断勾配)。線路以外・交差点の面の中では 0。
   * 検査コードが「実際に描かれた面」を再現するのにも使う。
   */
  cantAt(segment: SegmentId, s: number): number {
    return this.cant.get(segment)?.(s) ?? 0;
  }

  /**
   * 枝のセグメントを、ノードから外向きに `distance` [m] たどった点列。
   *
   * 接線で分かれる分岐器 (交差点のトリムが 0) では、分岐器の造作は交差点の
   * 中ではなく枝そのものの上に載る。レールを描くのに使ったのと同じ線形・
   * 同じカントでたどらないと、造作だけがレールから浮いてしまう。
   */
  private railPathOutward(approach: Approach, distance: number): AlignmentSample[] {
    const segment = approach.branch.segment;
    const alignment = this.network.alignmentOf(segment);
    // 枝がノードに付いている端から、反対の端へ向かってたどる。
    const atStart = approach.branch.atStart;
    const from = atStart ? approach.trim : alignment.length - approach.trim;
    const to = clamp(atStart ? from + distance : from - distance, 0, alignment.length);
    const samples = this.withCant(
      alignmentSamplesInRange(alignment, Math.min(from, to), Math.max(from, to), TURNOUT_STEP),
      segment,
    );
    return atStart ? samples : reverseSamples(samples);
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
   * 立体交差の下側が、交点のところでトンネルの中を通っているか。
   *
   * 地中を通っているものは盛土に埋まらないので、上を橋にする理由がない。
   * 橋にすると、地面の上に何も跨がない桁が残ってしまう (道路がトンネルに
   * なっている丘の上を線路が越える、といった配置)。
   *
   * 見るのは 2 つ。
   *
   *  - **上側が跨ぐ範囲がすべてトンネル**であること。坑口が交点にかかって
   *    いれば、露出している所が盛土で埋まるので橋のままにする。斜めに
   *    交わるほど跨ぐ範囲は長くなるので、交差角も見る。
   *  - 上側の整地が終わっても**土被りが残る**こと。上側が深い切土だと、
   *    掘った先にトンネルが顔を出しかねない。
   */
  private crossesOverTunnel(
    structures: Map<SegmentId, StructureRun[]>,
    crossing: Crossing,
  ): boolean {
    const runs = structures.get(crossing.lower);
    if (!runs || runs.length === 0) return false;
    const lower = this.network.alignmentOf(crossing.lower);
    const upper = this.network.alignmentOf(crossing.upper);
    const lowerSample = lower.sampleAt(crossing.sLower);
    const upperSample = upper.sampleAt(crossing.sUpper);

    // 上側の整地が終わったあとに残る土被り。
    if (upperSample.pos.y - lowerSample.pos.y < TUNNEL_THRESHOLD) return false;

    const upperClass = this.network.classOf(this.network.getSegment(crossing.upper));
    const sinTheta = Math.abs(
      upperSample.forwardXZ.x * lowerSample.forwardXZ.y -
        upperSample.forwardXZ.y * lowerSample.forwardXZ.x,
    );
    const reach = (upperClass.halfWidth / Math.max(0.26, sinTheta)) + CROSSING_TUNNEL_MARGIN;
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const s = clamp(crossing.sLower - reach + (2 * reach * i) / steps, 0, lower.length);
      if (modeAt(runs, s) !== 'tunnel') return false;
    }
    return true;
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
  ): GridRegion | null {
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
          if (run.mode !== 'bridge') continue;
          // 桁の下に地形が残るのは正しいが、桁より上に出てはいけない。
          // 立体交差やトンネル坑口の都合で地形より低い所を橋にしたとき、
          // そのままでは地形が路面に被さる。
          const c = gradingEdges(samples[i], cls.halfWidth + 1, DECK_CLEARANCE);
          const d = gradingEdges(samples[i + 1], cls.halfWidth + 1, DECK_CLEARANCE);
          grading.carveQuad(c.left, d.left, d.right, c.right);
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
                // footprint の外周は路肩の余裕幅 (margins) が持っている。
                interior: true,
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

    // Ground stations flatten their whole footprint. Elevated stations preserve the
    // terrain and only clear the volume directly below the shared deck.
    for (const station of this.network.stations.values()) {
      const ring = stationFootprint(
        station,
        0,
        station.center.y - gradingDrop(getClass('rail_single')),
      );
      if (station.elevated) {
        grading.blockQuad(ring[0], ring[1], ring[2], ring[3]);
        const carved = ring.map((point) => point.clone().setY(station.center.y - DECK_CLEARANCE));
        grading.carveQuad(carved[0], carved[1], carved[2], carved[3]);
      } else {
        grading.stampPolygon(ring, { distance: 0 });
      }
    }

    for (const margin of margins) {
      grading.stampQuad(margin.quad[0], margin.quad[1], margin.quad[2], margin.quad[3], {
        core: false,
      });
    }

    return grading.apply();
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
        else {
          grading.stampQuad(quad[0], quad[1], quad[2], quad[3], {
            ignoreProtected,
            distance,
            interior: true,
          });
        }
      }
    }
    grading.stampPolygon(bands[bands.length - 1], {
      ignoreProtected,
      distance: 0,
      interior: true,
    });
  }

  // ------------------------------------------------------------ セグメント

  /**
   * トンネル区間を、通常ビュー用の地表の影と地下ビュー用の実深度表示へ分けて描く。
   */
  private buildUndergroundGuides(
    shadow: MeshBuilder,
    highlight: MeshBuilder,
    alignment: Alignment,
    cls: NetworkClass,
    runs: StructureRun[],
    blends: SurfaceBlend[],
    segment: SegmentId,
  ): void {
    const flatProfile = [
      { offset: -cls.halfWidth, height: 0, color: [1, 1, 1] as RGB },
      { offset: cls.halfWidth, height: 0, color: [1, 1, 1] as RGB },
    ];
    for (const run of runs) {
      if (run.mode !== 'tunnel') continue;
      const raw = alignmentSamplesInRange(alignment, run.s0, run.s1, 2.5);
      if (raw.length < 2) continue;

      const actual = this.withCant(applySurfaceBlend(raw, blends), segment);
      buildRibbon(highlight, actual, flatProfile, { skirt: false, cls });

      const projected: AlignmentSample[] = raw.map((sample) => ({
        ...sample,
        pos: new Vector3(
          sample.pos.x,
          this.field.heightAt(sample.pos.x, sample.pos.z) + 0.22,
          sample.pos.z,
        ),
        forward: new Vector3(sample.forwardXZ.x, 0, sample.forwardXZ.y),
        grade: 0,
        roll: 0,
      }));
      buildRibbon(shadow, projected, flatProfile, { skirt: false, cls });
    }
  }

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
    /** 区間の範囲と、トンネルの中の交差点へ開く端。 */
    tunnelEnds?: { range: { s0: number; s1: number }; openEnds: { start: boolean; end: boolean } },
  ): void {
    const profile = profileFor(cls);
    const ground = (x: number, z: number): number => this.field.heightAt(x, z);

    for (const run of runs) {
      const raw = alignmentSamplesInRange(alignment, run.s0, run.s1, 2.5);
      if (raw.length < 2) continue;
      const samples = this.withCant(applySurfaceBlend(raw, blends), segment);

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
        if (!this.network.getSegment(segment).stationTrack) buildBridge(structure, samples, cls, this.field, {
          // 橋脚を下を通る道路・線路の真ん中に建てない。
          canPlace: (x, z, y) => this.canPlaceProp(x, z, y, [segment]),
        });
      } else if (run.mode === 'tunnel') {
        stats.tunnelLength += run.s1 - run.s0;
        // 交差点の空洞へ開く端には坑門を建てない。
        const range = tunnelEnds?.range;
        buildTunnel(structure, samples, cls, this.field, {
          start: !(
            tunnelEnds?.openEnds.start &&
            range !== undefined &&
            run.s0 <= range.s0 + 1e-3
          ),
          end: !(
            tunnelEnds?.openEnds.end &&
            range !== undefined &&
            run.s1 >= range.s1 - 1e-3
          ),
        });
      }
    }

    if (cls.kind === 'rail') {
      const first = runs[0];
      const last = runs[runs.length - 1];
      if (first && last) {
        const samples = this.withCant(
          alignmentSamplesInRange(alignment, first.s0, last.s1, 1.5),
          segment,
        );
        buildTrack(structure, samples, cls.tracks.length ? cls.tracks : [0]);
      }
    }
  }

  /** 小物を立ててよい場所か (自分の線形は除く)。 */
  private canPlaceProp(x: number, z: number, y: number | undefined, own: SegmentId[]): boolean {
    return this.occupancy.isFree(x, z, {
      exceptSegments: own,
      margin: PROP_CLEARANCE,
      y,
    });
  }

  /**
   * 架線柱を建てる。
   *
   * 平行に並んだ線路は 1 つのまとまりとして扱い、**まとめて 1 基の門型**で
   * 受ける。線路ごとに建てると、複線の間に柱が林立してしまう。区間
   * (地表・橋・トンネル) は既に揃えてあるので、まとまりの代表 1 本の
   * 区間をたどれば、並んだ線のどこに柱が要るかが決まる。
   */
  private buildCatenaries(
    structure: MeshBuilder,
    structures: Map<SegmentId, StructureRun[]>,
    groups: ParallelGroup[],
  ): void {
    const groupOf = new Map<SegmentId, SegmentId[]>();
    for (const group of groups) {
      if (group.kind !== 'rail') continue;
      // 代表は ID がいちばん小さい線。その断面で並びを測る。
      for (const id of group.members) groupOf.set(id, group.members);
    }

    for (const seg of this.network.segments.values()) {
      const cls = this.network.classOf(seg);
      if (cls.kind !== 'rail') continue;
      // 駅構内はホーム上屋と干渉しないよう、駅専用の支持物に任せる。
      if (seg.stationTrack) continue;
      const members = groupOf.get(seg.id);
      // まとまりの代表以外は、代表が建てた門型に吊るので何もしない。
      if (members && members[0] !== seg.id) continue;

      const alignment = this.network.alignmentOf(seg.id);
      const partners = (members ?? [])
        .filter((id) => id !== seg.id)
        .map((id) => this.network.alignmentOf(id));
      const own = members ?? [seg.id];
      /** その点にいちばん近い線形。門型の柱の持ち主を決めるのに使う。 */
      const nearestOf = (at: Vector3, candidates: SegmentId[]): SegmentId => {
        let best = candidates[0];
        let bestDistance = Infinity;
        for (const id of candidates) {
          const other = this.network.alignmentOf(id);
          const p = other.sampleAt(stationOf(other, at.x, at.z)).pos;
          const d = (p.x - at.x) ** 2 + (p.z - at.z) ** 2;
          if (d < bestDistance) {
            bestDistance = d;
            best = id;
          }
        }
        return best;
      };

      for (const run of structures.get(seg.id) ?? []) {
        if (run.mode === 'tunnel') continue;
        const samples = alignmentSamplesInRange(alignment, run.s0, run.s1, 2.5);
        if (samples.length < 2) continue;
        const bases = buildCatenary(structure, samples, cls, {
          canPlace: (x, z, y) => this.canPlaceProp(x, z, y, own),
          offsetsAt: (s) => {
            const offsets = [0];
            for (const other of partners) {
              const lateral = lateralOffsetAt(alignment, s, other);
              if (lateral !== null) offsets.push(lateral);
            }
            return offsets;
          },
        });
        // 門型の柱は外側の軌道の路肩に立つので、その軌道の持ち物として
        // 記録する (どの線形の路側にあるかで検証されるため)。
        for (const base of bases) {
          this.props.push({ kind: 'catenaryPole', position: base, segment: nearestOf(base, own) });
        }
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
    for (const message of junction.errors) {
      warnings.push({ message, position: node.pos.clone(), severity: 'error' });
    }

    if (junction.kind === 'intersection') stats.intersections++;
    if (junction.kind === 'railSwitch' && junction.approaches.length >= 3) stats.turnouts++;

    const cls = junction.approaches[0]?.branch.cls;
    if (!cls) return;

    if (cls.kind !== 'rail') {
      buildJunctionSurface(
        surface,
        junction.rings,
        cls,
        junction.openEdge,
        (x, z) => this.field.heightAt(x, z),
        tint,
      );
    }

    // 高い所にある交差点には床版と橋脚を付ける。付けないと路面だけが宙に浮く。
    const terrain = this.field.baseHeightAt(node.pos.x, node.pos.z);
    // トンネルの中の交差点は、地中の空洞として囲う。囲わないと交差点面が
    // 山の中に埋まったままになる。
    if (classify(node.pos.y, terrain) === 'tunnel' && junction.rings.length > 0) {
      // 覆工は舗装のすぐ外に立てる (面の上に出すと建築限界に食い込む)。
      buildJunctionChamber(
        structure,
        expandRing(junction.rings[0], 0.4),
        cls,
        this.field,
        junction.openEdge,
      );
    }
    if (classify(node.pos.y, terrain) === 'bridge' && junction.rings.length > 0) {
      buildJunctionDeck(structure, junction.rings[0], cls, this.field, {
        canPlace: (x, z, y) =>
          this.canPlaceProp(
            x,
            z,
            y,
            junction.approaches.map((a) => a.branch.segment),
          ),
      });
    }

    if (cls.kind === 'rail') {
      // 線路の交差点には面も中身も無く、枝の帯がノードまで通っている。
      // その帯の上に、分岐器の金物だけを載せる。
      buildTurnouts(structure, junction, {
        branchPath: (approach, distance) => this.railPathOutward(approach, distance),
        canPlace: (x, z, y) =>
          this.canPlaceProp(x, z, y, junction.approaches.map((a) => a.branch.segment)),
      });
      return;
    }

    if (junction.kind !== 'intersection' && junction.kind !== 'joint') return;

    // 進行方向別通行区分 (右折・左折車線) は交差点ごとに決まる。
    const laneAssignment = solveApproachLanes(junction);
    for (const approach of junction.approaches) {
      const frame = this.approachFrame(approach);
      if (junction.kind !== 'intersection') continue;
      buildCrosswalk(overlay, frame);
      buildStopLine(overlay, frame);
      const lanes = laneAssignment.get(approach.branch.segment);
      if (!lanes) continue;
      buildTurnArrows(
        overlay,
        frame,
        lanes.entry.map((entry) => ({
          // 断面の横距は線形基準なので、外向き基準に直す。
          offset: approach.branch.atStart ? entry.lane.offset : -entry.lane.offset,
          width: entry.lane.width,
          movements: entry.movements,
        })),
      );
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
        phase: signalPhaseOf(index),
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
    // 路肩の地形は、格子の粗さを吸収するぶんだけ路面より低く均してある
    // (`gradingSectionPoints` の shift)。そこへ素直に立てると、勾配のきつい
    // 道路で小物だけが路面から取り残される。路肩として自然な範囲で止める。
    return Math.max(terrain - 0.05, surfaceY - PROP_MAX_DROP);
  }

  // ---------------------------------------------------------------- 踏切

  /**
   * 踏切 1 か所を作る。
   *
   * 複線を渡る所では線路の本数だけ交点があるが、施設としての踏切は
   * 1 か所である。舗装・遮断機・停止線はまとめて作り、フランジ溝だけを
   * 線路ごとに敷く。
   */
  private buildCrossing(
    overlay: MeshBuilder,
    group: LevelCrossingGroup,
    structures: Map<SegmentId, StructureRun[]>,
    stats: WorldStats,
  ): void {
    stats.levelCrossings++;
    const road = group.main.road!;
    const build = buildLevelCrossing(
      overlay,
      group.main,
      { sampleAt: (s) => this.roadSampleAt(road.segment, s) },
      road.cls,
      group.main.rail!.cls,
      {
        span: { s0: group.s0, s1: group.s1 },
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

    // 踏切の中だけ、レールの内側にフランジ溝を敷く。線路が舗装から
    // わずかしか出ていないので、これが無いとどこが線路か分かりにくい。
    for (const crossing of group.crossings) {
      const rail = crossing.rail!;
      const railAlignment = this.network.alignmentOf(rail.segment);
      // 舗装の中だけ。外まで伸ばすと、道床の上に溝が浮いてしまう。
      const sin = Math.max(
        0.26,
        Math.abs(crossing.road!.dir.x * rail.dir.y - crossing.road!.dir.y * rail.dir.x),
      );
      const reach = Math.max(1, crossing.road!.cls.halfWidth / sin - 0.5);
      buildFlangeways(
        overlay,
        alignmentSamplesInRange(
          railAlignment,
          Math.max(0, rail.s - reach),
          Math.min(railAlignment.length, rail.s + reach),
          1.5,
        ),
        rail.cls,
        pavementY,
      );
    }

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
    for (const child of this.propGroup.children) {
      if (!child.name.startsWith('station-')) continue;
      child.traverse((object) => {
        const material = (object as { material?: Material }).material;
        if (!material) return;
        const map = (material as Material & { map?: Texture }).map;
        map?.dispose();
        material.dispose();
      });
    }
    this.propGroup.clear();
    this.signals = [];
    this.gates = [];
    this.props = [];
  }

  /** 信号・遮断機・車両のアニメーションを進める。 */
  animate(time: number, dt = 0): void {
    for (const signal of this.signals) {
      setSignalState(signal, signalStateAt(time, signal.phase));
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

    if (!this.showVehicles) {
      this.vehicleView.clear();
      return;
    }
    // 信号の現示は描画側と同じ時刻・同じ関数で見るので、青なのに止まった
    // ままになることがない。
    this.traffic.step(dt, time);
    this.vehicleView.sync(this.traffic.vehicles, this.highlightVehicle);
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

/** 1 か所の踏切としてまとめた、平面交差のまとまり。 */
interface LevelCrossingGroup {
  /** 代表 (まとまりの中央にいちばん近い交差)。 */
  main: Crossing;
  crossings: Crossing[];
  /** 舗装を敷く道路の弧長の範囲。 */
  s0: number;
  s1: number;
}

/** まとめる踏切パネルどうしの隙間の上限 [m]。 */
const CROSSING_MERGE_GAP = 10;
/** 同じ道路の上とみなす、中心線からのずれ [m]。 */
const CROSSING_MERGE_LATERAL = 4;

/**
 * 平面交差を「施設としての踏切」ごとにまとめる。
 *
 * 複線を渡れば交点は線路の本数だけできるが、実物では舗装も遮断機も
 * 1 組しかない。線路ごとに作ると、線路と線路の間 (数 m しかない) に
 * 遮断機と停止線が入り込んでしまう。
 *
 * まとめる判定は道路の弧長ではなく**world 座標**で行う。線路の間に道路の
 * ノードが来ると、隣り合う交差が別々のセグメントに乗ってしまい、弧長では
 * 比べられないため。舗装・遮断機は代表の交差の弧長で作るが、`roadSampleAt`
 * がノードを越えて隣のセグメントまで辿るので、範囲が端を越えても構わない。
 */
function groupLevelCrossings(crossings: Crossing[]): LevelCrossingGroup[] {
  const levels = crossings.filter((c) => c.kind === 'level' && c.road && c.rail);
  const clusters: Crossing[][] = [];

  for (const crossing of levels) {
    const cluster = clusters.find((members) =>
      members.some((other) => sameCrossingSite(other, crossing)),
    );
    if (cluster) cluster.push(crossing);
    else clusters.push([crossing]);
  }

  return clusters.map((members) => {
    // 代表はまとまりの真ん中にいちばん近い交差。舗装の傾きと遮断機の
    // 向きは、そこの道路の枠で決める。
    const centre = new Vector3();
    for (const c of members) centre.add(c.point);
    centre.divideScalar(members.length);
    const main = members.reduce((best, c) =>
      c.point.distanceTo(centre) < best.point.distanceTo(centre) ? c : best,
    );

    let s0 = Infinity;
    let s1 = -Infinity;
    for (const c of members) {
      // 代表の道路の弧長に直す (交差どうしは数 m しか離れていないので、
      // 進行方向への射影で足りる)。
      const along =
        (c.point.x - main.point.x) * main.road!.dir.x +
        (c.point.z - main.point.z) * main.road!.dir.y;
      const half = panelHalfLength(c, c.rail!.cls);
      s0 = Math.min(s0, main.road!.s + along - half);
      s1 = Math.max(s1, main.road!.s + along + half);
    }
    return { main, crossings: members, s0, s1 };
  });
}

/** 2 つの平面交差が「同じ 1 か所の踏切」か。 */
function sameCrossingSite(a: Crossing, b: Crossing): boolean {
  const dirA = a.road!.dir;
  const dirB = b.road!.dir;
  // 別の道路 (交差点の近くで交わる 2 本など) はまとめない。
  if (Math.abs(dirA.x * dirB.x + dirA.y * dirB.y) < 0.9) return false;
  const dx = b.point.x - a.point.x;
  const dz = b.point.z - a.point.z;
  const lateral = Math.abs(-dx * dirA.y + dz * dirA.x);
  if (lateral > CROSSING_MERGE_LATERAL) return false;
  if (Math.abs(a.point.y - b.point.y) > 2) return false;
  const along = Math.abs(dx * dirA.x + dz * dirA.y);
  const reach =
    panelHalfLength(a, a.rail!.cls) + panelHalfLength(b, b.rail!.cls) + CROSSING_MERGE_GAP;
  return along <= reach;
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

/** 地下ビュー中だけ既存メッシュを薄くし、強調線を読みやすくする。 */
function setMeshFade(mesh: Mesh, opacity: number, active: boolean): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    material.transparent = active;
    material.opacity = opacity;
    material.depthWrite = !active;
    material.needsUpdate = true;
  }
}
