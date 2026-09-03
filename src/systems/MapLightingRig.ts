import * as THREE from 'three';
import type { ArenaRuntime } from '../game/Arena';

type LightingProfile = Readonly<{
  ambientColor: THREE.ColorRepresentation;
  ambientIntensity: number;
  environmentIntensity: number;
  exposure: number;
  fillColor: THREE.ColorRepresentation;
  fillIntensity: number;
  fillPosition: readonly [number, number, number];
  groundColor: THREE.ColorRepresentation;
  keyColor: THREE.ColorRepresentation;
  keyIntensity: number;
  keyPosition: readonly [number, number, number];
  normalBias: number;
  rimColor: THREE.ColorRepresentation;
  rimIntensity: number;
  rimPosition: readonly [number, number, number];
  skyColor: THREE.ColorRepresentation;
  skyIntensity: number;
}>;

export type GroundingShadowSource = Readonly<{
  id: string;
  position: THREE.Vector3;
  footprint: Readonly<{ width: number; depth: number }>;
  heightOffset?: number;
  maxHeight?: number;
  visible: () => boolean;
}>;

export type MapLightingDiagnostics = Readonly<{
  profile: string;
  key: Readonly<{
    color: string;
    intensity: number;
    position: Readonly<{ x: number; y: number; z: number }>;
    target: Readonly<{ x: number; y: number; z: number }>;
  }>;
  fillIntensity: number;
  rimIntensity: number;
  environmentIntensity: number;
  exposure: number;
  shadow: Readonly<{
    type: 'PCFShadowMap';
    mapSize: number;
    extent: number;
    bias: number;
    normalBias: number;
    casters: number;
    receivers: number;
  }>;
  contactShadows: Readonly<{
    sources: number;
    visible: number;
    drawCalls: 1;
  }>;
}>;

// Reserve room for a full 8v8 roster plus vehicles and hostile drones. The
// instanced contact layer stays a single draw even when every source is live.
const MAX_CONTACT_SHADOWS = 32;
const UP = new THREE.Vector3(0, 0, 1);
const FLOOR_UP = new THREE.Vector3(0, 1, 0);
const HIDDEN_POSITION = new THREE.Vector3(0, -1_000, 0);
const HIDDEN_SCALE = new THREE.Vector3(0, 0, 0);
const IDENTITY_QUATERNION = new THREE.Quaternion();

const PROFILES = {
  monsoon: {
    ambientColor: 0x6f8792,
    ambientIntensity: 0.075,
    environmentIntensity: 0.7,
    exposure: 1.03,
    fillColor: 0x78a9c4,
    fillIntensity: 0.31,
    fillPosition: [-250, 184, -330],
    groundColor: 0x1f3126,
    keyColor: 0xffe1b7,
    keyIntensity: 3.65,
    keyPosition: [310, 456, 236],
    normalBias: 0.032,
    rimColor: 0x70b7e8,
    rimIntensity: 0.48,
    rimPosition: [-210, 164, -290],
    skyColor: 0xb8dce8,
    skyIntensity: 0.76,
  },
  quicksense: {
    // Warm desert key/fill preserves the concept's late-afternoon orange
    // bounce while the restrained cyan rim keeps the route language legible.
    ambientColor: 0x829ca8,
    ambientIntensity: 0.13,
    environmentIntensity: 0.64,
    exposure: 1.03,
    fillColor: 0x8fbad0,
    fillIntensity: 0.34,
    fillPosition: [-40, 132, 245],
    groundColor: 0x3d2a20,
    keyColor: 0xffd3a5,
    keyIntensity: 2.78,
    keyPosition: [255, 310, -210],
    normalBias: 0.022,
    rimColor: 0x6bc4dc,
    rimIntensity: 0.34,
    rimPosition: [170, 118, 190],
    skyColor: 0xffc292,
    skyIntensity: 0.72,
  },
  bipbeta2: {
    ambientColor: 0x9c8ab0,
    ambientIntensity: 0.16,
    environmentIntensity: 0.42,
    exposure: 0.96,
    fillColor: 0xa8c6d5,
    fillIntensity: 0.34,
    fillPosition: [-120, 92, 180],
    groundColor: 0x101118,
    keyColor: 0xffe3ca,
    keyIntensity: 2.1,
    keyPosition: [86, 150, 42],
    normalBias: 0.025,
    rimColor: 0xc786ff,
    rimIntensity: 0.62,
    rimPosition: [-120, 84, -140],
    skyColor: 0x2a2034,
    skyIntensity: 0.48,
  },
} as const satisfies Readonly<Record<'monsoon' | 'quicksense' | 'bipbeta2', LightingProfile>>;

