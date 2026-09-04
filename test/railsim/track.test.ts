import { describe, expect, it } from 'vitest';
import {
  Alignment,
  RampProfile,
  buildAlignment,
  buildRampProfile,
  GRAVITY,
  kmhToMps,
  mmToM,
  permilToSlope,
} from '../../src/railsim/core/index.ts';

describe('RampProfile', () => {
  it('一定値区間では値と積分が厳密に一致する', () => {
    const p = new RampProfile([{ length: 100, startValue: 2, endValue: 2 }]);
    expect(p.valueAt(0)).toBe(2);
    expect(p.valueAt(50)).toBe(2);
    expect(p.integralAt(50)).toBeCloseTo(100, 12);
    expect(p.totalIntegral).toBeCloseTo(200, 12);
  });

  it('線形変化区間の積分は台形則と一致する', () => {
    const p = new RampProfile([{ length: 10, startValue: 0, endValue: 10 }]);
    expect(p.valueAt(5)).toBeCloseTo(5, 12);
    // ∫0..5 s ds = 12.5
    expect(p.integralAt(5)).toBeCloseTo(12.5, 12);
    expect(p.totalIntegral).toBeCloseTo(50, 12);
  });

  it('定義域外は端点の値で外挿する', () => {
    const p = new RampProfile([{ length: 10, startValue: 3, endValue: 3 }]);
    expect(p.valueAt(-5)).toBe(3);
    expect(p.valueAt(20)).toBe(3);
    expect(p.integralAt(-2)).toBeCloseTo(-6, 12);
    expect(p.integralAt(12)).toBeCloseTo(36, 12);
  });

  it('区間平均は積分から正しく求まる', () => {
    const p = new RampProfile([
      { length: 100, startValue: 0, endValue: 0 },
      { length: 100, startValue: 10, endValue: 10 },
    ]);
    expect(p.averageOver(50, 150)).toBeCloseTo(5, 12);
  });
});

describe('buildRampProfile', () => {
  it('緩和区間は後続区間の先頭に配置される', () => {
    const p = buildRampProfile([
      { length: 100, value: 0 },
      { length: 100, value: 1, transitionLength: 20 },
    ]);
    expect(p.valueAt(100)).toBeCloseTo(0, 12);
    expect(p.valueAt(110)).toBeCloseTo(0.5, 12);
    expect(p.valueAt(120)).toBeCloseTo(1, 12);
    expect(p.valueAt(150)).toBeCloseTo(1, 12);
  });

  it('centered 指定で遷移が境界の前後に半分ずつ配置される', () => {
    const p = buildRampProfile(
      [
        { length: 100, value: 0 },
        { length: 100, value: 10, transitionLength: 20 },
      ],
      { centered: true },
    );
    expect(p.valueAt(90)).toBeCloseTo(0, 12);
    expect(p.valueAt(100)).toBeCloseTo(5, 12);
    expect(p.valueAt(110)).toBeCloseTo(10, 12);
  });

  it('遷移長が区間長を超える場合はエラーになる', () => {
    expect(() =>
      buildRampProfile([
        { length: 100, value: 0 },
        { length: 10, value: 1, transitionLength: 20 },
      ]),
    ).toThrow(/不足/);
  });
});

