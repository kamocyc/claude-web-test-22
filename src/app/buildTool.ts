import { Group, Mesh, Vector2, Vector3, type MeshStandardMaterial } from 'three';
import { Alignment } from '../core/alignment';
import { MeshBuilder } from '../core/meshbuilder';
import { VerticalProfile } from '../core/profile';
import { DEG, clamp } from '../core/units';
import { buildRibbon, profileFor } from '../build/surface';
import { buildStationPreview } from '../build/station';
import { getClass, type NetworkClass } from '../network/classes';
import {
  REACH_GAP,
  anchorFromNode,
  anchorFromSegment,
  computePlacement,
  placeSegment,
  reachedAnchor,
  type Anchor,
  type PlaceResult,
  type PlacementPreview,
} from '../network/editing';
import {
  applyRoadEdit,
  planCrossingHeights,
  splitAtCrossing,
  type CrossingHeightPlan,
} from '../network/crossingHeight';
import type { NetNode, Network, NodeId, SegmentId } from '../network/network';
import {
  findParallelReference,
  parallelRoute,
  previewFromAlignment,
  previewFromAlignments,
  stationOf,
  type ParallelLeg,
  type ParallelReference,
} from '../network/parallel';
import { checkPlacement, junctionReach } from '../network/rules';
import {
  planStationLayout,
  stationAt,
  stationPlatformRange,
  validateStationSpec,
  type Station,
  type StationId,
  type StationLength,
  type StationSpec,
} from '../network/station';
import type { LineId, LineMap } from '../network/line';
import { checkStationPlacement } from '../network/stationPlacement';
import { ZONE_COLORS, ZONE_EMPTY_COLOR } from '../build/buildings';
import type { ZoneMap, ZoneType } from '../network/zoning';
import {
  evaluateAlignment,
  worstDiagnostics,
  type SegmentDiagnostics,
} from '../network/validation';
import {
  createPreviewMaterial,
  createPreviewXrayMaterial,
  riskTint,
  setPreviewBlocked,
} from '../render/materials';
import {
  ELEVATION_GUIDE_STEP,
  ElevationGuideView,
  type ElevationGuidePoint,
} from '../render/elevationGuide';
import { SnapView, type SnapKind, type SnapMarker } from '../render/snapView';
import {
  inspectPoint,
  sampleProfile,
  type InspectProfile,
  type PointInspection,
  type SurfaceContext,
} from './inspect';
import type { Heightfield } from '../terrain/heightfield';

export type ToolMode = 'build' | 'station' | 'zone' | 'line' | 'bulldoze' | 'inspect';

/** 区画を塗る筆の半径 [m]。沿道の全奥行き (`ZONE_DEPTH`) は覆える太さにする。 */
export const ZONE_BRUSH_RADIUS = 20;

export interface StationToolSettings {
  name: string;
  trackCount: number;
  platformCount: number;
  length: StationLength;
  heading: number;
}

export interface CursorModifiers {
  /** Shift: 直線・角度スナップ。 */
  straight: boolean;
  /** Ctrl: スナップを無効にする。 */
  noSnap: boolean;
}

/** HUD に出す現在の状態。 */
export interface ToolStatus {
  mode: ToolMode;
  classId: string;
  elevation: number;
  /** 建設中かどうか。 */
  drawing: boolean;
  length: number;
  radius: number;
  grade: number;
  diagnostics: SegmentDiagnostics | null;
  snap: SnapKind;
  /** いま吸い付いている点 (表示用)。始点側と終点側で最大 2 つ。 */
  markers: readonly SnapMarker[];
  hoverSegment: SegmentId | null;
  /** 確認モードでカーソル下にある点 (無ければ null)。 */
  inspect: PointInspection | null;
  selectedStation: Station | null;
  station: StationToolSettings;
  cost: number;
  /** 平行スナップが有効か。 */
  parallelSnap: boolean;
  /** いま平行に敷こうとしている相手 (無ければ null)。 */
  parallelTo: SegmentId | null;
  /** 空でなければ敷設できない。理由をそのまま表示する。 */
  blockers: string[];
  /** 区画ツールでいま塗ろうとしている用途 (null なら消しゴム)。 */
  zone: ZoneType | null;
  /** 路線ツールでいま駅を足している路線 (無ければ null)。 */
  line: { id: LineId; name: string; stops: string[] } | null;
  /** 路線ツールで、カーソルの下にある駅 (無ければ null)。 */
  hoverStation: Station | null;
}

/** カーソルの行き先 (吸い付いた点と、その目印)。 */
interface Target {
  anchor: Anchor;
  snap: SnapKind;
  marker: SnapMarker | null;
}

const ELEVATION_STEP = ELEVATION_GUIDE_STEP;

/**
 * 吸い付く相手と「今働いている高さ」の差の上限 [m]。
 *
 * 立体交差の桁下は道路で 4.5 m + 床版 1.1 m あるので、これより狭く
 * 取れば上下の線形を取り違えない。高さ設定の刻み (3 m) より広いので、
 * 1 段ずれていても既存の線形に繋がる。
 */
const SNAP_HEIGHT = 4;
/**
 * 種別の違う線形 (踏切になる相手) を探す距離 [m]。
 *
 * 舗装の上ならどこを指しても中心線へ寄せたいので、相手の半幅を賄える
 * だけ広く取る。実際に候補にするかは相手の半幅で決める。
 */
const CROSS_REACH = 20;
/**
 * 踏切として吸い付く高さの差 [m]。
 *
 * 踏切になるのは同じ高さで交わるときだけ。高さ設定を 1 段 (3 m) 上げて
 * 立体交差にしようとしている人を、道路の高さへ引き戻さない値にする。
 * 盛土・切土で路面が地形から少しずれている分は飲み込む。
 */
const CROSSING_SNAP_HEIGHT = 2.5;

/**
 * 交差点に吸い付く範囲の下限 [m]。
 *
 * 面の広さ (`junctionReach`) に任せると、面を持たない線路の分岐では
 * ノードのすぐ上を指さないと掴めない。交差点は「繋いでください」と
 * 案内される相手なので、外した所からでも掴めるだけ広く取る。
 */
const JUNCTION_SNAP = 15;

/** カーソルが構造物 (橋の路面) に当たっているとみなす、地形との差 [m]。 */
const ON_STRUCTURE = 2;
const ANGLE_SNAP = 15 * DEG;

/**
 * 道路・線路を敷設するツール。
 *
 * 1 回目のクリックで始点を決め、そのあとカーソルを動かすと、始点の接線を
 * 保った円弧が伸びる。2 回目のクリックで確定し、そのまま終点を始点として
 * 連続して引ける。
 */
export class BuildTool {
  mode: ToolMode = 'build';
  classId = 'road_medium';
  /** 地形からの高さ [m]。立体交差やトンネルはこれで作る。 */
  elevationOffset = 0;
  /** 既存の線形に平行してスナップするか。複線・側道はこれで作る。 */
  parallelSnap = true;
  /** 区画ツールで塗る用途。null なら塗った用途を消す。 */
  zoneType: ZoneType | null = 'residential';

