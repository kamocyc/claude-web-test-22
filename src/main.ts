import { Vector3 } from 'three';
import { BuildTool, type ToolMode } from './app/buildTool';
import { buildDemoNetwork, buildInterchangeDemo } from './app/demo';
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
const tool = new BuildTool(network, field, () => {
  dirty = true;
});
viewport.scene.add(tool.previewGroup);

const ui = new Ui(uiRoot, {
  onMode: (mode) => setMode(mode),
  onClass: (classId) => {
    tool.setClass(classId);
    ui.setClass(classId);
  },
  onElevation: (steps) => tool.adjustElevation(steps),
  onParallel: (count) => tool.setParallel(count),
  onConnectivityColors: (on) => {
    world.colorMode = on ? 'connectivity' : 'normal';
    dirty = true;
  },
  onVehicles: (on) => {
    world.showVehicles = on;
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
  tool.setMode(mode);
  ui.setMode(mode);
}

setMode('build');
ui.setClass(tool.classId);
ui.setParallel(tool.parallelCount);
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
const modifiers = { straight: false, noSnap: false };
let pointerDownAt: { x: number; y: number; time: number } | null = null;

canvas.addEventListener('pointermove', (event) => {
  viewport.setPointer(event.clientX, event.clientY);
  modifiers.straight = event.shiftKey;
  modifiers.noSnap = event.ctrlKey || event.metaKey;
  cursor = viewport.pick(terrainMesh.meshes);
});

canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 0) {
    pointerDownAt = { x: event.clientX, y: event.clientY, time: performance.now() };
  }
});

canvas.addEventListener('pointerup', (event) => {
  if (event.button !== 0 || !pointerDownAt) return;
  const moved = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y);
  const elapsed = performance.now() - pointerDownAt.time;
  pointerDownAt = null;
  // ドラッグによる視点操作とクリックを区別する。
  if (moved > 5 || elapsed > 400) return;
  viewport.setPointer(event.clientX, event.clientY);
  cursor = viewport.pick(terrainMesh.meshes);
  tool.update(cursor, modifiers);
  tool.click();
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

window.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'Escape':
      tool.cancel();
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

  tool.update(cursor, modifiers);
  ui.updateStatus(tool.status());
  world.animate(time, dt);
  viewport.render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
