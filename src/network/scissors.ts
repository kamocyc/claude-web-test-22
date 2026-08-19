import { Vector2, Vector3 } from 'three';
import { Alignment } from '../core/alignment';
import { curveFromTangents } from '../core/curve';
import { VerticalProfile } from '../core/profile';
import {
  anchorFromSegment,
  placeSegment,
  resolveAnchor,
  type Anchor,
  type PlacementPreview,
} from './editing';
import type { Network, NodeId, SegmentId } from './network';
import { parallelSpacing, stationOf } from './parallel';

/** シーサスクロッシングを構成する片側の渡り線。 */
export interface ScissorsConnection {
  start: Anchor;
  end: Anchor;
  alignment: Alignment;
  preview: PlacementPreview;
}

/** クリックで一括敷設するシーサスクロッシング。 */
export interface ScissorsPlan {
  selected: SegmentId;
  parallel: SegmentId;
  classId: string;
  connections: [ScissorsConnection, ScissorsConnection];
  length: number;
}

export interface ScissorsPlanResult {
  plan: ScissorsPlan | null;
  hoverSegment: SegmentId | null;
  blockers: string[];
}

interface ParallelMate {
  segment: SegmentId;
  s: number;
  /** selected の弧長が増える向きと mate の弧長が増える向きの関係。 */
  sign: 1 | -1;
}

const PARALLEL_COS = Math.cos(7 * (Math.PI / 180));
const END_MARGIN = 4;
const MIN_HALF_SPAN = 18;
const SPAN_STEP = 3;

/**
 * カーソル直下の線路と、その隣の平行線路から施工案を作る。
 * 十分な直線長がない、平行線がない、といった理由もプレビュー段階で返す。
 */
export function scissorsPlanAt(network: Network, cursor: Vector3, radius = 10): ScissorsPlanResult {
  const hit = network.findSegmentNear(cursor, radius);
  if (!hit) return { plan: null, hoverSegment: null, blockers: ['線路上をクリックしてください。'] };
  const selected = network.getSegment(hit.segment);
  if (network.classOf(selected).kind !== 'rail') {
    return {
      plan: null,
      hoverSegment: selected.id,
      blockers: ['シーサスクロッシングは平行な線路にだけ設置できます。'],
    };
  }
  const result = planScissorsCrossover(network, selected.id, hit.s);
  return { ...result, hoverSegment: selected.id };
}

/** 指定した線路の `s` を中心にシーサスクロッシングを計画する。 */
export function planScissorsCrossover(
  network: Network,
  selectedId: SegmentId,
  s: number,
): Omit<ScissorsPlanResult, 'hoverSegment'> {
  const selectedSegment = network.segments.get(selectedId);
  if (!selectedSegment || network.classOf(selectedSegment).kind !== 'rail') {
    return { plan: null, blockers: ['線路を選択してください。'] };
  }

  const selected = network.alignmentOf(selectedId);
  const centerS = Math.max(0, Math.min(selected.length, s));
  const mate = findMate(network, selectedId, centerS);
  if (!mate) {
    return { plan: null, blockers: ['すぐ隣に並ぶ平行線路が見つかりません。'] };
  }

  const cls = network.classOf(selectedSegment);
  const maximumHalf = Math.min(centerS, selected.length - centerS) - END_MARGIN;
  if (maximumHalf < MIN_HALF_SPAN) {
    return {
      plan: null,
      blockers: ['端点や分岐器から離れた、十分に長い平行区間を選んでください。'],
    };
  }

  // 短い側から試し、選択中の線路規格を満たす最もコンパクトな形を採る。
  // 車両基地の側線なら短く、本線なら緩い渡り線になる。
  for (let half = MIN_HALF_SPAN; half <= maximumHalf + 1e-6; half += SPAN_STEP) {
    const a0s = centerS - half;
    const a1s = centerS + half;
    const a0 = selected.sampleAt(a0s);
    const a1 = selected.sampleAt(a1s);
    const other = network.alignmentOf(mate.segment);
    const b0s = stationOf(other, a0.pos.x, a0.pos.z);
    const b1s = stationOf(other, a1.pos.x, a1.pos.z);
    if (
      Math.min(b0s, b1s) < END_MARGIN ||
      Math.max(b0s, b1s) > other.length - END_MARGIN ||
      Math.sign(b1s - b0s || mate.sign) !== mate.sign
    ) {
      continue;
    }

    const b0 = other.sampleAt(b0s);
    const b1 = other.sampleAt(b1s);
    const physicalB0 = b0.forwardXZ.clone().multiplyScalar(mate.sign);
    const physicalB1 = b1.forwardXZ.clone().multiplyScalar(mate.sign);
    const first = connection(
      anchorFromSegment(network, selectedId, a0s),
      anchorFromSegment(network, mate.segment, b1s),
      a0.pos,
      a0.forwardXZ,
      a0.grade,
      b1.pos,
      physicalB1,
      b1.grade * mate.sign,
    );
    const second = connection(
      anchorFromSegment(network, mate.segment, b0s),
      anchorFromSegment(network, selectedId, a1s),
      b0.pos,
      physicalB0,
      b0.grade * mate.sign,
      a1.pos,
      a1.forwardXZ,
      a1.grade,
    );
    const connections: [ScissorsConnection, ScissorsConnection] = [first, second];
    if (
      connections.some(
        (item) =>
          item.preview.radius < cls.minRadius - 1e-6 ||
          item.alignment.vertical.maxGrade(32) > cls.maxGrade + 1e-6,
      )
    ) {
      continue;
    }

    return {
      blockers: [],
      plan: {
        selected: selectedId,
        parallel: mate.segment,
        classId: selectedSegment.classId,
        connections,
        length: first.alignment.length + second.alignment.length,
      },
    };
  }

  return {
    plan: null,
    blockers: [
      `${cls.label}の曲線半径を確保できません。端点から離れた、より長い平行区間を選んでください。`,
    ],
  };
}