  readonly previewGroup = new Group();
  private readonly snapView = new SnapView();
  private readonly elevationGuideView = new ElevationGuideView();
  private readonly previewMesh: Mesh;
  private readonly previewMaterial: MeshStandardMaterial;
  /** 地形などに隠れた所を透かして出す、プレビューのもう 1 枚。 */
  private readonly previewXrayMesh: Mesh;
  private readonly previewXrayMaterial: MeshStandardMaterial;
  private anchor: Anchor | null = null;
  private cursor: Vector3 | null = null;
  private preview: PlacementPreview | null = null;
  private endAnchor: Anchor | null = null;
  private snapKind: SnapKind = 'none';
  /** 引き始めた点の目印 (確定済み)。 */
  private anchorMarker: SnapMarker | null = null;
  private markers: SnapMarker[] = [];
  /** スナップの目印 (原因の交差点を除いたもの)。 */
  private snapMarkers: SnapMarker[] = [];
  private hoverSegment: SegmentId | null = null;
  private lastDiagnostics: SegmentDiagnostics | null = null;
  private blockers: string[] = [];
  /** 敷設を止めている原因の場所 (既存の交差点)。目印で囲って示す。 */
  private blockedPlaces: Vector3[] = [];
  /** いま平行に敷こうとしている基準の線形。 */
  private parallel: ParallelReference | null = null;
  /**
   * 平行スナップで組み立てた区間の列 (プレビューと同じもの)。
   *
   * 既存の線形の区切りごとに 1 本。空でなければ、確定時はこれを順に敷く。
   */
  private parallelRun: ParallelLeg[] = [];
  /**
   * 交点の高さ合わせの立案 (プレビューと同じもの)。
   *
   * 既存の線形と交わる所で高さを合わせるときは、そこで区間を分けて縦断を
   * 解き直す。確定時はこの立案どおりに敷く (プレビューと形が変わらない)。
   */
  private crossingPlan: CrossingHeightPlan | null = null;
  /** 確認モードで読み取った、カーソル下の 1 点。 */
  private inspection: PointInspection | null = null;
  private selectedStationId: StationId | null = null;
  private stationCandidate: Station | null = null;
  /** 路線ツールで駅を足している路線。 */
  private editingLineId: LineId | null = null;
  /** 路線ツールで、カーソルの下にある駅。 */
  private hoverStation: Station | null = null;
  private stationSettings: StationToolSettings = {
    name: '駅 1',
    trackCount: 2,
    platformCount: 2,
    length: 120,
    heading: 0,
  };
  /** グラフ用のサンプル列。同じ線形を指している間は作り直さない。 */
  private inspectProfile: { segment: SegmentId; version: number; profile: InspectProfile } | null =
    null;

  constructor(
    private readonly network: Network,
    private readonly field: Heightfield,
    private readonly onChanged: () => void,
    /**
     * 描画側だけが知っている情報 (カント・構造形式) の問い合わせ先。
     * 確認モードの読み取りに使う。無くても動く。
     */
    private readonly surface: SurfaceContext | null = null,
    /** 区画の塗り分け。渡さなければ区画ツールは何もしない。 */
    private readonly zones: ZoneMap | null = null,
    /** 路線の台帳。渡さなければ路線ツールは何もしない。 */
    private readonly lines: LineMap | null = null,
  ) {
    this.previewGroup.name = 'preview';
    this.previewMaterial = createPreviewMaterial();
    this.previewMesh = new Mesh(new MeshBuilder().build(), this.previewMaterial);
    this.previewMesh.name = 'preview-surface';
    this.previewMesh.frustumCulled = false;
    // トンネルや丘の陰でプレビューが消えないよう、同じ形をもう 1 枚、
    // 深度試験なしで**先に**描く。地表に出ている所はこのあと
    // `previewMesh` が上から塗り直すので、隠れている所だけが薄く透ける。
    this.previewXrayMaterial = createPreviewXrayMaterial();
    this.previewXrayMesh = new Mesh(this.previewMesh.geometry, this.previewXrayMaterial);
    this.previewXrayMesh.name = 'preview-xray';
    this.previewXrayMesh.frustumCulled = false;
    this.previewXrayMesh.renderOrder = 14;
    this.previewMesh.renderOrder = 15;
    this.previewGroup.add(
      this.previewXrayMesh,
      this.previewMesh,
      this.snapView.group,
      this.elevationGuideView.group,
    );
  }

  get cls(): NetworkClass {
    return getClass(this.classId);
  }

  setMode(mode: ToolMode): void {
    this.mode = mode;
    this.cancel();
  }

  setStationSettings(patch: Partial<Omit<StationToolSettings, 'heading'>>): void {
    this.stationSettings = { ...this.stationSettings, ...patch };
    const range = stationPlatformRange(this.stationSettings.trackCount);
    this.stationSettings.platformCount = clamp(
      Math.round(this.stationSettings.platformCount),
      range.min,
      range.max,
    );
    this.updateStationPreview();
  }

  rotateStation(steps: number): void {
    this.stationSettings.heading += steps * ANGLE_SNAP;
    this.stationSettings.heading = Math.atan2(
      Math.sin(this.stationSettings.heading),
      Math.cos(this.stationSettings.heading),
    );
    this.updateStationPreview();
  }

  selectStation(id: StationId | null): void {
    this.selectedStationId = id !== null && this.network.stations.has(id) ? id : null;
  }

  /** 区画ツールで塗る用途を選ぶ。 */
  setZone(zone: ZoneType | null): void {
    this.zoneType = zone;
  }

  setClass(classId: string): void {
    // 種別を変えたら、途中まで引いていた線形は破棄する。
    if (this.classId !== classId) this.cancel();
    this.classId = classId;
  }

  /** 平行スナップの入り切りを変える。 */
  setParallelSnap(on: boolean): void {
    if (on !== this.parallelSnap) this.cancel();
    this.parallelSnap = on;
  }

  /**
   * 敷設高さを上下する。
   *
   * 下は深いトンネルの底まで届かせる。スナップは「地形 + 高さ設定」の
   * あたりを見るので、トンネルの中の道に繋ぐにはここを掘り下げる。
   */
  adjustElevation(steps: number): void {
    this.elevationOffset = clamp(this.elevationOffset + steps * ELEVATION_STEP, -60, 60);
    this.refreshPreview();
  }

  cancel(): void {
    this.anchor = null;
    this.preview = null;
    this.endAnchor = null;
    this.lastDiagnostics = null;
    this.blockers = [];
    this.parallel = null;
    this.parallelRun = [];
    this.crossingPlan = null;
    this.anchorMarker = null;
    this.showMarkers([]);
    this.inspection = null;
    this.inspectProfile = null;
    this.stationCandidate = null;
    this.selectedStationId = null;
    // 路線は「ここまで」で区切る。次にクリックしたら新しい路線を作る。
    this.editingLineId = null;
    this.hoverStation = null;
    this.elevationGuideView.update([]);
    this.updatePreviewMesh();
  }

