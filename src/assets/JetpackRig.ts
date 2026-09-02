import * as THREE from 'three';

type JetpackRigOptions = {
  color?: number;
  firstPerson?: boolean;
  thirdPersonPlayer?: boolean;
  /** The combat trooper already has authored jump-jet housings. */
  vfxOnly?: boolean;
};

/** Low-draw-call backpack and exhaust rig shared by the player and AI. */
export class JetpackRig {
  readonly root = new THREE.Group();
  private readonly outerFlames: THREE.InstancedMesh;
  private readonly innerFlames: THREE.InstancedMesh;
  private readonly sparks: THREE.Points;
  private readonly outerMaterial: THREE.ShaderMaterial;
  private readonly innerMaterial: THREE.ShaderMaterial;
  private readonly sparkMaterial: THREE.PointsMaterial;
  private readonly sparkPositions = new Float32Array(36 * 3);
  private readonly sparkSeeds = new Float32Array(36);
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  private readonly scale = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly nozzleSpread: number;
  private readonly exhaustTravel: number;
  private intensity = 0;

  constructor(options: JetpackRigOptions = {}) {
    const color = options.color ?? 0x43dfff;
    const authoredExhausts = Boolean(options.vfxOnly && !options.firstPerson);
    this.nozzleSpread = options.firstPerson ? 0.82 : authoredExhausts ? 0.125 : options.thirdPersonPlayer ? 0.2 : 0.23;
    this.exhaustTravel = options.firstPerson ? 0.72 : authoredExhausts ? 0.86 : options.thirdPersonPlayer ? 0.78 : 1.35;
    this.root.name = options.firstPerson
      ? 'player-jetpack-vfx'
      : options.thirdPersonPlayer
        ? 'third-person-player-jetpack-rig'
        : 'bot-jetpack-rig';
    this.root.userData.jetpackVfx = true;
    const dark = new THREE.MeshStandardMaterial({ color: 0x101820, roughness: 0.32, metalness: 0.86 });
    const accent = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.55), emissive: color, emissiveIntensity: 1.35, roughness: 0.2, metalness: 0.68 });
    this.materials.push(dark, accent);
    const packGeometry = new THREE.BoxGeometry(0.5, 0.58, 0.22);
    const tankGeometry = new THREE.CylinderGeometry(0.105, 0.13, 0.62, 10);
    const nozzleGeometry = new THREE.CylinderGeometry(0.1, 0.145, 0.18, 12);
    this.geometries.push(packGeometry, tankGeometry, nozzleGeometry);
    const pack = new THREE.Mesh(packGeometry, dark);
    pack.position.set(0, 0.3, -0.08);
    pack.userData.jetpackVfx = true;
    pack.castShadow = true;
    pack.visible = !options.vfxOnly;
    this.root.add(pack);
    for (const side of [-1, 1]) {
      const tank = new THREE.Mesh(tankGeometry, dark);
      tank.position.set(side * 0.23, 0.22, 0);
      tank.userData.jetpackVfx = true;
      tank.castShadow = true;
      tank.visible = !options.firstPerson && !options.vfxOnly;
      this.root.add(tank);
      const nozzle = new THREE.Mesh(nozzleGeometry, accent);
      nozzle.position.set(side * 0.23, -0.14, 0);
      nozzle.userData.jetpackVfx = true;
      nozzle.visible = !options.firstPerson && !options.vfxOnly;
      this.root.add(nozzle);
    }
    const outerGeometry = new THREE.ConeGeometry(0.105, 0.72, 14, 1, true);
    const innerGeometry = new THREE.ConeGeometry(0.046, 0.44, 12, 1, true);
    this.geometries.push(outerGeometry, innerGeometry);
    this.outerMaterial = this.flameMaterial(color);
    this.innerMaterial = this.flameMaterial(0xdafaff, true);
    this.materials.push(this.outerMaterial, this.innerMaterial);
    this.outerFlames = new THREE.InstancedMesh(outerGeometry, this.outerMaterial, 2);
    this.innerFlames = new THREE.InstancedMesh(innerGeometry, this.innerMaterial, 2);
    for (const flames of [this.outerFlames, this.innerFlames]) {
      flames.frustumCulled = false;
      flames.userData.jetpackVfx = true;
      this.root.add(flames);
    }
    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(this.sparkPositions, 3));
    this.geometries.push(sparkGeometry);
    for (let index = 0; index < 36; index += 1) this.sparkSeeds[index] = (index * 0.61803398875) % 1;
    this.sparkMaterial = new THREE.PointsMaterial({ color: 0x9df4ff, size: options.firstPerson ? 0.055 : options.thirdPersonPlayer ? 0.045 : 0.075, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    this.materials.push(this.sparkMaterial);
    this.sparks = new THREE.Points(sparkGeometry, this.sparkMaterial);
    this.sparks.frustumCulled = false;
    this.sparks.userData.jetpackVfx = true;
    this.root.add(this.sparks);
    if (options.firstPerson) {
      this.root.position.set(0, -0.52, -0.5);
      this.root.scale.setScalar(0.58);
      pack.visible = false;
    } else if (authoredExhausts) {
      // The supplied trooper's two jump-jet housings span x ±0.17, bottom out
      // around y 1.0, and sit just behind the torso. Position the VFX origin so
      // the cone bases meet those authored exhausts instead of a fake pack.
      this.root.position.set(0, 1.28, -0.17);
    } else if (options.thirdPersonPlayer) {
      this.root.position.set(0, 0.76, -0.2);
      this.root.scale.setScalar(0.62);
    } else {
      this.root.position.set(0, 0.82, -0.3);
    }
    this.update(false, 0, 0, false);
  }

  update(active: boolean, delta: number, elapsed: number, reducedMotion: boolean): void {
    this.intensity = THREE.MathUtils.lerp(this.intensity, active ? 1 : 0, 1 - Math.exp(-delta * (active ? 18 : 24)));
    if (this.intensity < 0.002) this.intensity = 0;
    const flicker = reducedMotion ? 0.94 : 0.84 + Math.sin(elapsed * 43) * 0.09 + Math.sin(elapsed * 71) * 0.05;
    const flame = this.intensity * flicker;
    this.outerMaterial.uniforms.uIntensity.value = flame * 0.46;
    this.innerMaterial.uniforms.uIntensity.value = flame * 0.64;
    this.outerMaterial.uniforms.uTime.value = elapsed;
    this.innerMaterial.uniforms.uTime.value = elapsed;
    this.sparkMaterial.opacity = reducedMotion ? 0 : this.intensity * 0.82;
    for (let index = 0; index < 2; index += 1) {
      const side = index === 0 ? -1 : 1;
      this.position.set(side * this.nozzleSpread, -0.46 - flame * 0.08, 0);
      this.scale.set(0.72 + flame * 0.28, Math.max(0.001, flame), 0.72 + flame * 0.28);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.outerFlames.setMatrixAt(index, this.matrix);
      this.position.y = -0.29 - flame * 0.05;
      this.scale.set(0.8 + flame * 0.2, Math.max(0.001, flame), 0.8 + flame * 0.2);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.innerFlames.setMatrixAt(index, this.matrix);
    }
    this.outerFlames.instanceMatrix.needsUpdate = true;
    this.innerFlames.instanceMatrix.needsUpdate = true;
    for (let index = 0; index < 36; index += 1) {
      const phase = (this.sparkSeeds[index] + elapsed * (1.6 + (index % 5) * 0.12)) % 1;
      const side = index % 2 === 0 ? -1 : 1;
      const spread = phase * phase * 0.24;
      this.sparkPositions[index * 3] = side * this.nozzleSpread + Math.sin(index * 12.71) * spread;
      this.sparkPositions[index * 3 + 1] = -0.28 - phase * this.exhaustTravel;
      this.sparkPositions[index * 3 + 2] = Math.cos(index * 8.37) * spread;
    }
    (this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.root.visible = this.intensity > 0 || active;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }

  private flameMaterial(color: number, core = false): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      name: core ? 'AuthoredThrusterCore' : 'AuthoredThrusterEnvelope',
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uIntensity: { value: 0 },
        uTime: { value: 0 },
        uCore: { value: core ? 1 : 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormalView;
        varying vec3 vViewPosition;
        void main() {
          vUv = uv;
          mat4 instanceTransform = mat4(1.0);
          #ifdef USE_INSTANCING
            instanceTransform = instanceMatrix;
          #endif
          vec4 worldPosition = modelMatrix * instanceTransform * vec4(position, 1.0);
          vec4 viewPosition = viewMatrix * worldPosition;
          mat3 instanceNormal = mat3(instanceTransform);
          vNormalView = normalize(normalMatrix * instanceNormal * normal);
          vViewPosition = viewPosition.xyz;
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uTime;
        uniform float uCore;
        varying vec2 vUv;
        varying vec3 vNormalView;
        varying vec3 vViewPosition;
        void main() {
          float lengthFade = 1.0 - smoothstep(0.2 + uCore * 0.16, 1.0, vUv.y);
          float tailDissolve = smoothstep(0.985, 0.68, vUv.y);
          float facing = abs(dot(normalize(vNormalView), normalize(-vViewPosition)));
          float softShell = mix(0.34 + 0.52 * pow(1.0 - facing, 1.35), 0.72, uCore);
          float bands = 0.82
            + sin(vUv.y * 31.0 - uTime * 19.0 + sin(vUv.x * 25.0) * 1.4) * 0.1
            + sin(vUv.y * 67.0 + vUv.x * 13.0 + uTime * 11.0) * 0.05;
          float alpha = uIntensity * lengthFade * tailDissolve * softShell * bands;
          if (alpha < 0.008) discard;
          vec3 hotColor = mix(uColor, vec3(0.82, 0.98, 1.0), uCore * 0.28);
          gl_FragColor = vec4(hotColor, alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
  }
}
