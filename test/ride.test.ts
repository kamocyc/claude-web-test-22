import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Ride, cabOffset, cabPose, nearestVehicle } from '../src/app/ride';
import { roofOf } from '../src/render/vehicles';
import { draw } from '../src/app/sketch';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { buildLaneGraph, type LaneGraph, type VehicleKind } from '../src/sim/lanegraph';
import { Traffic, type Vehicle } from '../src/sim/traffic';
import { Heightfield } from '../src/terrain/heightfield';

/**
 * 乗車モード (一人称視点)。
 *
 * 目に見えるものを扱う所なので、「乗ったときにどこに目があるか」と
 * 「走っている間それが暴れないか」を数で押さえる。カメラにも DOM にも
 * 触らない素の計算なので、ブラウザなしで確かめられる。
 */

const SIZES: Record<VehicleKind, { length: number; width: number; height: number }> = {
  car: { length: 4.4, width: 1.8, height: 1.45 },
  train: { length: 18, width: 2.9, height: 3.6 },
};

/** 試験用の 1 両。`bodies[0]` だけを見るので、そこだけ埋める。 */
function vehicleAt(
  pos: Vector3,
  dir: Vector3,
  kind: VehicleKind = 'train',
  id = 1,
): Vehicle {
  return {
    id,
    kind,
    route: [0],
    head: 0,
    speed: 12,
    size: { ...SIZES[kind] },
    cars: kind === 'train' ? 3 : 1,
    color: [0.5, 0.5, 0.5],
    bodies: [{ pos: pos.clone(), dir: dir.clone().normalize() }],
  };
}

/** 交差点を解き、描画と同じトリム範囲つきの車線グラフを組み立てる。 */
function laneGraphOf(network: Network): LaneGraph {
  const { junctions, trims } = solveJunctions(network);
  const ranges = new Map<SegmentId, { s0: number; s1: number }>();
  for (const seg of network.segments.values()) {
    const trim = trims.get(seg.id)!;
    const length = network.alignmentOf(seg.id).length;
    ranges.set(seg.id, { s0: trim.a, s1: Math.max(trim.a + 0.5, length - trim.b) });
  }
  return buildLaneGraph(network, junctions, ranges);
}

/** 曲線と勾配のある 1 本の線路。 */
function railLine(): Network {
  const network = new Network();
  const field = new Heightfield();
  draw(network, field, 'rail_single', [
    { x: -400, z: -120, y: 0 },
    { x: -100, z: -120, y: 4 },
    { x: 120, z: 40, y: 9 },
    { x: 380, z: 160, y: 6 },
  ]);
  return network;
}