describe('Alignment - 平面線形', () => {
  it('直線は方位角一定で座標が線形に進む', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 1000 }],
      vertical: [{ length: 1000, gradePermil: 0 }],
    });
    expect(a.length).toBe(1000);
    expect(a.headingAt(500)).toBeCloseTo(0, 12);
    const p = a.positionAt(500);
    expect(p.x).toBeCloseTo(500, 6);
    expect(p.y).toBeCloseTo(0, 9);
    expect(p.z).toBeCloseTo(0, 9);
  });

  it('円曲線の座標が解析解（円弧）と一致する', () => {
    const R = 400;
    const arcLength = (Math.PI / 2) * R; // 90 度
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: arcLength, radius: R }],
      vertical: [{ length: arcLength, gradePermil: 0 }],
      sampleStep: 0.5,
    });
    // 90 度回った点は中心 (0, R) から見て (R, R) の位置（左曲がりなので -z 側へ）
    const p = a.positionAt(arcLength);
    expect(a.headingAt(arcLength)).toBeCloseTo(Math.PI / 2, 12);
    expect(p.x).toBeCloseTo(R, 4);
    expect(p.z).toBeCloseTo(-R, 4);
    // 途中 45 度の点
    const half = arcLength / 2;
    const ph = a.positionAt(half);
    expect(ph.x).toBeCloseTo(R * Math.sin(Math.PI / 4), 4);
    expect(ph.z).toBeCloseTo(-R * (1 - Math.cos(Math.PI / 4)), 4);
  });

  it('右曲線は左曲線の鏡像になる', () => {
    const R = 300;
    const L = 200;
    const left = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: L, radius: R }],
      vertical: [{ length: L, gradePermil: 0 }],
    });
    const right = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: L, radius: -R }],
      vertical: [{ length: L, gradePermil: 0 }],
    });
    expect(right.positionAt(L).x).toBeCloseTo(left.positionAt(L).x, 9);
    expect(right.positionAt(L).z).toBeCloseTo(-left.positionAt(L).z, 9);
    expect(right.curvatureAt(L / 2)).toBeCloseTo(-left.curvatureAt(L / 2), 12);
  });

  it('緩和曲線内で曲率が線形に変化する', () => {
    const R = 500;
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [
        { length: 200 },
        { length: 300, radius: R, transitionLength: 60, cant: mmToM(75) },
        { length: 200, transitionLength: 60 },
      ],
      vertical: [{ length: 700, gradePermil: 0 }],
    });
    expect(a.curvatureAt(200)).toBeCloseTo(0, 12);
    expect(a.curvatureAt(230)).toBeCloseTo(1 / R / 2, 12);
    expect(a.curvatureAt(260)).toBeCloseTo(1 / R, 12);
    expect(a.curvatureAt(480)).toBeCloseTo(1 / R, 12);
    // 出口側の緩和曲線は後続の直線区間の先頭に置かれる
    expect(a.curvatureAt(530)).toBeCloseTo(1 / R / 2, 12);
    expect(a.curvatureAt(560)).toBeCloseTo(0, 12);
    // カントも同じ区間で逓減する
    expect(a.cantAt(200)).toBeCloseTo(0, 12);
    expect(a.cantAt(230)).toBeCloseTo(mmToM(37.5), 12);
    expect(a.cantAt(400)).toBeCloseTo(mmToM(75), 12);
    expect(a.cantAt(560)).toBeCloseTo(0, 12);
  });

  it('クロソイドの座標が級数解と一致する', () => {
    // 曲率が 0 から 1/R へ長さ L で線形変化するクロソイド。
    // θ(s) = s^2 / (2 L R) なので x = ∫cos θ, z = -∫sin θ を級数展開と突き合わせる。
    const R = 400;
    const L = 100;
    const S0 = 100; // 先行する直線
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: S0 }, { length: L, radius: R, transitionLength: L }],
      vertical: [{ length: S0 + L, gradePermil: 0 }],
      sampleStep: 0.25,
    });
    const s = 80;
    const theta = (s * s) / (2 * L * R);
    expect(a.headingAt(S0 + s)).toBeCloseTo(theta, 10);
    // θ = s^2/(2LR) を cos/sin に代入して項別積分した級数（3 項まで）
    const xExact = s - s ** 5 / (40 * L ** 2 * R ** 2) + s ** 9 / (3456 * L ** 4 * R ** 4);
    const yExact =
      s ** 3 / (6 * L * R) - s ** 7 / (336 * L ** 3 * R ** 3) + s ** 11 / (42240 * L ** 5 * R ** 5);
    const p = a.positionAt(S0 + s);
    expect(p.x - S0).toBeCloseTo(xExact, 6);
    expect(-p.z).toBeCloseTo(yExact, 6);
  });
});

