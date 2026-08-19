import {
  BoxGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { RGB } from '../build/surface';
import type { Vehicle } from '../sim/traffic';

/**
 * 走行中の車両の描画。
 *
 * 車両は毎フレーム位置が変わるだけなので、メッシュは使い回す。1 両ぶんの
 * 箱を必要な数だけ用意しておき、シミュレーションの姿勢を写す。
 */

const BODY = new BoxGeometry(1, 1, 1);
const FORWARD = new Vector3(0, 0, 1);
const UP = new Vector3(0, 1, 0);
/** 姿勢を組み立てるための使い回しの行列。 */
const BASIS = new Matrix4();

const glass = new MeshStandardMaterial({ color: 0x1b2228, roughness: 0.25, metalness: 0.4 });
const tyre = new MeshStandardMaterial({ color: 0x15171a, roughness: 0.9 });

/** 車体色ごとのマテリアルを使い回す。 */
const paints = new Map<string, MeshStandardMaterial>();

function paintFor(color: RGB): MeshStandardMaterial {
  const key = color.join(',');
  const found = paints.get(key);
  if (found) return found;
  const material = new MeshStandardMaterial({
    color: new Color(color[0], color[1], color[2]),
    roughness: 0.45,
    metalness: 0.25,
  });
  paints.set(key, material);
  return material;
}

/** 1 両ぶんの箱。車体・窓・足回りの 3 枚で構成する。 */
interface Body {
  object: Group;
  shell: Mesh;
  cabin: Mesh;
  skirt: Mesh;
}

function createBody(): Body {
  const object = new Group();
  const shell = new Mesh(BODY, glass);
  const cabin = new Mesh(BODY, glass);
  const skirt = new Mesh(BODY, tyre);
  shell.castShadow = true;
  cabin.castShadow = true;
  object.add(skirt, shell, cabin);
  return { object, shell, cabin, skirt };
}

export class VehicleView {
  readonly group = new Group();
  private readonly pool: Body[] = [];

  constructor() {
    this.group.name = 'vehicles';
  }

  /** シミュレーションの状態を写す。 */
  sync(vehicles: readonly Vehicle[]): void {
    let used = 0;
    for (const vehicle of vehicles) {
      const paint = paintFor(vehicle.color);
      for (const pose of vehicle.bodies) {
        const body = this.bodyAt(used++);
        place(body, vehicle, pose.pos, pose.dir, paint);
      }
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].object.visible = false;
  }

  private bodyAt(index: number): Body {
    while (this.pool.length <= index) {
      const body = createBody();
      this.pool.push(body);
      this.group.add(body.object);
    }
    const body = this.pool[index];
    body.object.visible = true;
    return body;
  }

  /** 車両を隠す (シミュレーションを止めたとき)。 */
  clear(): void {
    for (const body of this.pool) body.object.visible = false;
  }

  dispose(): void {
    this.group.clear();
    this.pool.length = 0;
  }
}

/** 1 両を配置する。車体の寸法は種別ごとの箱の比率で決める。 */
function place(
  body: Body,
  vehicle: Vehicle,
  pos: Vector3,
  dir: Vector3,
  paint: MeshStandardMaterial,
): void {
  orient(body.object, pos, dir);
  const { length, width, height } = vehicle.size;
  const train = vehicle.kind === 'train';

  // 足回り。路面に接する暗い箱で、車体が浮いて見えないようにする。
  body.skirt.material = tyre;
  body.skirt.scale.set(width * 0.9, height * 0.18, length * 0.94);
  body.skirt.position.set(0, height * 0.09, 0);

  // 車体。
  body.shell.material = paint;
  const shellHeight = train ? height * 0.62 : height * 0.5;
  body.shell.scale.set(width, shellHeight, length * (train ? 0.99 : 0.96));
  body.shell.position.set(0, height * 0.18 + shellHeight / 2, 0);

  // 窓まわり。車は一段細く短い箱、列車は帯状にする。
  body.cabin.material = glass;
  if (train) {
    body.cabin.scale.set(width * 1.005, height * 0.22, length * 0.86);
    body.cabin.position.set(0, height * 0.72, 0);
  } else {
    body.cabin.scale.set(width * 0.88, height * 0.34, length * 0.46);
    body.cabin.position.set(0, height * 0.72, -length * 0.04);
  }
}

/**
 * 進行方向から車体の姿勢を作る。勾配のある所では前後に傾く。
 *
 * 「+Z から進行方向への最短回転」で作ってはいけない。ほぼ -Z へ進むとき
 * (向きが真後ろ) は回転軸が定まらず、勾配のわずかな上下成分だけで軸が X 側
 * へ倒れて、車体が**上下反転**することがある。上向きを固定した基底から
 * 作れば、どの向き・どの勾配でも屋根が上を向く。
 */
export function bodyQuaternion(dir: Vector3, target = new Quaternion()): Quaternion {
  const forward = dir.lengthSq() < 1e-8 ? FORWARD.clone() : dir.clone().normalize();
  const right = new Vector3().crossVectors(UP, forward);
  if (right.lengthSq() < 1e-10) {
    // 真上・真下を向いている (ふつうの勾配では起きない)。
    right.crossVectors(FORWARD, forward);
    if (right.lengthSq() < 1e-10) right.set(1, 0, 0);
  }
  right.normalize();
  const up = new Vector3().crossVectors(forward, right).normalize();
  return target.setFromRotationMatrix(BASIS.makeBasis(right, up, forward));
}

/** 位置と進行方向から姿勢を決める。 */
function orient(object: Object3D, pos: Vector3, dir: Vector3): void {
  object.position.copy(pos);
  bodyQuaternion(dir, object.quaternion);
}
