import { Vector3 } from 'three';
import {
  buildScene,
  cliffX,
  draw,
  drawBranch,
  flat,
  hillX,
  rampX,
  rough,
  type Blockers,
  type Scene,
  type Waypoint,
} from './adversarial';

/**
 * 敵対的検証の配置表。
 *
 * 種別・交差角・交差点の間隔・枝の数・地形・トンネル・高架を掛け合わせて
 * 「意地の悪いが、敷設ツールで実際に作れる」配置を一通り作る。
 * 作れない配置 (規則が弾くもの) も `Scene.blocked` に理由が残るので、
 * 「壊れるなら直すか、置けなくする」がそのまま測れる。
 */

export interface Case {
  name: string;
  make(): Scene;
}

const ROADS = ['road_small', 'road_medium', 'road_large', 'road_highway', 'road_ramp'];

/** 角度 `deg` で交わる 2 本の道路。 */
function crossCase(main: string, cross: string, deg: number, y = 20): Case {
  const name = `交差 ${main}×${cross} ${deg}°`;
  return {
    name,
    make: () =>
      buildScene(name, flat(y), (net, field) => {
        const rad = (deg * Math.PI) / 180;
        const blockers: Blockers = [];
        blockers.push(
          ...draw(net, field, main, [
            { x: -220, z: 0, y },
            { x: 220, z: 0, y },
          ], { straight: true }),
        );
        blockers.push(
          ...draw(net, field, cross, [
            { x: -Math.cos(rad) * 220, z: -Math.sin(rad) * 220, y },
            { x: Math.cos(rad) * 220, z: Math.sin(rad) * 220, y },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}

/** 幹線に、間隔 `gap` [m] で 2 本の道路が交わる。 */
function spacingCase(gap: number, cross = 'road_small'): Case {
  const name = `交差点の間隔 ${gap}m (${cross})`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const blockers: Blockers = [];
        blockers.push(
          ...draw(net, field, 'road_medium', [
            { x: -240, z: 0, y: 20 },
            { x: 240, z: 0, y: 20 },
          ], { straight: true }),
        );
        for (const x of [-gap / 2, gap / 2]) {
          blockers.push(
            ...draw(net, field, cross, [
              { x, z: -180, y: 20 },
              { x, z: 180, y: 20 },
            ], { straight: true }),
          );
        }
        return blockers;
      }),
  };
}

/** 1 つのノードから `arms` 本が放射状に出る交差点。 */
function starCase(arms: number, cls = 'road_small', jitter = 0): Case {
  const name = `${arms} 叉路 (${cls}${jitter ? ' 不等角' : ''})`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const blockers: Blockers = [];
        // 1 本目を通し、その中央を分割してから残りの枝を足す。
        blockers.push(
          ...draw(net, field, cls, [
            { x: -200, z: 0, y: 20 },
            { x: 200, z: 0, y: 20 },
          ], { straight: true }),
        );
        const hit = net.findSegmentNear(new Vector3(0, 20, 0), 10);
        if (!hit) return blockers;
        const node = net.splitSegment(hit.segment, hit.s);
        for (let i = 1; i < arms - 1; i++) {
          const deg = (180 * i) / (arms - 1) + (jitter ? (i % 2 ? jitter : -jitter) : 0);
          const rad = (deg * Math.PI) / 180;
          blockers.push(
            ...draw(net, field, cls, [
              { x: node.pos.x, z: node.pos.z, y: node.pos.y },
              { x: node.pos.x + Math.cos(rad) * 200, z: node.pos.z + Math.sin(rad) * 200, y: 20 },
            ], { straight: true }),
          );
        }
        return blockers;
      }),
  };
}

/** 地形の上の十字路 (勾配つきの枝を含む)。 */
function terrainCase(label: string, terrain: (x: number, z: number) => number): Case {
  const name = `地形 ${label}`;
  return {
    name,
    make: () =>
      buildScene(name, terrain, (net, field) => {
        const smooth = (x: number, z: number): number => {
          let sum = 0;
          let n = 0;
          for (let dx = -60; dx <= 60; dx += 15) {
            for (let dz = -60; dz <= 60; dz += 15) {
              sum += field.baseHeightAt(x + dx, z + dz);
              n++;
            }
          }
          return sum / n;
        };
        const trunk: Waypoint[] = [];
        for (let x = -240; x <= 240; x += 80) trunk.push({ x, z: 0, y: smooth(x, 0) });
        const blockers = draw(net, field, 'road_small', trunk, { straight: true });
        // 既存のノード (経由点) から離れた所に取り付く。
        const branch: Waypoint[] = [];
        for (let z = 60; z <= 240; z += 60) branch.push({ x: 30, z, y: smooth(30, z) });
        blockers.push(...drawBranch(net, field, 'road_small', new Vector3(30, 0, 0), branch, {
          straight: true,
        }));
        return blockers;
      }),
  };
}

