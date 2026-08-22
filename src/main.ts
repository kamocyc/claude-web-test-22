import { Vector3 } from 'three';
import { BuildTool, type ToolMode } from './app/buildTool';
import { buildDemoNetwork, buildInterchangeDemo } from './app/demo';
import { Ride } from './app/ride';
import { Ui } from './app/ui';
import { Viewport } from './app/viewport';
import { Network } from './network/network';
import { createTerrainMaterial } from './render/materials';
import { WorldBuilder } from './render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from './terrain/generator';
import { Heightfield } from './terrain/heightfield';
import { TerrainMesh } from './terrain/terrainMesh';

const canvas = document.querySelector<HTMLCanvasElement>('#view');
const uiRoot = document.querySelector<HTMLElement>('#ui');
if (!canvas || !uiRoot) throw new Error('必要な DOM 要素が見つかりません');

const viewport = new Viewport(canvas);

const field = new Heightfield();
let terrainSeed = DEFAULT_TERRAIN.seed;
generateTerrain(field, { ...DEFAULT_TERRAIN, seed: terrainSeed });

const terrainMesh = new TerrainMesh(field, createTerrainMaterial());
viewport.scene.add(terrainMesh.group);

const network = new Network();
const world = new WorldBuilder(network, field, terrainMesh);
viewport.scene.add(world.group);

let dirty = true;
// 確認モードでカント・構造形式を読めるよう、描画側を渡す。
const tool = new BuildTool(
  network,
  field,
  () => {
    dirty = true;
  },
  world,
);
viewport.scene.add(tool.previewGroup);

// 乗車モード (一人称視点)。走っている車両の運転台にカメラを置く。
const ride = new Ride();

const ui = new Ui(uiRoot, {
  onMode: (mode) => setMode(mode),
  onClass: (classId) => {
    tool.setClass(classId);
    ui.setClass(classId);
  },
  onElevation: (steps) => tool.adjustElevation(steps),
  onParallelSnap: (on) => tool.setParallelSnap(on),
  onConnectivityColors: (on) => {
    world.colorMode = on ? 'connectivity' : 'normal';
    dirty = true;
  },
  onVehicles: (on) => {
    world.showVehicles = on;
    // 走らせるのをやめたら、乗る車両もいなくなる。
    if (!on) stopRide();
  },
  onRide: () => (ride.active || ride.aiming ? stopRide() : startRide()),
  onRideNext: () => {
    if (ride.active) ride.next(world.traffic.vehicles);
    else startRide();
  },
  onRegenerate: () => {
    terrainSeed = (terrainSeed * 1664525 + 1013904223) >>> 0;
    generateTerrain(field, { ...DEFAULT_TERRAIN, seed: terrainSeed });
    dirty = true;
  },
  onDemo: () => {
    buildDemoNetwork(network, field);
    tool.cancel();
    dirty = true;
  },
  onInterchange: (kind) => {
    buildInterchangeDemo(network, field, kind);
    tool.cancel();
    dirty = true;
  },
  onClear: () => {
    network.clear();
    tool.cancel();
    dirty = true;
  },
});

function setMode(mode: ToolMode): void {
  // ツールを使うなら乗車モードから降りる (敷設中は俯瞰でないと使えない)。
  stopRide();
  tool.setMode(mode);
  ui.setMode(mode);
}

/**
 * 乗る車両を選ぶ状態に入る。
 *
 * すぐ一人称にせず、俯瞰のまま指した車両を光らせる。走っている車両の
 * どれに乗るかは、外から見て選べたほうが分かりやすい。
 */
function startRide(): void {
  if (ride.active) return;
  tool.cancel();
  // 車両を走らせていないと乗れない。切ってあったら入れる。
  if (!world.showVehicles) {
    world.showVehicles = true;
    ui.setVehicles(true);
  }
  ride.aim();
  document.body.classList.add('aiming');
  ui.setRideState('aim');
}

/**
 * 選択中の車両に乗り込む。
 *
 * 乗るのは**画面で光っている車両**。押してから離すまでの間にも車両は走って
 * いるので、ここで指し直すと「狙ったのと違う車両に乗る」ことになる。
 */
function boardRide(): void {
  if (!ride.boardTarget(world.traffic.vehicles)) {
    // 光っていた車両が消えていた (行き止まりに着いた)。選び直す。
    ride.hover(world.traffic.vehicles, viewport.ray(), cursor);
    if (!ride.boardTarget(world.traffic.vehicles)) return;
  }
  world.highlightVehicle = null;
  document.body.classList.remove('aiming');
  viewport.beginRide();
  ui.setRideState('ride');
}

/** 乗車モードから降り (選択中ならやめ)、元の視点に戻す。 */
function stopRide(): void {
  if (!ride.active && !ride.aiming) return;
  const rode = ride.active;
  ride.leave();
  world.highlightVehicle = null;
  document.body.classList.remove('aiming');
  if (rode) viewport.endRide();
  ui.setRideState('off');
}

setMode('build');
ui.setClass(tool.classId);
ui.setParallelSnap(tool.parallelSnap);
buildDemoNetwork(network, field);

