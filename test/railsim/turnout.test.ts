import { describe, expect, it } from 'vitest';
import {
  GRAVITY,
  TurnoutTrack,
  crossingAngle,
  leadLengthOf,
  standardLeadRadius,
  turnoutLengthOf,
  type Turnout,
} from '../../src/railsim/core/index.ts';

/** 番数と開通方向を指定して分岐器を 1 つ組み立てる（データ層のコンパイラと同じ手順） */
function makeTurnout(over: Partial<Turnout> = {}): Turnout {
  const number = over.number ?? 12;
  const angle = crossingAngle(number);
  const radius = over.radius ?? standardLeadRadius(number);
  const leadLength = leadLengthOf(radius, angle);
  const position = over.position ?? 1000;
  const orientation = over.orientation ?? 'facing';
  return {
    id: 'to-1',
    position,
    length: turnoutLengthOf(leadLength),
    number,
    crossingAngle: angle,
    radius,
    leadLength,
    side: 'right',
    orientation,
    route: 'through',
    crossover: false,
    swingNose: false,
    divergingSpeed: 45 / 3.6,
    pointsPosition: orientation === 'facing' ? position : position + leadLength,
    crossingPosition: orientation === 'facing' ? position + leadLength : position,
    ...over,
  };
}

describe('分岐器の寸法', () => {
  /** 番数 N はクロッシング角の cot。#8 なら 7.13 度、#12 なら 4.76 度。 */
  it('クロッシング角は tan α = 1/N', () => {
    expect(Math.tan(crossingAngle(8))).toBeCloseTo(1 / 8, 12);
    expect((crossingAngle(8) * 180) / Math.PI).toBeCloseTo(7.125, 2);
    expect((crossingAngle(12) * 180) / Math.PI).toBeCloseTo(4.764, 2);
    // 番数が大きいほど浅い
    expect(crossingAngle(20)).toBeLessThan(crossingAngle(8));
  });

  it('リード半径は在来線の標準値に一致する', () => {
    expect(standardLeadRadius(8)).toBeCloseTo(145, 6);
    expect(standardLeadRadius(12)).toBeCloseTo(350, 6);
    expect(standardLeadRadius(16)).toBeCloseTo(560, 6);
    // 表の中間は内挿、外は N² で外挿する
    expect(standardLeadRadius(11)).toBeGreaterThan(245);
    expect(standardLeadRadius(11)).toBeLessThan(350);
    expect(standardLeadRadius(24)).toBeCloseTo((900 * 24 * 24) / (20 * 20), 6);
  });

  /**
   * リード長は弧長 R α。#12・R350 で 29m 前後、#8・R145 で 18m 前後になり、
   * 実際の分岐器の寸法とおおむね一致する。
   */
  it('リード長は R α', () => {
    const lead12 = leadLengthOf(standardLeadRadius(12), crossingAngle(12));
    expect(lead12).toBeCloseTo(29.1, 1);
    const lead8 = leadLengthOf(standardLeadRadius(8), crossingAngle(8));
    expect(lead8).toBeCloseTo(18.0, 1);
    // リード曲線を通ると、ちょうどクロッシング角のぶんだけ向きが変わる
    expect(lead12 / standardLeadRadius(12)).toBeCloseTo(crossingAngle(12), 12);
  });

  /**
   * 分岐側の制限速度は、緩和曲線もカントも無い曲線として許容カント不足から決まる。
   * 50mm を許容すると在来線の分岐制限（#8 → 25、#12 → 45km/h）に一致する。
   */
  it('分岐側の制限速度が許容カント不足から出る', () => {
    const gauge = 1.067;
    const cd = 0.05;
    const speed = (n: number) => {
      const v = Math.sqrt((cd * GRAVITY * standardLeadRadius(n)) / gauge);
      return Math.floor((v * 3.6) / 5) * 5;
    };
    expect(speed(8)).toBe(25);
    expect(speed(10)).toBe(35);
    expect(speed(12)).toBe(45);
  });

  /** 対向は先にトングレール、背向は先にクロッシングを踏む */
  it('対向と背向で要素の並びが入れ替わる', () => {
    const facing = makeTurnout({ orientation: 'facing' });
    expect(facing.pointsPosition).toBeLessThan(facing.crossingPosition);
    const trailing = makeTurnout({ orientation: 'trailing' });
    expect(trailing.crossingPosition).toBeLessThan(trailing.pointsPosition);
  });
});

