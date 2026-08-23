import type { Alignment } from '../core/alignment';
import { RAIL_GAUGE } from '../core/units';
import { getClass } from '../network/classes';
import type { Network, SegmentId } from '../network/network';
import type { StationId } from '../network/station';
import type { StructureMode } from '../network/structure';
import { pointRisk } from '../network/validation';

/**
 * 確認モードの読み取り。
 *
 * カーソルの下にある線形の**その 1 点**について、曲線半径・勾配・縦曲線半径・
 * カントを読み取ります。緩和曲線や縦曲線は「区間の代表値」では分からない
 * (曲率が弧長に沿って変わっていくことそのものが緩和曲線なので) ため、点ごとに
 * 見られる必要があります。区間全体の変化はグラフ用のサンプル列で返します。
 *
 * ここは DOM に触りません。表示の文字列づくりまで含めて素の関数なので、
 * ブラウザなしで確かめられます。
 */

/** 描画側だけが知っている情報。`WorldBuilder` がそのまま満たします。 */
export interface SurfaceContext {
  /** その弧長で描画に使った横断勾配 (カント)。 */
  cantAt(segment: SegmentId, s: number): number;
  /** その弧長の構造形式。 */
  structureModeAt(segment: SegmentId, s: number): StructureMode;
}

/** グラフ用の、区間全体を等間隔に見たサンプル列。 */
export interface InspectProfile {
  length: number;
  /** `[i]` は弧長 `length * i / (n - 1)` の値。 */
  curvature: Float32Array;
  grade: Float32Array;
}

/** カーソル下の 1 点から読み取った値。 */
export interface PointInspection {
  segment: SegmentId;
  classId: string;
  /** 弧長 [m] と線形の全長 [m]。 */
  s: number;
  length: number;
  /** 中心線の高さ [m]。 */
  y: number;
  /** 曲率 [1/m]。符号付きで、線形の向きに見て右カーブが正。 */
  curvature: number;
  /** 縦断勾配 dy/ds。線形の向き基準。 */
  grade: number;
  /** その点の縦曲線半径 [m]。真っ直ぐなら `Infinity`。 */
  verticalRadius: number;
  /** 縦断の 2 階微分。凸 (負) と凹 (正) の判別に使う。 */
  verticalSecond: number;
  /** カント [m]。**道路では `null`** (0 ではなく「無い」)。 */
  cant: number | null;
  /** 描画に使った横断勾配 (正なら右が高い)。 */
  cantRoll: number;
  /** 構造形式。まだ組み立てていなければ `null`。 */
  structure: StructureMode | null;
  /** 規格に対する比 (診断色と同じ値)。 */
  curveRisk: number;
  gradeRisk: number;
  /** 区間全体の変化。同じ線形を指している間は同一オブジェクト。 */
  profile: InspectProfile;
  station: {
    id: StationId;
    name: string;
    trackIndex: number;
    trackCount: number;
    platformCount: number;
    length: number;
  } | null;
}

/** グラフ用のサンプル数。 */
export const PROFILE_SAMPLES = 64;

/** 区間全体の曲率と勾配を等間隔に拾う。 */
export function sampleProfile(alignment: Alignment, count = PROFILE_SAMPLES): InspectProfile {
  const n = Math.max(2, count);
  const curvature = new Float32Array(n);
  const grade = new Float32Array(n);
  const L = alignment.length;
  for (let i = 0; i < n; i++) {
    // `sampleAt` は Vector を毎回作るので、要る 2 つだけを直に取る。
    const s = (L * i) / (n - 1);
    curvature[i] = alignment.horizontal.curvatureAt(s);
    grade[i] = alignment.vertical.gradeAt(s);
  }
  return { length: L, curvature, grade };
}

