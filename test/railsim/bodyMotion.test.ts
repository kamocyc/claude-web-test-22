import { describe, expect, it } from 'vitest';
import {
  CarBodyMotion,
  DEFAULT_IRREGULARITY,
  DEFAULT_PASSENGER,
  DEFAULT_SUSPENSION,
  GRAVITY,
  Oscillator,
  TrackIrregularity,
  TrainDynamics,
  buildAlignment,
  kmhToMps,
  mmToM,
  type BodyMotionInput,
} from '../../src/railsim/core/index.ts';
import { NO_TUNNEL, flatTrack, testConsist } from './fixtures.ts';

const DT = 0.001;

const baseInput = (over: Partial<BodyMotionInput> = {}): BodyMotionInput => ({
  unbalancedLateral: 0,
  cantAngle: 0,
  gradeAngle: 0,
  longitudinalAcceleration: 0,
  frontVertical: 0,
  rearVertical: 0,
  frontLateral: 0,
  rearLateral: 0,
  crossLevel: 0,
  bogieSpacing: 13.8,
  gauge: 1.067,
  ...over,
});

describe('2 次系の振動子', () => {
  it('目標値へ減衰しながら収束する', () => {
    const osc = new Oscillator();
    for (let i = 0; i < 20_000; i++) osc.step(DT, 1, 1.0, 0.3);
    expect(osc.value).toBeCloseTo(1, 4);
    expect(osc.rate).toBeCloseTo(0, 3);
  });

  it('固有振動数どおりの周期で振動する', () => {
    const osc = new Oscillator();
    const freq = 1.0;
    // 減衰をほぼ 0 にしてステップ応答の周期を測る
    const values: number[] = [];
    for (let i = 0; i < 4000; i++) {
      osc.step(DT, 1, freq, 0.001);
      values.push(osc.value);
    }
    // 最初のピーク（オーバーシュート）はおよそ半周期後に来る
    let peakIndex = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i]! > values[peakIndex]!) peakIndex = i;
      else if (values[i]! < values[i - 1]!) break;
    }
    expect(peakIndex * DT).toBeCloseTo(0.5 / freq, 1);
  });
});

describe('軌道狂い', () => {
  const irr = new TrackIrregularity(42, DEFAULT_IRREGULARITY, 1);

  it('距離程の関数なので、同じ地点では常に同じ値になる', () => {
    expect(irr.verticalAt(1234.5)).toBe(irr.verticalAt(1234.5));
    expect(irr.crossLevelAt(500)).toBe(irr.crossLevelAt(500));
    expect(irr.verticalAt(1234.5)).not.toBe(irr.verticalAt(1240));
  });

  it('同じシードなら同じ軌道狂いになる', () => {
    const other = new TrackIrregularity(42, DEFAULT_IRREGULARITY, 1);
    expect(other.verticalAt(777)).toBeCloseTo(irr.verticalAt(777), 12);
  });

  it('シードが違えば別の軌道狂いになる', () => {
    const other = new TrackIrregularity(43, DEFAULT_IRREGULARITY, 1);
    expect(other.verticalAt(777)).not.toBeCloseTo(irr.verticalAt(777), 6);
  });

  it('標準偏差が指定した振幅と概ね一致する', () => {
    let sum = 0;
    let sumSq = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const v = irr.verticalAt(i * 0.37);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(sd).toBeGreaterThan(DEFAULT_IRREGULARITY.verticalAmplitude * 0.7);
    expect(sd).toBeLessThan(DEFAULT_IRREGULARITY.verticalAmplitude * 1.4);
  });

  it('レベル 0 では完全に平滑になる', () => {
    const smooth = new TrackIrregularity(42, DEFAULT_IRREGULARITY, 0);
    expect(smooth.verticalAt(123)).toBe(0);
    expect(smooth.crossLevelAt(456)).toBe(0);
  });
});

/** 傾いた床（総ピッチ角 p、正 = 前下がり）の上で、前後加速度 a のときに感じる比力 */
const feltFromPitch = (pitch: number, a: number): number =>
  GRAVITY * Math.sin(pitch) - a * Math.cos(pitch);

