import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { Alignment } from '../src/core/alignment';
import { HorizontalCurve, xz } from '../src/core/curve';
import { VerticalProfile } from '../src/core/profile';
import { LEVEL_CROSSING_TOLERANCE, RAIL_GAUGE } from '../src/core/units';
import { cantRoll } from '../src/build/cant';
import { computeCrossingBlend } from '../src/build/crossing';
import { getClass } from '../src/network/classes';
import { findCrossings } from '../src/network/crossings';
import { buildScene, draw, drawBranch, flat, type Scene } from './support/adversarial';
import * as C from './support/checks';
import { summarize } from './support/adversarial';

/**
 * カント (曲線で外側のレールを高くする)。
 *
 * 曲率から直に導くので、緩和曲線ではそのまま比例して立ち上がる。ただし
 * **交差点の面と踏切には持ち込まない**。分岐器では直進側と分岐側でカントが
 * 違うと道床がねじれ、踏切では舗装をレール頭頂面に合わせるので道路側が
 * 捻れるため。ここではその 2 つが守られていることを確かめる。
 */

const RAIL = getClass('rail_single');

/** 曲線の途中に分岐器がある線路。 */
function turnoutOnCurve(): Scene {
  return buildScene('曲線上の分岐器', flat(20), (net, field) => {
    const blockers = draw(net, field, 'rail_single', [
      { x: -320, z: -200, y: 20 },
      { x: -320, z: 40, y: 20 },
      { x: -200, z: 220, y: 20 },
      { x: 40, z: 300, y: 20 },
    ]);
    blockers.push(
      ...drawBranch(net, field, 'rail_yard', new Vector3(-236, 20, 185), [
        { x: -140, z: 140, y: 20 },
        { x: 0, z: 60, y: 20 },
      ]),
    );
    return blockers;
  });
}

describe('カントの付き方', () => {
  it('曲率に応じて付き、規格最小半径で最大になる', () => {
    // 横断勾配 = カント / 軌間。
    expect(cantRoll(RAIL, 1 / RAIL.minRadius)).toBeCloseTo(-RAIL.maxCant / RAIL_GAUGE, 6);
    // 緩い曲線では半径に反比例して小さくなる。
    expect(cantRoll(RAIL, 1 / (RAIL.minRadius * 2))).toBeCloseTo(-RAIL.maxCant / RAIL_GAUGE / 2, 6);
    // 直線では 0。
    expect(cantRoll(RAIL, 0)).toBeCloseTo(0, 12);
    // 左カーブでは逆向き。
    expect(cantRoll(RAIL, -1 / RAIL.minRadius)).toBeCloseTo(RAIL.maxCant / RAIL_GAUGE, 6);
    // 規格より急な曲線でも頭打ち。
    expect(cantRoll(RAIL, 1 / (RAIL.minRadius / 2))).toBeCloseTo(-RAIL.maxCant / RAIL_GAUGE, 6);
  });

  it('道路には付かない', () => {
    expect(cantRoll(getClass('road_medium'), 1 / 30)).toBe(0);
  });

  it('緩和曲線の区間で、弧長に比例して立ち上がる', () => {
    const scene = turnoutOnCurve();
    // いちばんカントの大きい線路の区間を選ぶ。
    let best: { segment: number; roll: number } | null = null;
    for (const seg of scene.network.segments.values()) {
      if (scene.network.classOf(seg).kind !== 'rail') continue;
      const L = scene.network.alignmentOf(seg.id).length;
      for (let i = 0; i <= 20; i++) {
        const roll = Math.abs(scene.world.cantAt(seg.id, (i / 20) * L));
        if (!best || roll > best.roll) best = { segment: seg.id, roll };
      }
    }
    expect(best!.roll).toBeGreaterThan(0.01);

    // その区間で、カントは曲率に沿って単調に動く (跳ばない)。
    const L = scene.network.alignmentOf(best!.segment).length;
    let prev = scene.world.cantAt(best!.segment, 0);
    for (let i = 1; i <= 60; i++) {
      const roll = scene.world.cantAt(best!.segment, (i / 60) * L);
      // 1 m あたりの変化が緩い (カント逓減の勾配が 1/100 より緩やか)。
      expect(Math.abs(roll - prev) / (L / 60)).toBeLessThan(0.01);
      prev = roll;
    }
  });
});