describe('Alignment - 縦断線形', () => {
  it('一定勾配で高さが線形に増える', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 1000 }],
      vertical: [{ length: 1000, gradePermil: 25 }],
    });
    expect(a.gradeAt(500)).toBeCloseTo(0.025, 12);
    expect(a.elevationAt(400)).toBeCloseTo(10, 9);
    expect(a.elevationAt(1000)).toBeCloseTo(25, 9);
  });

  it('縦曲線区間の高さが円曲線の解析解と一致する', () => {
    // 0‰ から 20‰ へ、縦曲線長 200m（半径 Rv = L / Δi = 200 / 0.02 = 10000m）
    const L = 200;
    const di = 0.02;
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 2000 }],
      vertical: [
        { length: 1000, gradePermil: 0 },
        { length: 1000, gradePermil: 20, verticalCurveLength: L },
      ],
    });
    // 縦曲線は 900m〜1100m に中心配置される
    expect(a.gradeAt(899)).toBeCloseTo(0, 12);
    expect(a.gradeAt(1000)).toBeCloseTo(0.01, 12);
    expect(a.gradeAt(1101)).toBeCloseTo(0.02, 12);
    // 縦曲線内の高さ: z(x) = x^2 / (2 Rv), Rv = L/Δi
    const Rv = L / di;
    const x = 50; // 縦曲線始点から 50m
    expect(a.elevationAt(900 + x)).toBeCloseTo((x * x) / (2 * Rv), 9);
  });

  it('勾配変化点は縦曲線の中心 1 点だけになる', () => {
    // 0‰ → 25‰ → 0‰、いずれも縦曲線 200m
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 4000 }],
      vertical: [
        { length: 2000, gradePermil: 0 },
        { length: 1000, gradePermil: 25, verticalCurveLength: 200 },
        { length: 1000, gradePermil: 0, verticalCurveLength: 200 },
      ],
    });
    const changes = a.gradeChanges;
    // 縦曲線の中は 200m にわたって勾配が変わり続けるが、変化点は各 1 点である
    expect(changes.length).toBe(2);
    expect(changes[0]!.s).toBeCloseTo(2000, 9);
    expect(changes[0]!.from).toBeCloseTo(0, 12);
    expect(changes[0]!.to).toBeCloseTo(permilToSlope(25), 12);
    expect(changes[0]!.verticalCurveLength).toBeCloseTo(200, 9);
    expect(changes[1]!.s).toBeCloseTo(3000, 9);
    expect(changes[1]!.from).toBeCloseTo(permilToSlope(25), 12);
    expect(changes[1]!.to).toBeCloseTo(0, 12);
  });

  it('縦曲線が無い勾配変化点は境界そのものになる', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 2000 }],
      vertical: [
        { length: 1000, gradePermil: 0 },
        { length: 1000, gradePermil: -33 },
      ],
    });
    const changes = a.gradeChanges;
    expect(changes.length).toBe(1);
    expect(changes[0]!.s).toBeCloseTo(1000, 9);
    expect(changes[0]!.to).toBeCloseTo(permilToSlope(-33), 12);
    expect(changes[0]!.verticalCurveLength).toBe(0);
  });

  it('勾配が変わらない路線には勾配変化点が無い', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 1000 }],
      vertical: [
        { length: 500, gradePermil: 10 },
        { length: 500, gradePermil: 10, verticalCurveLength: 200 },
      ],
    });
    expect(a.gradeChanges.length).toBe(0);
  });

  it('区間平均勾配が長さで重み付けされる', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 2000 }],
      vertical: [
        { length: 1000, gradePermil: 0 },
        { length: 1000, gradePermil: 33 },
      ],
    });
    // 勾配変化点をまたぐ 100m 区間の平均は半分ずつ
    expect(a.averageGrade(950, 1050)).toBeCloseTo(permilToSlope(16.5), 12);
  });
});

