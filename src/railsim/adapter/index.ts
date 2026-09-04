/**
 * こちらの世界と移植した運転シミュレータを繋ぐ 1 枚。
 *
 * `src/railsim/core` へはこの層だけを通して触る。境界を守っておけば、
 * 向こうの更新をもう一度取り込み直せる (`src/railsim/README.md`)。
 */

export { headingOf, rampFromSamples, sampleTrack, type TrackSample } from './geometry.ts';
export {
  buildDrivingRoute,
  type DrivingRoute,
  type DrivingRouteOptions,
} from './route.ts';
export {
  buildDrivingScenario,
  type DrivingScenarioOptions,
} from './scenario.ts';
