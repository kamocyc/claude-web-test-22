import type { ConsistSpec } from '../core/vehicle/spec.ts';
import type { SafetySystemKind } from '../core/route/types.ts';
import type { Scenario } from '../core/sim/types.ts';
import type { DrivingRoute } from './route.ts';

/**
 * 運転する場面を組み立てる。
 *
 * 移植元では路線データと一緒にシナリオ (どの列車が、いつ、どこから、どんな
 * 条件で走るか) を書いていた。こちらでは敷いた線路がそのまま路線なので、
 * 残るのは「その線路をどう走り出すか」だけになる。
 */
export interface DrivingScenarioOptions {
  readonly id?: string;
  readonly name?: string;
  /** 起点 (先頭端の距離程) [m]。 */
  readonly startPosition?: number;
  /** 起点での速度 [m/s]。 */
  readonly startSpeed?: number;
  /** 乗車率 0..1。 */
  readonly loadFactor?: number;
  /** レール踏面の状態。 */
  readonly railCondition?: Scenario['railCondition'];
  /** 架線の回生負荷受け入れ率 0..1。 */
  readonly regenerationReceptivity?: number;
  /** 使う保安装置。 */
  readonly safetySystems?: readonly SafetySystemKind[];
  /** EB 装置を積むか。運転の練習では切っておくほうが邪魔にならない。 */
  readonly hasVigilance?: boolean;
  /** 決定論のための種。 */
  readonly seed?: number;
}

export function buildDrivingScenario(
  route: DrivingRoute,
  consist: ConsistSpec,
  options: DrivingScenarioOptions = {},
): Scenario {
  // 起点は編成が丸ごと路線に載る位置にする。先頭端を 0 に置くと、後ろの車が
  // 距離程の外へはみ出す。
  const consistLength = consist.vehicles.reduce((a, v) => a + v.length, 0);
  const startPosition = options.startPosition ?? Math.min(consistLength, route.length);
  return {
    id: options.id ?? `${route.compiled.id}-run`,
    name: options.name ?? route.compiled.name,
    route: route.compiled,
    consist,
    scheduledTrains: [],
    startTime: 0,
    startPosition,
    startSpeed: options.startSpeed ?? 0,
    loadFactor: options.loadFactor ?? 0.5,
    railCondition: options.railCondition ?? 'dry',
    regenerationReceptivity: options.regenerationReceptivity ?? 1,
    seed: options.seed ?? 1,
    safetySystems: options.safetySystems ?? [],
    hasVigilance: options.hasVigilance ?? false,
  };
}