describe('運転台の位置', () => {
  it('目は車体の中の、床より上・先端より後ろにある', () => {
    for (const kind of ['car', 'train'] as VehicleKind[]) {
      const vehicle = vehicleAt(new Vector3(0, 10, 0), new Vector3(0, 0, 1), kind);
      const { ahead, up } = cabOffset(vehicle);
      const { length, height } = vehicle.size;
      // 前後: 車体の中で、先端より手前。
      expect(ahead).toBeGreaterThan(0);
      expect(length / 2 - ahead).toBeGreaterThan(1);
      // 前を走る車両との車間 (2.5 m) より奥に引っ込めない。詰まったときに
      // 相手の車体の中が見えてしまう。
      expect(length / 2 - ahead).toBeLessThan(2.5);
      // 上下: 足回り (車高の 18 %) より上、屋根より下。
      expect(up).toBeGreaterThan(height * 0.18);
      expect(up).toBeLessThan(height);

      const pose = cabPose(vehicle);
      expect(pose.eye.y).toBeCloseTo(10 + up, 6);
      expect(pose.eye.z).toBeCloseTo(ahead, 6);
      expect(pose.forward.z).toBeCloseTo(1, 6);
    }
  });

  it('目が自分の車体の屋根より上に出ない', () => {
    for (const kind of ['car', 'train'] as VehicleKind[]) {
      const vehicle = vehicleAt(new Vector3(0, 0, 0), new Vector3(0, 0, 1), kind);
      const { up } = cabOffset(vehicle);
      const roof = vehicle.size.height * roofOf(kind);
      // 屋根より上に出ると、自分の車体の屋根を見下ろすことになり、視界の
      // 下半分が車体色で埋まる (箱の外側の面を上から見る形になるため)。
      expect(up).toBeLessThan(roof);
      // かといって低すぎると、床の下から覗くことになる。
      expect(up).toBeGreaterThan(roof - vehicle.size.height * 0.25);
    }
  });

  it('勾配のある所では、目は線路と直角に立つ', () => {
    const grade = 0.05;
    const dir = new Vector3(0, grade, 1).normalize();
    const vehicle = vehicleAt(new Vector3(0, 0, 0), dir);
    const pose = cabPose(vehicle);
    const { ahead, up } = cabOffset(vehicle);
    // 目の位置 = 先頭車の中心 + 進行方向 * ahead + 車体の上向き * up。
    // 上向きは鉛直ではなく線路と直角なので、前後にも少し出る。
    expect(pose.eye.z).toBeCloseTo(dir.z * ahead - dir.y * up, 6);
    expect(pose.eye.y).toBeCloseTo(dir.y * ahead + dir.z * up, 6);
    // 進行方向を向いているので、視線も同じだけ上を向く。
    expect(pose.forward.y).toBeCloseTo(dir.y, 6);
    // 先頭車の中心から測った高さは、鉛直に見ると勾配のぶんだけ縮む。
    expect(pose.eye.y - ahead * dir.y).toBeCloseTo(up * dir.z, 6);
  });

  it('見回すと、車体を基準に左右・上下を向く', () => {
    const vehicle = vehicleAt(new Vector3(0, 0, 0), new Vector3(0, 0, 1));
    const right = cabPose(vehicle, { yaw: Math.PI / 2, pitch: 0 }).forward;
    expect(right.x).toBeCloseTo(1, 6);
    expect(right.z).toBeCloseTo(0, 6);
    const back = cabPose(vehicle, { yaw: Math.PI, pitch: 0 }).forward;
    expect(back.z).toBeCloseTo(-1, 6);
    const upward = cabPose(vehicle, { yaw: 0, pitch: 0.5 }).forward;
    expect(upward.y).toBeCloseTo(Math.sin(0.5), 6);
    // 真上まで回すと姿勢が定まらないので、手前で止める。
    const limit = cabPose(vehicle, { yaw: 0, pitch: 10 }).forward;
    expect(limit.y).toBeLessThan(0.95);
    // 目の位置は見回しでは動かない。
    expect(cabPose(vehicle, { yaw: 2, pitch: 1 }).eye.distanceTo(cabPose(vehicle).eye)).toBe(0);
  });

  it('横を向いた車両でも、視線が上下に転ばない', () => {
    for (let deg = 0; deg < 360; deg += 7) {
      const rad = (deg * Math.PI) / 180;
      const dir = new Vector3(Math.sin(rad), 0.03, Math.cos(rad)).normalize();
      const vehicle = vehicleAt(new Vector3(0, 0, 0), dir);
      const pose = cabPose(vehicle, { yaw: 1.2, pitch: 0 });
      // 左右を向いただけなら、上下の成分は勾配ぶんしか出ない。
      expect(Math.abs(pose.forward.y)).toBeLessThan(0.05);
      expect(pose.forward.length()).toBeCloseTo(1, 6);
    }
  });
});

describe('乗る車両の選び方', () => {
  const scene = (): Vehicle[] => [
    vehicleAt(new Vector3(0, 0, 0), new Vector3(0, 0, 1), 'train', 3),
    vehicleAt(new Vector3(50, 0, 0), new Vector3(1, 0, 0), 'car', 1),
    vehicleAt(new Vector3(200, 0, 0), new Vector3(0, 0, -1), 'car', 2),
  ];

  it('いちばん近い車両に乗る', () => {
    const vehicles = scene();
    expect(nearestVehicle(vehicles, new Vector3(45, 0, 0))?.id).toBe(1);
    const ride = new Ride();
    ride.board(vehicles, new Vector3(190, 0, 10));
    expect(ride.active).toBe(true);
    expect(ride.vehicleId).toBe(2);
    const status = ride.update(vehicles, 1 / 60)!;
    expect(status.vehicle?.id).toBe(2);
    expect(status.kind).toBe('car');
  });

  it('番号順に乗り換えて一巡する', () => {
    const vehicles = scene();
    const ride = new Ride();
    ride.board(vehicles, new Vector3(0, 0, 0));
    expect(ride.vehicleId).toBe(3);
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      ride.next(vehicles);
      seen.push(ride.vehicleId!);
    }
    expect(seen).toEqual([1, 2, 3, 1]);
  });

  it('乗っていた車両が消えたら、近くの車両に移る', () => {
    const vehicles = scene();
    const ride = new Ride();
    ride.board(vehicles, new Vector3(50, 0, 0));
    expect(ride.vehicleId).toBe(1);
    ride.update(vehicles, 1 / 60);

    // 行き止まりに着いて消えた。
    const left = vehicles.filter((v) => v.id !== 1);
    const status = ride.update(left, 1 / 60)!;
    expect(status.vehicle?.id).toBe(3);
    expect(ride.active).toBe(true);
  });

  it('1 両も走っていなければ、その場で次を待つ', () => {
    const ride = new Ride();
    const near = new Vector3(12, 34, 56);
    ride.board([], near);
    const status = ride.update([], 1 / 60)!;
    expect(status.vehicle).toBeNull();
    expect(status.kind).toBeNull();
    expect(status.speed).toBe(0);
    // 目は乗り込もうとした所に留まる (原点へ飛ばない)。
    expect(status.pose.eye.distanceTo(near)).toBe(0);

    // あとから湧いた車両に乗る。
    const vehicles = [vehicleAt(new Vector3(20, 34, 56), new Vector3(0, 0, 1), 'car', 7)];
    expect(ride.update(vehicles, 1 / 60)!.vehicle?.id).toBe(7);

    ride.leave();
    expect(ride.active).toBe(false);
    expect(ride.update(vehicles, 1 / 60)).toBeNull();
  });
});

