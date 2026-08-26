import * as THREE from 'three';

type JetpackRigOptions = { color?: number; firstPerson?: boolean };

/** Low-draw-call backpack and exhaust rig shared by the player and AI. */
export class JetpackRig {
  readonly root = new THREE.Group();
  private readonly outerFlames: THREE.InstancedMesh;
  private readonly innerFlames: THREE.InstancedMesh;
  private readonly sparks: THREE.Points;
  private readonly outerMaterial: THREE.MeshBasicMaterial;
  private readonly innerMaterial: THREE.MeshBasicMaterial;
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
    this.nozzleSpread = options.firstPerson ? 0.82 : 0.23;
    this.exhaustTravel = options.firstPerson ? 0.72 : 1.35;
    this.root.name = options.firstPerson ? 'player-jetpack-vfx' : 'bot-jetpack-rig';
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
    this.root.add(pack);
    for (const side of [-1, 1]) {
      const tank = new THREE.Mesh(tankGeometry, dark);
      tank.position.set(side * 0.23, 0.22, 0);
      tank.userData.jetpackVfx = true;
      tank.castShadow = true;
      tank.visible = !options.firstPerson;
      this.root.add(tank);
      const nozzle = new THREE.Mesh(nozzleGeometry, accent);
      nozzle.position.set(side * 0.23, -0.14, 0);
      nozzle.userData.jetpackVfx = true;
      nozzle.visible = !options.firstPerson;
      this.root.add(nozzle);
    }
    const outerGeometry = new THREE.ConeGeometry(0.115, 0.9, 10, 1, true);
    const innerGeometry = new THREE.ConeGeometry(0.058, 0.62, 8, 1, true);
    this.geometries.push(outerGeometry, innerGeometry);
    this.outerMaterial = this.flameMaterial(color);
    this.innerMaterial = this.flameMaterial(0xfff4c2);
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
    this.sparkMaterial = new THREE.PointsMaterial({ color: 0x9df4ff, size: options.firstPerson ? 0.055 : 0.075, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    this.materials.push(this.sparkMaterial);
    this.sparks = new THREE.Points(sparkGeometry, this.sparkMaterial);
    this.sparks.frustumCulled = false;
    this.sparks.userData.jetpackVfx = true;
    this.root.add(this.sparks);
    if (options.firstPerson) {
      this.root.position.set(0, -0.52, -0.5);
      this.root.scale.setScalar(0.58);
      pack.visible = false;
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
    this.outerMaterial.opacity = flame * 0.72;
    this.innerMaterial.opacity = flame * 0.95;
    this.sparkMaterial.opacity = reducedMotion ? 0 : this.intensity * 0.82;
    for (let index = 0; index < 2; index += 1) {
      const side = index === 0 ? -1 : 1;
      this.position.set(side * this.nozzleSpread, -0.58 - flame * 0.15, 0);
      this.scale.set(0.72 + flame * 0.28, Math.max(0.001, flame), 0.72 + flame * 0.28);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.outerFlames.setMatrixAt(index, this.matrix);
      this.position.y = -0.45 - flame * 0.1;
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

  private flameMaterial(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  }
}