  /** 毎フレーム、カーソルの地形交点を受け取って状態を更新する。 */
  update(cursor: Vector3 | null, modifiers: CursorModifiers): void {
    this.cursor = cursor;
    this.modifiers = modifiers;
    this.hoverSegment = null;
    this.inspection = null;

    if (!cursor) {
      this.preview = null;
      this.showMarkers(this.anchorMarker ? [this.anchorMarker] : []);
      this.elevationGuideView.update([]);
      this.updatePreviewMesh();
      return;
    }

    if (this.mode === 'station') {
      this.updateStationPreview();
      return;
    }

    if (this.mode === 'zone') {
      this.elevationGuideView.update([]);
      this.snapKind = 'none';
      this.preview = null;
      this.blockers = [];
      this.showMarkers([]);
      this.updatePreviewMesh();
      return;
    }

    if (this.mode === 'line') {
      this.elevationGuideView.update([]);
      this.snapKind = 'none';
      this.preview = null;
      this.blockers = [];
      // 指した駅を光らせる。駅は敷地全体が的なので、ホームでも構内でもよい。
      this.hoverStation = stationAt(this.network.stations.values(), cursor.x, cursor.z);
      this.showMarkers(this.hoverStation ? [this.stationMarker(this.hoverStation)] : []);
      this.updatePreviewMesh();
      return;
    }

    if (this.mode === 'bulldoze' || this.mode === 'inspect') {
      this.elevationGuideView.update([]);
      // 撤去・確認も指した高さのものを選ぶ (橋を指せば橋、下の道を
      // 指せば下の道)。カーソルは路面にも当たるので、橋の上を指せば
      // 橋の高さが返ってくる。
      const hit = this.network.findSegmentNear(cursor, 12, {
        y: cursor.y,
        tolerance: SNAP_HEIGHT,
      });
      this.hoverSegment = hit?.segment ?? null;
      // このモードではスナップしないので、敷設モードの表示を残さない。
      this.snapKind = 'none';
      this.preview = null;
      if (this.mode === 'inspect' && hit) {
        this.inspection = inspectPoint(
          this.network,
          hit.segment,
          hit.s,
          this.surface,
          this.profileOf(hit.segment),
        );
        this.showMarkers([this.inspectMarker(hit, this.inspection)]);
      } else {
        this.showMarkers([]);
      }
      this.updatePreviewMesh();
      return;
    }

    this.refreshPreview();
  }

  private modifiers: CursorModifiers = { straight: false, noSnap: false };

  private updateStationPreview(): void {
    if (this.mode !== 'station' || !this.cursor) {
      this.stationCandidate = null;
      this.elevationGuideView.update([]);
      if (this.mode === 'station') this.updatePreviewMesh();
      return;
    }
    const y = this.field.heightAt(this.cursor.x, this.cursor.z) + Math.max(0, this.elevationOffset);
    const spec: StationSpec = {
      ...this.stationSettings,
      center: new Vector3(this.cursor.x, y, this.cursor.z),
      elevated: this.elevationOffset > 0,
    };
    const layout = planStationLayout(spec.trackCount, spec.platformCount);
    this.stationCandidate = {
      id: 0,
      ...spec,
      center: spec.center.clone(),
      tracks: layout.tracks.map((track) => ({ ...track, segment: -1 })),
      platforms: layout.platforms,
      minOffset: layout.minOffset,
      maxOffset: layout.maxOffset,
    };
    this.blockers = [
      ...(this.elevationOffset < 0 ? ['地下駅には対応していません'] : []),
      ...validateStationSpec(spec),
      ...checkStationPlacement(this.network, spec),
    ];
    this.snapKind = 'none';
    this.preview = null;
    this.showMarkers([]);
    this.updateElevationGuides(
      this.elevationOffset > 0 && this.stationCandidate ? [this.stationCandidate.center] : [],
    );
    this.updatePreviewMesh();
  }

  /**
   * 今どの高さで働いているか。
   *
   * 原則は**地形 + 高さ設定**。橋を指しているとき (カーソルが橋の路面に
   * 当たっているとき) だけは、その橋の高さで働く。立体交差の上下は平面で
   * 見ると重なるので、これが無いと「地上の道を引いているのに頭上の橋に
   * 吸い付く」ことになる。
   */
  private workingY(cursor: Vector3): number {
    const ground = this.field.heightAt(cursor.x, cursor.z);
    if (cursor.y - ground > ON_STRUCTURE) return cursor.y;
    return ground + this.elevationOffset;
  }

  /** 現在のカーソル位置から、接続先を含めた到達点を決める。 */
  private resolveTarget(): Target {
    const cursor = this.cursor!;
    const cls = this.cls;
    const free = new Vector3(cursor.x, this.workingY(cursor), cursor.z);
    const height = { y: free.y, tolerance: SNAP_HEIGHT };

    if (this.modifiers.noSnap) return { anchor: { pos: free }, snap: 'none', marker: null };

    // 候補を集めて、カーソルからいちばん近い所へ寄せる。ノードの近くでは
    // ノードに、路肩の外では平行の位置に付く、という素直な決まりになる。
    // どの候補も「今働いている高さのあたり」にあるものだけを見る。
    const candidates: (Target & { snap: SnapMarker['kind']; distance: number })[] = [];

    const nodeSnapRadius = Math.max(8, cls.halfWidth * 1.4);
    const node = this.network.findNodeNear(cursor, nodeSnapRadius, height);
    if (node && this.canJoin(node)) {
      candidates.push({
        anchor: anchorFromNode(this.network, node, cls),
        snap: 'node',
        marker: this.nodeMarker(node),
        distance: Math.hypot(node.pos.x - cursor.x, node.pos.z - cursor.z),
      });
    }

    const onSegment = this.network.findSegmentNear(
      cursor,
      Math.max(cls.halfWidth + 3, CROSS_REACH),
      height,
    );
    if (onSegment) {
      const other = this.network.classOf(this.network.getSegment(onSegment.segment));
      const away = Math.hypot(onSegment.pos.x - cursor.x, onSegment.pos.z - cursor.z);
      // 種別が違う相手には取り付かない。交差 (踏切・立体交差) にしたいので、
      // 代わりに**中心線の上**へ寄せる。そこで止めれば、線路をいったん
      // 交点まで引いて、そこから先へ伸ばす、という引き方ができる。中心線を
      // 外した所で止めると、舗装と道床が重なって敷設できない。
      if (
        other.kind !== cls.kind &&
        away <= other.halfWidth + cls.halfWidth &&
        Math.abs(onSegment.pos.y - free.y) <= CROSSING_SNAP_HEIGHT
      ) {
        candidates.push({
          anchor: { pos: onSegment.pos.clone() },
          snap: 'crossing',
          marker: this.crossingMarker(onSegment, other),
          distance: away,
        });
      }
      // 種別が違う場合は交差 (踏切・立体交差) にしたいのでスナップしない。
      if (other.kind === cls.kind && away <= cls.halfWidth + 3) {
        // 交差点の面の中では、既存の線形を分割せずにその交差点へ繋ぐ。
        // 面の中で分割しても交差点の形が保てず (必ず「交差点が近すぎます」
        // になる)、T 字を十字にすることができない。
        const junction = this.junctionAt(onSegment.segment, onSegment.s);
        const distance = away;
        candidates.push(
          junction
            ? {
                anchor: anchorFromNode(this.network, junction, cls),
                snap: 'node',
                marker: this.nodeMarker(junction),
                distance,
              }
            : {
                anchor: anchorFromSegment(this.network, onSegment.segment, onSegment.s),
                snap: 'segment',
                marker: this.segmentMarker(onSegment, other),
                distance,
              },
        );
      }
    }

    // 枝の上でなくても、交差点の面の中を指していればその交差点に繋ぐ
    // (面の隅を指したときや、面が広い大通りの交差点のため)。
    const inside = this.junctionUnder(cursor, free.y);
    if (inside) {
      candidates.push({
        anchor: anchorFromNode(this.network, inside.node, cls),
        snap: 'node',
        marker: this.nodeMarker(inside.node),
        distance: inside.distance,
      });
    }

    // 既存の線形の隣なら、その線形に平行な位置へ寄せる。
    const parallel = this.findParallel(free);
    if (parallel) {
      candidates.push({
        anchor: { pos: parallel.pos.clone() },
        snap: 'parallel',
        marker: this.parallelMarker([parallel.segment], parallel.pos),
        distance: Math.hypot(parallel.pos.x - cursor.x, parallel.pos.z - cursor.z),
      });
    }

    const best = candidates.sort((a, b) => a.distance - b.distance)[0];
    if (!best) return { anchor: { pos: free }, snap: 'none', marker: null };
    return { anchor: best.anchor, snap: best.snap, marker: best.marker };
  }