describe('車体の動揺', () => {
  it('横加速度がゼロなら車体は傾かない', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    for (let i = 0; i < 10_000; i++) body.step(DT, baseInput());
    expect(body.state.roll).toBeCloseTo(0, 6);
    expect(body.state.feltLateral).toBeCloseTo(0, 6);
  });

  it('曲線の横加速度で車体が外側へロールする', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    const a = 0.8; // 右へ押される
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ unbalancedLateral: a }));
    // 車体傾斜率 0.3、つり合い角 atan(0.8/g) = 0.0815 rad
    const expected = 0.3 * Math.atan2(a, GRAVITY);
    expect(body.state.roll).toBeCloseTo(expected, 4);
    expect(body.state.roll).toBeGreaterThan(0);
  });

  it('車体ロールにより乗客が感じる横 G は軌道面の値より大きくなる', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    const a = 0.8;
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ unbalancedLateral: a }));
    expect(body.state.feltLateral).toBeGreaterThan(a);
    // ロール角ぶんの重力成分が上乗せされる
    const expected = a * Math.cos(body.state.roll) + GRAVITY * Math.sin(body.state.roll);
    expect(body.state.feltLateral).toBeCloseTo(expected, 6);
  });

  it('車体傾斜率が 0 なら体感横 G は軌道面の値と一致する', () => {
    const rigid = { ...DEFAULT_SUSPENSION, rollFlexibility: 0 };
    const body = new CarBodyMotion(rigid, DEFAULT_PASSENGER);
    const a = 0.8;
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ unbalancedLateral: a }));
    expect(body.state.feltLateral).toBeCloseTo(a, 5);
  });

  it('カントは軌道面自体の傾きとして車体を曲線内側へ傾ける', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    // 左曲線のカント（外軌 = 右レールが高い）→ カント角は正
    const cantAngle = Math.asin(mmToM(90) / 1.067);
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ cantAngle }));
    // 右レールが高い = 車体は左（内側）へ倒れる = ロールの符号は負
    expect(body.state.trackRoll).toBeCloseTo(-cantAngle, 12);
    expect(body.state.absoluteRoll).toBeLessThan(0);
    expect((Math.abs(body.state.trackRoll) * 180) / Math.PI).toBeCloseTo(4.84, 2);
  });

  it('停車中の曲線ではカント超過で内側へ引かれる', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    const cantAngle = Math.asin(mmToM(90) / 1.067);
    // 速度 0 なら軌道面の非平衡横加速度は -g*sin(カント角)
    const unbalancedLateral = -GRAVITY * Math.sin(cantAngle);
    for (let i = 0; i < 20_000; i++) {
      body.step(DT, baseInput({ cantAngle, unbalancedLateral }));
    }
    // 乗客は曲線内側（左）へ引かれる
    expect(body.state.feltLateral).toBeLessThan(0);
    expect(body.state.feltLateral).toBeCloseTo(GRAVITY * Math.sin(body.state.absoluteRoll), 6);
  });

  it('均衡カントで通過すると体感横 G が消え、体感上下 G が 1G を超える', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    const cantAngle = Math.asin(mmToM(90) / 1.067);
    // 均衡状態では軌道面の非平衡横加速度が 0 になる（このとき a_h = g*tan(φ)）
    for (let i = 0; i < 20_000; i++) {
      body.step(DT, baseInput({ cantAngle, unbalancedLateral: 0 }));
    }
    expect(body.state.roll).toBeCloseTo(0, 6);
    expect(body.state.feltLateral).toBeCloseTo(0, 6);
    // 重力と遠心力の合力は軌道面に垂直で、大きさは g/cos(φ)
    expect(body.state.feltVertical).toBeGreaterThan(GRAVITY);
    expect(body.state.feltVertical).toBeCloseTo(GRAVITY / Math.cos(cantAngle), 6);
  });

  it('加速すると乗客は後ろへ押され、車体は前上がりにピッチングする', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    for (let i = 0; i < 20_000; i++) {
      body.step(DT, baseInput({ longitudinalAcceleration: 1.0 }));
    }
    expect(body.state.pitch).toBeLessThan(0);
    expect(body.state.pitch).toBeCloseTo(-DEFAULT_SUSPENSION.pitchGain * 1.0, 4);
    // 加速度ぶんに加えて、前上がりに傾いた床に沿う重力成分も後ろ向きに効く
    // （スクォートしている車内では押し付けられ感が少し強くなる）
    expect(body.state.feltLongitudinal).toBeLessThan(-1.0);
    expect(body.state.feltLongitudinal).toBeCloseTo(
      feltFromPitch(body.state.absolutePitch, 1.0),
      9,
    );
  });

  it('制動すると乗客は前へ押され、車体は前下がりにピッチングする', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    for (let i = 0; i < 20_000; i++) {
      body.step(DT, baseInput({ longitudinalAcceleration: -1.0 }));
    }
    expect(body.state.pitch).toBeGreaterThan(0);
    expect(body.state.feltLongitudinal).toBeGreaterThan(1.0);
    expect(body.state.feltLongitudinal).toBeCloseTo(
      feltFromPitch(body.state.absolutePitch, -1.0),
      9,
    );
  });

  it('上り勾配で停車していると乗客は後ろへ押される', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    const gradeAngle = Math.atan(0.033); // 33‰ 上り
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ gradeAngle }));
    expect(body.state.trackPitch).toBeCloseTo(-gradeAngle, 12);
    expect(body.state.feltLongitudinal).toBeLessThan(0);
    expect(body.state.feltLongitudinal).toBeCloseTo(-GRAVITY * Math.sin(gradeAngle), 3);
  });

  /**
   * 前後の比力から勾配の重力成分が抜けていると、下り勾配を惰行しているだけで
   * 「後ろへ押される」と出てしまう（実際には斜面成分と加速度が打ち消し合う）。
   */
  it('下り勾配を自由に転がっているときは前後の比力がほぼ 0 になる', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    const gradeAngle = -Math.atan(0.033); // 33‰ 下り
    // 抵抗も回転部慣性も無いとすれば a = g*sin(下り角)
    const a = -GRAVITY * Math.sin(gradeAngle);
    expect(a).toBeGreaterThan(0);
    for (let i = 0; i < 20_000; i++) {
      body.step(DT, baseInput({ gradeAngle, longitudinalAcceleration: a }));
    }
    // 勾配成分が入っていなければ -a = -0.32 m/s²（後ろへ押される）と出るところ、
    // ほぼ打ち消し合って 1 桁以上小さくなる。残るのは車体がスクォートして
    // 床が起きるぶんで、これは実在する効果。
    expect(Math.abs(body.state.feltLongitudinal)).toBeLessThan(a / 10);
    // 吊り革もほぼ鉛直のまま（下り勾配で後ろへ倒れたりしない）
    expect(Math.abs(body.state.passenger.strap.longitudinal)).toBeLessThan(0.005);
  });

  it('水準狂いは軌道の傾きとしてそのまま車体を傾ける', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    const crossLevel = mmToM(10);
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ crossLevel }));
    expect(body.state.roll).toBeCloseTo(Math.asin(crossLevel / 1.067), 4);
  });

  it('前後台車の高低差はピッチングを、通り狂いの差はヨーイングを生む', () => {
    const body = new CarBodyMotion(DEFAULT_SUSPENSION, DEFAULT_PASSENGER);
    for (let i = 0; i < 20_000; i++) {
      body.step(
        DT,
        baseInput({
          frontVertical: 0.01,
          rearVertical: -0.01,
          frontLateral: 0.01,
          rearLateral: -0.01,
        }),
      );
    }
    expect(body.state.pitch).toBeCloseTo(-0.02 / 13.8, 4);
    expect(body.state.yaw).toBeCloseTo(0.02 / 13.8, 4);
    // 上下動は前後の平均なのでゼロ
    expect(body.state.vertical).toBeCloseTo(0, 5);
  });
});