describe('分岐器とカント', () => {
  it('交差点の面に取り付く断面が水平になる (道床がねじれない)', () => {
    const scene = turnoutOnCurve();
    let checked = 0;
    for (const junction of scene.world.junctions.values()) {
      if (junction.rings.length === 0) continue;
      for (const ap of junction.approaches) {
        const range = scene.result.ranges.get(ap.branch.segment)!;
        const s = ap.branch.atStart ? range.s0 : range.s1;
        expect(Math.abs(scene.world.cantAt(ap.branch.segment, s))).toBeLessThan(1e-9);
        // 断面の左右の端が同じ高さ (= 水平)。
        expect(Math.abs(ap.edgePrev.y - ap.edgeNext.y)).toBeLessThan(1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2);
  });

  it('カントの付いた曲線でも、交差点の面と帯の継ぎ目が開かない', () => {
    const scene = turnoutOnCurve();
    expect(scene.blocked).toEqual([]);
    expect(scene.result.stats.turnouts).toBeGreaterThan(0);
    expect(summarize('継ぎ目', C.seamViolations(scene))).toBe('継ぎ目: 違反なし');
  });
});

describe('踏切とカント', () => {
  /** 曲線の線路を道路が横切る配置。 */
  function crossingOnCurve(): Scene {
    return buildScene('曲線上の踏切', flat(20), (net, field) => {
      const blockers = draw(net, field, 'rail_single', [
        { x: -300, z: -180, y: 20 },
        { x: -300, z: 60, y: 20 },
        { x: -180, z: 240, y: 20 },
        { x: 60, z: 320, y: 20 },
      ]);
      blockers.push(
        ...draw(net, field, 'road_medium', [
          { x: -400, z: 200, y: 20 },
          { x: 60, z: 200, y: 20 },
        ], { straight: true }),
      );
      return blockers;
    });
  }

  it('踏切の所ではカントが抜けている', () => {
    const scene = crossingOnCurve();
    const crossings = findCrossings(scene.network).filter((c) => c.kind === 'level');
    expect(crossings.length).toBeGreaterThan(0);
    for (const crossing of crossings) {
      const roll = scene.world.cantAt(crossing.rail!.segment, crossing.rail!.s);
      expect(Math.abs(roll)).toBeLessThan(1e-9);
    }
  });

  it('カントが残っていても、舗装がレール頭頂面に合う', () => {
    // 踏切の手前でカントは 0 に戻しているが、目標面の式そのものが
    // カントを見ていることを確かめる (テーパを緩めても壊れないように)。
    const rail = new Alignment(
      HorizontalCurve.straight(xz(0, -100), xz(0, 100)),
      VerticalProfile.linear(20, 20, 200),
    );
    const road = new Alignment(
      HorizontalCurve.straight(xz(-100, 0), xz(100, 0)),
      VerticalProfile.linear(19, 19, 200),
    );
    const railCls = getClass('rail_single');
    const roadCls = getClass('road_medium');
    const crossing = {
      kind: 'level' as const,
      rail: { segment: 1, s: 100, cls: railCls, dir: new Vector2(0, 1), pos: new Vector3(0, 20, 0) },
      road: { segment: 2, s: 100, cls: roadCls, dir: new Vector2(1, 0), pos: new Vector3(0, 19, 0) },
    };

    for (const roll of [0, 0.05, -0.05]) {
      const blend = computeCrossingBlend(
        crossing as never,
        rail,
        road,
        roll,
      );
      // 線路は +Z 方向なので、線路の右手は -X。カント (右手へ 1 m あたりの
      // 上がり) が roll なら、レール頭頂面の高さは世界の x について
      // 20 - roll·x になる。
      const railTopAt = (x: number): number => 20 - roll * x;
      // 舗装の目標面はその面と平行 (道路は +X 方向)。
      expect(blend.targetSlope).toBeCloseTo(-roll, 9);
      // 両側のレールの所で、舗装とレール頭の差が同じになる (片方が潜って
      // もう片方が浮く、ということが起きない)。
      const gaps = [-1, 1].map((side) => {
        const x = (side * RAIL_GAUGE) / 2;
        return blend.targetY + blend.targetSlope * x - railTopAt(x);
      });
      expect(Math.abs(gaps[0] - gaps[1])).toBeLessThan(1e-9);
      expect(Math.abs(gaps[0])).toBeLessThan(LEVEL_CROSSING_TOLERANCE);
    }
  });
});
