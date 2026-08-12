import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';

/**
 * 信号機・踏切遮断機など、動きのある小物。
 *
 * 車両シミュレーションは持たないので、これらは時間で機械的に位相が
 * 変わるだけの「見た目のための」ギミックとして動かす。
 */

const LAMP_RADIUS = 0.16;

const geometries = {
  pole: new CylinderGeometry(0.09, 0.11, 1, 8),
  arm: new BoxGeometry(1, 0.12, 0.12),
  head: new BoxGeometry(1.05, 0.36, 0.26),
  headVertical: new BoxGeometry(0.36, 1.05, 0.26),
  lamp: new SphereGeometry(LAMP_RADIUS, 10, 8),
  boom: new BoxGeometry(1, 0.14, 0.1),
  panel: new BoxGeometry(0.9, 0.9, 0.08),
  box: new BoxGeometry(1, 1, 1),
};

function mat(color: number, emissive = 0x000000, emissiveIntensity = 0): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity,
    roughness: 0.7,
    metalness: 0.1,
  });
}

const materials = {
  pole: mat(0x4a4f52),
  housing: mat(0x2c3033),
  dark: mat(0x15181a),
  red: mat(0xd8342a, 0xd8342a, 1.4),
  yellow: mat(0xe8c135, 0xe8c135, 1.4),
  green: mat(0x2fbf6a, 0x2fbf6a, 1.4),
  boomWhite: mat(0xe8e6e0),
  boomRed: mat(0xc8342a),
  signRed: mat(0xc8342a),
  signWhite: mat(0xe8e6e0),
  concrete: mat(0x9a9894),
};

/** 交通信号の 1 面 (3 灯)。 */
interface SignalFace {
  lamps: [Mesh, Mesh, Mesh];
}

export interface SignalAssembly {
  object: Object3D;
  /** 同時に青になるグループ番号。 */
  phase: number;
  faces: SignalFace[];
}

export interface CrossingGate {
  object: Object3D;
  /** 遮断桿の回転軸となるピボット。 */
  pivot: Object3D;
  lamps: [Mesh, Mesh];
}

/** ワールド上の位置と向きから、Y-up の基準姿勢を作る。 */
function orient(object: Object3D, position: Vector3, forward: Vector3): void {
  object.position.copy(position);
  const dir = forward.clone().setY(0);
  if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
  dir.normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), dir);
  object.quaternion.copy(q);
}

/**
 * 車両用信号機を作る。支柱を路側に立て、アームを車道の上へ張り出す。
 *
 * `facing` は「この信号が向く方向」= 停止線側から交差点を見る向きの逆。
 */
export function createSignal(params: {
  base: Vector3;
  /** 交差点から外向き (= 信号が向く方向)。 */
  facing: Vector3;
  /** 車道側 (アームを伸ばす向き)。 */
  inward: Vector3;
  armLength: number;
  phase: number;
}): SignalAssembly {
  const group = new Group();
  orient(group, params.base, params.facing);

  const poleHeight = 5.4;
  const pole = new Mesh(geometries.pole, materials.pole);
  pole.scale.set(1, poleHeight, 1);
  pole.position.set(0, poleHeight / 2, 0);
  group.add(pole);

  // アームはローカル X 方向に伸ばす。inward が -X 側か +X 側かで符号を決める。
  const localRight = new Vector3(1, 0, 0).applyQuaternion(group.quaternion);
  const sign = localRight.dot(params.inward) >= 0 ? 1 : -1;
  const armLength = Math.max(1.5, params.armLength);

  const arm = new Mesh(geometries.arm, materials.pole);
  arm.scale.set(armLength, 1, 1);
  arm.position.set((sign * armLength) / 2, poleHeight - 0.3, 0);
  group.add(arm);

  const faces: SignalFace[] = [];
  const headX = sign * armLength * 0.78;
  const head = new Mesh(geometries.head, materials.housing);
  head.position.set(headX, poleHeight - 0.75, 0);
  group.add(head);

  const lamps: Mesh[] = [];
  // 日本の車両用信号は左から 青・黄・赤。
  for (let i = 0; i < 3; i++) {
    const lamp = new Mesh(geometries.lamp, materials.dark);
    lamp.position.set(headX - 0.33 + i * 0.33, poleHeight - 0.75, 0.16);
    group.add(lamp);
    lamps.push(lamp);
  }
  faces.push({ lamps: [lamps[0], lamps[1], lamps[2]] });

  // 歩行者用の小さな信号を支柱に付ける。
  const pedHead = new Mesh(geometries.headVertical, materials.housing);
  pedHead.position.set(0, 3.0, 0.22);
  pedHead.scale.set(0.75, 0.62, 1);
  group.add(pedHead);

  return { object: group, phase: params.phase, faces };
}

