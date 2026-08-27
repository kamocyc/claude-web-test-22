import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { buildDemoNetwork } from '../src/app/demo';
import { getClass } from '../src/network/classes';
import { anchorFromNode, computePlacement, placeSegment } from '../src/network/editing';
import { Network } from '../src/network/network';
import { curveBreakMessage, findCurveBreaks } from '../src/network/validation';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { testField } from './support/field';

/**
 * 継ぎ目での平面線形の連続性。
 *
 * レールは曲がり角にも曲率の飛びにも折り合えないので、繋いだ所で線形が
 * 切れていたら報せる。敷設ツールを通せば接線は引き継がれるので、ここに
 * 出るのは「座標だけで置いた線形」か「両端の向きが決まっていて緩和曲線を
 * 入れられない繋ぎ方」になる。
 */

/** 敷設ツールと同じ手順で、点を順に繋いだ線形を作る。 */
function chain(classId: string, points: Vector3[], straight = true): Network {
  const cls = getClass(classId);
  const network = new Network();
  let anchor = { pos: points[0].clone() } as ReturnType<typeof anchorFromNode>;
  for (let i = 1; i < points.length; i++) {
    const preview = computePlacement(anchor, points[i], { straight, cls });
    const result = placeSegment(network, classId, anchor, { pos: points[i] }, preview);
    anchor = anchorFromNode(network, network.getNode(result.endNode), cls);
  }
  return network;
}

/** 座標と制御点だけを指定して繋ぐ (接線も曲率も引き継がない)。 */
function rawSegment(
  network: Network,
  classId: string,
  a: Vector3,
  b: Vector3,
  c0: Vector2,
  c1: Vector2,
): void {
  const from = network.findNodeNear(a, 1) ?? network.addNode(a);
  const to = network.findNodeNear(b, 1) ?? network.addNode(b);
  network.addSegment({
    classId,
    a: from.id,
    b: to.id,
    ctrlA: c0,
    ctrlB: c1,
    gradeA: 0,
    gradeB: 0,
  });
}

