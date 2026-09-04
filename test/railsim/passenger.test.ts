import { describe, expect, it } from 'vitest';
import {
  CarBodyMotion,
  DEFAULT_PASSENGER,
  DEFAULT_SUSPENSION,
  GRAVITY,
  type BodyMotionInput,
  type PassengerSpec,
} from '../../src/railsim/core/index.ts';

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

interface RunResult {
  readonly body: CarBodyMotion;
  /** よろけ具合の最大 */
  readonly maxStagger: number;
  /** 足を出した回数 */
  readonly steps: number;
  /** 前後の傾きの履歴 [rad] */
  readonly lean: number[];
}

/**
 * 前後加速度の時間波形を与えて走らせる。
 * 軌道は平坦・狂いなしなので、乗客に効くのは前後加速度だけになる。
 */
function run(
  profile: (t: number) => number,
  seconds: number,
  spec: PassengerSpec = DEFAULT_PASSENGER,
  lateral = false,
): RunResult {
  const body = new CarBodyMotion(DEFAULT_SUSPENSION, spec);
  const lean: number[] = [];
  let maxStagger = 0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const a = profile(i * DT);
    body.step(DT, baseInput(lateral ? { unbalancedLateral: a } : { longitudinalAcceleration: a }));
    const stance = body.state.passenger.stance;
    maxStagger = Math.max(maxStagger, stance.stagger);
    lean.push(lateral ? stance.lateral.lean : stance.longitudinal.lean);
  }
  return { body, maxStagger, steps: body.state.passenger.stance.steps, lean };
}

/** 階段状に入れる（無限大のジャーク） */
const step = (a: number) => () => a;
/** `rise` 秒かけて直線的に入れる */
const ramp = (a: number, rise: number) => (t: number) => a * Math.min(1, t / rise);

