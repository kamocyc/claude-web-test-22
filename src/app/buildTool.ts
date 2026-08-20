import { Group, Mesh, Vector2, Vector3, type MeshStandardMaterial } from 'three';
import { Alignment } from '../core/alignment';
import { MeshBuilder } from '../core/meshbuilder';
import { VerticalProfile } from '../core/profile';
import { DEG, clamp } from '../core/units';
import { buildRibbon, profileFor } from '../build/surface';
import { getClass, type NetworkClass } from '../network/classes';
import {
  anchorFromNode,
  anchorFromSegment,
  computePlacement,
  placeSegment,
  type Anchor,
  type PlaceResult,
  type PlacementPreview,
} from '../network/editing';
import type { NetNode, Network, NodeId, SegmentId } from '../network/network';
import {
  findParallelReference,
  parallelAlignment,
  previewFromAlignment,
  stationOf,
  type ParallelReference,
} from '../network/parallel';
import { checkPlacement, junctionReach } from '../network/rules';
import {
  placeScissorsCrossover,
  scissorsPlanAt,
  type ScissorsPlan,
} from '../network/scissors';
import { evaluateAlignment, type SegmentDiagnostics } from '../network/validation';
import { createPreviewMaterial, riskTint, setPreviewBlocked } from '../render/materials';
import { SnapView, type SnapKind, type SnapMarker } from '../render/snapView';
import {
  inspectPoint,
  sampleProfile,
  type InspectProfile,
  type PointInspection,
  type SurfaceContext,
} from './inspect';
import type { Heightfield } from '../terrain/heightfield';

export type ToolMode = 'build' | 'scissors' | 'bulldoze' | 'inspect';

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
  cost: number;
  /** 平行スナップが有効か。 */
  parallelSnap: boolean;
  /** いま平行に敷こうとしている相手 (無ければ null)。 */
  parallelTo: SegmentId | null;
  /** 空でなければ敷設できない。理由をそのまま表示する。 */
  blockers: string[];
}

/** カーソルの行き先 (吸い付いた点と、その目印)。 */
interface Target {
  anchor: Anchor;
  snap: SnapKind;
  marker: SnapMarker | null;
}

const ELEVATION_STEP = 3;

/**
 * 吸い付く相手と「今働いている高さ」の差の上限 [m]。
 *
 * 立体交差の桁下は道路で 4.5 m + 床版 1.1 m あるので、これより狭く
 * 取れば上下の線形を取り違えない。高さ設定の刻み (3 m) より広いので、
 * 1 段ずれていても既存の線形に繋がる。
 */
