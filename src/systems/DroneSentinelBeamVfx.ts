import * as THREE from 'three';

const BEAM_UP = new THREE.Vector3(0, 1, 0);
const HALO_COUNT = 6;
const STREAM_PARTICLE_COUNT = 24;
const POINT_COUNT = STREAM_PARTICLE_COUNT + 2;

const BEAM_VERTEX_SHADER = `
  varying vec2 vBeamUv;
  varying vec3 vBeamNormal;
  varying vec3 vBeamViewPosition;

  void main() {
    vBeamUv = uv;
    vBeamNormal = normalize(normalMatrix * normal);
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vBeamViewPosition = viewPosition.xyz;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const CORE_FRAGMENT_SHADER = `
  uniform float uTime;
  uniform float uPhase;
  varying vec2 vBeamUv;
  varying vec3 vBeamNormal;
  varying vec3 vBeamViewPosition;

  void main() {
    float endpointFade = smoothstep(0.0, 0.035, vBeamUv.y)
      * smoothstep(0.0, 0.035, 1.0 - vBeamUv.y);
    float stream = sin(vBeamUv.y * 118.0 - uTime * 38.0 + uPhase * 3.7);
    float filament = sin(vBeamUv.y * 51.0 - uTime * 21.0
      + sin(vBeamUv.x * 18.8496 + uTime * 4.4) * 1.8);
    float viewRim = 1.0 - abs(dot(normalize(vBeamNormal), normalize(-vBeamViewPosition)));
    float heat = clamp(0.78 + stream * 0.13 + filament * 0.09 + viewRim * 0.12, 0.0, 1.0);
    vec3 plasmaRed = vec3(1.0, 0.015, 0.075);
    vec3 whiteHot = vec3(1.0, 0.92, 0.78);
    vec3 color = mix(plasmaRed, whiteHot, heat);
    gl_FragColor = vec4(color, endpointFade * (0.82 + heat * 0.18));
  }
