import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { Alignment } from '../src/core/alignment';
import { HorizontalCurve } from '../src/core/curve';
import { MeshBuilder } from '../src/core/meshbuilder';
import { buildTurnArrows } from '../src/build/markings';
import { NETWORK_CLASSES, getClass } from '../src/network/classes';
import { solveJunctions } from '../src/network/junction';
import { allocateMovements, movementBetween, solveApproachLanes } from '../src/network/lanes';
import { Network } from '../src/network/network';

/** 中心ノードから放射状に伸びるセグメントを作る。 */
function star(
  classIds: string[],
  angles: number[],
  length = 160,
): { network: Network; center: number } {
  const network = new Network();
  const center = network.addNode(new Vector3(0, 0, 0));
  angles.forEach((angle, i) => {
    const dir = new Vector2(Math.cos(angle), Math.sin(angle));
    const end = network.addNode(new Vector3(dir.x * length, 0, dir.y * length));
    network.addSegment({
      classId: classIds[i % classIds.length],
      a: center.id,
      b: end.id,
      ctrlA: new Vector2(dir.x * (length / 3), dir.y * (length / 3)),
      ctrlB: new Vector2(dir.x * ((length * 2) / 3), dir.y * ((length * 2) / 3)),
      gradeA: 0,
      gradeB: 0,
    });
  });
  return { network, center: center.id };
}

/** 指定した方位に伸びる枝の車線割り当てを取り出す。 */
function assignmentAt(classIds: string[], angles: number[], at = 0) {
  const { network, center } = star(classIds, angles);
  const junction = solveJunctions(network).junctions.get(center)!;
  const lanes = solveApproachLanes(junction);
  const want = new Vector2(Math.cos(at), Math.sin(at));
  const approach = junction.approaches.reduce((best, a) =>
    a.dir.dot(want) > best.dir.dot(want) ? a : best,
  );
  return { junction, lanes: lanes.get(approach.branch.segment)!, approach };
}