/** 1 点を読み取る。`profile` は呼び出し側で使い回してよい。 */
export function inspectPoint(
  network: Network,
  segment: SegmentId,
  s: number,
  surface: SurfaceContext | null,
  profile: InspectProfile,
): PointInspection {
  const seg = network.getSegment(segment);
  const cls = network.classOf(seg);
  const alignment = network.alignmentOf(segment);
  const sample = alignment.sampleAt(s);
  const roll = surface?.cantAt(segment, s) ?? 0;
  const risk = pointRisk(sample.curvature, sample.grade, cls);
  const station = network.stationForSegment(segment);
  return {
    segment,
    classId: cls.id,
    s,
    length: alignment.length,
    y: sample.pos.y,
    curvature: sample.curvature,
    grade: sample.grade,
    verticalRadius: alignment.vertical.verticalRadiusAt(s),
    verticalSecond: alignment.vertical.secondDerivativeAt(s),
    cant: cls.kind === 'rail' ? Math.abs(roll) * RAIL_GAUGE : null,
    cantRoll: roll,
    structure: surface ? surface.structureModeAt(segment, s) : null,
    curveRisk: risk.curveRisk,
    gradeRisk: risk.gradeRisk,
    profile,
    station: station && seg.stationTrack
      ? {
          id: station.id,
          name: station.name,
          trackIndex: seg.stationTrack.index,
          trackCount: station.trackCount,
          platformCount: station.platformCount,
          length: station.length,
        }
      : null,
  };
}

// ------------------------------------------------------------------ 表示

/**
 * 曲線とみなす上限の半径 [m]。
 * これより緩いと、この縮尺 (数 km 四方) では直線と区別がつかない。
 */
const STRAIGHT_ABOVE = 5000;

/** 曲線半径。向き (左右) つき。 */
export function formatRadius(curvature: number): string {
  const radius = Math.abs(curvature) > 1e-6 ? 1 / Math.abs(curvature) : Infinity;
  if (!(radius < STRAIGHT_ABOVE)) return '直線';
  return `${curvature > 0 ? '右' : '左'} R ${radius.toFixed(0)} m`;
}

/** 縦断勾配。符号つき。 */
export function formatGrade(grade: number): string {
  return `${grade >= 0 ? '+' : ''}${(grade * 100).toFixed(2)} %`;
}

/** 縦曲線半径。凸 (山) と凹 (谷) を区別する。 */
export function formatVerticalRadius(radius: number, second: number): string {
  if (!(radius < 1e4)) return '直線';
  return `${second < 0 ? '凸' : '凹'} R ${radius.toFixed(0)} m`;
}

/** カント。高い側も出す。 */
export function formatCant(cant: number, roll: number): string {
  const mm = `${(cant * 1000).toFixed(0)} mm`;
  if (Math.abs(roll) < 1e-6) return mm;
  return `${mm} (${roll > 0 ? '右' : '左'}が高い)`;
}

/** 構造形式。 */
export function formatStructure(mode: StructureMode | null): string {
  if (mode === 'bridge') return '橋';
  if (mode === 'tunnel') return 'トンネル';
  if (mode === 'ground') return '地表';
  return '—';
}

/** 弧長。区間のどこを見ているか。 */
export function formatStation(s: number, length: number): string {
  return `${s.toFixed(1)} / ${length.toFixed(1)} m`;
}

// ------------------------------------------------------------------ グラフ

/** グラフの幅 [px] (右パネルの内寸)。 */
export const GRAPH_W = 232;
/** グラフの高さ [px]。CSS の `.graph` と揃える。 */
export const GRAPH_H = 128;
/** 帯の高さ [px] と、上端の位置。見出しはそれぞれの帯の上に置く。 */
const BAND_H = 44;
const BAND_A = 14;
const BAND_B = 76;
const MID_A = BAND_A + BAND_H / 2;
const MID_B = BAND_B + BAND_H / 2;
const HALF = BAND_H / 2;