function findMate(network: Network, selectedId: SegmentId, s: number): ParallelMate | null {
  const selectedSegment = network.getSegment(selectedId);
  const cls = network.classOf(selectedSegment);
  const selected = network.alignmentOf(selectedId);
  const center = selected.sampleAt(s);
  let best: ParallelMate | null = null;
  let bestScore = Infinity;

  for (const candidate of network.segments.values()) {
    if (candidate.id === selectedId || network.classOf(candidate).kind !== 'rail') continue;
    const alignment = network.alignmentOf(candidate.id);
    const t = stationOf(alignment, center.pos.x, center.pos.z);
    const sample = alignment.sampleAt(t);
    const dx = sample.pos.x - center.pos.x;
    const dz = sample.pos.z - center.pos.z;
    const distance = Math.hypot(dx, dz);
    const expected = parallelSpacing(cls, network.classOf(candidate));
    if (distance < expected * 0.55 || distance > expected * 1.7) continue;
    if (Math.abs(sample.pos.y - center.pos.y) > 1.2) continue;
    const dot = sample.forwardXZ.dot(center.forwardXZ);
    if (Math.abs(dot) < PARALLEL_COS) continue;
    const score = Math.abs(distance - expected) + Math.abs(sample.pos.y - center.pos.y) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = { segment: candidate.id, s: t, sign: dot >= 0 ? 1 : -1 };
    }
  }
  return best;
}

function connection(
  start: Anchor,
  end: Anchor,
  a: Vector3,
  ta: Vector2,
  gradeA: number,
  b: Vector3,
  tb: Vector2,
  gradeB: number,
): ScissorsConnection {
  const horizontal = curveFromTangents(
    new Vector2(a.x, a.z),
    ta,
    new Vector2(b.x, b.z),
    tb,
  );
  const alignment = new Alignment(
    horizontal,
    new VerticalProfile(a.y, b.y, gradeA, gradeB, horizontal.length),
  );
  const preview: PlacementPreview = {
    horizontal,
    end: b.clone(),
    startGrade: gradeA,
    endGrade: gradeB,
    radius: horizontal.extremeCurvature(64).minRadius,
    grade: alignment.vertical.maxGrade(32),
    endTangent: horizontal.tangentAt(horizontal.length),
  };
  return { start, end, alignment, preview };
}

/** プレビュー済みのシーサスクロッシングをネットワークへ一括追加する。 */
export function placeScissorsCrossover(network: Network, plan: ScissorsPlan): SegmentId[] {
  // 4 箇所を先に分割する。同じ元セグメントを2回分割すると後の split ID は
  // 古くなるが、resolveAnchor は座標から該当する片側を探し直せる。
  const anchors = plan.connections.flatMap((item) => [item.start, item.end]);
  const nodes: NodeId[] = anchors.map((anchor) => resolveAnchor(network, anchor).id);
  const placed: SegmentId[] = [];
  plan.connections.forEach((item, index) => {
    const result = placeSegment(
      network,
      plan.classId,
      { pos: network.getNode(nodes[index * 2]).pos.clone(), node: nodes[index * 2] },
      { pos: network.getNode(nodes[index * 2 + 1]).pos.clone(), node: nodes[index * 2 + 1] },
      item.preview,
    );
    placed.push(result.segment);
  });
  return placed;
}