describe('Alignment - カント', () => {
  it('均衡カントが釣り合い条件 tan(φ) = v^2κ/g を満たす', () => {
    const R = 400;
    const gauge = 1.067;
    const a = buildAlignment({
      gauge,
      horizontal: [{ length: 500, radius: R }],
      vertical: [{ length: 500, gradePermil: 0 }],
    });
    const v = kmhToMps(70);
    const got = a.equilibriumCant(250, v);
    // C = G*sin(φ) なので φ を復元して tan(φ) を確かめる
    const phi = Math.asin(got / gauge);
    expect(Math.tan(phi)).toBeCloseTo((v * v) / (GRAVITY * R), 9);
  });

  it('均衡カントが慣用式 C = G V^2 / (127 R) と 1% 以内で一致する', () => {
    const R = 400;
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 500, radius: R }],
      vertical: [{ length: 500, gradePermil: 0 }],
    });
    const V = 70; // km/h
    // 慣用式は G*tan(φ) に相当する小角度近似（分母 127 も 3.6^2*g = 127.09 の丸め）なので、
    // 厳密な G*sin(φ) より数 0.1% 大きい
    const conventionalMm = (1067 * V * V) / (127 * R);
    const got = a.equilibriumCant(250, kmhToMps(V)) * 1000;
    expect(got).toBeLessThan(conventionalMm);
    expect(Math.abs(got - conventionalMm) / conventionalMm).toBeLessThan(1e-2);
  });

  it('均衡カントちょうどのとき非平衡横加速度が 0 になる', () => {
    const R = 400;
    const v = kmhToMps(70);
    const gauge = 1.067;
    const probe = buildAlignment({
      gauge,
      horizontal: [{ length: 500, radius: R }],
      vertical: [{ length: 500, gradePermil: 0 }],
    });
    const a = buildAlignment({
      gauge,
      horizontal: [{ length: 500, radius: R, cant: probe.equilibriumCant(250, v) }],
      vertical: [{ length: 500, gradePermil: 0 }],
    });
    expect(a.lateralAcceleration(250, v)).toBeCloseTo(0, 12);
    expect(a.cantDeficiency(250, v)).toBeCloseTo(0, 12);
  });

  /**
   * カント不足は左右の曲線で同じように読めなければならない。
   * `cantDeficiency` は向き付きなので右曲線では符号が反転する。表示に使うのは
   * `cantDeficiencyAmount`（正 = 不足）のほう。
   */
  it('カント過不足量は曲線の左右によらず正 = 不足になる', () => {
    const gauge = 1.067;
    const build = (radius: number) =>
      buildAlignment({
        gauge,
        horizontal: [{ length: 500, radius, cant: mmToM(90) }],
        vertical: [{ length: 500, gradePermil: 0 }],
      });
    const left = build(400);
    const right = build(-400);

    const fast = kmhToMps(80); // 均衡速度（約 66km/h）より速い → 不足
    const slow = kmhToMps(30); // 遅い → 超過

    expect(left.cantDeficiencyAmount(250, fast)).toBeGreaterThan(0);
    expect(right.cantDeficiencyAmount(250, fast)).toBeGreaterThan(0);
    expect(left.cantDeficiencyAmount(250, slow)).toBeLessThan(0);
    expect(right.cantDeficiencyAmount(250, slow)).toBeLessThan(0);
    // 左右で量は同じ
    expect(right.cantDeficiencyAmount(250, fast)).toBeCloseTo(
      left.cantDeficiencyAmount(250, fast),
      12,
    );
    // 向き付きの cantDeficiency は右曲線で符号が反転する
    expect(right.cantDeficiency(250, fast)).toBeCloseTo(-left.cantDeficiency(250, fast), 12);
  });

  it('カント不足があると外向きの非平衡加速度が生じる', () => {
    const R = 400;
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 500, radius: R, cant: mmToM(75) }],
      vertical: [{ length: 500, gradePermil: 0 }],
    });
    const v = kmhToMps(90);
    expect(a.cantDeficiency(250, v)).toBeGreaterThan(0);
    expect(a.lateralAcceleration(250, v)).toBeGreaterThan(0);
  });

  it('右曲線ではカントの符号が反転する', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 500, radius: -400, cant: mmToM(75) }],
      vertical: [{ length: 500, gradePermil: 0 }],
    });
    expect(a.cantAt(250)).toBeCloseTo(-mmToM(75), 12);
    expect(a.cantAngleAt(250)).toBeLessThan(0);
  });
});