describe('吊り革の振られ方（減衰振り子）', () => {
  const run = (steps: number, input: Partial<BodyMotionInput>, spec = DEFAULT_PASSENGER) => {
    const body = new CarBodyMotion({ ...DEFAULT_SUSPENSION, rollFlexibility: 0 }, spec);
    const history: number[] = [];
    for (let i = 0; i < steps; i++) {
      body.step(DT, baseInput(input));
      history.push(body.state.passenger.strap.lateral);
    }
    return { body, history };
  };

  it('静止していれば振れない', () => {
    const { body } = run(5000, {});
    expect(body.state.passenger.strap.lateral).toBeCloseTo(0, 9);
    expect(body.state.passenger.strap.longitudinal).toBeCloseTo(0, 9);
  });

  it('一定加速度では tan θ = a / g へ収束する', () => {
    const a = 1.0;
    const { body } = run(40_000, { unbalancedLateral: a });
    expect(Math.tan(body.state.passenger.strap.lateral)).toBeCloseTo(a / GRAVITY, 4);
    // 平衡角は瞬時値そのもの
    expect(body.state.passenger.strap.equilibriumLateral).toBeCloseTo(
      Math.atan2(body.state.feltLateral, body.state.feltVertical),
      9,
    );
  });

  it('加速度に遅れて追従する（＝加加速度が見える）', () => {
    const a = 1.0;
    const { body, history } = run(300, { unbalancedLateral: a });
    // 0.3 秒後にはまだ平衡角へ届いていない
    const target = Math.atan2(a, GRAVITY);
    expect(history[299]!).toBeLessThan(target);
    expect(history[299]!).toBeGreaterThan(0);
    // 瞬時値との差が「まだ振れ切っていない量」
    expect(
      body.state.passenger.strap.equilibriumLateral - body.state.passenger.strap.lateral,
    ).toBeGreaterThan(0.005);
  });

  it('減衰が弱いと行き過ぎてから収束する', () => {
    const light = { ...DEFAULT_PASSENGER, strapDamping: 0.05 };
    const target = Math.atan2(1.0, GRAVITY);
    const { history } = run(4000, { unbalancedLateral: 1.0 }, light);
    expect(Math.max(...history)).toBeGreaterThan(target * 1.5);
    // 減衰が強ければ行き過ぎない
    const heavy = { ...DEFAULT_PASSENGER, strapDamping: 1.0 };
    const h2 = run(4000, { unbalancedLateral: 1.0 }, heavy).history;
    expect(Math.max(...h2)).toBeLessThan(target * 1.02);
  });

  it('固有周期が 2π√(L/g) と一致する', () => {
    const L = 0.6;
    const undamped = { ...DEFAULT_PASSENGER, strapLength: L, strapDamping: 0.0005 };
    const { history } = run(4000, { unbalancedLateral: 1.0 }, undamped);
    let peak = 0;
    for (let i = 1; i < history.length; i++) {
      if (history[i]! > history[peak]!) peak = i;
      else if (history[i]! < history[i - 1]!) break;
    }
    // ステップ応答の最初のピークは半周期後
    expect(peak * DT).toBeCloseTo(Math.PI * Math.sqrt(L / GRAVITY), 2);
  });

  it('振り子が短いほど速く追従する', () => {
    const shortP = run(300, { unbalancedLateral: 1.0 }, { ...DEFAULT_PASSENGER, strapLength: 0.2 });
    const longP = run(300, { unbalancedLateral: 1.0 }, { ...DEFAULT_PASSENGER, strapLength: 1.2 });
    expect(shortP.body.state.passenger.strap.lateral).toBeGreaterThan(
      longP.body.state.passenger.strap.lateral,
    );
  });

  it('制動が急に切れると後ろへ大きく揺り戻す', () => {
    const body = new CarBodyMotion(
      { ...DEFAULT_SUSPENSION, rollFlexibility: 0 },
      DEFAULT_PASSENGER,
    );
    // 制動が定常になるまで前へ振られる
    for (let i = 0; i < 20_000; i++) body.step(DT, baseInput({ longitudinalAcceleration: -1.2 }));
    const leaned = body.state.passenger.strap.longitudinal;
    expect(leaned).toBeGreaterThan(0);

    // 停車した瞬間に減速度が消える
    let back = 0;
    for (let i = 0; i < 4000; i++) {
      body.step(DT, baseInput({}));
      back = Math.min(back, body.state.passenger.strap.longitudinal);
    }
    // 行き過ぎ量 exp(-πζ/√(1-ζ²)) は ζ = 0.2 で約 53%。
    // 減衰が強すぎると揺り戻しが見えなくなる（ζ = 0.45 なら 20%）。
    expect(-back / leaned).toBeGreaterThan(0.4);
    expect(-back / leaned).toBeLessThan(0.7);
  });

  it('制動では前へ、力行では後ろへ振れる', () => {
    const braking = run(20_000, { longitudinalAcceleration: -1.0 });
    const powering = run(20_000, { longitudinalAcceleration: 1.0 });
    expect(braking.body.state.passenger.strap.longitudinal).toBeGreaterThan(0);
    expect(powering.body.state.passenger.strap.longitudinal).toBeLessThan(0);
  });

  it('同じ入力なら同じ振れになる（決定論）', () => {
    const a = run(2000, { unbalancedLateral: 0.7, longitudinalAcceleration: -0.5 });
    const b = run(2000, { unbalancedLateral: 0.7, longitudinalAcceleration: -0.5 });
    expect(a.body.state.passenger.strap.lateral).toBe(b.body.state.passenger.strap.lateral);
    expect(a.body.state.passenger.strap.longitudinal).toBe(
      b.body.state.passenger.strap.longitudinal,
    );
  });
});