  // ---------------------------------------------------------- 目印

  /** 交差点・端点に繋ぐ目印。輪の大きさは吸い付く範囲に合わせる。 */
  private nodeMarker(node: NetNode): SnapMarker {
    return {
      kind: 'node',
      pos: node.pos.clone(),
      radius: Math.max(this.junctionSnapRange(node), this.cls.halfWidth * 0.8),
    };
  }

  /** 路線ツールで駅を指したときの目印。駅の敷地をぐるりと囲む。 */
  private stationMarker(station: Station): SnapMarker {
    const line = this.editingLineId === null ? null : this.lines?.get(this.editingLineId) ?? null;
    return {
      kind: 'node',
      pos: station.center.clone(),
      radius: Math.max(station.length / 2, (station.maxOffset - station.minOffset) / 2) + 3,
      tint: line?.color,
    };
  }

  /** 既存の線形の途中に取り付く目印。分割する位置に横棒を引く。 */
  private segmentMarker(
    hit: { pos: Vector3; dir: Vector2 },
    other: NetworkClass,
  ): SnapMarker {
    return {
      kind: 'segment',
      pos: hit.pos.clone(),
      radius: Math.max(1.8, this.cls.halfWidth * 0.4),
      bar: new Vector2(-hit.dir.y, hit.dir.x).multiplyScalar(other.halfWidth + 0.8),
    };
  }

  /**
   * 踏切になる点の目印。
   *
   * 相手の中心線に沿った棒を引く。取り付き (`segmentMarker`) の棒は相手を
   * **横切る**向きで「ここで分割する」ことを示すので、同じ向きにすると
   * 繋がると誤解される。踏切では相手を分割も接続もしない。
   */
  private crossingMarker(hit: { pos: Vector3; dir: Vector2 }, other: NetworkClass): SnapMarker {
    return {
      kind: 'crossing',
      pos: hit.pos.clone(),
      radius: Math.max(1.8, this.cls.halfWidth * 0.6),
      bar: hit.dir.clone().multiplyScalar(other.halfWidth + 2),
    };
  }

  /**
   * 確認モードの目印。
   *
   * どの点を読んでいるのかを示す輪と、断面を横切る棒。さらに線形の向き
   * (始点 → 終点) へ短い棒を出す。左右・勾配の符号はこの向きが基準なので、
   * 数値だけでは何に対しての「右」なのかが分からない。
   */
  private inspectMarker(
    hit: { pos: Vector3; dir: Vector2 },
    inspection: PointInspection,
  ): SnapMarker {
    const cls = getClass(inspection.classId);
    const forward = new Vector3(hit.dir.x, 0, hit.dir.y);
    return {
      kind: 'inspect',
      pos: hit.pos.clone(),
      radius: Math.max(1.8, cls.halfWidth * 0.6),
      bar: new Vector2(-hit.dir.y, hit.dir.x).multiplyScalar(cls.halfWidth + 0.8),
      tie: [hit.pos.clone(), hit.pos.clone().addScaledVector(forward, 8)],
      tint: riskTint(Math.max(inspection.curveRisk, inspection.gradeRisk)),
    };
  }

  /**
   * グラフ用のサンプル列。同じ線形を指し続けている間は作り直さない
   * (毎フレーム作ると SVG を組み直すことになる)。
   */
  private profileOf(segment: SegmentId): InspectProfile {
    const cached = this.inspectProfile;
    if (cached && cached.segment === segment && cached.version === this.network.version) {
      return cached.profile;
    }
    const profile = sampleProfile(this.network.alignmentOf(segment));
    this.inspectProfile = { segment, version: this.network.version, profile };
    return profile;
  }

  /**
   * 平行に敷く目印。基準の線形をなぞり、間隔を渡り線で示す。
   *
   * ルートに沿って何本かをまたぐときは、そのぜんぶをなぞる。どこまでを
   * 基準にしているのかが一目で分かるようにするため。
   */
  private parallelMarker(references: readonly SegmentId[], at: Vector3): SnapMarker {
    const guide: Vector3[] = [];
    for (const segment of references) {
      const alignment = this.network.alignmentOf(segment);
      const steps = Math.max(2, Math.ceil(alignment.length / 4));
      for (let i = 0; i <= steps; i++) {
        const p = alignment.sampleAt((alignment.length * i) / steps).pos;
        // 継ぎ目の点は前の区間と重なるので落とす (帯がねじれる)。
        if (guide.length > 0 && guide[guide.length - 1].distanceToSquared(p) < 1e-6) continue;
        guide.push(p.clone());
      }
    }
    const last = this.network.alignmentOf(references[references.length - 1]);
    const s = clamp(stationOf(last, at.x, at.z), 0, last.length);
    return {
      kind: 'parallel',
      pos: at.clone(),
      radius: Math.max(1.8, this.cls.halfWidth * 0.4),
      guide,
      tie: [last.sampleAt(s).pos.clone(), at.clone()],
    };
  }

  /** 目印を描き直す。引き始めた点は常に出す。 */
  private showMarkers(markers: readonly (SnapMarker | null)[]): void {
    this.snapMarkers = markers.filter((m): m is SnapMarker => m !== null);
    this.syncMarkers();
  }

  /**
   * 目印を描き直す。
   *
   * スナップの目印は `refreshPreview` が、止めている原因の交差点はその後の
   * `updatePreviewMesh` (判定を通す所) が決めるので、両方をここで合わせる。
   */
  private syncMarkers(): void {
    this.markers = [
      ...this.snapMarkers,
      ...this.blockedPlaces.map((pos) => this.blockedMarker(pos)),
    ];
    this.snapView.update(this.markers);
  }

  /** 敷設を止めている交差点の目印。 */
  private blockedMarker(pos: Vector3): SnapMarker {
    const node = this.network.findNodeNear(pos, 1);
    const radius = node
      ? Math.max(junctionReach(this.network, node.id), this.cls.halfWidth)
      : this.cls.halfWidth;
    return { kind: 'blocked', pos: pos.clone(), radius, width: 1.1 };
  }

  /** その種別を繋いでよいノードか (線路のノードに道路は繋がない)。 */
  private canJoin(node: NetNode): boolean {
    const branches = this.network.branchesAt(node.id);
    return branches.length === 0 || branches.some((b) => b.cls.kind === this.cls.kind);
  }

  /**
   * その交差点に吸い付く範囲 [m]。
   *
   * 下限は「そこに端点を置くと止められる範囲」(`checkJunctionSpacing` と
   * 同じ式)。指せる所と置ける所が食い違わないようにする。そのうえで
   * 3 枝以上の交差点は、面が無くても掴めるよう `JUNCTION_SNAP` まで広げる。
   */
  private junctionSnapRange(node: NetNode): number {
    const blocked = junctionReach(this.network, node.id) + this.cls.halfWidth * 0.5;
    return this.network.branchesAt(node.id).length >= 3
      ? Math.max(JUNCTION_SNAP, blocked)
      : blocked;
  }