const SNAP_HEIGHT = 4;

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

  readonly previewGroup = new Group();
  private readonly snapView = new SnapView();
  private readonly previewMesh: Mesh;
  private readonly previewMaterial: MeshStandardMaterial;
  private anchor: Anchor | null = null;
  private cursor: Vector3 | null = null;
  private preview: PlacementPreview | null = null;
  private endAnchor: Anchor | null = null;
  private snapKind: SnapKind = 'none';
  /** 引き始めた点の目印 (確定済み)。 */
  private anchorMarker: SnapMarker | null = null;
  private markers: SnapMarker[] = [];
  private hoverSegment: SegmentId | null = null;
  private lastDiagnostics: SegmentDiagnostics | null = null;
  private blockers: string[] = [];
  /** いま平行に敷こうとしている基準の線形。 */
  private parallel: ParallelReference | null = null;
  /** 平行スナップで組み立てた線形 (プレビューと同じもの)。 */
  private parallelAlignmentPreview: Alignment | null = null;
  /** シーサスクロッシングの一括施工プレビュー。 */
  private scissorsPlan: ScissorsPlan | null = null;
  /** 確認モードで読み取った、カーソル下の 1 点。 */
  private inspection: PointInspection | null = null;
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
  ) {
    this.previewGroup.name = 'preview';
    this.previewMaterial = createPreviewMaterial();
    this.previewMesh = new Mesh(new MeshBuilder().build(), this.previewMaterial);
    this.previewMesh.frustumCulled = false;
    this.previewGroup.add(this.previewMesh, this.snapView.group);
  }

  get cls(): NetworkClass {
    return getClass(this.classId);
  }

  setMode(mode: ToolMode): void {
    this.mode = mode;
    this.cancel();
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
    this.parallelAlignmentPreview = null;
    this.anchorMarker = null;
    this.showMarkers([]);
    this.scissorsPlan = null;
    this.inspection = null;
    this.inspectProfile = null;
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
      this.scissorsPlan = null;
      if (this.mode === 'scissors') this.blockers = [];
      this.updatePreviewMesh();
      return;
    }

    if (this.mode === 'bulldoze' || this.mode === 'inspect') {
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

    if (this.mode === 'scissors') {
      const result = scissorsPlanAt(this.network, cursor);
      this.scissorsPlan = result.plan;
      this.hoverSegment = result.hoverSegment;
      this.blockers = result.blockers;
      this.snapKind = result.plan ? 'scissors' : 'none';
      this.preview = null;
      this.showMarkers([]);
      this.updatePreviewMesh();
      return;
    }

    this.refreshPreview();
  }

  private modifiers: CursorModifiers = { straight: false, noSnap: false };

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

    const onSegment = this.network.findSegmentNear(cursor, cls.halfWidth + 3, height);
    if (onSegment) {
      const other = this.network.classOf(this.network.getSegment(onSegment.segment));
      // 種別が違う場合は交差 (踏切・立体交差) にしたいのでスナップしない。
      if (other.kind === cls.kind) {
        // 交差点の面の中では、既存の線形を分割せずにその交差点へ繋ぐ。
        // 面の中で分割しても交差点の形が保てず (必ず「交差点が近すぎます」
        // になる)、T 字を十字にすることができない。
        const junction = this.junctionAt(onSegment.segment, onSegment.s);
        const distance = Math.hypot(onSegment.pos.x - cursor.x, onSegment.pos.z - cursor.z);
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
        marker: this.parallelMarker(parallel, parallel.pos),
        distance: Math.hypot(parallel.pos.x - cursor.x, parallel.pos.z - cursor.z),
      });
    }

    const best = candidates.sort((a, b) => a.distance - b.distance)[0];
    if (!best) return { anchor: { pos: free }, snap: 'none', marker: null };
    return { anchor: best.anchor, snap: best.snap, marker: best.marker };
  }

  // ---------------------------------------------------------- 目印

  /** 交差点・端点に繋ぐ目印。輪の大きさは交差点の面の広がりに合わせる。 */
  private nodeMarker(node: NetNode): SnapMarker {
    return {
      kind: 'node',
      pos: node.pos.clone(),
      radius: Math.max(junctionReach(this.network, node.id), this.cls.halfWidth * 0.8),
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

  /** 平行に敷く目印。基準の線形をなぞり、間隔を渡り線で示す。 */
  private parallelMarker(reference: ParallelReference, at: Vector3): SnapMarker {
    const alignment = this.network.alignmentOf(reference.segment);
    const guide: Vector3[] = [];
    const steps = Math.max(2, Math.ceil(alignment.length / 4));
    for (let i = 0; i <= steps; i++) {
      guide.push(alignment.sampleAt((alignment.length * i) / steps).pos.clone());
    }
    const s = clamp(stationOf(alignment, at.x, at.z), 0, alignment.length);
    return {
      kind: 'parallel',
      pos: at.clone(),
      radius: Math.max(1.8, this.cls.halfWidth * 0.4),
      guide,
      tie: [alignment.sampleAt(s).pos.clone(), at.clone()],
    };
  }

  /** 目印を描き直す。引き始めた点は常に出す。 */
  private showMarkers(markers: readonly (SnapMarker | null)[]): void {
    this.markers = markers.filter((m): m is SnapMarker => m !== null);
    this.snapView.update(this.markers);
  }

  /** その種別を繋いでよいノードか (線路のノードに道路は繋がない)。 */
  private canJoin(node: NetNode): boolean {
    const branches = this.network.branchesAt(node.id);
    return branches.length === 0 || branches.some((b) => b.cls.kind === this.cls.kind);
  }

  /**
   * 既存の線形の `s` 地点が交差点の面の中なら、その交差点のノード。
   *
   * 面の広がりは敷設の判定と同じ `junctionReach` で測る。指せる所と
   * 置ける所が同じ範囲になるので、「指せるのに置けない」所ができない。
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

  /** カーソルが交差点の面の中にあれば、その交差点のノード。 */
  private junctionUnder(cursor: Vector3, y: number): { node: NetNode; distance: number } | null {
    let best: { node: NetNode; distance: number } | null = null;
    for (const node of this.network.nodes.values()) {
      if (Math.abs(node.pos.y - y) > SNAP_HEIGHT) continue;
      const distance = Math.hypot(node.pos.x - cursor.x, node.pos.z - cursor.z);
      if (distance > 60 || (best && distance >= best.distance)) continue;
      if (!this.canJoin(node)) continue;
      if (distance > junctionReach(this.network, node.id)) continue;
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
      this.parallelAlignmentPreview = null;
      this.showMarkers([target.marker]);
      this.updatePreviewMesh();
      return;
    }

    // 平行に敷いている間は、基準の線形をそのまま横にずらした線形を引く。
    if (this.parallel && !this.modifiers.noSnap && this.parallelPreview()) {
      this.updatePreviewMesh();
      return;
    }

    this.parallelAlignmentPreview = null;
    let end = target.anchor;
    if (this.modifiers.straight && target.snap === 'none') {
      end = { ...end, pos: this.snapAngle(this.anchor.pos, end.pos) };
    }

    this.endAnchor = end;
    this.preview = computePlacement(this.anchor, end, {
      straight: this.modifiers.straight,
      cls: this.cls,
    });
    // (角度スナップで位置をずらすのは、どこにも吸い付いていないときだけ
    //  なので、そのときは target.marker が無い。)
    this.showMarkers([this.anchorMarker, target.marker]);
    this.updatePreviewMesh();
  }

  /**
   * 平行スナップのプレビューを組み立てる。
   *
   * 始点・カーソルをそれぞれ基準線形に投影し、その間を横にずらした線形に
   * する。カーソルが基準の端を越えたらそこで止まるので、既存の線形の
   * 区切り (ノード) と同じ位置で区切って敷ける。
   */
  private parallelPreview(): boolean {
    const anchor = this.anchor;
    const reference = this.parallel;
    if (!reference || !anchor || !this.network.segments.has(reference.segment)) return false;

    const solve = (ref: ParallelReference): Alignment | null => {
      const alignment = this.network.alignmentOf(ref.segment);
      const s0 = stationOf(alignment, anchor.pos.x, anchor.pos.z);
      const s1 = stationOf(alignment, this.cursor!.x, this.cursor!.z);
      return parallelAlignment(alignment, s0, s1, ref.offset);
    };

    let parallel = solve(reference);
    if (!parallel) {
      // 基準の端に来ている。引こうとしている向きに続く線形へ乗り換える
      // (既存の複線を、区切りを跨いで続けて引ける)。
      const direction = new Vector2(
        this.cursor!.x - anchor.pos.x,
        this.cursor!.z - anchor.pos.z,
      );
      const next =
        direction.lengthSq() > 1e-6 ? this.findParallel(anchor.pos, direction.normalize()) : null;
      if (next && next.segment !== reference.segment) {
        this.parallel = next;
        parallel = solve(next);
      }
    }
    if (!parallel) {
      this.preview = null;
      this.endAnchor = null;
      this.parallelAlignmentPreview = null;
      this.showMarkers([this.anchorMarker]);
      return true;
    }

    this.parallelAlignmentPreview = parallel;
    this.preview = previewFromAlignment(parallel);
    // 既に敷いてある平行線の端に届いたら、そこへ繋ぐ。
    const node = this.network.findNodeNear(this.preview.end, 2);
    this.endAnchor = node
      ? { pos: node.pos.clone(), node: node.id }
      : { pos: this.preview.end.clone() };
    this.snapKind = 'parallel';
    // 何に平行なのか・どこまで来ているのかを目印で出す。
    this.showMarkers([
      this.anchorMarker,
      this.parallelMarker(this.parallel ?? reference, this.preview.end),
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

  /** いま敷こうとしている線形。 */
  private previewAlignment(preview: PlacementPreview): Alignment {
    if (this.parallelAlignmentPreview) return this.parallelAlignmentPreview;
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
    if (this.scissorsPlan) {
      const cls = getClass(this.scissorsPlan.classId);
      for (const connection of this.scissorsPlan.connections) {
        buildRibbon(mb, connection.alignment.sample(2), profileFor(cls), {
          skirt: false,
          cls,
        });
      }
      this.lastDiagnostics = null;
    } else if (preview && this.anchor) {
      const cls = this.cls;
      const alignment = this.previewAlignment(preview);
      this.lastDiagnostics = evaluateAlignment(alignment, cls);
      // 置けるかどうかはクリック前に分かるようにする。
      this.blockers = checkPlacement({
        network: this.network,
        cls,
        alignment,
        start: this.anchor,
        end: this.endAnchor ?? { pos: preview.end },
        field: this.field,
      }).blockers;
      buildRibbon(mb, alignment.sample(2), profileFor(cls), { skirt: false, cls });
    } else if (this.mode !== 'scissors') {
      this.lastDiagnostics = null;
      this.blockers = [];
    }
    // 置けないときはプレビューを赤くする。
    setPreviewBlocked({ material: this.previewMaterial }, this.blockers.length > 0);
    const old = this.previewMesh.geometry;
    this.previewMesh.geometry = mb.build();
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
    if (this.mode === 'inspect') return;
    if (this.mode === 'scissors') {
      if (!this.scissorsPlan || this.blockers.length > 0) return;
      placeScissorsCrossover(this.network, this.scissorsPlan);
      this.scissorsPlan = null;
      this.preview = null;
      this.blockers = [];
      this.onChanged();
      this.update(this.cursor, this.modifiers);
      return;
    }

    const target = this.resolveTarget();
    if (!this.anchor) {
      this.anchor = target.anchor;
      this.anchorMarker = target.marker ? { ...target.marker, fixed: true } : null;
      // 始点が既存の線形の隣なら、そこから平行に敷き始める。既に敷いた
      // 平行線の端 (ノード) から続ける場合も同じ。
      this.parallel = this.findParallel(target.anchor.pos);
      this.refreshPreview();
      return;
    }

    if (!this.preview || !this.endAnchor) return;
    if (this.preview.horizontal.length < 3) return;
    // 規格違反・重なり・建築限界不足は置かせない。
    if (this.blockers.length > 0) return;

    const preview = this.preview;
    const result = placeSegment(this.network, this.classId, this.anchor, this.endAnchor, preview);

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
    this.parallelAlignmentPreview = null;
    this.onChanged();
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

  status(): ToolStatus {
    const preview = this.preview;
    const length = this.scissorsPlan?.length ?? (preview ? preview.horizontal.length : 0);
    return {
      mode: this.mode,
      classId: this.classId,
      elevation: this.elevationOffset,
      drawing: this.anchor !== null || this.scissorsPlan !== null,
      length,
      radius: this.scissorsPlan
        ? Math.min(...this.scissorsPlan.connections.map((item) => item.preview.radius))
        : preview
          ? preview.radius
          : Infinity,
      grade: this.scissorsPlan
        ? Math.max(...this.scissorsPlan.connections.map((item) => item.preview.grade))
        : preview
          ? preview.grade
          : 0,
      diagnostics: this.lastDiagnostics,
      snap: this.snapKind,
      markers: this.markers,
      hoverSegment: this.hoverSegment,
      inspect: this.inspection,
      cost:
        length *
        (this.scissorsPlan ? getClass(this.scissorsPlan.classId).costPerMeter : this.cls.costPerMeter),
      blockers: this.blockers,
      parallelSnap: this.parallelSnap,
      parallelTo: this.parallel?.segment ?? null,
    };
  }
}
