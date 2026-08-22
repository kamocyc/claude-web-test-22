import { Quaternion, Vector3 } from 'three';
import { clamp } from '../core/units';
import { bodyQuaternion, roofOf } from '../render/vehicles';
import type { VehicleKind } from '../sim/lanegraph';
import type { BodyPose, Vehicle } from '../sim/traffic';

/**
 * 乗車モード (一人称視点)。
 *
 * 走っている列車・自動車をクリックで 1 両選び、その運転台に目を置きます。敷いた線形が
 * 実際にどう見えるか — 緩和曲線の入り方、勾配の変わり目、トンネルの坑口、
 * 分岐器の渡り — は、上から見ているだけでは分からないので、乗って確かめる
 * ための視点です。
 *
 * ここは DOM にもカメラにも触りません。「目の位置と向き」を返すだけの素の
 * 計算なので、ブラウザなしで確かめられます。カメラへの反映は `Viewport`、
 * キー・マウスの割り当ては `main.ts` が持ちます。
 */

/** 見回しの向き。車体を基準にした左右 (yaw) と上下 (pitch) [rad]。 */
export interface LookAngles {
  yaw: number;
  pitch: number;
}

/** 一人称視点のカメラの置き所。 */
export interface RidePose {
  /** 目の位置。 */
  eye: Vector3;
  /** 見ている向き (単位ベクトル)。 */
  forward: Vector3;
  /**
   * 頭の上の向き (単位ベクトル)。
   *
   * カントの付いた曲線では車体ごと傾くので、鉛直ではない。車体と同じだけ
   * 傾けないと、窓の外だけが傾いて見える。
   */
  up: Vector3;
}

/** 乗車まわりの状態。表示用。 */
export interface RideStatus {
  /** 車両を選んでいる最中か、乗っているか。 */
  phase: 'aim' | 'ride';
  pose: RidePose;
  /**
   * 乗っている車両。選択中なら、いま指している車両。
   * まだ見つかっていなければ `null` (待機中・指していない)。
   */
  vehicle: Vehicle | null;
  kind: VehicleKind | null;
  /** 速度 [m/s]。 */
  speed: number;
  /** 両数。 */
  cars: number;
  /** 見回している向き (車体基準)。 */
  look: LookAngles;
}

/** 見回しの上下の限界 [rad]。真上・真下まで回すと姿勢が定まらない。 */
const MAX_PITCH = 1.15;
/** 向きの平滑化の時定数 [s]。 */
const DIR_TAU = 0.12;
/** 目の位置の平滑化の時定数 [s]。 */
const EYE_TAU = 0.05;
/** これ以上離れていたら、平滑化せずに飛ぶ [m] (乗り換え・湧き直し)。 */
const SNAP_DISTANCE = 5;

/**
 * 目の高さ (車高に対する割合)。
 *
 * 屋根 (`roofOf`) より下でなければならない。上に出ると、自分の車体の屋根を
 * 見下ろすことになり、視界の下半分が車体色で埋まる。車の車体は 1.45 m しか
 * ないので、実物の着座位置の割合 (0.78) では屋根の上に出てしまう。
 */
const EYE_HEIGHT: Record<VehicleKind, number> = { car: 0.6, train: 0.62 };

/**
 * 運転台の位置。先頭車の中心から前へ `ahead` [m]、路面から上へ `up` [m]。
 *
 * 先端ぎりぎりに置かないのは、前を走る車両との車間 (`MIN_GAP` = 2.5 m) より
 * 目が前に出ると、詰まったときに相手の車体の中が見えてしまうため。
 */
export function cabOffset(vehicle: Vehicle): { ahead: number; up: number } {
  const { length, height } = vehicle.size;
  const setback = vehicle.kind === 'train' ? 1.6 : 1.2;
  return {
    ahead: Math.max(0, length / 2 - setback),
    // 屋根のすぐ下まで。比率を上げても、屋根から出ることはない。
    up: height * Math.min(EYE_HEIGHT[vehicle.kind], roofOf(vehicle.kind) - 0.04),
  };
}