  /**
   * 既存の線形の `s` 地点が交差点の面の中なら、その交差点のノード。
   *
   * ここは `junctionSnapRange` ではなく**面の広さそのもの**で測る。広げると
   * 交差点の近くで線形を分割できなくなり、分岐器のすぐ先に渡り線を作る、
   * といった引き方ができなくなる。線形から外れた所を指したときの吸い付き
   * (`junctionUnder`) だけを広げる。
   */
  private junctionAt(segment: SegmentId, s: number): NetNode | null {
    const seg = this.network.getSegment(segment);
    const length = this.network.alignmentOf(segment).length;
    const ends: [NodeId, number][] = [
      [seg.a, s],
      [seg.b, length - s],
    ];
    for (const [id, from] of ends) {
      const node = this.network.nodes.get(id);
      if (!node || !this.canJoin(node)) continue;
      if (from <= junctionReach(this.network, id)) return node;
    }
    return null;
  }

  /**
   * カーソルが交差点の吸い付く範囲にあれば、その交差点のノード。
   *
   * 候補はいちばん近いものが勝つので、範囲を広げても線形の上 (距離 ≒ 0) の
   * 分割や平行スナップを奪わない。効くのは「線形から外れた所を指したとき」。
   */
  private junctionUnder(cursor: Vector3, y: number): { node: NetNode; distance: number } | null {
    let best: { node: NetNode; distance: number } | null = null;
    for (const node of this.network.nodes.values()) {
      if (Math.abs(node.pos.y - y) > SNAP_HEIGHT) continue;
      const distance = Math.hypot(node.pos.x - cursor.x, node.pos.z - cursor.z);
      if (distance > 60 || (best && distance >= best.distance)) continue;
      if (!this.canJoin(node)) continue;
      if (distance > this.junctionSnapRange(node)) continue;
      best = { node, distance };
    }
    return best;
  }

  /** 平行に敷ける基準の線形を探す (無効化されていれば null)。 */
  private findParallel(at: Vector3, direction?: Vector2): ParallelReference | null {
    if (!this.parallelSnap || this.modifiers.noSnap) return null;
    // 基準にするのも「今働いている高さのあたり」の線形だけ。頭上の高架に
    // 平行して地面の上に引く、といったことにならない。
    return findParallelReference(this.network, this.cls, at, {
      direction,
      heightTolerance: SNAP_HEIGHT,
    });
  }

  private refreshPreview(): void {
    if (!this.cursor || this.mode !== 'build') return;
    const target = this.resolveTarget();
    this.snapKind = target.snap;

    if (!this.anchor) {
      this.preview = null;
      this.endAnchor = null;
      this.parallelRun = [];
      this.crossingPlan = null;
      this.showMarkers([target.marker]);
      this.updateElevationGuides([target.anchor.pos]);
      this.updatePreviewMesh();
      return;
    }

    // 平行に敷いている間は、基準の線形をそのまま横にずらした線形を引く。
    if (this.parallel && !this.modifiers.noSnap && this.parallelPreview()) {
      this.updateElevationGuides(
        this.endAnchor ? [this.anchor.pos, this.endAnchor.pos] : [this.anchor.pos],
      );
      this.updatePreviewMesh();
      return;
    }

    this.parallelRun = [];
    this.crossingPlan = null;
    let end = target.anchor;
    if (this.modifiers.straight && target.snap === 'none') {
      end = { ...end, pos: this.snapAngle(this.anchor.pos, end.pos) };
    }

    this.preview = computePlacement(this.anchor, end, {
      straight: this.modifiers.straight,
      cls: this.cls,
    });
    // 掃引角の制限で指した所まで届かないときは、届いた所を終点にして敷く。
    // 吸い付いていた相手には繋がらないので、その目印も出さない。
    const short =
      Math.hypot(this.preview.end.x - end.pos.x, this.preview.end.z - end.pos.z) > REACH_GAP;
    if (short) {
      // 高さも**届いた所**で決め直す。カーソルの下の高さのまま伸ばすと、
      // 届いた所が尾根でも谷でも「指した所の高さ」になり、頼んでいない
      // 築堤やトンネルができてしまう。高さ設定 (地下・高架) は保つ。
      const reached = new Vector3(
        this.preview.end.x,
        this.field.heightAt(this.preview.end.x, this.preview.end.z) + this.elevationOffset,
        this.preview.end.z,
      );
      this.preview = computePlacement(this.anchor, { pos: reached }, {
        straight: this.modifiers.straight,
        cls: this.cls,
      });
    }
    this.endAnchor = reachedAnchor(end, this.preview.end);
    this.applyCrossingHeights();
    // (角度スナップで位置をずらすのは、どこにも吸い付いていないときだけ
    //  なので、そのときは target.marker が無い。)
    this.showMarkers([this.anchorMarker, short ? null : target.marker]);
    this.updateElevationGuides([this.anchor.pos, this.endAnchor.pos]);
    this.updatePreviewMesh();
  }

  /**
   * 既存の線形と交わる所で、交点の高さに合わせた縦断へ組み直す。
   *
   * プレビューの時点から入れないと、置いた形とプレビューが食い違う。
   * 合わせられない (勾配制限を超える) ときは立案が理由を持って返るので、
   * `updatePreviewMesh` がそれを敷設を止める理由に足す。
   */
  private applyCrossingHeights(): void {
    this.crossingPlan = null;
    if (!this.preview || !this.anchor) return;
    const start = reachedAnchor(this.anchor, this.preview.start);
    const end = this.endAnchor ?? { pos: this.preview.end };
    const plan = planCrossingHeights(
      this.network,
      this.cls,
      this.previewAlignment(this.preview),
      {
        startGrade: this.preview.startGrade,
        // 到着側が既存の線形に繋がるなら、その勾配を守る。繋がらないなら
        // 平均勾配に任せる (`computePlacement` と同じ決め方)。
        endGrade: end.node !== undefined || end.split ? this.preview.endGrade : null,
      },
      { startNode: start.node, endNode: end.node },
    );
    if (!plan) return;
    this.crossingPlan = plan;
    // 区間に分かれても、長さ・最小半径・最大勾配は「引いている区間ぜんぶ」で
    // 出す。端点・接線はそのままなので、続けて引く所も変わらない。
    this.preview = previewFromAlignments(plan.legs.map((leg) => leg.alignment));
  }

  /** 地表の対応点から実際の敷設高さまでを、目盛付きの垂線で示す。 */
  private updateElevationGuides(points: readonly Vector3[]): void {
    if (
      this.elevationOffset === 0 ||
      (this.mode !== 'build' && this.mode !== 'station')
    ) {
      this.elevationGuideView.update([]);
      return;
    }
    const guides: ElevationGuidePoint[] = points.map((point) => ({
      point: point.clone(),
      groundY: this.field.heightAt(point.x, point.z),
    }));
    this.elevationGuideView.update(guides);
  }

