import { describe, expect, it } from 'vitest';
import { summarize, type Scene, type Violation } from './support/adversarial';
import * as C from './support/checks';
import { matrixCases, tunnelInsideCase } from './support/matrix';
import { checkTraffic } from './support/traffic';

/**
 * 敵対的検証 (総当たりの配置表)。
 *
 * 種別・交差角・交差点の間隔・枝の数・地形・トンネル・高架を掛け合わせた
 * 配置を一通り組み立て、**実際に描かれたメッシュ**と**実際に走らせた車**を
 * 測って、次の 2 つを確かめる。
 *
 *  - 交差点が正しく描かれる (継ぎ目・段差・穴・縁石のはみ出し・埋没・
 *    橋やトンネルの構造物による食い込みが無い)
 *  - 車が正しく動く (進む・停止線で止まる・舗装の上を曲がる・向きが合う)
 *
 * 配置は敷設ツールと同じ規則 (`checkPlacement`) を通してから組み立てる。
 * 規則が弾いた配置は「作れない配置」として数えるだけなので、この検証は
 * 「作れる配置は必ず正しく描かれ、正しく走れる」という主張になる。
 */

/** 場面は作るのに時間がかかるので、1 度だけ作って全ての検査で使い回す。 */
const built = (() => {
  const scenes: Scene[] = [];
  const failures: string[] = [];
  for (const c of matrixCases()) {
    try {
      scenes.push(c.make());
    } catch (e) {
      failures.push(`${c.name}: ${(e as Error).message}`);
    }
  }
  return { scenes, failures };
})();

function all(check: (scene: Scene) => Violation[]): Violation[] {
  const out: Violation[] = [];
  for (const scene of built.scenes) out.push(...check(scene));
  return out;
}

function expectClean(name: string, violations: Violation[]): void {
  expect(summarize(name, violations)).toBe(`${name}: 違反なし`);
}

/** 交差点の面を持つノードの数 (検査が空振りしていないかの確認)。 */
function junctionCount(): number {
  let n = 0;
  for (const scene of built.scenes) {
    for (const junction of scene.world.junctions.values()) {
      if (junction.rings.length > 0) n++;
    }
  }
  return n;
}

describe('敵対的検証: 配置表', () => {
  it('配置表が組み立てられ、狙った要素が揃っている', () => {
    expect(built.failures).toEqual([]);
    expect(built.scenes.length).toBeGreaterThan(100);
    // 交差点・踏切・橋・トンネルが一通り出ていること。
    expect(junctionCount()).toBeGreaterThan(100);
    let bridges = 0;
    let tunnels = 0;
    let crossings = 0;
    let turnouts = 0;
    for (const scene of built.scenes) {
      bridges += scene.result.stats.bridgeLength > 0 ? 1 : 0;
      tunnels += scene.result.stats.tunnelLength > 0 ? 1 : 0;
      crossings += scene.result.stats.levelCrossings;
      turnouts += scene.result.stats.turnouts;
    }
    expect(bridges).toBeGreaterThan(5);
    expect(tunnels).toBeGreaterThan(3);
    expect(crossings).toBeGreaterThan(8);
    expect(turnouts).toBeGreaterThan(2);
    // 規則が弾いた配置ばかりになっていないこと。
    const blocked = built.scenes.filter((s) => s.blocked.length > 0).length;
    expect(blocked).toBeLessThan(built.scenes.length / 4);
  });

  it('交差点の面と枝の帯が継ぎ目なく噛み合う', () => {
    expectClean('継ぎ目', all((s) => C.seamViolations(s)));
  });

  it('枝の口に縁石・垂れ壁が残らない (道路を横切る段差ができない)', () => {
    expectClean('縁石のはみ出し', all((s) => C.curbAcrossMouthViolations(s)));
  });

  it('交差点の車道面が枝の車道面と段差なく繋がる', () => {
    expectClean('段差', all((s) => C.mouthStepViolations(s)));
  });

  it('交差点の面が地形に埋まらない', () => {
    expectClean('埋没', all((s) => C.junctionBuriedViolations(s)));
  });

  it('交差点の外周・路端に穴が開かない', () => {
    expectClean('穴', all((s) => C.skirtGapViolations(s)));
  });

  it('橋・トンネルの構造物が交差点に食い込まない', () => {
    expectClean('構造物の食い込み', all((s) => C.structureIntrusionViolations(s)));
  });

  it('信号機・遮断機などの小物が交差点の面の中に立たない', () => {
    expectClean('小物', all((s) => C.propInJunctionViolations(s)));
    // 小物が 1 つも無い配置ばかりでないこと。
    const props = built.scenes.reduce((n, s) => n + s.result.props.length, 0);
    expect(props).toBeGreaterThan(200);
  });

  it('交差点のリングがねじれず、面どうしも重ならない', () => {
    expectClean('リングの形', all((s) => C.ringShapeViolations(s)));
    expectClean('面の重なり', all((s) => C.junctionOverlapViolations(s)));
  });

  it('トンネルの中でも交差点は作れる (地中の空洞になる)', () => {
    // 坑口にかかる交差点だけは止まる (`test/tunnel.test.ts`)。
    const scene = tunnelInsideCase().make();
    expect(scene.blocked).toEqual([]);
    expect(scene.result.stats.intersections).toBe(1);
  });
});

describe('敵対的検証: 走行', () => {
  const reports = built.scenes.map((scene) => ({ scene, report: checkTraffic(scene, 40) }));

  it('車の姿勢・進路・停止位置がどの配置でも正しい', () => {
    const violations: Violation[] = [];
    for (const { report } of reports) violations.push(...report.violations);
    expectClean('走行', violations);
  });

  it('検査が空振りしていない (十分な台数・回数を見ている)', () => {
    let samples = 0;
    let pavement = 0;
    let stops = 0;
    let vehicles = 0;
    for (const { report } of reports) {
      samples += report.samples;
      pavement += report.onPavement;
      stops += report.stops.length;
      vehicles += report.vehicles;
    }
    expect(vehicles).toBeGreaterThan(300);
    expect(samples).toBeGreaterThan(100000);
    expect(pavement).toBeGreaterThan(100000);
    // 停止線の手前で止まる場面も見ていること。
    expect(stops).toBeGreaterThan(500);
  });

  it('車が進み続ける (詰まって動かなくなる配置がない)', () => {
    const stuck: string[] = [];
    const idle: string[] = [];
    for (const { scene, report } of reports) {
      if (report.vehicles === 0) continue;
      // 信号 1 周期 (26 s) と待ち行列の掃け残りを見込んでも、
      // 1 分以上ずっと止まったままなら詰まっている。
      if (report.longestStop > 60) {
        stuck.push(`${scene.name}: ${report.longestStop.toFixed(0)} s 止まったまま`);
      }
      if (report.meanSpeed < 1.5) {
        idle.push(`${scene.name}: 平均 ${report.meanSpeed.toFixed(1)} m/s`);
      }
    }
    expect([...stuck, ...idle]).toEqual([]);
    // 車が湧く場面が十分にあること。
    expect(reports.filter((r) => r.report.vehicles > 0).length).toBeGreaterThan(80);
  });
});