/** 信号の灯火を位相に応じて更新する。`state` は 0=青, 1=黄, 2=赤。 */
export function setSignalState(assembly: SignalAssembly, state: 0 | 1 | 2): void {
  const on = [materials.green, materials.yellow, materials.red];
  for (const face of assembly.faces) {
    for (let i = 0; i < 3; i++) {
      face.lamps[i].material = i === state ? on[i] : materials.dark;
    }
  }
}

/** 一時停止・徐行の標識 (信号のない交差点に置く)。 */
export function createStopSign(position: Vector3, facing: Vector3): Object3D {
  const group = new Group();
  orient(group, position, facing);
  const height = 2.2;
  const pole = new Mesh(geometries.pole, materials.pole);
  pole.scale.set(0.55, height, 0.55);
  pole.position.set(0, height / 2, 0);
  group.add(pole);
  const panel = new Mesh(geometries.panel, materials.signRed);
  panel.position.set(0, height + 0.35, 0.05);
  panel.rotation.z = Math.PI / 4;
  group.add(panel);
  return group;
}

/**
 * 踏切の遮断機。支柱と、上下する遮断桿からなる。
 * `across` は道路を横切る方向で、遮断桿はこの向きに伸びる。
 */
export function createCrossingGate(params: {
  base: Vector3;
  /** 遮断桿が伸びる方向 (道路を横切る向き)。 */
  across: Vector3;
  /** 遮断桿の長さ [m]。 */
  length: number;
  /** 線路の方を向く向き (警報灯の向き)。 */
  facing: Vector3;
}): CrossingGate {
  const group = new Group();
  orient(group, params.base, params.facing);

  const poleHeight = 2.6;
  const pole = new Mesh(geometries.pole, materials.pole);
  pole.scale.set(1.1, poleHeight, 1.1);
  pole.position.set(0, poleHeight / 2, 0);
  group.add(pole);

  // 警報灯 (赤 2 灯) と踏切警標。
  const lamps: Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const lamp = new Mesh(geometries.lamp, materials.dark);
    lamp.scale.setScalar(1.15);
    lamp.position.set(-0.32 + i * 0.64, poleHeight + 0.35, 0.1);
    group.add(lamp);
    lamps.push(lamp);
  }
  const cross = new Mesh(geometries.panel, materials.signWhite);
  cross.position.set(0, poleHeight + 1.1, 0);
  cross.rotation.z = Math.PI / 4;
  cross.scale.setScalar(0.8);
  group.add(cross);

  // 遮断桿。ピボットのローカル X 方向に伸ばし、Z 軸まわりに回して上げ下げする。
  const pivot = new Object3D();
  pivot.position.set(0, poleHeight * 0.62, 0);
  const localRight = new Vector3(1, 0, 0).applyQuaternion(group.quaternion);
  const sign = localRight.dot(params.across) >= 0 ? 1 : -1;
  pivot.rotation.y = sign > 0 ? 0 : Math.PI;
  group.add(pivot);

  const boom = new Mesh(geometries.boom, materials.boomWhite);
  boom.scale.set(params.length, 1, 1);
  boom.position.set(params.length / 2, 0, 0);
  pivot.add(boom);
  for (let i = 0; i < 3; i++) {
    const band = new Mesh(geometries.box, materials.boomRed);
    band.scale.set(params.length / 7, 0.16, 0.12);
    band.position.set(params.length * (0.18 + i * 0.28), 0, 0);
    pivot.add(band);
  }

  return { object: group, pivot, lamps: [lamps[0], lamps[1]] };
}

/** 遮断機の状態を更新する。`closed` は 0 (開) 〜 1 (閉)。 */
export function setGateState(gate: CrossingGate, closed: number, blinkPhase: boolean): void {
  gate.pivot.rotation.z = (1 - closed) * (Math.PI / 2);
  const active = closed > 0.02;
  gate.lamps[0].material = active && blinkPhase ? materials.red : materials.dark;
  gate.lamps[1].material = active && !blinkPhase ? materials.red : materials.dark;
}

/** 交差点や踏切の位置を示すデバッグ用の目印。 */
export function createMarker(position: Vector3, color: number, size = 1.2): Object3D {
  const mesh = new Mesh(geometries.box, mat(color, color, 0.8));
  mesh.scale.setScalar(size);
  mesh.position.copy(position).add(new Vector3(0, size, 0));
  return mesh;
}

export function disposeSharedProps(): void {
  for (const g of Object.values(geometries)) g.dispose();
  for (const m of Object.values(materials)) m.dispose();
}