  /**
   * 平行スナップのプレビューを組み立てる。
   *
   * 始点の隣からカーソルの隣まで、既存の線形の**ルートをたどって**横に
   * ずらした線形を並べる。基準の線形の端で止まらないので、途中で分割された
   * 複線 (橋・踏切・分岐でノードが入っている) の隣も一度に敷ける。区切りは
   * 基準と同じ位置に入るので、橋・トンネルの境目が隣どうしで揃う。
   */
  private parallelPreview(): boolean {
    const anchor = this.anchor;
    const reference = this.parallel;
    if (!reference || !anchor || !this.network.segments.has(reference.segment)) return false;

    let legs = parallelRoute(this.network, this.cls, reference, anchor.pos, this.cursor!);
    if (legs.length === 0) {
      // 基準の端に来ていて、そこから先へは繋がっていない。引こうとしている
      // 向きに並んでいる別の線形へ乗り換える (線形が途切れていても続けられる)。
      const direction = new Vector2(
        this.cursor!.x - anchor.pos.x,
        this.cursor!.z - anchor.pos.z,
      );
      const next =
        direction.lengthSq() > 1e-6 ? this.findParallel(anchor.pos, direction.normalize()) : null;
      if (next && next.segment !== reference.segment) {
        this.parallel = next;
        legs = parallelRoute(this.network, this.cls, next, anchor.pos, this.cursor!);
      }
    }
    if (legs.length === 0) {
      this.preview = null;
      this.endAnchor = null;
      this.parallelRun = [];
      this.crossingPlan = null;
      this.showMarkers([this.anchorMarker]);
      return true;
    }

    this.parallelRun = legs;
    this.preview = previewFromAlignments(legs.map((leg) => leg.alignment));
    // 既に敷いてある平行線の端に届いたら、そこへ繋ぐ。
    const node = this.network.findNodeNear(this.preview.end, 2);
    this.endAnchor = node
      ? { pos: node.pos.clone(), node: node.id }
      : { pos: this.preview.end.clone() };
    this.snapKind = 'parallel';
    // 何に平行なのか・どこまで来ているのかを目印で出す。
    this.showMarkers([
      this.anchorMarker,
      this.parallelMarker(legs.flatMap((leg) => leg.references), this.preview.end),
      node && this.canJoin(node) ? this.nodeMarker(node) : null,
    ]);
    return true;
  }

  /** 始点からの方位を 15 度刻みに丸める。 */
  private snapAngle(from: Vector3, to: Vector3): Vector3 {
    const d = new Vector2(to.x - from.x, to.z - from.z);
    const len = d.length();
    if (len < 1e-3) return to.clone();
    const angle = Math.round(Math.atan2(d.y, d.x) / ANGLE_SNAP) * ANGLE_SNAP;
    return new Vector3(from.x + Math.cos(angle) * len, to.y, from.z + Math.sin(angle) * len);
  }

  /** いま敷こうとしている線形 (平行スナップでないとき)。 */
  private previewAlignment(preview: PlacementPreview): Alignment {
    return new Alignment(
      preview.horizontal,
      new VerticalProfile(
        this.anchor!.pos.y,
        preview.end.y,
        preview.startGrade,
        preview.endGrade,
        preview.horizontal.length,
      ),
    );
  }

  /** プレビューの線形を実際の断面で描き直す。 */
  private updatePreviewMesh(): void {
    const mb = new MeshBuilder();
    const preview = this.preview;
    this.blockedPlaces = [];
    if (this.mode === 'zone') {
      if (this.cursor) buildZoneBrush(mb, this.cursor, this.field, this.zoneType);
      this.lastDiagnostics = null;
      this.blockers = [];
    } else if (this.mode === 'station' && this.stationCandidate) {
      buildStationPreview(mb, this.stationCandidate);
      this.lastDiagnostics = null;
    } else if (this.crossingPlan && this.anchor) {
      // 交点で高さを合わせる区間は 1 本ずつ独立したセグメントになるので、
      // 検査も 1 本ずつ行う。意図した平面交差は `matched` で規則に教える
      // (合わせる前の高低差で見られると、必ず「桁下が足りません」になる)。
      const plan = this.crossingPlan;
      const cls = this.cls;
      const diagnostics: SegmentDiagnostics[] = [];
      const blockers: string[] = plan.blockers.map((b) => b.message);
      this.blockedPlaces.push(...plan.blockers.map((b) => b.at.clone()));
      let start: Anchor = reachedAnchor(this.anchor, plan.legs[0].alignment.sampleAt(0).pos);
      for (const [index, leg] of plan.legs.entries()) {
        const alignment = leg.alignment;
        const at = previewFromAlignment(alignment);
        const end =
          index === plan.legs.length - 1 ? this.endAnchor ?? { pos: at.end } : { pos: at.end };
        diagnostics.push(evaluateAlignment(alignment, cls));
        const check = checkPlacement({
          network: this.network,
          cls,
          alignment,
          start,
          end,
          matchedCrossings: leg.matched,
          field: this.field,
        });
        blockers.push(...check.blockers);
        this.blockedPlaces.push(...check.places);
        buildRibbon(mb, alignment.sample(2), profileFor(cls), { skirt: false, cls });
        start = { pos: at.end.clone() };
      }
      this.lastDiagnostics = worstDiagnostics(diagnostics);
      this.blockers = [...new Set(blockers)];
    } else if (this.parallelRun.length > 0 && this.anchor) {
      // 平行に敷く区間は 1 本ずつ独立したセグメントになるので、検査も
      // 1 本ずつ行う。パネルに出す診断だけは全体をまとめたものにする。
      const cls = this.cls;
      const diagnostics: SegmentDiagnostics[] = [];
      const blockers: string[] = [];
      // 最初の区間の始点だけは、吸い付いていた相手に繋がる (`placeSegment`
      // が同じ `reachedAnchor` で端点を決める)。
      let start: Anchor = reachedAnchor(this.anchor, this.parallelRun[0].alignment.sampleAt(0).pos);
      for (const [index, leg] of this.parallelRun.entries()) {
        const alignment = leg.alignment;
        const at = previewFromAlignment(alignment);
        const end =
          index === this.parallelRun.length - 1
            ? this.endAnchor ?? { pos: at.end }
            : { pos: at.end };
        diagnostics.push(evaluateAlignment(alignment, cls));
        const check = checkPlacement({
          network: this.network,
          cls,
          alignment,
          start,
          end,
          field: this.field,
        });
        blockers.push(...check.blockers);
        this.blockedPlaces.push(...check.places);
        buildRibbon(mb, alignment.sample(2), profileFor(cls), { skirt: false, cls });
        start = { pos: at.end.clone() };
      }
      this.lastDiagnostics = worstDiagnostics(diagnostics);
      this.blockers = [...new Set(blockers)];
    } else if (preview && this.anchor) {
      const cls = this.cls;
      const alignment = this.previewAlignment(preview);
      this.lastDiagnostics = evaluateAlignment(alignment, cls);
      // 置けるかどうかはクリック前に分かるようにする。
      const check = checkPlacement({
        network: this.network,
        cls,
        alignment,
        // 届かなかった端は接続を諦めて敷くので、判定もその形で行う
        // (`placeSegment` が同じ `reachedAnchor` で端点を決める)。
        start: reachedAnchor(this.anchor, preview.start),
        end: this.endAnchor ?? { pos: preview.end },
        field: this.field,
      });
      this.blockers = check.blockers;
      this.blockedPlaces = check.places;
      buildRibbon(mb, alignment.sample(2), profileFor(cls), { skirt: false, cls });
    } else if (this.mode !== 'station') {
      this.lastDiagnostics = null;
      this.blockers = [];
    }
    // 原因の交差点は目印で示す (文言だけでは、どの交差点の話か分からない)。
    this.syncMarkers();
    // 置けないときはプレビューを赤くする。
    setPreviewBlocked(
      { preview: this.previewMaterial, xray: this.previewXrayMaterial },
      this.blockers.length > 0,
    );
    const old = this.previewMesh.geometry;
    // 透視用の面は同じ形を使い回す (作り直すのは 1 つだけ)。
    const geometry = mb.build();
    this.previewMesh.geometry = geometry;
    this.previewXrayMesh.geometry = geometry;
    old.dispose();
  }