// 動作確認・デバッグ用に主要オブジェクトを公開する。
declare global {
  interface Window {
    trackBuilder: {
      viewport: Viewport;
      network: Network;
      world: WorldBuilder;
      field: Heightfield;
      tool: BuildTool;
      ride: Ride;
      /** 指定した地点を、指定した距離・方位から見る。 */
      lookAt: (x: number, z: number, distance?: number, azimuth?: number) => void;
    };
  }
}

window.trackBuilder = {
  viewport,
  network,
  world,
  field,
  tool,
  ride,
  lookAt: (x, z, distance = 120, azimuth = Math.PI * 0.25) => {
    const y = field.heightAt(x, z);
    viewport.controls.target.set(x, y, z);
    viewport.camera.position.set(
      x + Math.cos(azimuth) * distance,
      y + distance * 0.55,
      z + Math.sin(azimuth) * distance,
    );
    viewport.controls.update();
  },
};

// ---------------------------------------------------------------- 入力

let cursor: Vector3 | null = null;

/**
 * カーソルの当たり先。地形に加えて**路面**も見る。
 *
 * 地形だけを見ていると、橋の上を指しても橋の下の地面を指したことに
 * なってしまう。路面を含めれば、橋を指したときは橋の高さが返る
 * (敷設ツールはその高さで働き、その橋に繋がる)。
 */
const pick = (): Vector3 | null => viewport.pick([...terrainMesh.meshes, world.surfaceMesh]);
const modifiers = { straight: false, noSnap: false };
let pointerDownAt: { x: number; y: number; time: number } | null = null;
/** 乗車中に見回すときの感度 [rad/px]。 */
const LOOK_SENSITIVITY = 0.004;
/** 乗車中のドラッグの前回位置。 */
let lookFrom: { x: number; y: number } | null = null;

canvas.addEventListener('pointermove', (event) => {
  if (ride.active) {
    if (!lookFrom) return;
    // 画面をつかんで回す向き (地図の視点操作と同じ感覚)。
    ride.turn(
      -(event.clientX - lookFrom.x) * LOOK_SENSITIVITY,
      (event.clientY - lookFrom.y) * LOOK_SENSITIVITY,
    );
    lookFrom = { x: event.clientX, y: event.clientY };
    return;
  }
  viewport.setPointer(event.clientX, event.clientY);
  modifiers.straight = event.shiftKey;
  modifiers.noSnap = event.ctrlKey || event.metaKey;
  cursor = pick();
});

canvas.addEventListener('pointerdown', (event) => {
  if (ride.active) {
    lookFrom = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button === 0) {
    pointerDownAt = { x: event.clientX, y: event.clientY, time: performance.now() };
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (ride.active) {
    lookFrom = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0 || !pointerDownAt) return;
  const moved = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y);
  const elapsed = performance.now() - pointerDownAt.time;
  pointerDownAt = null;
  // ドラッグによる視点操作とクリックを区別する。
  if (moved > 5 || elapsed > 400) return;
  viewport.setPointer(event.clientX, event.clientY);
  cursor = pick();
  if (ride.aiming) {
    boardRide();
    return;
  }
  tool.update(cursor, modifiers);
  tool.click();
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

window.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'Escape':
      if (ride.active || ride.aiming) stopRide();
      else tool.cancel();
      break;
    case 'f':
    case 'F':
      if (ride.active || ride.aiming) stopRide();
      else startRide();
      break;
    case 'n':
    case 'N':
      if (ride.active) ride.next(world.traffic.vehicles);
      break;
    case 'PageUp':
      tool.adjustElevation(1);
      event.preventDefault();
      break;
    case 'PageDown':
      tool.adjustElevation(-1);
      event.preventDefault();
      break;
    case 'b':
    case 'B':
      setMode('build');
      break;
    case 'c':
    case 'C':
      setMode('scissors');
      break;
    case 'x':
    case 'X':
      setMode('bulldoze');
      break;
    case 'v':
    case 'V':
      setMode('inspect');
      break;
    default:
      break;
  }
  if (event.key === 'Shift') modifiers.straight = true;
  if (event.key === 'Control' || event.key === 'Meta') modifiers.noSnap = true;
});

window.addEventListener('keyup', (event) => {
  if (event.key === 'Shift') modifiers.straight = false;
  if (event.key === 'Control' || event.key === 'Meta') modifiers.noSnap = false;
});

// ------------------------------------------------------------ メインループ

const clock = { start: performance.now(), last: performance.now() };

function frame(): void {
  const now = performance.now();
  const time = (now - clock.start) / 1000;
  const dt = (now - clock.last) / 1000;
  clock.last = now;

  if (dirty) {
    dirty = false;
    const result = world.rebuild();
    ui.updateBuild(result);
  }

  // 選択中は、指している車両を毎フレーム選び直す (車両は走っている)。
  if (ride.aiming) {
    world.highlightVehicle =
      ride.hover(world.traffic.vehicles, viewport.ray(), cursor)?.id ?? null;
  }

  world.animate(time, dt);
  // 乗車モードのカメラは、車両を進めたあとに置く (1 フレーム遅れないように)。
  const riding = ride.update(world.traffic.vehicles, dt);
  if (riding?.phase === 'ride') {
    viewport.placeEye(riding.pose.eye, riding.pose.forward, riding.pose.up);
  }

  // 乗車中・選択中は敷設のプレビューを出さない。
  tool.update(ride.active || ride.aiming ? null : cursor, modifiers);
  ui.updateStatus(tool.status(), riding);
  viewport.render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