describe('走行中の車体動揺', () => {
  const irregular = (level: number) => new TrackIrregularity(2024, DEFAULT_IRREGULARITY, level);

  it('軌道狂いがあると走行中に揺れ続ける', () => {
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
      initialSpeed: kmhToMps(80),
      initialFrontPosition: 1000,
      irregularity: irregular(1),
    });
    let maxRoll = 0;
    let maxVertical = 0;
    for (let i = 0; i < 20_000; i++) {
      dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
      maxRoll = Math.max(maxRoll, Math.abs(dyn.vehicles[0]!.body.roll));
      maxVertical = Math.max(maxVertical, Math.abs(dyn.vehicles[0]!.body.vertical));
    }
    expect(maxRoll).toBeGreaterThan(0.001);
    expect(maxVertical).toBeGreaterThan(0.001);
    // 過大な揺れにはならない（ロール 3 度以内、上下 3cm 以内）
    expect(maxRoll).toBeLessThan(0.05);
    expect(maxVertical).toBeLessThan(0.03);
  });

  it('軌道狂いが大きいほど揺れが大きい', () => {
    const amplitude = (level: number) => {
      const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
        initialSpeed: kmhToMps(80),
        initialFrontPosition: 1000,
        irregularity: irregular(level),
      });
      let sum = 0;
      for (let i = 0; i < 20_000; i++) {
        dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
        sum += Math.abs(dyn.vehicles[0]!.body.roll);
      }
      return sum / 20_000;
    };
    expect(amplitude(2)).toBeGreaterThan(amplitude(1) * 1.5);
  });

  it('狂いのない軌道では揺れない', () => {
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
      initialSpeed: kmhToMps(80),
      initialFrontPosition: 1000,
    });
    for (let i = 0; i < 10_000; i++) {
      dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
    }
    expect(Math.abs(dyn.vehicles[0]!.body.roll)).toBeLessThan(1e-9);
    expect(Math.abs(dyn.vehicles[0]!.body.vertical)).toBeLessThan(1e-9);
  });

  it('曲線に進入すると車体が外側へ傾き、体感横 G が立ち上がる', () => {
    const alignment = buildAlignment({
      gauge: 1.067,
      horizontal: [
        { length: 500 },
        { length: 800, radius: 400, transitionLength: 60, cant: mmToM(60) },
        { length: 500, transitionLength: 60 },
      ],
      vertical: [{ length: 1800, gradePermil: 0 }],
      sampleStep: 5,
    });
    const dyn = new TrainDynamics(testConsist({ cars: 4 }), alignment, {
      initialSpeed: kmhToMps(90),
      initialFrontPosition: 100,
    });
    let maxFelt = 0;
    let rollAtCurve = 0;
    for (let i = 0; i < 40_000; i++) {
      dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
      const body = dyn.vehicles[0]!.body;
      maxFelt = Math.max(maxFelt, Math.abs(body.feltLateral));
      if (dyn.vehicles[0]!.s > 700 && dyn.vehicles[0]!.s < 1200) rollAtCurve = body.roll;
      if (dyn.frontPosition > 1700) break;
    }
    // 左曲線でカント不足 → 乗客は右（外側）へ押され、車体も右下がりにロールする
    expect(rollAtCurve).toBeGreaterThan(0.005);
    expect(maxFelt).toBeGreaterThan(0.3);
  });

  it('車体動揺は決定論的（同じ条件なら同じ揺れ）', () => {
    const runOnce = () => {
      const dyn = new TrainDynamics(testConsist({ cars: 4 }), flatTrack(), {
        initialSpeed: kmhToMps(80),
        initialFrontPosition: 1000,
        irregularity: irregular(1),
      });
      for (let i = 0; i < 5000; i++) {
        dyn.step(DT, { adhesion: { rail: 'dry', sanding: false }, ...NO_TUNNEL });
      }
      return dyn.vehicles[0]!.body.roll;
    };
    expect(runOnce()).toBe(runOnce());
  });
});
