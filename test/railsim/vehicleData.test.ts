import { describe, expect, it } from 'vitest';
import {
  commuter4ChopperVehicle,
  commuter4ResistorVehicle,
  commuter4Vehicle,
  compileVehicle,
} from '../../src/railsim/vehicle/index.ts';
import {
  DEFAULT_INVERTER,
  DEFAULT_PASSENGER,
  DEFAULT_SUSPENSION,
  backEmf,
  kmhToMps,
  motorTorque,
  rpmToRadPerSec,
  type ResistorTractionSpec,
} from '../../src/railsim/core/index.ts';

const resistorSpec = () => {
  const consist = compileVehicle(commuter4ResistorVehicle);
  const spec = consist.vehicles[1]?.traction;
  if (spec?.kind !== 'resistor') throw new Error('抵抗制御の仕様が取れません');
  return { consist, spec };
};

const chopperSpec = () => {
  const consist = compileVehicle(commuter4ChopperVehicle);
  const spec = consist.vehicles[1]?.traction;
  if (spec?.kind !== 'chopper') throw new Error('チョッパの仕様が取れません');
  return { consist, spec };
};

describe('制御方式の判別可能ユニオン', () => {
  it('3 方式それぞれがコンパイルできる', () => {
    expect(compileVehicle(commuter4Vehicle).vehicles[1]?.traction?.kind).toBe('vvvf');
    expect(compileVehicle(commuter4ResistorVehicle).vehicles[1]?.traction?.kind).toBe('resistor');
    expect(compileVehicle(commuter4ChopperVehicle).vehicles[1]?.traction?.kind).toBe('chopper');
  });

  it('方式ごとに違う諸元を要求する（VVVF に抵抗制御の諸元は書けない）', () => {
    expect(() =>
      compileVehicle({
        ...commuter4Vehicle,
        cars: commuter4Vehicle.cars.map((car) =>
          car.traction ? { ...car, traction: { ...car.traction, kind: 'resistor' as const } } : car,
        ),
      } as never),
    ).toThrow();
  });

});

describe('直流直巻電動機の諸元の逆算', () => {
  it('磁束定数が銘板の定格点を再現する', () => {
    const { spec } = resistorSpec();
    const motor = spec.motor;
    // データに書いてある銘板は 375V・350A・1630rpm
    const omega = rpmToRadPerSec(1630);
    expect(backEmf(motor, 350, 1, omega)).toBeCloseTo(375 - 350 * motor.armatureResistance, 6);
    // 定格出力が 120kW 級に収まる
    const power = (motorTorque(motor, 350, 1) * omega) / 1000;
    expect(power).toBeGreaterThan(115);
    expect(power).toBeLessThan(122);
  });

  it('インダクタンスが mH から H へ換算される', () => {
    const { spec } = resistorSpec();
    expect(spec.motor.armatureInductance).toBeCloseTo(0.022, 9);
  });

  it('抵抗制御とチョッパで同じ電動機を使っている', () => {
    const r = resistorSpec().spec.motor;
    const c = chopperSpec().spec.motor;
    expect(c.fluxConstant).toBeCloseTo(r.fluxConstant, 9);
    expect(c.saturationCurrent).toBe(r.saturationCurrent);
    expect(c.armatureResistance).toBe(r.armatureResistance);
  });
});

describe('進段表の生成', () => {
  const ladder = (spec: ResistorTractionSpec, motorsInSeries: number) =>
    spec.camSteps.filter((s) => s.motorsInSeries === motorsInSeries && s.fieldRatio === 1);

  it('つなぎごとに抵抗が公比 進段電流/限流値 の幾何級数で落ちる', () => {
    const { spec } = resistorSpec();
    const ratio = spec.stepCurrent / spec.currentLimit;
    for (const motorsInSeries of [8, 4]) {
      const steps = ladder(spec, motorsInSeries);
      const internal = motorsInSeries * spec.motor.armatureResistance;
      // 全短絡の段を除いた隣接ペアで、合計抵抗の比が公比になる
      for (let i = 1; i < steps.length - 1; i++) {
        const previous = steps[i - 1]!.resistance + internal;
        const current = steps[i]!.resistance + internal;
        expect(current / previous).toBeCloseTo(ratio, 6);
      }
    }
  });

  it('各つなぎの初段は起動時に限流値がちょうど流れる抵抗になっている', () => {
    const { spec } = resistorSpec();
    const first = spec.camSteps[0]!;
    const total = first.resistance + first.motorsInSeries * spec.motor.armatureResistance;
    // 起動時は逆起電力が無いので、V / R_合計 = 限流値
    expect(spec.lineVoltage / total).toBeCloseTo(spec.currentLimit, 6);
  });

  it('各つなぎの最後は全短絡、最後の 4 段は弱め界磁', () => {
    const { spec } = resistorSpec();
    expect(ladder(spec, 8).at(-1)?.resistance).toBe(0);
    expect(ladder(spec, 4).at(-1)?.resistance).toBe(0);
    const weakened = spec.camSteps.filter((s) => s.fieldRatio < 1);
    expect(weakened).toHaveLength(4);
    expect(weakened.map((s) => s.fieldRatio)).toEqual([0.8, 0.65, 0.55, 0.45]);
    // 弱め界磁は最終つなぎ・全短絡のうえに積まれる
    for (const s of weakened) {
      expect(s.resistance).toBe(0);
      expect(s.motorsInSeries).toBe(4);
    }
  });

  it('つなぎ方は直列から並列へ 1 度だけ変わる', () => {
    const { spec } = resistorSpec();
    const changes = spec.camSteps.filter(
      (s, i) => i > 0 && spec.camSteps[i - 1]!.motorsInSeries !== s.motorsInSeries,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.motorsInSeries).toBe(4);
  });

  it('ノッチの止まり位置がすべて全短絡の段である（抵抗を残したまま走れない）', () => {
    const { spec } = resistorSpec();
    expect(spec.notchFinalStep).toHaveLength(4);
    for (const index of spec.notchFinalStep) {
      expect(spec.camSteps[index]?.resistance).toBe(0);
    }
    // 昇順で、最終ノッチが最終段
    for (let i = 1; i < spec.notchFinalStep.length; i++) {
      expect(spec.notchFinalStep[i]!).toBeGreaterThan(spec.notchFinalStep[i - 1]!);
    }
    expect(spec.notchFinalStep.at(-1)).toBe(spec.camSteps.length - 1);
  });

  it('進段電流が限流値以上なら弾く', () => {
    const broken = {
      ...commuter4ResistorVehicle,
      cars: commuter4ResistorVehicle.cars.map((car) =>
        car.traction?.kind === 'resistor'
          ? { ...car, traction: { ...car.traction, stepCurrent: car.traction.currentLimit } }
          : car,
      ),
    };
    expect(() => compileVehicle(broken)).toThrow(/進段電流/);
  });
});

