/**
 * 車両データ。移植元 `packages/data` のうち**車両の側だけ**を持ってきたもの。
 *
 * 路線の側 (`schema/route.ts` / `compile/route.ts`) は持ってこない。あちらは
 * 「距離程に沿って曲線と勾配を書き下す」データ形式で、こちらの網目状の線形とは
 * 別物である。こちらの線路から `CompiledRoute` を作るのはアダプタの仕事。
 */

export { compileVehicle } from './compile.ts';
export {
  applyVehicleDefaults,
  DEFAULT_ADHESION,
  DEFAULT_BRAKE_CONTROL,
  DEFAULT_COUPLER,
  DEFAULT_DAVIS,
  DEFAULT_TRACTION_CONTROL,
  DEFAULT_VEHICLE_BRAKE,
  type AdhesionData,
  type BrakeControlData,
  type CarData,
  type CarInput,
  type ChopperData,
  type CouplerData,
  type DavisData,
  type DcMotorData,
  type DcMotorInput,
  type ParsedVehicle,
  type ResistorData,
  type TractionControlData,
  type TractionData,
  type TractionInput,
  type VehicleBrakeData,
  type VehicleDefinition,
  type VvvfData,
} from './schema.ts';

export { commuter4Vehicle } from './assets/commuter4.ts';
export { commuter4ChopperVehicle } from './assets/commuter4Chopper.ts';
export { commuter4ResistorVehicle } from './assets/commuter4Resistor.ts';
export { commuter4ScaleVehicle } from './assets/commuter4Scale.ts';
