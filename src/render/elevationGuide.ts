import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';

export interface ElevationGuidePoint {
  point: Vector3;
  groundY: number;
}

/** 高さ変更と同じ目盛間隔 [m]。 */
export const ELEVATION_GUIDE_STEP = 3;

/** 地表の対応点と、実際に敷設する高さを結ぶ目盛付きガイド。 */
export class ElevationGuideView {
  readonly group = new Group();
  private readonly geometry = new BufferGeometry();
  private readonly material = new LineBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  private readonly lines = new LineSegments(this.geometry, this.material);
  private readonly labels = new Group();
  private cacheKey = '';

  constructor() {
    this.group.name = 'elevation-guides';
    this.lines.name = 'elevation-guide-lines';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 30;
    this.group.add(this.lines, this.labels);
  }

  update(guides: readonly ElevationGuidePoint[]): void {
    const visible = guides.filter((guide) => Math.abs(guide.point.y - guide.groundY) > 0.2);
    const key = visible
      .map(({ point, groundY }) =>
        [point.x, point.y, point.z, groundY].map((n) => n.toFixed(2)).join(','),
      )
      .join('|');
    if (key === this.cacheKey) return;
    this.cacheKey = key;

    const positions: number[] = [];
    for (const guide of visible) addGuideLines(positions, guide);
    this.geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    this.geometry.computeBoundingSphere();

    this.clearLabels();
    if (typeof document === 'undefined') return;
    for (const guide of visible) this.labels.add(createLabel(guide));
  }

  private clearLabels(): void {
    for (const child of [...this.labels.children]) {
      const sprite = child as Sprite;
      const material = sprite.material as SpriteMaterial;
      material.map?.dispose();
      material.dispose();
      this.labels.remove(child);
    }
  }

  dispose(): void {
    this.clearLabels();
    this.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}

function addSegment(out: number[], a: Vector3, b: Vector3): void {
  out.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

function addGuideLines(out: number[], guide: ElevationGuidePoint): void {
  const { point, groundY } = guide;
  const ground = new Vector3(point.x, groundY + 0.18, point.z);
  addSegment(out, ground, point);

  const ringRadius = 2.2;
  const ringSteps = 24;
  for (let i = 0; i < ringSteps; i++) {
    const a = (i / ringSteps) * Math.PI * 2;
    const b = ((i + 1) / ringSteps) * Math.PI * 2;
    addSegment(
      out,
      new Vector3(point.x + Math.cos(a) * ringRadius, ground.y, point.z + Math.sin(a) * ringRadius),
      new Vector3(point.x + Math.cos(b) * ringRadius, ground.y, point.z + Math.sin(b) * ringRadius),
    );
  }

  const delta = point.y - groundY;
  const direction = Math.sign(delta);
  const count = Math.floor(Math.abs(delta) / ELEVATION_GUIDE_STEP + 1e-6);
  for (let i = 1; i <= count; i++) {
    const y = groundY + direction * Math.min(Math.abs(delta), i * ELEVATION_GUIDE_STEP);
    const half = i % 3 === 0 ? 1.8 : 1.05;
    addSegment(out, new Vector3(point.x - half, y, point.z), new Vector3(point.x + half, y, point.z));
    addSegment(out, new Vector3(point.x, y, point.z - half), new Vector3(point.x, y, point.z + half));
  }
}

function createLabel(guide: ElevationGuidePoint): Sprite {
  const delta = guide.point.y - guide.groundY;
  const text = `${delta > 0 ? '+' : '\u2212'}${Math.abs(delta).toFixed(1)} m`;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext('2d')!;
  context.fillStyle = 'rgba(18, 22, 27, 0.9)';
  roundedRect(context, 8, 8, 240, 80, 18);
  context.fill();
  context.strokeStyle = '#ffd166';
  context.lineWidth = 4;
  roundedRect(context, 8, 8, 240, 80, 18);
  context.stroke();
  context.fillStyle = '#fff4cf';
  context.font = '600 38px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 128, 49);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  }));
  sprite.position.set(guide.point.x + 4.5, (guide.point.y + guide.groundY) / 2, guide.point.z);
  sprite.scale.set(12, 4.5, 1);
  sprite.renderOrder = 31;
  return sprite;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}