function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create the map contact-shadow texture.');
  const gradient = context.createRadialGradient(48, 48, 4, 48, 48, 46);
  // alphaMap samples the texture's green channel, not its alpha channel.
  // Encode the falloff as grayscale so the quad never reads as a rectangle.
  gradient.addColorStop(0, 'rgb(255,255,255)');
  gradient.addColorStop(0.34, 'rgb(226,226,226)');
  gradient.addColorStop(0.67, 'rgb(92,92,92)');
  gradient.addColorStop(0.9, 'rgb(18,18,18)');
  gradient.addColorStop(1, 'rgb(0,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'MapGroundingContactShadowAlpha';
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

/**
 * One coherent, performance-bounded lighting stack for both authored maps.
 * The directional atlas owns the static world while one batched contact layer
 * grounds moving characters and vehicles. This keeps buildings and props on
 * full soft sun shadows without resubmitting the arena when an actor moves.
 */
export class MapLightingRig {
  readonly root = new THREE.Group();
  readonly key: THREE.DirectionalLight;
  readonly environmentIntensity: number;
  readonly exposure: number;

  private readonly profileName: 'monsoon' | 'quicksense' | 'bipbeta2';
  private readonly profile: LightingProfile;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly fill: THREE.DirectionalLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly shadowExtent: number;
  private readonly contactGeometry = new THREE.PlaneGeometry(2, 2);
  private readonly contactTexture = createContactShadowTexture();
  private readonly contactMaterial: THREE.MeshBasicMaterial;
  private readonly contactMesh: THREE.InstancedMesh;
  private readonly contactSources: GroundingShadowSource[] = [];
  private readonly contactMatrix = new THREE.Matrix4();
  private readonly contactQuaternion = new THREE.Quaternion();
  private readonly contactNormal = new THREE.Vector3(0, 1, 0);
  private readonly contactPosition = new THREE.Vector3();
  private readonly contactScale = new THREE.Vector3();
  private visibleContactShadows = 0;

  constructor(
    mapName: string,
    bounds: Readonly<{ width: number; depth: number }>,
    corePosition: THREE.Vector3,
    mobileQuality: boolean,
  ) {
    this.profileName = mapName === 'QuickSense' ? 'quicksense' : mapName === 'Bipbeta2' ? 'bipbeta2' : 'monsoon';
    this.profile = PROFILES[this.profileName];
    this.environmentIntensity = this.profile.environmentIntensity;
    this.exposure = this.profile.exposure;
    this.root.name = `${mapName} cinematic map lighting rig`;

    const ambient = new THREE.AmbientLight(this.profile.ambientColor, this.profile.ambientIntensity);
    ambient.name = `${mapName} low-frequency ambient`;
    this.hemisphere = new THREE.HemisphereLight(
      this.profile.skyColor,
      this.profile.groundColor,
      this.profile.skyIntensity,
    );
    this.hemisphere.name = `${mapName} sky and terrain bounce`;

    this.key = new THREE.DirectionalLight(this.profile.keyColor, this.profile.keyIntensity);
    this.key.name = `${mapName} authored sun key`;
    this.key.position.set(...this.profile.keyPosition);
    this.key.target.name = `${mapName} sun key target`;
    this.key.target.position.copy(corePosition);
    this.key.target.position.y = Math.max(corePosition.y, this.profileName === 'quicksense' ? 28 : 4);
    this.key.castShadow = true;
    const shadowMapSize = mobileQuality ? 1024 : 2048;
    this.key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.key.shadow.camera.near = 8;
    this.key.shadow.camera.far = this.profileName === 'quicksense' ? 1140 : 5000;
    // Cover the full authored play bounds with only a small guard band. The
    // previous oversized frustum diluted texel density and hid contact detail.
    this.shadowExtent = Math.max(bounds.width, bounds.depth) * 0.52;
    this.key.shadow.camera.left = -this.shadowExtent;
    this.key.shadow.camera.right = this.shadowExtent;
    this.key.shadow.camera.top = this.shadowExtent;
    this.key.shadow.camera.bottom = -this.shadowExtent;
    this.key.shadow.camera.updateProjectionMatrix();
    this.key.shadow.bias = -0.00008;
    this.key.shadow.normalBias = this.profile.normalBias;
    this.key.shadow.radius = mobileQuality ? 1.6 : 2.25;

    this.fill = new THREE.DirectionalLight(this.profile.fillColor, this.profile.fillIntensity);
    this.fill.name = `${mapName} playable-side fill`;
    this.fill.position.set(...this.profile.fillPosition);
    this.fill.target = this.key.target;

    this.rim = new THREE.DirectionalLight(this.profile.rimColor, this.profile.rimIntensity);
    this.rim.name = `${mapName} silhouette rim`;
    this.rim.position.set(...this.profile.rimPosition);
    this.rim.target = this.key.target;

    this.contactMaterial = new THREE.MeshBasicMaterial({
      name: 'SharedGroundingContactShadow',
      alphaMap: this.contactTexture,
      color: this.profileName === 'quicksense' ? 0x10171c : this.profileName === 'bipbeta2' ? 0x100d16 : 0x111b17,
      depthTest: true,
      depthWrite: false,
      fog: true,
      opacity: this.profileName === 'quicksense' ? 0.44 : this.profileName === 'bipbeta2' ? 0.34 : 0.38,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      side: THREE.DoubleSide,
      transparent: true,
    });
    this.contactMesh = new THREE.InstancedMesh(
      this.contactGeometry,
      this.contactMaterial,
      MAX_CONTACT_SHADOWS,
    );
    this.contactMesh.name = `${mapName} batched moving contact shadows`;
    this.contactMesh.count = 0;
    this.contactMesh.castShadow = false;
    this.contactMesh.receiveShadow = false;
    this.contactMesh.frustumCulled = false;
    this.contactMesh.renderOrder = 4;
    this.contactMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.root.add(
      ambient,
      this.hemisphere,
      this.key,
      this.key.target,
      this.fill,
      this.rim,
      this.contactMesh,
    );
  }

  setWeatherSeverity(severity: number): void {
    const storm = this.profileName === 'monsoon'
      ? THREE.MathUtils.clamp(severity, 0, 1)
      : 0;
    this.key.intensity = this.profile.keyIntensity * THREE.MathUtils.lerp(1, 0.62, storm);
    this.fill.intensity = this.profile.fillIntensity * THREE.MathUtils.lerp(1, 0.72, storm);
    this.rim.intensity = this.profile.rimIntensity * THREE.MathUtils.lerp(1, 1.32, storm);
    this.hemisphere.intensity = this.profile.skyIntensity * THREE.MathUtils.lerp(1, 0.68, storm);
  }

  addGroundingShadow(source: GroundingShadowSource): void {
    if (this.contactSources.length >= MAX_CONTACT_SHADOWS) {
      throw new Error(`Map lighting supports at most ${MAX_CONTACT_SHADOWS} grounding shadows.`);
    }
    this.contactSources.push(source);
    this.contactMesh.count = this.contactSources.length;
  }

  updateGroundingShadows(arena: ArenaRuntime): void {
    this.visibleContactShadows = 0;
    for (let index = 0; index < this.contactSources.length; index += 1) {
      const source = this.contactSources[index];
      const position = source.position;
      const heightOffset = source.heightOffset ?? 0;
      const sourceBottom = position.y - heightOffset;
      const groundY = arena.floorHeightAt(position.x, position.z, position.y + 1.5);
      const maxHeight = source.maxHeight ?? 5;
      const height = groundY === null ? Number.POSITIVE_INFINITY : Math.max(0, sourceBottom - groundY);
      if (!source.visible() || groundY === null || height > maxHeight) {
        this.contactMatrix.compose(HIDDEN_POSITION, IDENTITY_QUATERNION, HIDDEN_SCALE);
        this.contactMesh.setMatrixAt(index, this.contactMatrix);
        continue;
      }

      const normal = arena.surfaceNormalAt?.(position.x, position.z, position.y + 1.5);
      this.contactNormal.copy(normal ?? FLOOR_UP).normalize();
      this.contactQuaternion.setFromUnitVectors(UP, this.contactNormal);
      const heightSpread = 1 + THREE.MathUtils.clamp(height / maxHeight, 0, 1) * 0.45;
      this.contactPosition.set(position.x, groundY, position.z).addScaledVector(this.contactNormal, 0.045);
      this.contactScale.set(
        source.footprint.width * 0.5 * heightSpread,
        source.footprint.depth * 0.5 * heightSpread,
        1,
      );
      this.contactMatrix.compose(this.contactPosition, this.contactQuaternion, this.contactScale);
      this.contactMesh.setMatrixAt(index, this.contactMatrix);
      this.visibleContactShadows += 1;
    }
    this.contactMesh.instanceMatrix.needsUpdate = true;
  }

  /** Moving silhouettes use the dedicated contact-shadow batch. */
  excludeDynamicShadowCasters(roots: readonly THREE.Object3D[]): void {
    for (const root of roots) {
      root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) mesh.castShadow = false;
      });
    }
  }

  diagnostics(scene: THREE.Scene): MapLightingDiagnostics {
    let casters = 0;
    let receivers = 0;
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.castShadow) casters += 1;
      if (mesh.receiveShadow) receivers += 1;
    });
    return {
      profile: this.profileName,
      key: {
        color: `#${this.key.color.getHexString()}`,
        intensity: this.key.intensity,
        position: { x: this.key.position.x, y: this.key.position.y, z: this.key.position.z },
        target: {
          x: this.key.target.position.x,
          y: this.key.target.position.y,
          z: this.key.target.position.z,
        },
      },
      fillIntensity: this.fill.intensity,
      rimIntensity: this.rim.intensity,
      environmentIntensity: this.environmentIntensity,
      exposure: this.exposure,
      shadow: {
        type: 'PCFShadowMap',
        mapSize: this.key.shadow.mapSize.x,
        extent: this.shadowExtent,
        bias: this.key.shadow.bias,
        normalBias: this.key.shadow.normalBias,
        casters,
        receivers,
      },
      contactShadows: {
        sources: this.contactSources.length,
        visible: this.visibleContactShadows,
        drawCalls: 1,
      },
    };
  }

  dispose(): void {
    this.root.removeFromParent();
    this.contactGeometry.dispose();
    this.contactMaterial.dispose();
    this.contactTexture.dispose();
  }
}