describe('車線', () => {
  it('左側通行では、線形の向きに走る車線が中心線より左にある', () => {
    for (const cls of NETWORK_CLASSES) {
      if (cls.kind !== 'road' || cls.oneWay) continue;
      for (const lane of cls.lanes) {
        expect(Math.sign(lane.offset)).toBe(lane.direction === 1 ? -1 : 1);
      }
    }
  });

  it('一方通行の種別は、全ての車線が線形の向きに走る', () => {
    const ramp = getClass('road_ramp');
    expect(ramp.oneWay).toBe(true);
    expect(ramp.lanes.every((l) => l.direction === 1)).toBe(true);
    // 車線は舗装の中に収まっている。
    for (const lane of ramp.lanes) {
      expect(Math.abs(lane.offset) + lane.width / 2).toBeLessThanOrEqual(ramp.halfWidth);
    }
  });

  it('進路の判定は左側通行の向き (右へ曲がれば右折)', () => {
    const east = new Vector2(1, 0);
    // XZ 平面では +Z が進行方向の右手。
    expect(movementBetween(east, new Vector2(0, 1))).toBe('right');
    expect(movementBetween(east, new Vector2(0, -1))).toBe('left');
    expect(movementBetween(east, new Vector2(1, 0))).toBe('through');
    expect(movementBetween(east, new Vector2(-1, 0))).toBe('uturn');
  });

  it('4 車線の十字路では、歩道側の車線が左折、中央側の車線が右折になる', () => {
    const { lanes } = assignmentAt(['road_medium'], [0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    expect(lanes.entry).toHaveLength(2);
    expect(lanes.entry[0].movements).toContain('left');
    expect(lanes.entry[0].movements).toContain('through');
    expect(lanes.entry[1].movements).toEqual(['right']);
    // 歩道側の車線のほうが中心線から遠い。
    expect(Math.abs(lanes.entry[0].lane.offset)).toBeGreaterThan(
      Math.abs(lanes.entry[1].lane.offset),
    );
  });

  it('6 車線あれば、左折・直進・右折に 1 本ずつ割り当てる', () => {
    const { lanes } = assignmentAt(['road_large'], [0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    expect(lanes.entry.map((e) => e.movements)).toEqual([['left'], ['through'], ['right']]);
  });

  it('突き当たりの T 字では、直進のない割り当てになる', () => {
    // 東の枝から来ると、北と南へしか行けない。
    const { lanes } = assignmentAt(['road_medium'], [0, Math.PI / 2, -Math.PI / 2]);
    const movements = lanes.entry.flatMap((e) => e.movements);
    expect(movements).toContain('left');
    expect(movements).toContain('right');
    expect(movements).not.toContain('through');
  });

  it('車線が足りなければ進路をまとめ、余れば直進に配る', () => {
    const all = ['left', 'through', 'right'] as const;
    expect(allocateMovements(1, [...all])).toEqual([['left', 'through', 'right']]);
    expect(allocateMovements(2, [...all])).toEqual([['left', 'through'], ['right']]);
    expect(allocateMovements(3, [...all])).toEqual([['left'], ['through'], ['right']]);
    expect(allocateMovements(4, [...all])).toEqual([
      ['left'],
      ['through'],
      ['through'],
      ['right'],
    ]);
    // 直進のない突き当たりでは左右に均等に配る。
    expect(allocateMovements(3, ['left', 'right'])).toEqual([['left'], ['left'], ['right']]);
  });

  it('中央分離帯のある道路では右折の進路を作らない', () => {
    const highway = getClass('road_highway');
    expect(highway.divided).toBe(true);
    // 自動車専用道の十字路 (ランプが両側に付いた形)。
    const { lanes } = assignmentAt(
      ['road_highway', 'road_ramp', 'road_highway', 'road_ramp'],
      [0, Math.PI / 2, Math.PI, -Math.PI / 2],
    );
    expect(lanes.exits.some((e) => e.movement === 'right')).toBe(false);
    expect(lanes.exits.some((e) => e.movement === 'left')).toBe(true);
  });

  it('一方通行の出口側からは、その道路へ進入できない', () => {
    const { network, center } = star(['road_medium', 'road_ramp', 'road_medium'], [
      0,
      Math.PI / 2,
      Math.PI,
    ]);
    const junction = solveJunctions(network).junctions.get(center)!;
    const lanes = solveApproachLanes(junction);
    const ramp = junction.approaches.find((a) => a.branch.cls.id === 'road_ramp')!;
    // ランプは中心から外向きに引いたので、中心へ入ってくる車線がない。
    for (const [segment, assignment] of lanes) {
      if (segment === ramp.branch.segment) {
        expect(assignment.entry).toHaveLength(0);
        continue;
      }
      // 他の枝から見ると、ランプは行き先として使える。
      expect(assignment.exits.some((e) => e.approach === ramp)).toBe(true);
    }
  });
});

describe('進行方向矢印', () => {
  /** 直線の道路 1 本を、交差点の枝に見立てた座標系。 */
  function frameOf(classId: string, length = 120) {
    const cls = getClass(classId);
    const curve = HorizontalCurve.straight(new Vector2(0, 0), new Vector2(length, 0));
    const alignment = Alignment.create(curve, 0, 0);
    return { alignment, atStart: true, length, trim: 8, cls };
  }

  it('矢印は車道の中に収まる (縁石や歩道にはみ出さない)', () => {
    for (const classId of ['road_small', 'road_medium', 'road_large']) {
      const frame = frameOf(classId);
      const cls = getClass(classId);
      const mb = new MeshBuilder();
      const entry = cls.lanes
        .filter((l) => l.direction === -1)
        .map((l) => ({
          offset: l.offset,
          width: l.width,
          movements: ['left', 'through', 'right'] as const,
        }));
      buildTurnArrows(mb, frame, [...entry]);
      const geometry = mb.build();
      const position = geometry.getAttribute('position');
      expect(position.count).toBeGreaterThan(0);
      for (let i = 0; i < position.count; i++) {
        // 枝は +X 方向なので、横距はそのまま Z。
        expect(Math.abs(position.getZ(i))).toBeLessThanOrEqual(cls.carriagewayHalfWidth);
      }
    }
  });

  it('矢印は停止線より手前 (交差点から遠い側) に描かれる', () => {
    const frame = frameOf('road_medium');
    const mb = new MeshBuilder();
    buildTurnArrows(mb, frame, [{ offset: 4.875, width: 3.25, movements: ['through'] }]);
    const position = mb.build().getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      expect(position.getX(i)).toBeGreaterThan(frame.trim + 5);
    }
  });

  it('取り付き長が足りない枝には描かない', () => {
    const frame = { ...frameOf('road_medium', 14), trim: 8 };
    const mb = new MeshBuilder();
    buildTurnArrows(mb, frame, [{ offset: 4.875, width: 3.25, movements: ['through'] }]);
    expect(mb.isEmpty).toBe(true);
  });
});