`;

const SHEATH_FRAGMENT_SHADER = `
  uniform float uTime;
  uniform float uPhase;
  varying vec2 vBeamUv;
  varying vec3 vBeamNormal;
  varying vec3 vBeamViewPosition;

  float hash21(vec2 value) {
    value = fract(value * vec2(123.34, 456.21));
    value += dot(value, value + 45.32);
    return fract(value.x * value.y);
  }

  float valueNoise(vec2 value) {
    vec2 cell = floor(value);
    vec2 local = fract(value);
    local = local * local * (3.0 - 2.0 * local);
    float a = hash21(cell);
    float b = hash21(cell + vec2(1.0, 0.0));
    float c = hash21(cell + vec2(0.0, 1.0));
    float d = hash21(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
  }

  void main() {
    float endpointFade = smoothstep(0.0, 0.055, vBeamUv.y)
      * smoothstep(0.0, 0.055, 1.0 - vBeamUv.y);
    vec2 flowUv = vec2(vBeamUv.x * 10.0 + uPhase, vBeamUv.y * 32.0 - uTime * 7.5);
    float turbulence = valueNoise(flowUv) * 0.62
      + valueNoise(flowUv * 2.03 + 7.4) * 0.38;
    float packet = 0.5 + 0.5 * sin(vBeamUv.y * 72.0 - uTime * 19.0
      + sin(vBeamUv.x * 12.5664 + uTime * 3.1) * 2.2);
    float viewRim = pow(1.0 - abs(dot(normalize(vBeamNormal), normalize(-vBeamViewPosition))), 1.5);
    float energy = clamp(turbulence * 0.62 + packet * 0.38, 0.0, 1.0);
    vec3 deepCrimson = vec3(0.44, 0.0, 0.08);
    vec3 ionMagenta = vec3(1.0, 0.055, 0.32);
    vec3 color = mix(deepCrimson, ionMagenta, energy);
    float alpha = endpointFade * (0.08 + energy * 0.16 + viewRim * 0.18);
    gl_FragColor = vec4(color, alpha);
  }
`;

const POINT_VERTEX_SHADER = `
  attribute float aSize;
  attribute vec3 aColor;
  varying vec3 vPointColor;

  void main() {
    vPointColor = aColor;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * 220.0 / max(1.0, -viewPosition.z), 1.25, 72.0);
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const POINT_FRAGMENT_SHADER = `
  varying vec3 vPointColor;

  void main() {
    float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (radius > 1.0) discard;
    float glow = smoothstep(1.0, 0.08, radius);
    float hot = smoothstep(0.55, 0.0, radius);
    vec3 color = mix(vPointColor, vec3(1.0, 0.9, 0.74), hot * 0.86);
    gl_FragColor = vec4(color, glow * (0.28 + hot * 0.72));
  }
`;

const fract = (value: number): number => value - Math.floor(value);

/**
 * A four-layer continuous particle lance inspired by the readable structure of
 * classic sci-fi sterilization beams: hot filament, turbulent sheath, traveling
 * packet rings, and one batched point pass for eye/impact coronas plus motes.
 */
export class DroneSentinelBeamVfx {
  readonly root = new THREE.Group();
  readonly layerCount = 4;
  readonly haloCount = HALO_COUNT;
  readonly particleCount = STREAM_PARTICLE_COUNT;

  private readonly body = new THREE.Group();
  private readonly coreMaterial: THREE.ShaderMaterial;
  private readonly sheathMaterial: THREE.ShaderMaterial;
  private readonly haloMaterial: THREE.MeshBasicMaterial;
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly core: THREE.Mesh;
  private readonly sheath: THREE.Mesh;
  private readonly halos: THREE.InstancedMesh;
  private readonly particles: THREE.Points;
  private readonly particlePositions = new Float32Array(POINT_COUNT * 3);
  private readonly particleSizes = new Float32Array(POINT_COUNT);
  private readonly particleColors = new Float32Array(POINT_COUNT * 3);
  private readonly direction = new THREE.Vector3();
  private readonly midpoint = new THREE.Vector3();
  private readonly instancePosition = new THREE.Vector3();
  private readonly instanceScale = new THREE.Vector3();
  private readonly instanceQuaternion = new THREE.Quaternion();
  private readonly instanceMatrix = new THREE.Matrix4();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(id: string) {
    this.root.name = `${id}-sentinel-particle-beam`;
    this.body.name = `${id}-sentinel-beam-body`;

    const beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    const haloGeometry = new THREE.TorusGeometry(1, 0.075, 6, 18);
    haloGeometry.rotateX(Math.PI * 0.5);
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    particleGeometry.setAttribute('aSize', new THREE.BufferAttribute(this.particleSizes, 1));
    particleGeometry.setAttribute('aColor', new THREE.BufferAttribute(this.particleColors, 3));

    this.coreMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPhase: { value: 0 },
      },
      vertexShader: BEAM_VERTEX_SHADER,
      fragmentShader: CORE_FRAGMENT_SHADER,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      transparent: true,
    });
    this.sheathMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPhase: { value: 0 },
      },
      vertexShader: BEAM_VERTEX_SHADER,
      fragmentShader: SHEATH_FRAGMENT_SHADER,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      transparent: true,
    });
    this.haloMaterial = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color: 0xff2d68,
      depthTest: true,
      depthWrite: false,
      opacity: 0.56,
      toneMapped: false,
      transparent: true,
      vertexColors: true,
    });
    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: POINT_VERTEX_SHADER,
      fragmentShader: POINT_FRAGMENT_SHADER,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    });

    this.core = new THREE.Mesh(beamGeometry, this.coreMaterial);
    this.sheath = new THREE.Mesh(beamGeometry, this.sheathMaterial);
    this.halos = new THREE.InstancedMesh(haloGeometry, this.haloMaterial, HALO_COUNT);
    this.particles = new THREE.Points(particleGeometry, this.particleMaterial);
    this.core.name = `${id}-sentinel-hot-core`;
    this.sheath.name = `${id}-sentinel-plasma-sheath`;
    this.halos.name = `${id}-sentinel-traveling-halos`;
    this.particles.name = `${id}-sentinel-stream-particles`;
    this.core.renderOrder = 17;
    this.sheath.renderOrder = 16;
    this.halos.renderOrder = 18;
    this.particles.renderOrder = 19;
    this.core.frustumCulled = false;
    this.sheath.frustumCulled = false;
    this.halos.frustumCulled = false;
    this.particles.frustumCulled = false;
    this.halos.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let index = 0; index < HALO_COUNT; index += 1) {
      const color = new THREE.Color().setRGB(
        1,
        0.08 + index / HALO_COUNT * 0.18,
        0.22 + index / HALO_COUNT * 0.26,
      );
      this.halos.setColorAt(index, color);
    }
    if (this.halos.instanceColor) this.halos.instanceColor.needsUpdate = true;
    for (let index = 0; index < POINT_COUNT; index += 1) {
      const endpoint = index < 2;
      this.particleColors[index * 3] = 1;
      this.particleColors[index * 3 + 1] = endpoint ? 0.05 : 0.025 + (index % 4) * 0.045;
      this.particleColors[index * 3 + 2] = endpoint ? 0.2 : 0.12 + (index % 5) * 0.055;
    }

    this.body.add(this.sheath, this.core, this.halos, this.particles);
    this.root.add(this.body);
    this.root.visible = false;
    this.geometries.push(beamGeometry, haloGeometry, particleGeometry);
    this.materials.push(
      this.coreMaterial,
      this.sheathMaterial,
      this.haloMaterial,
      this.particleMaterial,
    );
  }

  update(startLocal: THREE.Vector3, endLocal: THREE.Vector3, phaseSeconds: number): void {
    this.direction.subVectors(endLocal, startLocal);
    const length = this.direction.length();
    if (length <= 0.05) {
      this.stop();
      return;
    }
    this.direction.multiplyScalar(1 / length);
    this.root.visible = true;
    this.midpoint.copy(startLocal).lerp(endLocal, 0.5);
    this.body.position.copy(this.midpoint);
    this.body.quaternion.setFromUnitVectors(BEAM_UP, this.direction);
    this.core.scale.set(0.072, length, 0.072);
    this.sheath.scale.set(0.23, length, 0.23);
    this.coreMaterial.uniforms.uTime.value = phaseSeconds;
    this.coreMaterial.uniforms.uPhase.value = phaseSeconds * 0.37;
    this.sheathMaterial.uniforms.uTime.value = phaseSeconds;
    this.sheathMaterial.uniforms.uPhase.value = phaseSeconds * 0.19;

    this.updateHalos(length, phaseSeconds);
    this.updateParticles(length, phaseSeconds);
  }

  stop(): void {
    this.root.visible = false;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  private updateHalos(length: number, phaseSeconds: number): void {
    for (let index = 0; index < HALO_COUNT; index += 1) {
      const progress = fract(phaseSeconds * 0.92 + index / HALO_COUNT);
      const radius = 0.25
        + Math.sin(progress * Math.PI) * 0.11
        + Math.sin(phaseSeconds * 8.2 + index * 1.7) * 0.018;
      this.instancePosition.set(0, (progress - 0.5) * length, 0);
      this.instanceQuaternion.setFromAxisAngle(BEAM_UP, phaseSeconds * 2.4 + index * 0.73);
      this.instanceScale.setScalar(radius);
      this.instanceMatrix.compose(
        this.instancePosition,
        this.instanceQuaternion,
        this.instanceScale,
      );
      this.halos.setMatrixAt(index, this.instanceMatrix);
    }
    this.halos.instanceMatrix.needsUpdate = true;
  }

  private updateParticles(length: number, phaseSeconds: number): void {
    const halfLength = length * 0.5;
    this.setParticle(0, 0, -halfLength, 0, 0.62 + Math.sin(phaseSeconds * 16) * 0.07);
    this.setParticle(1, 0, halfLength, 0, 0.42 + Math.sin(phaseSeconds * 23 + 1.8) * 0.05);
    for (let index = 0; index < STREAM_PARTICLE_COUNT; index += 1) {
      const pointIndex = index + 2;
      const progress = fract(phaseSeconds * (1.42 + (index % 3) * 0.17) + index * 0.61803398875);
      const angle = index * 2.3999632297 + phaseSeconds * (4.2 + (index % 4) * 0.31);
      const radius = 0.045
        + (0.05 + (index % 5) * 0.012) * (0.35 + Math.sin(progress * Math.PI) * 0.65);
      const axialJitter = Math.sin(phaseSeconds * 13.0 + index * 4.1) * 0.06;
      this.setParticle(
        pointIndex,
        Math.cos(angle) * radius,
        (progress - 0.5) * length + axialJitter,
        Math.sin(angle) * radius,
        0.075 + (index % 4) * 0.018,
      );
    }
    const position = this.particles.geometry.getAttribute('position');
    const size = this.particles.geometry.getAttribute('aSize');
    position.needsUpdate = true;
    size.needsUpdate = true;
  }

  private setParticle(
    index: number,
    x: number,
    y: number,
    z: number,
    size: number,
  ): void {
    this.particlePositions[index * 3] = x;
    this.particlePositions[index * 3 + 1] = y;
    this.particlePositions[index * 3 + 2] = z;
    this.particleSizes[index] = size;
  }
}