/**
 * 帯 1 本ぶんの折れ線。
 *
 * 縦の目盛りは「その区間の最大値」ではなく「**規格値と最大値の大きい方**」で
 * 決めます。規格の破線が常に同じ高さに出るので、目盛りを読まなくても
 * 「規格までどれだけ余裕があるか」が形で分かります。
 */
export function bandPoints(
  values: Float32Array | number[],
  limit: number,
  mid: number,
  half = HALF,
): { points: string; scale: number } {
  let peak = Math.abs(limit);
  for (const v of values) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 1e-12 ? half / (peak * 1.15) : 0;
  const n = values.length - 1;
  const out: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = n > 0 ? (i / n) * GRAPH_W : 0;
    out.push(`${x.toFixed(1)},${(mid - values[i] * scale).toFixed(1)}`);
  }
  return { points: out.join(' '), scale };
}

/**
 * 区間全体の曲率と勾配を 2 段の帯で描く SVG。
 *
 * **半径ではなく曲率を描きます。** 緩和曲線では曲率が弧長に比例するので、
 * 曲率で描けば緩和区間がまっすぐな斜めの線になり、一目で分かります。
 * 半径で描くと直線部が無限大に飛んでしまい、同じ形が双曲線に化けます。
 */
export function renderInspectGraph(inspection: PointInspection): string {
  const cls = getClass(inspection.classId);
  const profile = inspection.profile;
  const curveLimit = 1 / cls.minRadius;
  const a = bandPoints(profile.curvature, curveLimit, MID_A);
  const b = bandPoints(profile.grade, cls.maxGrade, MID_B);

  let peakCurve = 0;
  for (const k of profile.curvature) peakCurve = Math.max(peakCurve, Math.abs(k));
  let peakGrade = 0;
  for (const g of profile.grade) peakGrade = Math.max(peakGrade, Math.abs(g));
  const minRadius = peakCurve > 1e-6 ? `最小 R ${(1 / peakCurve).toFixed(0)} m` : '直線';
  const maxGrade = `最大 ${(peakGrade * 100).toFixed(1)} %`;

  const limitLine = (mid: number, value: number, scale: number): string =>
    [-1, 1]
      .map(
        (side) =>
          `<line class="limit" x1="0" y1="${(mid - side * value * scale).toFixed(1)}" x2="${GRAPH_W}" y2="${(mid - side * value * scale).toFixed(1)}"/>`,
      )
      .join('');

  return [
    `<svg class="graph" viewBox="0 0 ${GRAPH_W} ${GRAPH_H}" preserveAspectRatio="none" role="img">`,
    `<rect class="band" x="0" y="${BAND_A}" width="${GRAPH_W}" height="${BAND_H}"/>`,
    `<rect class="band" x="0" y="${BAND_B}" width="${GRAPH_W}" height="${BAND_H}"/>`,
    `<line class="zero" x1="0" y1="${MID_A}" x2="${GRAPH_W}" y2="${MID_A}"/>`,
    `<line class="zero" x1="0" y1="${MID_B}" x2="${GRAPH_W}" y2="${MID_B}"/>`,
    limitLine(MID_A, curveLimit, a.scale),
    limitLine(MID_B, cls.maxGrade, b.scale),
    `<polyline class="curv" points="${a.points}"/>`,
    `<polyline class="grad" points="${b.points}"/>`,
    `<text class="tick" x="1" y="${BAND_A - 4}">曲率 (右+)</text>`,
    `<text class="tick" x="${GRAPH_W - 1}" y="${BAND_A - 4}" text-anchor="end">${minRadius}</text>`,
    `<text class="tick" x="1" y="${BAND_B - 4}">勾配</text>`,
    `<text class="tick" x="${GRAPH_W - 1}" y="${BAND_B - 4}" text-anchor="end">${maxGrade}</text>`,
    `<line class="cursor" x1="0" y1="${BAND_A - 2}" x2="0" y2="${BAND_B + BAND_H + 2}"/>`,
    `</svg>`,
  ].join('');
}