/**
 * 高架をくぐる道路と、その取り付きから `gap` [m] の所にある交差点。
 * 高架は谷 (崖) を渡るので、実際に橋の区間になる。
 */
function viaductCase(gap: number, upper = 'road_medium'): Case {
  const name = `高架の脇の交差点 ${gap}m (${upper})`;
  return {
    name,
    make: () =>
      buildScene(name, cliffX(40, 26, 60), (net, field) => {
        // 崖を渡る高架 (x 方向)。
        const blockers = draw(net, field, upper, [
          { x: -220, z: 0, y: 40 },
          { x: 220, z: 0, y: 40 },
        ], { straight: true });
        // 下をくぐる道路 (z 方向、谷の底)。
        blockers.push(
          ...draw(net, field, 'road_small', [
            { x: 120, z: -200, y: 14 },
            { x: 120, z: 200, y: 14 },
          ], { straight: true }),
        );
        // くぐる道路に、高架のすぐ脇で交わる枝。
        blockers.push(
          ...draw(net, field, 'road_small', [
            { x: 120 - 200, z: gap, y: 14 },
            { x: 120 + 60, z: gap, y: 14 },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}

/** 山を貫くトンネルと、坑口から `gap` [m] の所にある交差点。 */
function tunnelCase(gap: number): Case {
  const name = `トンネル坑口の先の交差点 ${gap}m`;
  return {
    name,
    make: () =>
      buildScene(name, hillX(20, 40, 90), (net, field) => {
        const blockers = draw(net, field, 'road_medium', [
          { x: -260, z: 0, y: 20 },
          { x: 260, z: 0, y: 20 },
        ], { straight: true });
        // 坑口はおおよそ x = ±90。その外側 gap の所で交わる道路。
        blockers.push(
          ...drawBranch(net, field, 'road_small', new Vector3(90 + gap, 0, 0), [
            { x: 90 + gap, z: 120, y: 20 },
            { x: 90 + gap, z: 240, y: 20 },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}

/** 踏切 (交差角つき)。 */
function levelCrossingCase(deg: number, roadCls = 'road_medium', railCls = 'rail_single'): Case {
  const name = `踏切 ${deg}° (${roadCls}×${railCls})`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const rad = (deg * Math.PI) / 180;
        const blockers = draw(net, field, railCls, [
          { x: -260, z: 0, y: 20 },
          { x: 260, z: 0, y: 20 },
        ], { straight: true });
        blockers.push(
          ...draw(net, field, roadCls, [
            { x: -Math.cos(rad) * 240, z: -Math.sin(rad) * 240, y: 20 },
            { x: Math.cos(rad) * 240, z: Math.sin(rad) * 240, y: 20 },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}

/** 分岐器 (分岐角つき)。 */
function turnoutCase(deg: number, cls = 'rail_yard'): Case {
  const name = `分岐器 ${deg}° (${cls})`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const blockers = draw(net, field, 'rail_single', [
          { x: -300, z: 0, y: 20 },
          { x: 300, z: 0, y: 20 },
        ], { straight: true });
        const rad = (deg * Math.PI) / 180;
        blockers.push(
          ...drawBranch(net, field, cls, new Vector3(0, 20, 0), [
            { x: Math.cos(rad) * 150, z: Math.sin(rad) * 150, y: 20 },
            { x: Math.cos(rad) * 150 + 150, z: Math.sin(rad) * 150 + Math.sin(rad) * 40, y: 20 },
          ]),
        );
        return blockers;
      }),
  };
}

/** ランプが本線に合流する (一方通行の取り付き)。 */
function rampCase(deg: number): Case {
  const name = `ランプの合流 ${deg}°`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const blockers = draw(net, field, 'road_highway', [
          { x: -300, z: 0, y: 20 },
          { x: 300, z: 0, y: 20 },
        ], { straight: true });
        const rad = (deg * Math.PI) / 180;
        blockers.push(
          ...drawBranch(net, field, 'road_ramp', new Vector3(0, 20, 0), [
            { x: -Math.cos(rad) * 120, z: Math.sin(rad) * 120, y: 20 },
            { x: -Math.cos(rad) * 240, z: Math.sin(rad) * 240, y: 20 },
          ]),
        );
        return blockers;
      }),
  };
}

/** 勾配のついた枝が突き当たる T 字。 */
function gradeTeeCase(grade: number, cls = 'road_small'): Case {
  const name = `勾配 ${(grade * 100).toFixed(0)}% の T 字 (${cls})`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const blockers = draw(net, field, 'road_medium', [
          { x: -220, z: 0, y: 20 },
          { x: 220, z: 0, y: 20 },
        ], { straight: true });
        const branch: Waypoint[] = [];
        for (let z = 80; z <= 240; z += 80) branch.push({ x: 0, z, y: 20 + grade * z });
        blockers.push(...drawBranch(net, field, cls, new Vector3(0, 20, 0), branch, {
          straight: true,
        }));
        return blockers;
      }),
  };
}

/** 曲線どうしの交差点。 */
function curvedCase(seed: number): Case {
  const name = `曲線の交差点 #${seed}`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const bend = 40 + seed * 25;
        const blockers = draw(net, field, 'road_medium', [
          { x: -220, z: -bend, y: 20 },
          { x: 0, z: 0, y: 20 },
          { x: 220, z: bend, y: 20 },
        ]);
        blockers.push(
          ...drawBranch(net, field, 'road_small', new Vector3(90, 20, bend / 2), [
            { x: 120, z: 140, y: 20 },
            { x: 100, z: 250, y: 20 },
          ]),
        );
        return blockers;
      }),
  };
}


/** 谷を渡る高架の上に交差点がある配置。 */
function viaductJunctionCase(height: number): Case {
  const name = `高架の上の交差点 (桁下 ${height}m)`;
  return {
    name,
    make: () =>
      buildScene(name, (x: number) => (Math.abs(x) < 140 ? 30 - height : 30), (net, field) => {
        const y = 30;
        const blockers = draw(net, field, 'road_medium', [
          { x: -260, z: 0, y },
          { x: 260, z: 0, y },
        ], { straight: true });
        blockers.push(
          ...drawBranch(net, field, 'road_small', new Vector3(0, y, 0), [
            { x: 0, z: 120, y },
            { x: 0, z: 240, y },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}

/** 橋の取り付き (崖の縁) から `gap` [m] 手前に交差点がある配置。 */
function abutmentCase(gap: number): Case {
  const name = `橋の取り付き ${gap}m 手前の交差点`;
  return {
    name,
    make: () =>
      buildScene(name, cliffX(40, 34, 45), (net, field) => {
        const blockers = draw(net, field, 'road_medium', [
          { x: -220, z: 0, y: 40 },
          { x: 220, z: 0, y: 40 },
        ], { straight: true });
        blockers.push(
          ...drawBranch(net, field, 'road_small', new Vector3(-gap, 40, 0), [
            { x: -gap, z: 120, y: 40 },
            { x: -gap, z: 240, y: 40 },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}

/** 交差点の真上を高架が渡る立体交差。橋脚が交差点に降りてはいけない。 */
function overpassCase(offset: number): Case {
  const name = `交差点の真上を渡る高架 (${offset}m ずれ)`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const blockers = draw(net, field, 'road_medium', [
          { x: -240, z: 0, y: 20 },
          { x: 240, z: 0, y: 20 },
        ], { straight: true });
        blockers.push(
          ...drawBranch(net, field, 'road_small', new Vector3(0, 20, 0), [
            { x: 0, z: 120, y: 20 },
            { x: 0, z: 240, y: 20 },
          ], { straight: true }),
        );
        // 交差点のすぐ上を斜めに渡る高架。
        blockers.push(
          ...draw(net, field, 'road_medium', [
            { x: -240 + offset, z: -240, y: 32 },
            { x: 240 + offset, z: 240, y: 32 },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}

/** 格子状の街路。交差点が `pitch` [m] おきに並ぶ。 */
function gridCase(pitch: number, cls = 'road_small'): Case {
  const name = `格子状の街路 ${pitch}m (${cls})`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const blockers: Blockers = [];
        for (let i = -1; i <= 1; i++) {
          blockers.push(
            ...draw(net, field, cls, [
              { x: -200, z: i * pitch, y: 20 },
              { x: 200, z: i * pitch, y: 20 },
            ], { straight: true }),
          );
        }
        for (let i = -1; i <= 1; i++) {
          blockers.push(
            ...draw(net, field, cls, [
              { x: i * pitch, z: -200, y: 20 },
              { x: i * pitch, z: 200, y: 20 },
            ], { straight: true }),
          );
        }
        return blockers;
      }),
  };
}

/** 交差点のすぐ脇に踏切がある配置。 */
function crossingNearJunctionCase(gap: number): Case {
  const name = `交差点から ${gap}m の踏切`;
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const blockers = draw(net, field, 'road_medium', [
          { x: -240, z: 0, y: 20 },
          { x: 240, z: 0, y: 20 },
        ], { straight: true });
        blockers.push(
          ...drawBranch(net, field, 'road_small', new Vector3(-gap, 20, 0), [
            { x: -gap, z: 120, y: 20 },
            { x: -gap, z: 240, y: 20 },
          ], { straight: true }),
        );
        blockers.push(
          ...draw(net, field, 'rail_single', [
            { x: 0, z: -260, y: 20 },
            { x: 0, z: 260, y: 20 },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}

/** 複線 (平行) を渡る踏切と、その脇の分岐。 */
function doubleTrackCase(): Case {
  const name = '複線を渡る踏切と分岐';
  return {
    name,
    make: () =>
      buildScene(name, flat(20), (net, field) => {
        const blockers: Blockers = [];
        for (const z of [0, 4.6]) {
          blockers.push(
            ...draw(net, field, 'rail_single', [
              { x: -300, z, y: 20 },
              { x: 300, z, y: 20 },
            ], { straight: true }),
          );
        }
        blockers.push(
          ...draw(net, field, 'road_medium', [
            { x: 0, z: -240, y: 20 },
            { x: 0, z: 240, y: 20 },
          ], { straight: true }),
        );
        blockers.push(
          ...drawBranch(net, field, 'rail_yard', new Vector3(-150, 20, 0), [
            { x: -40, z: -60, y: 20 },
            { x: 80, z: -90, y: 20 },
          ]),
        );
        return blockers;
      }),
  };
}

/** 縦断が変化する所 (縦曲線) に交差点がある配置。 */
function sagCase(grade: number): Case {
  const name = `縦曲線の底の交差点 (±${(grade * 100).toFixed(0)}%)`;
  return {
    name,
    make: () =>
      buildScene(name, flat(40), (net, field) => {
        const blockers = draw(net, field, 'road_medium', [
          { x: -200, z: 0, y: 40 + grade * 200 },
          { x: 0, z: 0, y: 40 },
          { x: 200, z: 0, y: 40 + grade * 200 },
        ], { straight: true });
        blockers.push(
          ...drawBranch(net, field, 'road_small', new Vector3(0, 40, 0), [
            { x: 0, z: 120, y: 40 },
            { x: 0, z: 240, y: 40 },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}


/** 山の中 (トンネルの中) に交差点を作ろうとする配置。規則が止めるはず。 */
export function tunnelInsideCase(): Case {
  const name = 'トンネルの中の交差点';
  return {
    name,
    make: () =>
      buildScene(name, hillX(20, 40, 90), (net, field) => {
        const blockers = draw(net, field, 'road_medium', [
          { x: -260, z: 0, y: 20 },
          { x: 260, z: 0, y: 20 },
        ], { straight: true });
        blockers.push(
          ...drawBranch(net, field, 'road_small', new Vector3(0, 20, 0), [
            { x: 0, z: 120, y: 20 },
            { x: 0, z: 240, y: 20 },
          ], { straight: true }),
        );
        return blockers;
      }),
  };
}


/** 決定的な擬似乱数。 */
function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * でたらめな配置 (ファズ)。
 *
 * 種別・角度・位置・高さ・曲がり方を乱数で決めて何本か引く。地形も起伏を
 * つけるので、橋・トンネル・踏切・交差点が偶然に絡み合う。敷設規則を
 * 通すので、出来上がるのは「実際に作れる配置」だけ。
 */
export function fuzzCase(seed: number): Case {
  const name = `ファズ #${seed}`;
  const r = rng(seed);
  const terrain = (x: number, z: number): number =>
    30 + 7 * Math.sin(x / 70 + seed) + 6 * Math.cos(z / 55 - seed) + 3 * Math.sin((x + z) / 30);
  return {
    name,
    make: () =>
      buildScene(name, terrain, (net, field) => {
        const blockers: Blockers = [];
        const count = 3 + Math.floor(r() * 3);
        for (let i = 0; i < count; i++) {
          const isRail = r() < 0.3;
          const cls = isRail
            ? (['rail_single', 'rail_yard'] as const)[Math.floor(r() * 2)]
            : ROADS[Math.floor(r() * ROADS.length)];
          const angle = r() * Math.PI;
          const cx = (r() - 0.5) * 140;
          const cz = (r() - 0.5) * 140;
          const half = 140 + r() * 140;
          // 地形をならした高さを基準に、ときどき持ち上げ / 掘り下げる。
          const lift = r() < 0.3 ? (r() - 0.5) * 30 : 0;
          const base = field.baseHeightAt(cx, cz) + lift;
          const points: Waypoint[] = [];
          const steps = 2 + Math.floor(r() * 2);
          for (let k = 0; k <= steps; k++) {
            const t = -half + (2 * half * k) / steps;
            const bend = (r() - 0.5) * 50;
            points.push({
              x: cx + Math.cos(angle) * t - Math.sin(angle) * bend,
              z: cz + Math.sin(angle) * t + Math.cos(angle) * bend,
              y: base + (r() - 0.5) * 4,
            });
          }
          blockers.push(...draw(net, field, cls, points, { straight: r() < 0.5 }));
        }
        return blockers;
      }),
  };
}

export function matrixCases(): Case[] {
  const cases: Case[] = [];

  // 種別 × 交差角。
  for (const deg of [25, 35, 50, 70, 90, 110, 130, 155]) {
    cases.push(crossCase('road_medium', 'road_small', deg));
    cases.push(crossCase('road_large', 'road_medium', deg));
  }
  for (const deg of [30, 45, 60, 120, 150]) {
    cases.push(crossCase('road_small', 'road_small', deg));
    cases.push(crossCase('road_highway', 'road_ramp', deg));
    cases.push(crossCase('road_ramp', 'road_small', deg));
  }
  for (const main of ROADS) {
    for (const cross of ROADS) cases.push(crossCase(main, cross, 90));
  }
  cases.push(crossCase('road_medium', 'road_medium', 90));

  // 交差点の間隔。
  for (const gap of [12, 18, 26, 40, 60, 100]) {
    cases.push(spacingCase(gap));
    cases.push(spacingCase(gap, 'road_medium'));
  }

  // 枝の数。
  for (const arms of [3, 4, 5, 6, 7]) {
    cases.push(starCase(arms));
    cases.push(starCase(arms, 'road_medium'));
  }
  cases.push(starCase(5, 'road_small', 12));
  cases.push(starCase(6, 'road_medium', 10));

  // 地形。
  cases.push(terrainCase('平坦', flat(20)));
  cases.push(terrainCase('一定勾配 6%', rampX(20, 0.06)));
  cases.push(terrainCase('起伏', rough(1)));
  cases.push(terrainCase('激しい起伏', rough(1.6)));

  // 勾配のついた枝。
  for (const grade of [0.03, 0.06, 0.09, 0.12]) cases.push(gradeTeeCase(grade));

  // 高架・トンネル。
  for (const gap of [10, 20, 35, 60]) cases.push(viaductCase(gap));
  for (const gap of [8, 16, 30, 60]) cases.push(tunnelCase(gap));

  // 線路。
  for (const deg of [25, 45, 65, 90, 115, 140]) cases.push(levelCrossingCase(deg));
  for (const deg of [35, 90, 145]) {
    cases.push(levelCrossingCase(deg, 'road_ramp'));
    cases.push(levelCrossingCase(deg, 'road_large'));
  }
  cases.push(levelCrossingCase(90, 'road_small'));
  cases.push(levelCrossingCase(90, 'road_large', 'rail_yard'));
  for (const deg of [4, 8, 12, 18]) cases.push(turnoutCase(deg));

  // ランプ。
  for (const deg of [15, 25, 40]) cases.push(rampCase(deg));

  // 曲線。
  for (let seed = 0; seed < 3; seed++) cases.push(curvedCase(seed));

  // 勾配のある地形の上のトンネル・高架。
  cases.push(terrainCase('斜面 + 交差点', rampX(20, 0.09)));

  // 高架・橋台・立体交差。
  for (const height of [10, 16, 24]) cases.push(viaductJunctionCase(height));
  for (const gap of [2, 6, 12, 25]) cases.push(abutmentCase(gap));
  for (const offset of [0, 6, 14]) cases.push(overpassCase(offset));

  // 交差点が詰まった街路。
  for (const pitch of [40, 60, 90]) cases.push(gridCase(pitch));
  cases.push(gridCase(90, 'road_medium'));

  // 踏切と交差点の取り合い。
  for (const gap of [12, 20, 35, 60]) cases.push(crossingNearJunctionCase(gap));
  cases.push(doubleTrackCase());

  // 縦曲線。
  for (const grade of [0.04, 0.08]) cases.push(sagCase(grade));

  // トンネルの中の交差点 (規則が止める配置)。
  cases.push(tunnelInsideCase());

  // でたらめな配置。
  for (let seed = 1; seed <= 20; seed++) cases.push(fuzzCase(seed));

  return cases;
}
