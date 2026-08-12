import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  Fog,
  Mesh,
  PerspectiveCamera,
  PCFShadowMap,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { MAP_SIZE } from '../core/units';

/**
 * 3D 表示まわり。レンダラ・カメラ・光源・空と、地形へのレイキャストを持つ。
 */
export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: MapControls;
  private readonly sun: DirectionalLight;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.scene.background = new Color(0x9fc4e0);
    this.scene.fog = new Fog(0xa8c8e0, MAP_SIZE * 0.55, MAP_SIZE * 1.5);

    this.camera = new PerspectiveCamera(52, 1, 1, MAP_SIZE * 3);
    this.camera.position.set(150, 180, 220);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 20;
    this.controls.maxDistance = MAP_SIZE * 0.9;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.set(0, 0, 0);

    this.scene.add(new AmbientLight(0xbcd0e6, 0.5));

    this.sun = new DirectionalLight(0xfff2df, 1.55);
    this.sun.position.set(-160, 240, 120);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const shadowExtent = 260;
    this.sun.shadow.camera.left = -shadowExtent;
    this.sun.shadow.camera.right = shadowExtent;
    this.sun.shadow.camera.top = shadowExtent;
    this.sun.shadow.camera.bottom = -shadowExtent;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 900;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(createSky());

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** 影のカメラを注視点に追従させ、広いマップでも影の解像度を保つ。 */
  private updateShadowCamera(): void {
    const t = this.controls.target;
    this.sun.position.set(t.x - 160, t.y + 240, t.z + 120);
    this.sun.target.position.copy(t);
    this.sun.target.updateMatrixWorld();
  }

  render(): void {
    this.controls.update();
    this.updateShadowCamera();
    this.renderer.render(this.scene, this.camera);
  }

  /** 画面座標 (CSS ピクセル) を正規化デバイス座標に変換して保持する。 */
  setPointer(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** 現在のポインタ位置から対象メッシュへレイキャストする。 */
  pick(targets: Mesh[]): Vector3 | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(targets, false);
    return hits.length > 0 ? hits[0].point.clone() : null;
  }
}

/** 天頂から地平にかけて色が変わる簡単な空。 */
function createSky(): Mesh {
  const geometry = new SphereGeometry(MAP_SIZE * 1.4, 24, 16);
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new Color(0x4f86c6) },
      middleColor: { value: new Color(0xa9cbe6) },
      bottomColor: { value: new Color(0xd8e2e6) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 middleColor;
      uniform vec3 bottomColor;
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y;
        vec3 c = h > 0.0
          ? mix(middleColor, topColor, smoothstep(0.0, 0.6, h))
          : mix(middleColor, bottomColor, smoothstep(0.0, -0.25, h));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  return mesh;
}