describe('分岐器を踏む', () => {
  const turnout = makeTurnout();
  const track = new TurnoutTrack([turnout]);

  it('区間を跨いだ要素を取りこぼさない', () => {
    // 分岐器の全長を一気に跨いでも、トングレールとクロッシングの両方が出る
    const crossed = track.crossing(999, 1000 + turnout.length);
    expect(crossed.map((c) => c.value.kind)).toEqual(['points', 'crossing']);
    expect(crossed[0]!.s).toBeCloseTo(turnout.pointsPosition, 9);
    expect(crossed[1]!.s).toBeCloseTo(turnout.crossingPosition, 9);
    // 手前を走っているあいだは何も踏まない
    expect(track.crossing(900, 950)).toHaveLength(0);
  });

  it('クロッシングの衝撃はトングレールより強く、可動ノーズなら弱い', () => {
    const fixed = new TurnoutTrack([makeTurnout()]);
    const swing = new TurnoutTrack([makeTurnout({ swingNose: true })]);
    const strength = (t: TurnoutTrack, kind: string) =>
      t.crossing(999, 1100).find((c) => c.value.kind === kind)!.value.strength;
    expect(strength(fixed, 'crossing')).toBeGreaterThan(strength(fixed, 'points'));
    expect(strength(swing, 'crossing')).toBeLessThan(strength(fixed, 'crossing'));
  });

  it('分岐側を通るほうがトングレールの衝撃が強い', () => {
    const through = new TurnoutTrack([makeTurnout({ route: 'through' })]);
    const diverging = new TurnoutTrack([makeTurnout({ route: 'diverging' })]);
    const points = (t: TurnoutTrack) =>
      t.crossing(999, 1100).find((c) => c.value.kind === 'points')!.value.strength;
    expect(points(diverging)).toBeGreaterThan(points(through));
  });
});

describe('分岐器がつくる局所的な軌道狂い', () => {
  const turnout = makeTurnout();
  const track = new TurnoutTrack([turnout]);

  it('分岐器の外では何も起きない', () => {
    // 影響するのは分岐器の範囲だけ（要素の半幅ぶんだけ外へはみ出す）
    for (const s of [0, 500, 998, 1100, 5000]) {
      expect(track.verticalAt(s)).toBe(0);
      expect(track.lateralAt(s)).toBe(0);
      expect(track.crossLevelAt(s)).toBe(0);
    }
  });

  /** 欠線は落ち込みなので高低狂いは負。クロッシングの真上でいちばん深い。 */
  it('クロッシングで落ち込む', () => {
    const at = track.verticalAt(turnout.crossingPosition);
    expect(at).toBeLessThan(0);
    expect(Math.abs(at)).toBeGreaterThan(
      Math.abs(track.verticalAt(turnout.crossingPosition + 0.4)),
    );
    expect(track.verticalAt(turnout.crossingPosition + 1.0)).toBe(0);
  });

  /**
   * 欠線は**片方のレールにしか無い**ので、上下動だけでなく水準狂いになる。
   * 直進と分岐側では踏むレールが逆になるため、車体が傾く向きも逆になる。
   */
  it('欠線を踏む側は開通方向で入れ替わり、水準狂いの符号が逆になる', () => {
    const through = new TurnoutTrack([makeTurnout({ route: 'through' })]);
    const diverging = new TurnoutTrack([makeTurnout({ route: 'diverging' })]);
    const s = turnout.crossingPosition;
    expect(through.crossLevelAt(s)).toBeGreaterThan(0);
    expect(diverging.crossLevelAt(s)).toBeLessThan(0);
    expect(through.crossLevelAt(s)).toBeCloseTo(-diverging.crossLevelAt(s), 12);
  });

  it('トングレールでは分岐する側へ輪軸が振られる', () => {
    const right = new TurnoutTrack([makeTurnout({ side: 'right', route: 'diverging' })]);
    const left = new TurnoutTrack([makeTurnout({ side: 'left', route: 'diverging' })]);
    expect(right.lateralAt(turnout.pointsPosition)).toBeGreaterThan(0);
    expect(left.lateralAt(turnout.pointsPosition)).toBeLessThan(0);
  });

  it('通過中の分岐器と、次の分岐器を引ける', () => {
    expect(track.at(turnout.position + 1)?.id).toBe('to-1');
    expect(track.at(turnout.position - 1)).toBeUndefined();
    expect(track.at(turnout.position + turnout.length + 1)).toBeUndefined();
    expect(track.next(0)?.id).toBe('to-1');
    expect(track.next(turnout.position + turnout.length + 1)).toBeUndefined();
  });
});
