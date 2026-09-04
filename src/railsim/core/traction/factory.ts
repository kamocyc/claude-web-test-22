import type { ConsistSpec, TractionKind } from '../vehicle/spec.ts';
import { ChopperTractionSystem } from './chopper.ts';
import { NoTractionSystem } from './none.ts';
import { ResistorTractionSystem } from './resistor.ts';
import type { TractionSystem } from './types.ts';
import { VvvfTractionSystem } from './vvvf.ts';

/** 編成に載っている制御方式（動力車が無ければ null） */
export function consistTractionKind(consist: ConsistSpec): TractionKind | null {
  const kinds = new Set<TractionKind>();
  for (const veh of consist.vehicles) {
    if (veh.traction) kinds.add(veh.traction.kind);
  }
  if (kinds.size === 0) return null;
  if (kinds.size > 1) {
    throw new Error(`編成内で制御方式が混在しています: ${[...kinds].join(', ')}`);
  }
  return [...kinds][0]!;
}

/**
 * 編成の車両仕様から動力装置を組み立てる。
 *
 * `createSafetySystem()` と同じ形にしてある。実車でも制御方式の違う電動車を
 * 1 本の編成に混ぜることはしない（主回路の引き通しがつながらない）ので、
 * 混在は設定の誤りとして弾く。
 */
export function createTractionSystem(consist: ConsistSpec): TractionSystem {
  switch (consistTractionKind(consist)) {
    case 'vvvf':
      return new VvvfTractionSystem(consist);
    case 'resistor':
      return new ResistorTractionSystem(consist);
    case 'chopper':
      return new ChopperTractionSystem(consist);
    case null:
      return new NoTractionSystem();
  }
}