/**
 * その車両の運転台から見た、目の位置と向き。
 *
 * 上下方向は車体基準 (勾配のある所では線路と直角) に取る。カントでは傾け
 * ない — 車体の描画自体がカントで傾かないので、目だけ傾けると窓の外と
 * 合わなくなる。
 */
export function cabPose(vehicle: Vehicle, look: LookAngles = { yaw: 0, pitch: 0 }): RidePose {
  const body = vehicle.bodies[0];
  const dir =
    body && body.dir.lengthSq() > 1e-8 ? body.dir.clone().normalize() : new Vector3(0, 0, 1);
  // 車体と同じ姿勢 (カントで傾いた基底) の上に運転台を置く。
  const basis = bodyQuaternion(dir, body?.roll ?? 0);
  const { ahead, up } = cabOffset(vehicle);
  const head = new Vector3(0, 1, 0).applyQuaternion(basis);
  const eye = (body ? body.pos.clone() : new Vector3())
    .addScaledVector(dir, ahead)
    .addScaledVector(head, up);

  const pitch = clamp(look.pitch, -MAX_PITCH, MAX_PITCH);
  const cp = Math.cos(pitch);
  const forward = new Vector3(cp * Math.sin(look.yaw), Math.sin(pitch), cp * Math.cos(look.yaw))
    .applyQuaternion(basis)
    .normalize();
  return { eye, forward, up: head };
}

/** 画面から伸ばすレイ (ワールド座標)。`Viewport.ray()` が作る。 */
export interface PickRay {
  origin: Vector3;
  direction: Vector3;
}

/**
 * 当たり判定を車体より少し広く取る余裕 [m]。
 *
 * 車は幅 1.8 m・高さ 1.45 m しかない。遠くから見下ろしていると画面上では
 * 数ピクセルなので、輪郭ちょうどで判定すると掴めない。
 */
const PICK_MARGIN = 0.35;

const PICK_ROTATION = new Quaternion();

/**
 * レイと 1 両の当たり判定。当たったらレイ上の距離、外れたら `null`。
 *
 * 車体は「路面に接する箱」なので、姿勢の逆回転でレイを車体座標へ移してから
 * 軸に沿った箱として調べる。箱の原点は路面 (`pose.pos`) で、上へ `height`、
 * 左右へ `width/2`、前後へ `length/2` 伸びている (描画と同じ)。
 */
export function hitBody(
  ray: PickRay,
  pose: BodyPose,
  size: { length: number; width: number; height: number },
): number | null {
  const inverse = bodyQuaternion(pose.dir, pose.roll, PICK_ROTATION).invert();
  const origin = ray.origin.clone().sub(pose.pos).applyQuaternion(inverse);
  const dir = ray.direction.clone().applyQuaternion(inverse);
  const half = [
    size.width / 2 + PICK_MARGIN,
    size.height / 2 + PICK_MARGIN,
    size.length / 2 + PICK_MARGIN,
  ];
  // 高さだけ原点が下端にあるので、中心をずらす。
  const centre = [0, size.height / 2, 0];
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];

  let near = 0;
  let far = Infinity;
  for (let i = 0; i < 3; i++) {
    const lo = centre[i] - half[i];
    const hi = centre[i] + half[i];
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo || o[i] > hi) return null;
      continue;
    }
    const t0 = (lo - o[i]) / d[i];
    const t1 = (hi - o[i]) / d[i];
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
    if (near > far) return null;
  }
  return far >= near ? near : null;
}

/**
 * クリックで乗る車両を決める。
 *
 * まずレイの当たった車両 (手前から)。当たらなければ、指した地点にいちばん
 * 近い車両を返す。**外しても必ず何かに乗れる**ようにしてあるのは、車両は
 * 走っているので、押した瞬間には指していた車両が動いているため。
 */
export function pickVehicle(
  vehicles: readonly Vehicle[],
  ray: PickRay | null,
  ground: Vector3 | null,
): Vehicle | null {
  let best: Vehicle | null = null;
  let nearest = Infinity;
  if (ray) {
    for (const vehicle of vehicles) {
      for (const body of vehicle.bodies) {
        const t = hitBody(ray, body, vehicle.size);
        if (t === null || t >= nearest) continue;
        nearest = t;
        best = vehicle;
      }
    }
  }
  if (best) return best;
  return ground ? nearestVehicle(vehicles, ground) : null;
}