describe('目の動きの平滑化', () => {
  /** 車両を `by` [m] だけ前へ動かす。 */
  const shift = (vehicle: Vehicle, by: number): void => {
    vehicle.bodies[0].pos.addScaledVector(vehicle.bodies[0].dir, by);
  };

  it('小さな段差は追いかけ、行き過ぎない', () => {
    const vehicle = vehicleAt(new Vector3(0, 0, 0), new Vector3(0, 0, 1));
    const ride = new Ride();
    ride.board([vehicle], new Vector3(0, 0, 0));
    const start = ride.update([vehicle], 1 / 60)!.pose.eye.clone();

    // 1 フレームで 1 m 跳ねた (踏切の舗装の段差など)。
    shift(vehicle, 1);
    const after = ride.update([vehicle], 1 / 60)!.pose.eye.clone();
    const jumped = after.distanceTo(start);
    expect(jumped).toBeGreaterThan(0.1);
    expect(jumped).toBeLessThan(0.9);

    // 追いつく。
    for (let i = 0; i < 20; i++) ride.update([vehicle], 1 / 60);
    expect(ride.update([vehicle], 1 / 60)!.pose.eye.distanceTo(cabPose(vehicle).eye)).toBeLessThan(
      0.01,
    );
  });

  it('乗り換えのような大きな飛びは、追わずにそのまま置く', () => {
    const vehicle = vehicleAt(new Vector3(0, 0, 0), new Vector3(0, 0, 1));
    const ride = new Ride();
    ride.board([vehicle], new Vector3(0, 0, 0));
    ride.update([vehicle], 1 / 60);
    shift(vehicle, 40);
    const eye = ride.update([vehicle], 1 / 60)!.pose.eye;
    expect(eye.distanceTo(cabPose(vehicle).eye)).toBeLessThan(1e-9);
  });
});

describe('走っている列車に乗る', () => {
  it('目はレールの上を、車体と一緒に進む', () => {
    const network = railLine();
    const traffic = new Traffic(laneGraphOf(network));
    const dt = 1 / 20;
    // 列車が湧くまで走らせる。
    for (let i = 0; i < 200; i++) traffic.step(dt);
    const train = traffic.vehicles.find((v) => v.kind === 'train');
    expect(train).toBeDefined();

    const ride = new Ride();
    ride.board(traffic.vehicles, train!.bodies[0].pos.clone());
    expect(ride.vehicleId).toBe(train!.id);

    let frames = 0;
    let worstHeight = 0;
    let worstLateral = 0;
    let worstStep = 0;
    let previous: Vector3 | null = null;
    let seat = ride.vehicleId;

    for (let i = 0; i < 60 / dt; i++) {
      traffic.step(dt);
      const status = ride.update(traffic.vehicles, dt);
      if (!status?.vehicle) continue;
      const eye = status.pose.eye;

      // 線路の上にいる。中心線から横に外れず、レール面の上にある。
      const hit = network.findSegmentNear(eye, 30);
      expect(hit).not.toBeNull();
      const sample = network.alignmentOf(hit!.segment).sampleAt(hit!.s);
      const lateral =
        (eye.x - sample.pos.x) * sample.right.x + (eye.z - sample.pos.z) * sample.right.z;
      worstLateral = Math.max(worstLateral, Math.abs(lateral));
      worstHeight = Math.max(worstHeight, Math.abs(eye.y - sample.pos.y - 2.2));

      // 1 フレームで進む距離は、車両の速度ぶん。跳ねたら気付く。
      if (previous && seat === ride.vehicleId) {
        worstStep = Math.max(worstStep, previous.distanceTo(eye) - status.speed * dt);
      }
      previous = eye.clone();
      seat = ride.vehicleId;
      // 視線は進行方向。勾配 (5 % まで) のぶんしか上下しない。
      expect(Math.abs(status.pose.forward.y)).toBeLessThan(0.06);
      frames++;
    }

    expect(frames).toBeGreaterThan(1000);
    // 単線の中心を走るので、横のずれは軌間の半分もない。
    expect(worstLateral).toBeLessThan(0.5);
    // 目の高さはレール面から 2.2 m ほど。勾配ぶんの縮みしか出ない。
    expect(worstHeight).toBeLessThan(0.12);
    // 平滑化の遅れがあるぶん、進む距離が速度を上回ることはない。
    expect(worstStep).toBeLessThan(0.01);
  });
});