describe('チョッパの単位換算', () => {
  it('回生の絞り込み速度が km/h から m/s へ換算される', () => {
    const { spec } = chopperSpec();
    expect(spec.regenFadeStartSpeed).toBeCloseTo(kmhToMps(12), 9);
    expect(spec.regenFadeEndSpeed).toBeCloseTo(kmhToMps(5), 9);
  });
});

/**
 * 移植時の差分:
 *
 * - 「標準ライブラリに 3 方式の車両とシナリオが入っている」と「公称性能」は落とした。
 *   どちらもシナリオライブラリ (`packages/data` の路線側) を要るが、そちらは
 *   こちらの網目状の線形と別物なので移植していない。起動加速度の検定は、
 *   経路アダプタが `CompiledRoute` を作れるようになってから改めて置く。
 * - 既定値の埋まり方 (zod を素の TypeScript で置き換えた部分) の検定を足した。
 */
describe('既定値の埋まり方', () => {
  it('省いた項目に既定値が入る', () => {
    // commuter4 は車体の寸法もブレーキも動揺も書いていない
    const car = compileVehicle(commuter4Vehicle).vehicles[0]!;
    expect(car.length).toBe(20);
    expect(car.bogieSpacing).toBe(13.8);
    expect(car.axleCount).toBe(4);
    expect(car.wheelDiameter).toBe(0.86);
    expect(car.brake.kind).toBe('disc');
    expect(car.brake.maxCylinderPressure).toBeCloseTo(400_000, 6);
    expect(car.suspension).toEqual(DEFAULT_SUSPENSION);
    expect(car.passenger).toEqual(DEFAULT_PASSENGER);
  });

  it('書いた項目は既定値に上書きされない', () => {
    const consist = compileVehicle(commuter4Vehicle);
    // 先頭車だけ速度 2 乗項が大きい (前面の空気抵抗)
    const lead = consist.vehicles[0]!.runningResistance;
    const middle = consist.vehicles[1]!.runningResistance;
    expect(lead.c).toBeGreaterThan(middle.c);
    expect(lead.a).toBeCloseTo(middle.a, 12);
    expect(consist.vehicles[0]!.drivenAxleCount).toBe(0);
    expect(consist.vehicles[1]!.drivenAxleCount).toBe(4);
  });

  it('`inverter: {}` と書けば変調は既定の GTO 車になる', () => {
    const spec = compileVehicle(commuter4Vehicle).vehicles[1]?.traction;
    if (spec?.kind !== 'vvvf') throw new Error('VVVF の仕様が取れません');
    expect(spec.inverter).toEqual(DEFAULT_INVERTER);
  });

  it('現場の単位が SI へ換算される', () => {
    const consist = compileVehicle(commuter4Vehicle);
    expect(consist.vehicles[0]!.tareMass).toBe(25_000); // t -> kg
    expect(consist.maxSpeed).toBeCloseTo(kmhToMps(120), 12); // km/h -> m/s
    expect(consist.brake.maxServiceDeceleration).toBeCloseTo(3.5 / 3.6, 12); // km/h/s -> m/s^2
    expect(consist.adhesion.lateralCreepSaturation).toBeCloseTo(0.003, 12); // mrad -> rad
    const spec = consist.vehicles[1]?.traction;
    if (spec?.kind !== 'vvvf') throw new Error('VVVF の仕様が取れません');
    expect(spec.constantTorqueSpeed).toBeCloseTo(kmhToMps(35), 12);
  });

  it('車両が 1 両も無い定義は弾く', () => {
    expect(() => compileVehicle({ ...commuter4Vehicle, cars: [] })).toThrow(/車両/);
  });
});