describe('継ぎ目の平面線形', () => {
  it('座標だけで繋いだ線路は継ぎ目で折れ、その角を述べる', () => {
    const network = chain('rail_single', [new Vector3(0, 0, 0), new Vector3(200, 0, 0)]);
    // 端点から 10° 振った向きへ、接線を無視して直線を足す。
    const end = new Vector3(200, 0, 0);
    const away = new Vector3(200 + 200 * Math.cos(0.1745), 0, 200 * Math.sin(0.1745));
    rawSegment(
      network,
      'rail_single',
      end,
      away,
      new Vector2(end.x, end.z).lerp(new Vector2(away.x, away.z), 1 / 3),
      new Vector2(end.x, end.z).lerp(new Vector2(away.x, away.z), 2 / 3),
    );

    const breaks = findCurveBreaks(network);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].tangentBreak).toBe(true);
    expect(breaks[0].deflection).toBeCloseTo(0.1745, 3);
    expect(curveBreakMessage(breaks[0])).toContain('10.0° 折れています');
  });

  it('接線が揃っていても、曲率が飛んでいれば見つける', () => {
    const network = chain('rail_single', [new Vector3(0, 0, 0), new Vector3(100, 0, 0)]);
    // 継ぎ目の接線は +X で揃えたまま、曲がりはじめだけを急にする。
    // 3 次ベジエの端の曲率は、最初の 3 点が一直線でなければ 0 にならない。
    rawSegment(
      network,
      'rail_single',
      new Vector3(100, 0, 0),
      new Vector3(220, 0, 20),
      new Vector2(140, 0),
      new Vector2(180, 10),
    );

    const breaks = findCurveBreaks(network);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].tangentBreak).toBe(false);
    expect(breaks[0].curvatureBreak).toBe(true);
    // 半径 240 m 相当の曲率が、その場でかかる。
    expect(1 / breaks[0].curvature).toBeGreaterThan(200);
    expect(1 / breaks[0].curvature).toBeLessThan(280);
    expect(curveBreakMessage(breaks[0])).toContain('曲率が半径');
  });

  it('端点に繋いで引いた線路では鳴らない', () => {
    const network = chain('rail_single', [
      new Vector3(0, 0, 0),
      new Vector3(200, 0, 0),
      new Vector3(400, 0, 60),
      new Vector3(600, 0, 200),
    ], false);
    expect(findCurveBreaks(network)).toEqual([]);
  });

  /**
   * 標準半径より急な曲線には緩和曲線を入れない (徐行区間として素の円曲線で
   * 敷く) ので、直線から入る所では曲率が飛ぶ。そこは黙って通すのではなく、
   * 「急すぎて緩和曲線が入らない」と理由を添えて報せる。
   */
  it('標準半径より急な曲線は、緩和曲線が入らない旨を添えて鳴る', () => {
    const cls = getClass('rail_single');
    const network = chain('rail_single', [new Vector3(0, 0, 0), new Vector3(200, 0, 0)]);
    const end = network.findNodeNear(new Vector3(200, 0, 0), 1)!;
    const anchor = anchorFromNode(network, end, cls);
    // 半径 75 m ぶんの曲がり (最小半径 50 m より緩く、標準半径より急)。
    const target = new Vector3(260, 0, -30);
    const preview = computePlacement(anchor, target, { straight: false, cls });
    expect(preview.radius).toBeLessThan(cls.smoothRadius);
    expect(preview.radius).toBeGreaterThan(cls.minRadius);
    // 円弧なので、指した点にはちょうど届く。
    expect(preview.end.distanceTo(target)).toBeLessThan(0.05);
    placeSegment(network, cls.id, anchor, { pos: target }, preview);

    const breaks = findCurveBreaks(network);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].curvatureBreak).toBe(true);
    expect(breaks[0].radius).toBeCloseTo(preview.radius, 0);
    const message = curveBreakMessage(breaks[0]);
    expect(message).toContain('標準半径');
    expect(message).toContain('緩和曲線が入りません');
  });

  it('サンプルの町の線路は、どの継ぎ目も繋がっている', () => {
    const field = testField();
    generateTerrain(field, DEFAULT_TERRAIN);
    const network = new Network();
    buildDemoNetwork(network, field);
    expect(findCurveBreaks(network)).toEqual([]);
  });

  it('分岐器では鳴らない (枝ごとに向きが違うのがふつう)', () => {
    const cls = getClass('rail_single');
    const network = chain('rail_single', [
      new Vector3(-200, 0, 0),
      new Vector3(0, 0, 0),
      new Vector3(200, 0, 0),
    ]);
    const node = network.findNodeNear(new Vector3(0, 0, 0), 2)!;
    const anchor = anchorFromNode(network, node, cls);
    // 本線の途中から 8° 振った側線を出す (3 枝のノードになる)。
    const target = new Vector3(200, 0, 28);
    placeSegment(
      network,
      'rail_single',
      anchor,
      { pos: target },
      computePlacement(anchor, target, { straight: true, cls }),
    );
    expect(network.branchesAt(node.id)).toHaveLength(3);
    expect(findCurveBreaks(network)).toEqual([]);
  });

  it('端点から引いた線路は継ぎ目が均されるが、均しきれない折れは鳴らす', () => {
    const cls = getClass('rail_single');
    const network = chain('rail_single', [new Vector3(-200, 0, 0), new Vector3(0, 0, 0)]);
    const node = network.findNodeNear(new Vector3(0, 0, 0), 2)!;
    const anchor = anchorFromNode(network, node, cls);
    // 接線を無視して引く (Shift の直線)。8° ほどの折れは敷設時に均される。
    const gentle = new Vector3(200, 0, 28);
    placeSegment(
      network,
      'rail_single',
      anchor,
      { pos: gentle },
      computePlacement(anchor, gentle, { straight: true, cls }),
    );
    expect(network.branchesAt(node.id)).toHaveLength(2);
    expect(findCurveBreaks(network)).toEqual([]);

    // 均しは「角にしたい」ほど深い折れには手を出さない。線路にその角は
    // 作れないので、そこは残った折れとして鳴る。
    const sharp = chain('rail_single', [new Vector3(-200, 0, 0), new Vector3(0, 0, 0)]);
    const corner = sharp.findNodeNear(new Vector3(0, 0, 0), 2)!;
    const back = anchorFromNode(sharp, corner, cls);
    const target = new Vector3(60, 0, 160);
    placeSegment(
      sharp,
      'rail_single',
      back,
      { pos: target },
      computePlacement(back, target, { straight: true, cls }),
    );
    const breaks = findCurveBreaks(sharp);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].tangentBreak).toBe(true);
  });

  it('道路の曲がり角では鳴らない (交差点の面が隅を繋ぐ)', () => {
    const network = chain('road_small', [
      new Vector3(0, 0, 0),
      new Vector3(120, 0, 0),
      new Vector3(120, 0, 120),
    ]);
    const corner = network.findNodeNear(new Vector3(120, 0, 0), 2)!;
    expect(network.branchesAt(corner.id)).toHaveLength(2);
    expect(findCurveBreaks(network)).toEqual([]);
  });
});