describe('Alignment - 直接構築', () => {
  it('AlignmentInput から直接組み立てられる', () => {
    const a = new Alignment({
      curvature: new RampProfile([{ length: 100, startValue: 0, endValue: 0 }]),
      grade: new RampProfile([{ length: 100, startValue: 0.01, endValue: 0.01 }]),
      cant: new RampProfile([{ length: 100, startValue: 0, endValue: 0 }]),
      gauge: 1.435,
      length: 100,
    });
    expect(a.elevationAt(100)).toBeCloseTo(1, 12);
    expect(a.radiusAt(50)).toBe(Infinity);
  });
});

describe('Alignment - 曲線区間', () => {
  it('緩和曲線つきの曲線から 4 点と半径・カントが出る', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [
        { length: 500 },
        { length: 800, radius: 600, transitionLength: 80, cant: mmToM(75) },
        { length: 700, transitionLength: 80 },
      ],
      vertical: [{ length: 2000, gradePermil: 0 }],
    });
    const [curve] = a.curveSections;
    expect(a.curveSections.length).toBe(1);
    // BTC 500 → BCC 580 → ECC 1300 → ETC 1380
    expect(curve!.start).toBeCloseTo(500, 9);
    expect(curve!.circularStart).toBeCloseTo(580, 9);
    expect(curve!.circularEnd).toBeCloseTo(1300, 9);
    expect(curve!.end).toBeCloseTo(1380, 9);
    expect(curve!.radius).toBeCloseTo(600, 6);
    expect(curve!.leftHand).toBe(true);
    expect(curve!.cant).toBeCloseTo(mmToM(75), 12);
    expect(curve!.length).toBeCloseTo(880, 9);
    expect(curve!.hasTransition).toBe(true);
  });

  it('緩和曲線もカントも無い曲線（分岐器のリード曲線）が区別できる', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [
        { length: 100 },
        { length: 30, radius: -250, transitionLength: 0 },
        { length: 100 },
      ],
      vertical: [{ length: 230, gradePermil: 0 }],
    });
    const [curve] = a.curveSections;
    expect(curve!.start).toBeCloseTo(100, 9);
    expect(curve!.circularStart).toBeCloseTo(100, 9);
    expect(curve!.circularEnd).toBeCloseTo(130, 9);
    expect(curve!.radius).toBeCloseTo(250, 6);
    expect(curve!.leftHand).toBe(false);
    expect(curve!.cant).toBe(0);
    expect(curve!.hasTransition).toBe(false);
  });

  it('直線を挟まない反向曲線は零点で 2 つに分かれる', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [
        { length: 200, radius: 500 },
        // 直前が R500 左なので、この 100m の緩和曲線が符号をまたぐ
        { length: 300, radius: -500, transitionLength: 100 },
      ],
      vertical: [{ length: 500, gradePermil: 0 }],
    });
    const curves = a.curveSections;
    expect(curves.length).toBe(2);
    expect(curves[0]!.leftHand).toBe(true);
    expect(curves[1]!.leftHand).toBe(false);
    // 零点は緩和曲線 200〜300m の中央
    expect(curves[0]!.end).toBeCloseTo(250, 9);
    expect(curves[1]!.start).toBeCloseTo(250, 9);
  });

  it('直線だけの路線には曲線区間が無い', () => {
    const a = buildAlignment({
      gauge: 1.067,
      horizontal: [{ length: 1000 }],
      vertical: [{ length: 1000, gradePermil: 0 }],
    });
    expect(a.curveSections.length).toBe(0);
  });
});
