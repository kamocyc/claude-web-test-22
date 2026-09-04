import type { DriverCommand, HeldCommand } from './driverState';

/**
 * 運転中のキー割り当て。
 *
 * 移植元 (`apps/debugger/src/input/keymap.ts`) の並びをそのまま採る。実車の
 * 運転台に合わせた並びではなく、**左手でノッチ・右手でブレーキ**という
 * キーボードの都合で決まった並びだが、慣れているものを変える理由が無い。
 *
 * こちらの敷設の道具ともキーが重なる (`Z` は区画、`X` は撤去、`V` は確認、
 * `W`/`A`/`S`/`D` は視点移動)。**運転中はこちらの表だけを引く**という
 * 割り切りで捌く。ハンドルを握っている間は線路を敷かないので、取り合いに
 * ならない。
 */

/** 一度押すごとに 1 回効くもの (ハンドル・スイッチ)。 */
const DRIVER_KEYS: Readonly<Record<string, DriverCommand>> = {
  // --- ノッチ ---
  z: 'powerUp',
  a: 'powerDown',
  q: 'notchToBrake',
  s: 'notchNeutral',
  w: 'notchB1',
  '.': 'brakeUp',
  ',': 'brakeDown',
  '1': 'emergency',

  // --- 運転台のスイッチ ---
  arrowup: 'reverserForward',
  arrowdown: 'reverserBackward',
  pagedown: 'doorsOpen',
  pageup: 'doorsClose',
  y: 'snowproofToggle',
};

/** 押している間だけ立つもの (警笛・砂撒き・確認扱い)。 */
const HELD_KEYS: Readonly<Record<string, HeldCommand>> = {
  ' ': 'horn',
  x: 'sanding',
  enter: 'acknowledge',
  '2': 'safetyReset',
};

export type DrivingKeyAction =
  | { readonly kind: 'driver'; readonly command: DriverCommand }
  | { readonly kind: 'held'; readonly command: HeldCommand };

/** `KeyboardEvent.key` から運転の指令を引く。 */
export function lookupDrivingKey(key: string): DrivingKeyAction | undefined {
  const lower = key.toLowerCase();
  const command = DRIVER_KEYS[lower];
  if (command) return { kind: 'driver', command };
  const heldCommand = HELD_KEYS[lower];
  if (heldCommand) return { kind: 'held', command: heldCommand };
  return undefined;
}