/** その点にいちばん近い車両。1 両も走っていなければ `null`。 */
export function nearestVehicle(vehicles: readonly Vehicle[], near: Vector3): Vehicle | null {
  let best: Vehicle | null = null;
  let bestDistance = Infinity;
  for (const vehicle of vehicles) {
    const body = vehicle.bodies[0];
    if (!body) continue;
    const distance = body.pos.distanceToSquared(near);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = vehicle;
    }
  }
  return best;
}

/**
 * 乗車モードの状態。
 *
 * 「選ぶ (`aim`) → 乗る (`boardTarget`) → 降りる (`leave`)」の 3 段。選ぶ間は
 * 俯瞰のままで、指した車両を呼び出し側が光らせる。
 *
 * 車両は行き止まりに着くと消え、敷き直すと全部湧き直す。乗っていた車両が
 * 消えるたびに視点を放り出されると使いものにならないので、**近くの車両へ
 * 乗り移る**。1 両も走っていない間 (敷き直した直後など) は、その場に留まって
 * 次の車両を待つ。
 */
export class Ride {
  /** 乗車モードに入っているか (一人称視点)。 */
  active = false;
  /** 乗る車両を選んでいる最中か。俯瞰のまま、指した車両を強調する。 */
  aiming = false;
  private id: number | null = null;
  /** 選択中に指している車両の番号。 */
  private target: number | null = null;
  private readonly look: LookAngles = { yaw: 0, pitch: 0 };
  private readonly eye = new Vector3();
  private readonly forward = new Vector3(0, 0, 1);
  private readonly up = new Vector3(0, 1, 0);
  /** いちど車両に乗ったか。乗る前・乗り換えた直後は平滑化しない。 */
  private seated = false;

  /** いま乗っている車両の番号。 */
  get vehicleId(): number | null {
    return this.id;
  }

  /** 選択中に指している車両の番号。 */
  get targetId(): number | null {
    return this.target;
  }

  /**
   * 乗る車両を選ぶ状態に入る。
   *
   * すぐ乗せずに一段挟むのは、走っている車両のどれに乗るかを**見て**選べる
   * ようにするため。乗ってしまうと外から車両を見られない。
   */
  aim(): void {
    this.active = false;
    this.aiming = true;
    this.target = null;
  }

  /**
   * 選択中の指し先を更新し、乗ることになる車両を返す。
   *
   * 車両は動くので、指した先に何も無ければ**その地点にいちばん近い車両**を
   * 選ぶ。線路や道路をクリックすれば、そこを走っている車両に乗れる。
   */
  hover(vehicles: readonly Vehicle[], ray: PickRay | null, ground: Vector3 | null): Vehicle | null {
    if (!this.aiming) return null;
    const found = pickVehicle(vehicles, ray, ground);
    this.target = found?.id ?? null;
    return found;
  }

  /** 選択中に指していた車両に乗り込む。乗れたら `true`。 */
  boardTarget(vehicles: readonly Vehicle[]): boolean {
    if (!this.aiming) return false;
    const vehicle = vehicles.find((v) => v.id === this.target);
    if (!vehicle) return false;
    this.aiming = false;
    this.active = true;
    this.target = null;
    const body = vehicle.bodies[0];
    if (body) this.eye.copy(body.pos);
    this.reseat(vehicle);
    return true;
  }

  /** `near` にいちばん近い車両に乗り込む。 */
  board(vehicles: readonly Vehicle[], near: Vector3): void {
    this.active = true;
    this.aiming = false;
    this.target = null;
    this.eye.copy(near);
    this.reseat(nearestVehicle(vehicles, near));
  }