  /** 左クリック。モードに応じて始点確定・確定敷設・削除を行う。 */
  click(): void {
    if (!this.cursor) return;

    if (this.mode === 'bulldoze') {
      if (this.hoverSegment !== null) {
        this.network.removeSegment(this.hoverSegment);
        this.network.pruneOrphanNodes();
        this.onChanged();
      }
      return;
    }
    if (this.mode === 'inspect') {
      this.selectedStationId = this.inspection?.station?.id ?? null;
      return;
    }
    if (this.mode === 'zone') {
      if (!this.zones) return;
      if (this.zones.paint(this.cursor.x, this.cursor.z, ZONE_BRUSH_RADIUS, this.zoneType)) {
        this.onChanged();
      }
      return;
    }
    if (this.mode === 'line') {
      if (!this.lines || !this.hoverStation) return;
      // 引いている路線が無ければ、最初の駅を選んだところで 1 本作る。
      const line = this.currentLine() ?? this.lines.create();
      this.editingLineId = line.id;
      if (this.lines.addStop(line.id, this.hoverStation.id)) this.onChanged();
      return;
    }
    if (this.mode === 'station') {
      if (!this.stationCandidate || this.blockers.length > 0) return;
      this.network.addStation({
        name: this.stationCandidate.name,
        center: this.stationCandidate.center,
        heading: this.stationCandidate.heading,
        length: this.stationCandidate.length,
        trackCount: this.stationCandidate.trackCount,
        platformCount: this.stationCandidate.platformCount,
        elevated: this.stationCandidate.elevated,
      });
      this.stationSettings.name = this.nextStationName();
      this.onChanged();
      this.updateStationPreview();
      return;
    }
    const target = this.resolveTarget();
    if (!this.anchor) {
      this.anchor = target.anchor;
      this.anchorMarker = target.marker ? { ...target.marker, fixed: true } : null;
      // 始点が既存の線形の隣なら、そこから平行に敷き始める。既に敷いた
      // 平行線の端 (ノード) から続ける場合も同じ。
      // 駅端では隣の構内線を平行スナップの基準にすると、基準線が駅端で
      // 終わっているためプレビューまで消えてしまう。構内線は各端点から
      // 1 本ずつ独立して延長する。
      const stationEndpoint =
        target.anchor.node !== undefined &&
        this.network
          .branchesAt(target.anchor.node)
          .some((branch) => this.network.getSegment(branch.segment).stationTrack !== undefined);
      this.parallel = stationEndpoint ? null : this.findParallel(target.anchor.pos);
      this.refreshPreview();
      return;
    }

    if (!this.preview || !this.endAnchor) return;
    if (this.preview.horizontal.length < 3) return;
    // 規格違反・重なり・建築限界不足は置かせない。
    if (this.blockers.length > 0) return;

    const preview = this.preview;
    const result = this.crossingPlan
      ? this.placeCrossingRun()
      : this.parallelRun.length > 0
        ? this.placeParallelRun()
        : this.place(this.anchor, this.endAnchor, preview);
    if (!result) return;

    // 終点を始点にして続けて引けるようにする。接線は敷設後の線形から
    // 取り直す (折れをなめらかにした分だけ、プレビューとずれるため)。
    this.anchor = this.continuation(result);
    const endNode = this.network.nodes.get(result.endNode);
    this.anchorMarker =
      this.anchor && endNode ? { ...this.nodeMarker(endNode), fixed: true } : null;
    // 平行に敷いていたなら、基準の線形を取り直す。既存の線形の端まで
    // 来ていれば、そのまま隣のセグメントへ引き継がれる。
    this.parallel =
      this.parallel && this.anchor
        ? this.findParallel(this.anchor.pos, preview.endTangent)
        : null;
    this.preview = null;
    this.endAnchor = null;
    this.parallelRun = [];
    this.crossingPlan = null;
    this.onChanged();
  }

  /** 1 本敷いて、線路の向きを揃える。 */
  private place(start: Anchor, end: Anchor, preview: PlacementPreview): PlaceResult {
    const result = placeSegment(this.network, this.classId, start, end, preview);
    this.alignRailDirection(result.segment, result.startNode, result.endNode);
    return result;
  }

  /**
   * 交点で高さを合わせた区間を、交点ごとに 1 本ずつ敷く。
   *
   * 交点では**先に相手を分割**して、できたノードへ向けて敷く。あとから
   * 自動で交差点にまとめる (`resolveAutoJunctions`) 経路と違って、ノードの
   * 位置を平均で寄せないので、交点の高さが既存の線形のまま残る。
   *
   * 相手のセグメント ID は分割のたびに変わるので、立案時の ID ではなく
   * 位置・種別・高さから引き直す (`splitAtCrossing`)。
   */
  private placeCrossingRun(): PlaceResult | null {
    const plan = this.crossingPlan!;
    // 引き直しで自分の区間を拾わないように覚えておく。
    const placed = new Set<SegmentId>();
    const laid: { segment: SegmentId; preview: PlacementPreview }[] = [];
    let start: Anchor = this.anchor!;
    let result: PlaceResult | null = null;

    for (const [index, leg] of plan.legs.entries()) {
      const preview = previewFromAlignment(leg.alignment);
      let end: Anchor;
      if (!leg.joint) {
        end =
          index === plan.legs.length - 1
            ? this.endAnchor ?? { pos: preview.end }
            : { pos: preview.end };
      } else {
        // 先に相手を分割して、できたノードへ向けて敷く。位置を平均で寄せる
        // `mergeNodes` を通らないので、交点の高さが既存の線形のまま残る。
        const node = splitAtCrossing(this.network, leg.joint, placed);
        end = node ? { pos: node.pos.clone(), node: node.id } : { pos: preview.end.clone() };
      }
      result = this.place(start, end, preview);
      placed.add(result.segment);
      laid.push({ segment: result.segment, preview });
      const node = this.network.nodes.get(result.endNode);
      start = node ? { pos: node.pos.clone(), node: node.id } : { pos: preview.end.clone() };
    }

    // 区間どうしの継ぎ目が枝 2 本だけになる所 (道路を交点で分けただけの所)
    // では `smoothGradeJoint` が勾配を動かす。交点の高さに合わせて解いた
    // 勾配を入れ直す。全部敷き終わってからでないと、次の区間を敷いたときに
    // また動かされる。区間の**外側**の端は既存の線形へ繋がるので、均して
    // もらったままにする。
    for (const [index, { segment, preview }] of laid.entries()) {
      this.network.updateSegment(segment, {
        ...(index > 0 ? { gradeA: preview.startGrade } : {}),
        ...(index < laid.length - 1 ? { gradeB: preview.endGrade } : {}),
      });
    }

    // 既設の道路を曲げるのは最後。敷く場所には影響しない。
    for (const edit of plan.roadEdits) applyRoadEdit(this.network, edit, placed);
    return result;
  }