describe('立っている乗客（倒立振子 + 遅れのある姿勢制御）', () => {
  it('静止していれば傾かないし、よろけない', () => {
    const r = run(step(0), 10);
    const stance = r.body.state.passenger.stance;
    expect(Math.abs(stance.longitudinal.lean)).toBeLessThan(1e-6);
    expect(Math.abs(stance.lateral.lean)).toBeLessThan(1e-6);
    expect(r.maxStagger).toBeLessThan(1e-3);
    expect(r.steps).toBe(0);
  });

  /**
   * 定常では見かけの重力に上体を沿わせる。**押される向きと逆へ傾く**のが
   * 吊り革との決定的な違いで、制動中の乗客は後ろへよりかかっている。
   */
  it('一定の加速度では押される向きへよりかかる（吊り革とは逆）', () => {
    const a = 0.8;
    const braking = run(ramp(-a, 4), 30);
    const stance = braking.body.state.passenger.stance.longitudinal;
    // 制動 → 前へ押される → 後ろへよりかかる（負）
    expect(stance.lean).toBeLessThan(0);
    expect(Math.tan(-stance.lean)).toBeCloseTo(a / GRAVITY, 2);
    // 吊り革は逆に前へ振れている
    expect(braking.body.state.passenger.strap.longitudinal).toBeGreaterThan(0);
    // つり合っているので足圧中心はくるぶしの近くへ戻る
    expect(Math.abs(stance.cop)).toBeLessThan(0.02);

    const powering = run(ramp(a, 4), 30);
    expect(powering.body.state.passenger.stance.longitudinal.lean).toBeGreaterThan(0);
  });

  /**
   * この模型の目的そのもの。**同じ加速度**でも、一気に入れればよろけ、
   * 刻んで入れれば静かによりかかるだけになる。
   */
  it('同じ加速度でも、急に変えればよろけ、徐々に変えればよろけない', () => {
    const a = -1.0;
    const sudden = run(step(a), 12);
    const gradual = run(ramp(a, 3), 12);

    expect(sudden.maxStagger).toBeGreaterThan(1);
    expect(sudden.steps).toBeGreaterThan(0);

    expect(gradual.maxStagger).toBeLessThan(0.5);
    expect(gradual.steps).toBe(0);
    // 差は 1 桁以上ある
    expect(sudden.maxStagger).toBeGreaterThan(gradual.maxStagger * 10);

    // どちらも最後は同じ姿勢へ落ち着く（最終的な加速度は同じなのだから）。
    // 傾きは比力そのものから決まるので、車体がスクォートして床が起きるぶんだけ
    // atan(a/g) より少し大きい。
    const suddenLean = sudden.body.state.passenger.stance.longitudinal.lean;
    const gradualLean = gradual.body.state.passenger.stance.longitudinal.lean;
    expect(suddenLean).toBeCloseTo(gradualLean, 3);
    expect(-suddenLean).toBeGreaterThan(Math.atan(1.0 / GRAVITY) * 0.98);
    expect(-suddenLean).toBeLessThan(Math.atan(1.0 / GRAVITY) * 1.1);
  });

  /**
   * 吊り革は「変え方」を区別しない。同じ加速度なら同じ角度へ落ち着き、
   * 途中の行き過ぎも減衰比だけで決まる。人と物の違いはここにある。
   */
  it('吊り革は変え方に関わらず同じところへ落ち着く（人だけがよろける）', () => {
    const sudden = run(step(-1.0), 20);
    const gradual = run(ramp(-1.0, 3), 20);
    const s1 = sudden.body.state.passenger.strap.longitudinal;
    const s2 = gradual.body.state.passenger.strap.longitudinal;
    expect(s1).toBeCloseTo(s2, 3);
    // 定常の振れ角は比力そのもの（車体のスクォートぶんだけ a/g より少し大きい）
    expect(Math.tan(s1)).toBeGreaterThan(1.0 / GRAVITY);
    expect(Math.tan(s1)).toBeLessThan((1.0 / GRAVITY) * 1.1);
  });

  /**
   * よろけの原因が**むだ時間**であることの確認。遅れを 0 にすれば、
   * 同じ階段状の入力でも足圧中心が即座に応答するのでよろけない。
   */
  it('反応が遅いほどよろける（むだ時間が原因）', () => {
    const a = -1.0;
    const quick = run(step(a), 12, { ...DEFAULT_PASSENGER, reactionDelay: 0.001 });
    const normal = run(step(a), 12, DEFAULT_PASSENGER);
    const slow = run(step(a), 12, { ...DEFAULT_PASSENGER, reactionDelay: 0.25 });

    expect(quick.maxStagger).toBeLessThan(normal.maxStagger);
    expect(normal.maxStagger).toBeLessThan(slow.maxStagger);
    expect(quick.steps).toBe(0);
  });

  /** 手すりにつかまれば支持余裕が増えるので、同じ操作でも耐えられる */
  it('つかまっていればよろけにくい', () => {
    const a = -1.0;
    const free = run(step(a), 12, { ...DEFAULT_PASSENGER, handSupport: 0 });
    const holding = run(step(a), 12, { ...DEFAULT_PASSENGER, handSupport: 0.12 });
    expect(free.steps).toBeGreaterThan(0);
    expect(holding.steps).toBe(0);
    expect(holding.maxStagger).toBeLessThan(free.maxStagger);
  });

  /**
   * 支持基底面は爪先側が広く踵側が狭い。同じ大きさの加速度でも、
   * **後ろへ押される力行のほうがよろけやすい**というのは実際そのとおりで、
   * 発車のほうが揺り戻しが目立つ理由のひとつになっている。
   */
  it('後ろへ押される（力行）ほうが前へ押される（制動）よりよろけやすい', () => {
    const magnitude = 0.75;
    const braking = run(step(-magnitude), 8);
    const powering = run(step(magnitude), 8);
    expect(powering.maxStagger).toBeGreaterThan(braking.maxStagger);
  });

  /** 足を出せば支持基底面が重心の下へ移動するので、そこから立て直せる */
  it('よろけても足を出せば立て直す', () => {
    const r = run(step(-1.0), 20);
    expect(r.steps).toBeGreaterThan(0);
    const stance = r.body.state.passenger.stance;
    expect(stance.stagger).toBeLessThan(0.3);
    expect(stance.fallen).toBe(false);
    // 最後の 2 秒は落ち着いている
    const tail = r.lean.slice(-2000);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.02);
  });

  /** 曲線でも同じ。緩和曲線があれば横 G は徐々に立ち上がるのでよろけない。 */
  it('横方向でも、緩和曲線のある立ち上がりならよろけない', () => {
    const sudden = run(step(0.9), 10, DEFAULT_PASSENGER, true);
    const gradual = run(ramp(0.9, 3), 10, DEFAULT_PASSENGER, true);
    expect(sudden.maxStagger).toBeGreaterThan(gradual.maxStagger * 5);
    expect(gradual.steps).toBe(0);
    // 右へ押されるので、左（負）へよりかかる
    expect(gradual.body.state.passenger.stance.lateral.lean).toBeLessThan(0);
  });

  it('同じ入力なら同じ動きになる（決定論）', () => {
    const a = run(ramp(-0.9, 2), 6);
    const b = run(ramp(-0.9, 2), 6);
    expect(a.lean).toEqual(b.lean);
    expect(a.maxStagger).toBe(b.maxStagger);
  });
});