  /** 次の車両に乗り換える。番号順に回るので、押し続ければ一巡する。 */
  next(vehicles: readonly Vehicle[]): void {
    if (!this.active || vehicles.length === 0) return;
    const order = [...vehicles].sort((a, b) => a.id - b.id);
    const index = order.findIndex((v) => v.id === this.id);
    this.reseat(order[(index + 1) % order.length]);
  }

  /** 降りる (選択中なら、選ぶのをやめる)。 */
  leave(): void {
    this.active = false;
    this.aiming = false;
    this.id = null;
    this.target = null;
    this.seated = false;
  }

  /** 見回す (車体を基準にした相対角 [rad])。 */
  turn(yaw: number, pitch: number): void {
    this.look.yaw = wrapAngle(this.look.yaw + yaw);
    this.look.pitch = clamp(this.look.pitch + pitch, -MAX_PITCH, MAX_PITCH);
  }

  /** 見回しを正面に戻す。 */
  faceForward(): void {
    this.look.yaw = 0;
    this.look.pitch = 0;
  }

  /**
   * 目の位置を `dt` [s] ぶん進める。乗車モードでなければ `null`。
   *
   * 車線どうしの継ぎ目や踏切の舗装の段差で目が跳ねないよう、位置と向きを
   * 短い時定数で追わせる。乗り換えのように大きく飛ぶときは、追わずに飛ぶ。
   */
  update(vehicles: readonly Vehicle[], dt: number): RideStatus | null {
    if (this.aiming) {
      const target = vehicles.find((v) => v.id === this.target) ?? null;
      return {
        phase: 'aim',
        pose: { eye: this.eye.clone(), forward: this.forward.clone(), up: this.up.clone() },
        vehicle: target,
        kind: target?.kind ?? null,
        speed: target?.speed ?? 0,
        cars: target?.cars ?? 0,
        look: { ...this.look },
      };
    }
    if (!this.active) return null;

    let vehicle = vehicles.find((v) => v.id === this.id) ?? null;
    if (!vehicle) {
      // 乗っていた車両が消えた (行き止まり・敷き直し)。近くの車両に移る。
      vehicle = nearestVehicle(vehicles, this.eye);
      this.reseat(vehicle, true);
    }
    if (!vehicle) {
      return {
        phase: 'ride',
        pose: { eye: this.eye.clone(), forward: this.forward.clone(), up: this.up.clone() },
        vehicle: null,
        kind: null,
        speed: 0,
        cars: 0,
        look: { ...this.look },
      };
    }

    const target = cabPose(vehicle, this.look);
    if (!this.seated || this.eye.distanceTo(target.eye) > SNAP_DISTANCE) {
      this.eye.copy(target.eye);
      this.forward.copy(target.forward);
      this.up.copy(target.up);
      this.seated = true;
    } else {
      const step = clamp(dt, 0, 0.1);
      this.eye.lerp(target.eye, blend(step, EYE_TAU));
      this.forward.lerp(target.forward, blend(step, DIR_TAU));
      if (this.forward.lengthSq() < 1e-8) this.forward.copy(target.forward);
      this.forward.normalize();
      this.up.lerp(target.up, blend(step, DIR_TAU));
      if (this.up.lengthSq() < 1e-8) this.up.copy(target.up);
      this.up.normalize();
    }

    return {
      phase: 'ride',
      pose: { eye: this.eye.clone(), forward: this.forward.clone(), up: this.up.clone() },
      vehicle,
      kind: vehicle.kind,
      speed: vehicle.speed,
      cars: vehicle.cars,
      look: { ...this.look },
    };
  }

  /** 乗る車両を決める。乗り換えたら見回しは正面に戻す。 */
  private reseat(vehicle: Vehicle | null, keepLook = false): void {
    this.id = vehicle?.id ?? null;
    this.seated = false;
    if (!keepLook) this.faceForward();
  }
}

/** 時定数 `tau` [s] の指数追従で、1 フレームぶんの混ぜ率。 */
function blend(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}

/** 角度を (-π, π] に畳む。 */
function wrapAngle(angle: number): number {
  const turn = Math.PI * 2;
  const wrapped = ((angle + Math.PI) % turn + turn) % turn;
  return wrapped - Math.PI;
}
