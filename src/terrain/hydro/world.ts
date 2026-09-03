/**
 * 地形と水系を作る一連の流れ。
 *
 * 移植元 `src/generator.ts` の `generateCandidate` から、地形・水系の部分だけを
 * 取り出したもの。集落・道路・農地・鉄道は移していない (TrackBuilder では
 * 利用者が敷くため)。ゲーム性の点で引き直す `autoQuality` も、その評価が
 * 集落と道路に依るので落としてある。
 *
 * 埋め立て (Priority-Flood) を 4 回・流量集積を 3 回まわす。順に:
 * 素の地形 → 盆地の開削 → 蛇行河道 → 侵食と氾濫原 → 最終的な排水路。
 */
import { makeGrid, type HydroGrid } from './grid';
import {
  accumulate,
  breachDepressions,
  buildSuitability,
  carveAndFlatten,
  classifyRiverLandforms,
  makeSea,
  makeTerrain,
  meanderChannels,
  priorityFlood,
  riverThresholdFor,
  slopeMap,
} from './hydrology';
import type { HydroParams, HydroWorld } from './types';

export function generateHydroWorld(
  cells: number,
  params: HydroParams,
  cell = 40,
  origin = -(cells * cell) / 2,
): HydroWorld {
  const g: HydroGrid = makeGrid(cells + 1, cell, origin);
  const len = g.len;

  const raw = makeTerrain(g, params);
  const { sea, level: seaLevel } = makeSea(g, raw, params.sea);

  let hydro = priorityFlood(g, raw, sea);
  const breached = breachDepressions(g, raw, sea, hydro, params.basin);

  hydro = priorityFlood(g, breached.height, sea);
  let accumulation = accumulate(g, hydro.parent, hydro.order, sea);
  let terrain = meanderChannels(g, breached.height, sea, hydro, accumulation, params);

  hydro = priorityFlood(g, terrain, sea);
  terrain = hydro.filled;
  accumulation = accumulate(g, hydro.parent, hydro.order, sea);
  const carved = carveAndFlatten(g, terrain, sea, accumulation, params);

  hydro = priorityFlood(g, carved, sea);
  terrain = hydro.filled;
  accumulation = accumulate(g, hydro.parent, hydro.order, sea);

  const riverThreshold = riverThresholdFor(g, accumulation, sea, params.river);
  const rivers = new Uint8Array(len);
  for (let i = 0; i < len; i++) if (!sea[i] && accumulation[i] >= riverThreshold) rivers[i] = 1;

  const slope = slopeMap(g, terrain);
  const geomorph = classifyRiverLandforms(g, terrain, sea, rivers, accumulation, riverThreshold, params);
  const geo = buildSuitability(g, terrain, sea, rivers, geomorph.landform, geomorph.riverDist, params);

  return {
    grid: g,
    params,
    terrain,
    sea,
    seaLevel,
    filled: hydro.filled,
    parent: hydro.parent,
    accumulation,
    rivers,
    riverThreshold,
    slope,
    breaches: breached.breaches,
    landform: geomorph.landform,
    suitability: geo.suitability,
    coastDistance: geo.coastDistance,
    riverDistance: geomorph.riverDist,
  };
}
