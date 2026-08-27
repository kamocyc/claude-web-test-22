import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { groupWarnings, nextPlace } from '../src/app/ui';
import type { WorldWarning } from '../src/render/worldBuilder';

/**
 * 警告の一覧。
 *
 * 文言だけでは「どこの話なのか」が分からないので、同じ内容をまとめても
 * 場所は全部持っておき、行を押すたびに 1 か所ずつ見て回れるようにする。
 */
const at = (x: number, z: number): Vector3 => new Vector3(x, 0, z);

const warn = (message: string, position?: Vector3, severity: WorldWarning['severity'] = 'warning'): WorldWarning =>
  position ? { message, position, severity } : { message, severity };

describe('警告の一覧', () => {
  it('同じ内容は 1 行にまとまり、場所は全部残る', () => {
    const groups = groupWarnings([
      warn('勾配が急です', at(10, 0)),
      warn('曲線がきついです', at(0, 40)),
      warn('勾配が急です', at(20, 0)),
      warn('勾配が急です', at(30, 0)),
    ]);
    expect(groups.map((g) => g.message)).toEqual(['勾配が急です', '曲線がきついです']);
    expect(groups[0].places.map((p) => p.x)).toEqual([10, 20, 30]);
    expect(groups[1].places).toHaveLength(1);
  });

  it('押すたびに次の場所へ進み、最後まで行くと先頭へ戻る', () => {
    const [group] = groupWarnings([
      warn('勾配が急です', at(10, 0)),
      warn('勾配が急です', at(20, 0)),
      warn('勾配が急です', at(30, 0)),
    ]);
    expect([1, 2, 3, 4, 5].map(() => nextPlace(group)!.x)).toEqual([10, 20, 30, 10, 20]);
  });

  it('場所の分からない警告は飛び先が無い (押しても空振りしない)', () => {
    const [group] = groupWarnings([warn('線路が繋がっていません')]);
    expect(group.places).toHaveLength(0);
    expect(nextPlace(group)).toBeNull();
  });

  it('同じ文言で重さが混ざったら、重い方で出す', () => {
    const [group] = groupWarnings([
      warn('交差できません', at(0, 0), 'warning'),
      warn('交差できません', at(50, 0), 'error'),
    ]);
    expect(group.severity).toBe('error');
    expect(group.places).toHaveLength(2);
  });

  it('場所は複製する (あとで動かしても一覧は変わらない)', () => {
    const position = at(10, 0);
    const [group] = groupWarnings([warn('勾配が急です', position)]);
    position.set(999, 0, 999);
    expect(group.places[0].x).toBe(10);
  });

  it('警告が無ければ 1 行も出ない', () => {
    expect(groupWarnings([])).toEqual([]);
  });
});