  /**
   * ルートに沿った平行区間を、区切りごとに 1 本ずつ敷く。
   *
   * 途中の継ぎ目は新しいノードになり、次の区間はそこから続く。基準の線形と
   * 同じ位置で区切られるので、橋・トンネルの境目や踏切が隣どうしで揃う。
   * 最後の区間だけは、吸い付いていた相手 (既設の平行線の端など) へ繋ぐ。
   */
  private placeParallelRun(): PlaceResult | null {
    let start = this.anchor!;
    let result: PlaceResult | null = null;
    for (const [index, leg] of this.parallelRun.entries()) {
      const preview = previewFromAlignment(leg.alignment);
      const end =
        index === this.parallelRun.length - 1
          ? this.endAnchor ?? { pos: preview.end }
          : { pos: preview.end.clone() };
      result = this.place(start, end, preview);
      const node = this.network.nodes.get(result.endNode);
      start = node ? { pos: node.pos.clone(), node: node.id } : { pos: preview.end.clone() };
    }
    return result;
  }

  /**
   * 続けて引くためのアンカー。
   *
   * 行き止まりで終わったなら、その線形から接線と勾配を引き継いで滑らかに
   * 続ける。**交差点に取り付いて終わったなら引き継がない**。そこから引く
   * のは「続き」ではなく新しい枝なので、向きは自由に決められる方がよい
   * (一度やめて交差点を指し直したときと同じアンカーになる)。どちらも
   * `anchorFromNode` の判断そのままなので、続けても・やめても同じ形に
   * 引ける。
   */
  private continuation(result: PlaceResult): Anchor | null {
    const end = this.network.nodes.get(result.endNode);
    if (!end) return null;
    return anchorFromNode(this.network, end, this.cls);
  }

  /**
   * Rails are directional. At a simple end-to-end joint, make one segment arrive
   * and the other depart regardless of which end the user drew from. A station
   * track takes priority when the endpoint is also part of a larger junction.
   */
  private alignRailDirection(segmentId: SegmentId, startNode: NodeId, endNode: NodeId): void {
    const segment = this.network.segments.get(segmentId);
    if (!segment || this.cls.kind !== 'rail') return;
    let shouldReverse: boolean | null = null;
    for (const nodeId of [startNode, endNode]) {
      const connectedRails = this.network
        .branchesAt(nodeId)
        .map((branch) => this.network.getSegment(branch.segment))
        .filter(
          (candidate) =>
            candidate.id !== segmentId && this.network.classOf(candidate).kind === 'rail',
        );
      const reference =
        connectedRails.find((candidate) => candidate.stationTrack !== undefined) ??
        (connectedRails.length === 1 ? connectedRails[0] : undefined);
      if (!reference) continue;
      const referenceArrives = reference.b === nodeId;
      const newArrives = segment.b === nodeId;
      const needed = referenceArrives === newArrives;
      if (shouldReverse === null) shouldReverse = needed;
      else if (shouldReverse !== needed) return;
    }
    if (shouldReverse) this.network.reverseSegment(segmentId);
  }

  /** いま駅を足している路線。 */
  private currentLine(): { id: LineId; name: string; stops: StationId[] } | null {
    if (this.editingLineId === null) return null;
    return this.lines?.get(this.editingLineId) ?? null;
  }

  /** 新しい路線を作り、そこへ駅を足していく。 */
  newLine(): void {
    if (!this.lines) return;
    this.editingLineId = this.lines.create().id;
    this.onChanged();
  }

  /** 既にある路線に駅を足せるようにする (一覧から選んだとき)。 */
  selectLine(id: LineId | null): void {
    this.editingLineId = id !== null && this.lines?.get(id) ? id : null;
  }

  /** 路線を消す。 */
  removeLine(id: LineId): void {
    if (!this.lines?.remove(id)) return;
    if (this.editingLineId === id) this.editingLineId = null;
    this.onChanged();
  }

  /** 引いている路線の、最後に足した駅を取り消す。 */
  undoLineStop(): void {
    if (this.editingLineId === null) return;
    if (this.lines?.removeLastStop(this.editingLineId)) this.onChanged();
  }

  status(): ToolStatus {
    const preview = this.preview;
    const length = this.mode === 'station'
      ? this.stationSettings.length * this.stationSettings.trackCount
      : preview
        ? preview.horizontal.length
        : 0;
    return {
      mode: this.mode,
      classId: this.classId,
      elevation: this.elevationOffset,
      drawing: this.mode === 'station' ? this.stationCandidate !== null : this.anchor !== null,
      length,
      radius: preview ? preview.radius : Infinity,
      grade: preview ? preview.grade : 0,
      diagnostics: this.lastDiagnostics,
      snap: this.snapKind,
      markers: this.markers,
      zone: this.zoneType,
      hoverSegment: this.hoverSegment,
      inspect: this.inspection,
      selectedStation:
        this.selectedStationId === null ? null : this.network.stations.get(this.selectedStationId) ?? null,
      station: { ...this.stationSettings },
      cost: length * this.cls.costPerMeter,
      blockers: this.blockers,
      parallelSnap: this.parallelSnap,
      parallelTo: this.parallel?.segment ?? null,
      line: this.lineStatus(),
      hoverStation: this.mode === 'line' ? this.hoverStation : null,
    };
  }

  private lineStatus(): ToolStatus['line'] {
    const line = this.currentLine();
    if (!line) return null;
    return {
      id: line.id,
      name: line.name,
      stops: line.stops.map((id) => this.network.stations.get(id)?.name ?? `駅 #${id}`),
    };
  }

  private nextStationName(): string {
    let index = this.network.stations.size + 1;
    const used = new Set([...this.network.stations.values()].map((station) => station.name));
    while (used.has(`駅 ${index}`)) index++;
    return `駅 ${index}`;
  }
}

/**
 * 区画を塗る筆の輪。
 *
 * 円板で塗り潰すと、起伏のある地形では三角形が地面に潜って歯抜けに
 * 見える。細い輪 (幅 1.6 m) なら地形に沿うので、どこまで塗れるかが
 * どんな斜面でも分かる。
 */
function buildZoneBrush(
  mb: MeshBuilder,
  cursor: Vector3,
  field: Heightfield,
  zone: ZoneType | null,
): void {
  const color = zone ? ZONE_COLORS[zone] : ZONE_EMPTY_COLOR;
  const up = new Vector3(0, 1, 0);
  const steps = 64;
  const lift = 0.3;
  const width = 1.6;
  const inner: number[] = [];
  const outer: number[] = [];
  const at = (angle: number, radius: number): number => {
    const x = cursor.x + Math.cos(angle) * radius;
    const z = cursor.z + Math.sin(angle) * radius;
    return mb.vertex(new Vector3(x, field.heightAt(x, z) + lift, z), up, 0, 0, color);
  };
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    inner.push(at(angle, ZONE_BRUSH_RADIUS - width));
    outer.push(at(angle, ZONE_BRUSH_RADIUS));
  }
  for (let i = 0; i < steps; i++) {
    const j = (i + 1) % steps;
    mb.quad(inner[i], inner[j], outer[j], outer[i]);
  }
}
