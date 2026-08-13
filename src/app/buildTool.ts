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
  type Anchor,
  type PlaceResult,
  type PlacementPreview,
} from '../network/editing';
import type { Network, SegmentId } from '../network/network';
import {
  defaultSpacing,
  offsetCurve,
  parallelTracks,
  placeParallel,
  type TrackAnchors,
} from '../network/parallel';
import { checkPlacement } from '../network/rules';
import { evaluateAlignment, type SegmentDiagnostics } from '../network/validation';
import { createPreviewMaterial, setPreviewBlocked } from '../render/materials';
import type { Heightfield } from '../terrain/heightfield';

export type ToolMode = 'build' | 'bulldoze' | 'inspect';

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
  snap: 'none' | 'node' | 'segment';
  hoverSegment: SegmentId | null;
  cost: number;
  /** 並列敷設の本数。 */
  parallel: number;
  /** 空でなければ敷設できない。理由をそのまま表示する。 */
  blockers: string[];
}

const ELEVATION_STEP = 3;
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
  /** 並列敷設の本数。複線・三線はこれで作る。 */
  parallelCount = 1;

  readonly previewGroup = new Group();
  private readonly previewMesh: Mesh;
  private readonly previewMaterial: MeshStandardMaterial;
  private anchor: Anchor | null = null;
  private cursor: Vector3 | null = null;
  private preview: PlacementPreview | null = null;
  private endAnchor: Anchor | null = null;
  private snapKind: 'none' | 'node' | 'segment' = 'none';
  private hoverSegment: SegmentId | null = null;
  private lastDiagnostics: SegmentDiagnostics | null = null;
  private blockers: string[] = [];
  /** 並列敷設で、続けて引くときの各線の接続先。 */
  private trackAnchors: TrackAnchors = [];

  constructor(
    private readonly network: Network,
    private readonly field: Heightfield,
    private readonly onChanged: () => void,
  ) {
    this.previewGroup.name = 'preview';
    this.previewMaterial = createPreviewMaterial();
    this.previewMesh = new Mesh(new MeshBuilder().build(), this.previewMaterial);
    this.previewMesh.frustumCulled = false;
    this.previewGroup.add(this.previewMesh);
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

  /** 並列敷設の本数を変える。 */
  setParallel(count: number): void {
    const next = clamp(Math.round(count), 1, 4);
    if (next !== this.parallelCount) this.cancel();
    this.parallelCount = next;
  }

  /** いま敷こうとしている並列の各線 (中心線からの横距と向き)。 */
  private tracks(): ReturnType<typeof parallelTracks> {
    return parallelTracks(this.cls, this.parallelCount);
  }

  adjustElevation(steps: number): void {
    this.elevationOffset = clamp(this.elevationOffset + steps * ELEVATION_STEP, -30, 60);
    this.refreshPreview();
  }

  cancel(): void {
    this.anchor = null;
    this.preview = null;
    this.endAnchor = null;
    this.lastDiagnostics = null;
    this.blockers = [];
    this.trackAnchors = [];
    this.updatePreviewMesh();
  }

  /** 毎フレーム、カーソルの地形交点を受け取って状態を更新する。 */
  update(cursor: Vector3 | null, modifiers: CursorModifiers): void {
    this.cursor = cursor;
    this.modifiers = modifiers;
    this.hoverSegment = null;

    if (!cursor) {
      this.preview = null;
      this.updatePreviewMesh();
      return;
    }

    if (this.mode === 'bulldoze' || this.mode === 'inspect') {
      const hit = this.network.findSegmentNear(cursor, 12);
      this.hoverSegment = hit?.segment ?? null;
      this.preview = null;
      this.updatePreviewMesh();
      return;
    }

    this.refreshPreview();
  }

  private modifiers: CursorModifiers = { straight: false, noSnap: false };

  /** 現在のカーソル位置から、接続先を含めた到達点を決める。 */
  private resolveTarget(): { anchor: Anchor; snap: 'none' | 'node' | 'segment' } {
    const cursor = this.cursor!;
    const cls = this.cls;
    const free = new Vector3(
      cursor.x,
      this.field.heightAt(cursor.x, cursor.z) + this.elevationOffset,
      cursor.z,
    );

    if (this.modifiers.noSnap) return { anchor: { pos: free }, snap: 'none' };

    const nodeSnapRadius = Math.max(8, cls.halfWidth * 1.4);
    const node = this.network.findNodeNear(cursor, nodeSnapRadius);
    if (node) {
      return { anchor: anchorFromNode(this.network, node, cls), snap: 'node' };
    }

    const onSegment = this.network.findSegmentNear(cursor, cls.halfWidth + 3);
    if (onSegment) {
      const other = this.network.classOf(this.network.getSegment(onSegment.segment));
      // 種別が違う場合は交差 (踏切・立体交差) にしたいのでスナップしない。
      if (other.kind === cls.kind) {
        return {
          anchor: anchorFromSegment(this.network, onSegment.segment, onSegment.s),
          snap: 'segment',
        };
      }
    }

    return { anchor: { pos: free }, snap: 'none' };
  }

  private refreshPreview(): void {
    if (!this.cursor || this.mode !== 'build') return;
    const target = this.resolveTarget();
    this.snapKind = target.snap;

    if (!this.anchor) {
      this.preview = null;
      this.endAnchor = null;
      this.updatePreviewMesh();
      return;
    }

    let end = target.anchor;
    if (this.modifiers.straight && target.snap === 'none') {
      end = { ...end, pos: this.snapAngle(this.anchor.pos, end.pos) };
    }

    this.endAnchor = end;
    this.preview = computePlacement(this.anchor, end.pos, {
      straight: this.modifiers.straight,
      cls: this.cls,
    });
    this.updatePreviewMesh();
  }

  /** 始点からの方位を 15 度刻みに丸める。 */
  private snapAngle(from: Vector3, to: Vector3): Vector3 {
    const d = new Vector2(to.x - from.x, to.z - from.z);
    const len = d.length();
    if (len < 1e-3) return to.clone();
    const angle = Math.round(Math.atan2(d.y, d.x) / ANGLE_SNAP) * ANGLE_SNAP;
    return new Vector3(from.x + Math.cos(angle) * len, to.y, from.z + Math.sin(angle) * len);
  }

  /** 並列の 1 本ぶんの線形。中心線のプレビューを横にずらして作る。 */
  private trackAlignment(preview: PlacementPreview, offset: number): Alignment {
    const horizontal = offsetCurve(preview.horizontal, offset);
    return new Alignment(
      horizontal,
      new VerticalProfile(
        this.anchor!.pos.y,
        preview.end.y,
        preview.startGrade,
        preview.endGrade,
        horizontal.length,
      ),
    );
  }

  /** プレビューの線形を実際の断面で描き直す。並列敷設では本数ぶん描く。 */
  private updatePreviewMesh(): void {
    const mb = new MeshBuilder();
    const preview = this.preview;
    if (preview && this.anchor) {
      const cls = this.cls;
      const tracks = this.tracks();
      const blockers = new Set<string>();
      this.lastDiagnostics = null;
      tracks.forEach((track, i) => {
        const alignment = this.trackAlignment(preview, track.offset);
        // 診断は中心に近い線のものを代表として出す。
        if (i === 0) this.lastDiagnostics = evaluateAlignment(alignment, cls);
        // 置けるかどうかはクリック前に分かるようにする。
        const single = tracks.length === 1;
        for (const message of checkPlacement({
          network: this.network,
          cls,
          alignment,
          start: single ? this.anchor! : { pos: alignment.sampleAt(0).pos },
          end: single
            ? this.endAnchor ?? { pos: preview.end }
            : { pos: alignment.sampleAt(alignment.length).pos },
        }).blockers) {
          blockers.add(message);
        }
        buildRibbon(mb, alignment.sample(2), profileFor(cls), { skirt: false, cls });
      });
      this.blockers = [...blockers];
    } else {
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

    const target = this.resolveTarget();
    if (!this.anchor) {
      this.anchor = target.anchor;
      this.refreshPreview();
      return;
    }

    if (!this.preview || !this.endAnchor) return;
    if (this.preview.horizontal.length < 3) return;
    // 規格違反・重なり・建築限界不足は置かせない。
    if (this.blockers.length > 0) return;

    const preview = this.preview;
    const tracks = this.tracks();
    const single = tracks.length === 1;
    // 1 本のときは、スナップした接続先 (ノード・既存線形の途中) をそのまま
    // 使う。並列のときは線ごとに端点が違うので、その位置の近くにある
    // ノードを探して繋ぐ (既に敷いた複線の続きを引ける)。
    const starts: TrackAnchors = single
      ? [this.anchor]
      : this.trackAnchors.length === tracks.length
        ? this.trackAnchors
        : [];
    const ends: TrackAnchors = single ? [this.endAnchor] : [];

    const results = placeParallel(
      this.network,
      this.classId,
      tracks,
      preview,
      this.anchor.pos.y,
      { starts, ends, snap: single ? undefined : (pos) => this.nodeNear(pos) },
    );

    // 終点を始点にして続けて引けるようにする。接線は敷設後の線形から
    // 取り直す (折れをなめらかにした分だけ、プレビューとずれるため)。
    this.trackAnchors = results.map((result) => {
      const node = this.network.nodes.get(result.endNode);
      return node ? { pos: node.pos.clone(), node: node.id } : undefined;
    });
    const centre = this.continuation(results, preview);
    this.anchor = centre;
    if (!centre) this.trackAnchors = [];
    this.preview = null;
    this.endAnchor = null;
    this.onChanged();
  }

  /** その位置にあるノード (並列敷設で、隣の線を掴まないだけの近さで探す)。 */
  private nodeNear(pos: Vector3): Anchor | undefined {
    const radius = Math.min(4, defaultSpacing(this.cls) * 0.4);
    const node = this.network.findNodeNear(pos, radius);
    return node ? { pos: node.pos.clone(), node: node.id } : undefined;
  }

  /**
   * 続けて引くための中心線のアンカー。
   *
   * 1 本なら敷いた線形からそのまま引き継ぐ。並列のときは中心に線が無い
   * ことがあるので、敷いた各線の端点と接線を平均して中心を復元する。
   */
  private continuation(results: PlaceResult[], preview: PlacementPreview): Anchor | null {
    const ends = results
      .map((result) => this.network.nodes.get(result.endNode))
      .filter((node): node is NonNullable<typeof node> => node !== undefined);
    if (ends.length === 0) return null;
    if (results.length === 1) {
      const inherited = anchorFromNode(this.network, ends[0], this.cls);
      return {
        ...inherited,
        tangent: inherited.tangent ?? preview.endTangent.clone(),
        grade: inherited.grade ?? preview.endGrade,
      };
    }

    const pos = new Vector3();
    const tangent = new Vector2();
    let grade = 0;
    for (const node of ends) {
      const inherited = anchorFromNode(this.network, node, this.cls);
      pos.add(node.pos);
      tangent.add(inherited.tangent ?? preview.endTangent);
      grade += inherited.grade ?? preview.endGrade;
    }
    pos.divideScalar(ends.length);
    grade /= ends.length;
    if (tangent.lengthSq() < 1e-9) tangent.copy(preview.endTangent);
    return { pos, tangent: tangent.normalize(), grade };
  }

  status(): ToolStatus {
    const preview = this.preview;
    const length = preview ? preview.horizontal.length : 0;
    return {
      mode: this.mode,
      classId: this.classId,
      elevation: this.elevationOffset,
      drawing: this.anchor !== null,
      length,
      radius: preview ? preview.radius : Infinity,
      grade: preview ? preview.grade : 0,
      diagnostics: this.lastDiagnostics,
      snap: this.snapKind,
      hoverSegment: this.hoverSegment,
      cost: length * this.cls.costPerMeter * this.parallelCount,
      blockers: this.blockers,
      parallel: this.parallelCount,
    };
  }
}
