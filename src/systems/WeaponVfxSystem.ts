import * as THREE from 'three';
import type { WeaponId } from '../game/config';

type Effect = {
  root: THREE.Group;
  age: number;
  duration: number;
  materials: THREE.Material[];
  update: (progress: number, delta: number) => void;
  kind?: 'tracer';
};

type ContinuousLaser = {
  root: THREE.Group;
  segments: Array<{ core: THREE.Mesh; halo: THREE.Mesh }>;
  coreGeometry: THREE.CylinderGeometry;
  haloGeometry: THREE.CylinderGeometry;
  coreMaterial: THREE.MeshBasicMaterial;
  haloMaterial: THREE.MeshBasicMaterial;
};

type ImpactMark = {
  root: THREE.Group;
  material: THREE.MeshBasicMaterial;
  accentMaterial: THREE.MeshBasicMaterial;
  position: THREE.Vector3;
  weapon: WeaponId;
  age: number;
  duration: number;
};

const FORWARD = new THREE.Vector3(0, 0, -1);
const SURFACE_NORMAL = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

function additiveMaterial(color: number, opacity = 1, depthTest = true): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

function orientBetween(root: THREE.Object3D, start: THREE.Vector3, end: THREE.Vector3): number {
  const direction = end.clone().sub(start);
  const length = direction.length();
  root.position.copy(start).add(end).multiplyScalar(0.5);
  if (length > 0.0001) root.quaternion.setFromUnitVectors(UP, direction.multiplyScalar(1 / length));
  return length;
}

export class WeaponVfxSystem {
  private readonly effects: Effect[] = [];
  private readonly marks: ImpactMark[] = [];
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempQuaternion = new THREE.Quaternion();
  private readonly laserLaggedEnd = new THREE.Vector3();
  private readonly laserPoints = Array.from({ length: 11 }, () => new THREE.Vector3());
  private continuousLaser?: ContinuousLaser;
  private grappleRoot?: THREE.Group;
  private grappleCable?: THREE.Mesh;
  private grappleHook?: THREE.Mesh;
  private grappleHookCore?: THREE.Mesh;
  private readonly grappleMaterials: THREE.Material[] = [];
  private laserPhase = 0;
  private laserBend = 0;
  private ropePhase = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly random: () => number,
  ) {}

  muzzle(weapon: WeaponId, color: number, socket: THREE.Object3D): void {
    socket.updateWorldMatrix(true, false);
    socket.getWorldPosition(this.tempPosition);
    socket.getWorldQuaternion(this.tempQuaternion);

    const root = new THREE.Group();
    root.name = `${weapon}-muzzle-vfx`;
    root.position.copy(this.tempPosition);
    root.quaternion.copy(this.tempQuaternion);

    const hot = additiveMaterial(0xffffff, 0.72, false);
    const glow = additiveMaterial(color, 0.58, false);
    const materials: THREE.Material[] = [hot, glow];
    const heavy = weapon === 'rocket' || weapon === 'rail' || weapon === 'shotgun';
    const coneLength = (weapon === 'rail' ? 1.25 : heavy ? 0.85 : 0.52) * 0.5;
    const coneRadius = (weapon === 'shotgun' ? 0.32 : weapon === 'rocket' ? 0.28 : weapon === 'rail' ? 0.22 : 0.13) * 0.36;

    const cone = new THREE.Mesh(new THREE.ConeGeometry(coneRadius, coneLength, weapon === 'rocket' ? 8 : 12, 1, true), glow);
    cone.name = 'muzzle-plume';
    cone.rotation.x = -Math.PI * 0.5;
    cone.position.z = -coneLength * 0.5;
    root.add(cone);

    const core = new THREE.Mesh(new THREE.ConeGeometry(coneRadius * 0.38, coneLength * 0.72, 10, 1, true), hot);
    core.name = 'muzzle-core';
    core.rotation.x = -Math.PI * 0.5;
    core.position.z = -coneLength * 0.36;
    root.add(core);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(coneRadius * 0.78, Math.max(0.018, coneRadius * 0.12), 8, 24), glow);
    ring.name = 'muzzle-ring';
    ring.position.z = -0.04;
    root.add(ring);

    if (weapon === 'rail' || weapon === 'plasma') {
      for (let index = 0; index < 3; index += 1) {
        const arc = new THREE.Mesh(new THREE.TorusGeometry(coneRadius * (1.25 + index * 0.35), 0.012, 6, 18, Math.PI * 1.3), glow);
        arc.name = `muzzle-arc-${index}`;
        arc.position.z = -0.08 - index * 0.09;
        arc.rotation.z = index * 2.1;
        root.add(arc);
      }
    }

    if (weapon === 'rocket') {
      const backblast = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.26, 10, 1, true), glow);
      backblast.name = 'rocket-backblast';
      backblast.rotation.x = Math.PI * 0.5;
      backblast.position.z = 0.13;
      root.add(backblast);
    }

    this.scene.add(root);
    const duration = weapon === 'rail' ? 0.16 : heavy ? 0.1 : 0.065;
    this.effects.push({
      root,
      age: 0,
      duration,
      materials,
      update: (progress) => {
        const envelope = 1 - progress;
        hot.opacity = envelope * 0.72;
        glow.opacity = envelope * 0.58;
        root.scale.setScalar(0.82 + Math.sin(progress * Math.PI) * 0.35);
        ring.rotation.z += 0.24;
      },
    });
  }

  beam(start: THREE.Vector3, end: THREE.Vector3, weapon: WeaponId, color: number, duration: number): void {
    const visibleStart = start.clone();
    if (weapon === 'machine') visibleStart.lerp(end, 0.08);
    if (weapon === 'shotgun') visibleStart.lerp(end, 0.04);
    const root = new THREE.Group();
    root.name = `${weapon}-beam-vfx`;
    const length = orientBetween(root, visibleStart, end);
    const coreMaterial = additiveMaterial(weapon === 'rail' ? 0xffffff : color, 1);
    const glowMaterial = additiveMaterial(color, 0.38);
    const coreRadius = weapon === 'rail' ? 0.03
      : weapon === 'sniper' ? 0.012
        : weapon === 'shotgun' ? 0.006
          : weapon === 'machine' ? 0.009 : 0.014;
    const haloRadius = weapon === 'rail' ? 0.11
      : weapon === 'sniper' ? 0.052
        : weapon === 'shotgun' ? 0.013
          : weapon === 'machine' ? 0.022 : 0.06;
    const coreOpacity = weapon === 'shotgun' ? 0.42 : weapon === 'machine' ? 0.66 : weapon === 'sniper' ? 0.9 : 1;
    const glowOpacity = weapon === 'shotgun' ? 0.07 : weapon === 'machine' ? 0.14 : weapon === 'sniper' ? 0.22 : 0.34;
    coreMaterial.opacity = coreOpacity;
    glowMaterial.opacity = glowOpacity;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(coreRadius, coreRadius * 0.72, length, 8, 1, true), coreMaterial);
    const halo = new THREE.Mesh(new THREE.CylinderGeometry(haloRadius, haloRadius * 0.72, length, 10, 1, true), glowMaterial);
    core.name = 'beam-core';
    halo.name = 'beam-halo';
    root.add(halo, core);

    if (weapon === 'machine') {
      // A fast sequence of tiny ionized packet glints gives the ballistic
      // tracer character without turning every round into a solid laser.
      for (let index = 0; index < 5; index += 1) {
        const packet = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.006, Math.min(0.34, length * 0.055), 6), coreMaterial);
        packet.name = `machine-tracer-packet-${index}`;
        packet.position.y = -length * 0.42 + length * (index / 5) * 0.82;
        root.add(packet);
      }
    } else if (weapon === 'sniper') {
      for (let index = 0; index < 3; index += 1) {
        const wave = new THREE.Mesh(new THREE.RingGeometry(0.035 + index * 0.024, 0.045 + index * 0.024, 16), glowMaterial);
        wave.name = `sniper-pressure-wave-${index}`;
        wave.rotation.x = Math.PI * 0.5;
        wave.position.y = length * (0.18 + index * 0.22) - length * 0.5;
        root.add(wave);
      }
    } else if (weapon === 'rail') {
      for (let index = 0; index < 8; index += 1) {
        const marker = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.012, 6, 18), glowMaterial);
        marker.name = `rail-wave-${index}`;
        marker.rotation.x = Math.PI * 0.5;
        marker.position.y = -length * 0.5 + length * ((index + 0.5) / 8);
        root.add(marker);
      }
    }

    this.scene.add(root);
    this.effects.push({
      root,
      age: 0,
      duration,
      materials: [coreMaterial, glowMaterial],
      update: (progress, delta) => {
        const envelope = Math.pow(1 - progress, 1.8);
        coreMaterial.opacity = envelope * coreOpacity;
        glowMaterial.opacity = envelope * glowOpacity;
        root.scale.x = 0.65 + envelope * 0.55;
        root.scale.z = root.scale.x;
        if (weapon === 'rail') root.rotation.y += 0.2;
        if (weapon === 'machine') root.position.addScaledVector(end.clone().sub(visibleStart).normalize(), delta * 18);
      },
    });
  }

  projectileTrail(position: THREE.Vector3, weapon: 'rocket' | 'plasma', color: number): void {
    const root = new THREE.Group();
    root.name = `${weapon}-projectile-trail`;
    root.position.copy(position);
    const glow = additiveMaterial(color, weapon === 'rocket' ? 0.48 : 0.34);
    const hot = additiveMaterial(weapon === 'rocket' ? 0xffdf8a : 0xf4e8ff, 0.6);
    const materials: THREE.Material[] = [glow, hot];

    if (weapon === 'rocket') {
      const ember = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), hot);
      ember.position.set((this.random() - 0.5) * 0.05, (this.random() - 0.5) * 0.05, 0);
      root.add(ember);
      const smokeMaterial = new THREE.MeshBasicMaterial({
        color: 0x2a2423,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        blending: THREE.NormalBlending,
      });
      materials.push(smokeMaterial);
      const smoke = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 1), smokeMaterial);
      smoke.name = 'rocket-smoke-wisp';
      root.add(smoke);
    } else {
      const mote = new THREE.Mesh(new THREE.IcosahedronGeometry(0.038, 1), hot);
      const ripple = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.008, 5, 14), glow);
      ripple.rotation.set(this.random() * Math.PI, this.random() * Math.PI, this.random() * Math.PI);
      root.add(mote, ripple);
    }

    this.scene.add(root);
    const duration = weapon === 'rocket' ? 0.34 : 0.22;
    this.effects.push({
      root,
      age: 0,
      duration,
      materials,
      update: (progress, delta) => {
        const envelope = Math.pow(1 - progress, 1.4);
        glow.opacity = envelope * (weapon === 'rocket' ? 0.48 : 0.34);
        hot.opacity = envelope * 0.6;
        root.scale.multiplyScalar(1 + delta * (weapon === 'rocket' ? 2.4 : 1.3));
        const smoke = root.getObjectByName('rocket-smoke-wisp') as THREE.Mesh | undefined;
        if (smoke) (smoke.material as THREE.MeshBasicMaterial).opacity = envelope * 0.18;
      },
    });
  }

  updateContinuousLaser(start: THREE.Vector3, end: THREE.Vector3, color: number, delta: number): void {
    if (!this.continuousLaser) this.continuousLaser = this.createContinuousLaser(color);
    const laser = this.continuousLaser;
    const resuming = !laser.root.visible;
    laser.root.visible = true;
    if (resuming) this.laserLaggedEnd.copy(end);

    const lagFactor = 1 - Math.exp(-Math.max(delta, 1 / 120) * 8.5);
    this.laserLaggedEnd.lerp(end, lagFactor);
    const liveVector = end.clone().sub(start);
    const laggedVector = this.laserLaggedEnd.clone().sub(start);
    this.laserBend = 0;
    for (let index = 0; index < this.laserPoints.length; index += 1) {
      const amount = index / (this.laserPoints.length - 1);
      const bend = Math.sin(amount * Math.PI) * 0.72;
      const livePoint = start.clone().addScaledVector(liveVector, amount);
      const laggedPoint = start.clone().addScaledVector(laggedVector, amount);
      this.laserPoints[index].copy(livePoint).lerp(laggedPoint, bend);
      this.laserBend = Math.max(this.laserBend, this.laserPoints[index].distanceTo(livePoint));
    }

    this.laserPhase += delta * 18;
    laser.coreMaterial.opacity = 0.88 + Math.sin(this.laserPhase) * 0.1;
    laser.haloMaterial.opacity = 0.26 + Math.sin(this.laserPhase * 0.73) * 0.07;
    laser.segments.forEach((segment, index) => {
      const segmentStart = this.laserPoints[index];
      const segmentEnd = this.laserPoints[index + 1];
      const coreLength = orientBetween(segment.core, segmentStart, segmentEnd);
      const haloLength = orientBetween(segment.halo, segmentStart, segmentEnd);
      segment.core.scale.set(1, coreLength, 1);
      segment.halo.scale.set(1, haloLength, 1);
    });
  }

  stopContinuousLaser(): void {
    if (this.continuousLaser) this.continuousLaser.root.visible = false;
  }

  impact(position: THREE.Vector3, color: number, weapon: WeaponId, surfaceNormal?: THREE.Vector3): void {
    const root = new THREE.Group();
    root.name = `${weapon}-impact-vfx`;
    root.position.copy(position);
    if (surfaceNormal && surfaceNormal.lengthSq() > 0.5) {
      const normal = surfaceNormal.clone().normalize();
      root.quaternion.setFromUnitVectors(SURFACE_NORMAL, normal);
      root.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(normal, this.random() * Math.PI * 2));
    } else {
      root.lookAt(this.camera.position);
    }
    const glow = additiveMaterial(color, 0.95);
    const hot = additiveMaterial(weapon === 'rocket' ? 0xffc06a : 0xffffff, weapon === 'rocket' ? 0.72 : 1);
    const materials: THREE.Material[] = [glow, hot];
    const heavy = weapon === 'rocket' || weapon === 'rail';
    const radius = weapon === 'rocket' ? 1.8 : weapon === 'rail' ? 1.15 : weapon === 'plasma' ? 0.72 : 0.46;

    const flash = new THREE.Mesh(new THREE.CircleGeometry(radius * (weapon === 'rocket' ? 0.25 : 0.34), 18), hot);
    flash.name = 'impact-flash';
    root.add(flash);
    for (let index = 0; index < (heavy ? 3 : 2); index += 1) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(radius * (0.32 + index * 0.17), radius * (0.38 + index * 0.18), 28), glow);
      ring.name = `impact-ring-${index}`;
      ring.position.z = -0.01 * index;
      ring.userData.phase = index * 0.16;
      root.add(ring);
    }

    const shardCount = heavy ? 14 : weapon === 'plasma' ? 9 : 6;
    for (let index = 0; index < shardCount; index += 1) {
      const shard = new THREE.Mesh(new THREE.ConeGeometry(0.025 + this.random() * 0.02, 0.35 + this.random() * 0.48, 4), index % 3 === 0 ? hot : glow);
      shard.name = `impact-shard-${index}`;
      const angle = (index / shardCount) * Math.PI * 2 + this.random() * 0.25;
      shard.rotation.z = angle;
      shard.position.set(Math.cos(angle) * 0.12, Math.sin(angle) * 0.12, 0.02);
      shard.userData.velocity = new THREE.Vector3(Math.cos(angle), Math.sin(angle), this.random() * 0.25).multiplyScalar(radius * (1.3 + this.random()));
      root.add(shard);
    }

    this.scene.add(root);
    const duration = heavy ? 0.52 : 0.3;
    this.effects.push({
      root,
      age: 0,
      duration,
      materials,
      update: (progress, delta) => {
        const envelope = Math.pow(1 - progress, 1.35);
        hot.opacity = envelope * (weapon === 'rocket' ? 0.72 : 1);
        glow.opacity = envelope * 0.9;
        flash.scale.setScalar(0.5 + progress * 2.4);
        for (const child of root.children) {
          if (child.name.startsWith('impact-ring')) {
            const phase = child.userData.phase as number;
            child.scale.setScalar(0.45 + Math.max(0, progress - phase) * 2.8);
            child.rotation.z += delta * (child.id % 2 ? 4 : -4);
          } else if (child.name.startsWith('impact-shard')) {
            child.position.addScaledVector(child.userData.velocity as THREE.Vector3, delta);
            child.scale.y = Math.max(0.08, envelope);
          }
        }
      },
    });
  }

  mark(position: THREE.Vector3, surfaceNormal: THREE.Vector3, weapon: WeaponId, color: number): void {
    const duplicate = this.marks.find((entry) => entry.weapon === weapon && entry.position.distanceToSquared(position) < 0.012);
    if (duplicate) {
      duplicate.age = 0;
      return;
    }
    const normal = surfaceNormal.clone().normalize();
    if (normal.lengthSq() < 0.5) normal.set(0, 0, 1);
    const root = new THREE.Group();
    root.name = `${weapon}-surface-mark`;
    root.position.copy(position).addScaledVector(normal, 0.018);
    root.quaternion.setFromUnitVectors(SURFACE_NORMAL, normal);
    root.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(normal, this.random() * Math.PI * 2));

    const radii: Record<WeaponId, number> = {
      machine: 0.085,
      shotgun: 0.105,
      rocket: 0.78,
      plasma: 0.3,
      laser: 0.12,
      sniper: 0.16,
      rail: 0.36,
    };
    const radius = radii[weapon];
    const dark = new THREE.MeshBasicMaterial({
      color: weapon === 'rocket' ? 0x050302 : 0x04070b,
      transparent: true,
      opacity: weapon === 'rocket' ? 0.78 : 0.68,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    const accent = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: weapon === 'machine' || weapon === 'shotgun' ? 0.42 : 0.76,
      blending: weapon === 'rocket' ? THREE.NormalBlending : THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
    });
    const crater = new THREE.Mesh(new THREE.CircleGeometry(radius, weapon === 'rocket' ? 18 : 12), dark);
    crater.scale.set(1, 0.82 + this.random() * 0.22, 1);
    root.add(crater);

    if (weapon === 'rocket') {
      for (let index = 0; index < 3; index += 1) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(radius * (0.28 + index * 0.2), radius * (0.34 + index * 0.21), 22),
          index === 0 ? accent : dark,
        );
        ring.position.z = 0.002 + index * 0.001;
        ring.rotation.z = index * 0.73;
        root.add(ring);
      }
      for (let index = 0; index < 9; index += 1) {
        const chip = new THREE.Mesh(new THREE.CircleGeometry(0.045 + this.random() * 0.055, 6), dark);
        const angle = (index / 9) * Math.PI * 2 + this.random() * 0.22;
        chip.position.set(Math.cos(angle) * radius * (0.68 + this.random() * 0.34), Math.sin(angle) * radius * (0.68 + this.random() * 0.34), 0.001);
        root.add(chip);
      }
    } else if (weapon === 'plasma') {
      const residue = new THREE.Mesh(new THREE.RingGeometry(radius * 0.34, radius * 0.74, 20), accent);
      const core = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.18, 12), accent);
      residue.position.z = core.position.z = 0.002;
      root.add(residue, core);
    } else if (weapon === 'laser') {
      const burn = new THREE.Mesh(new THREE.PlaneGeometry(radius * 0.34, radius * 1.8), accent);
      burn.position.z = 0.002;
      root.add(burn);
    } else if (weapon === 'rail') {
      for (let index = 0; index < 3; index += 1) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(radius * (0.18 + index * 0.2), radius * (0.24 + index * 0.2), 26), accent);
        ring.position.z = 0.002 + index * 0.001;
        root.add(ring);
      }
    } else {
      const puncture = new THREE.Mesh(new THREE.RingGeometry(radius * 0.22, radius * 0.5, weapon === 'shotgun' ? 7 : 12), accent);
      puncture.position.z = 0.002;
      root.add(puncture);
    }

    this.scene.add(root);
    this.marks.push({ root, material: dark, accentMaterial: accent, position: position.clone(), weapon, age: 0, duration: weapon === 'rocket' ? 42 : 30 });
    while (this.marks.length > 96) this.removeMark(0);
  }

  stickTracer(target: THREE.Object3D, worldPosition: THREE.Vector3, incomingDirection: THREE.Vector3, color: number): void {
    const direction = incomingDirection.clone().normalize();
    if (direction.lengthSq() < 0.5) return;
    target.updateWorldMatrix(true, true);
    const targetWorldQuaternion = new THREE.Quaternion();
    target.getWorldQuaternion(targetWorldQuaternion);
    const worldQuaternion = new THREE.Quaternion().setFromUnitVectors(FORWARD, direction);
    const localPosition = target.worldToLocal(worldPosition.clone());
    const root = new THREE.Group();
    root.name = 'stuck-tracer';
    root.position.copy(localPosition);
    root.quaternion.copy(targetWorldQuaternion.invert().multiply(worldQuaternion));

    const tracerMaterial = additiveMaterial(color, 0.92, false);
    const hotMaterial = additiveMaterial(0xffffff, 0.96, false);
    const materials = [tracerMaterial, hotMaterial];
    const tracer = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.012, 0.2, 6), tracerMaterial);
    tracer.name = 'tracer-needle';
    tracer.rotation.x = Math.PI * 0.5;
    tracer.position.z = 0.04;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.08, 6), hotMaterial);
    tip.name = 'tracer-tip';
    tip.rotation.x = -Math.PI * 0.5;
    tip.position.z = -0.08;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.008, 5, 12), tracerMaterial);
    ring.name = 'tracer-ring';
    ring.position.z = 0.03;
    ring.rotation.x = Math.PI * 0.5;
    root.add(tracer, tip, ring);
    target.add(root);
    this.effects.push({
      root,
      age: 0,
      duration: 1.8,
      materials,
      kind: 'tracer',
      update: (progress) => {
        const envelope = 1 - THREE.MathUtils.smoothstep(progress, 0.72, 1);
        tracerMaterial.opacity = envelope * 0.92;
        hotMaterial.opacity = envelope * 0.96;
        ring.scale.setScalar(0.92 + Math.sin(progress * Math.PI * 8) * 0.16);
      },
    });
  }

  burst(position: THREE.Vector3, color: number, count: number): void {
    const root = new THREE.Group();
    root.name = 'spark-burst-vfx';
    root.position.copy(position);
    const material = additiveMaterial(color, 0.9);
    const hot = additiveMaterial(0xffffff, 0.8);
    const limitedCount = Math.min(18, Math.max(3, count));
    for (let index = 0; index < limitedCount; index += 1) {
      const length = 0.18 + this.random() * 0.72;
      const spark = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.022, length, 5), index % 4 === 0 ? hot : material);
      spark.name = `spark-${index}`;
      const velocity = new THREE.Vector3(this.random() - 0.5, this.random() * 0.75 + 0.08, this.random() - 0.5).normalize().multiplyScalar(2.6 + this.random() * 5.5);
      spark.userData.velocity = velocity;
      spark.quaternion.setFromUnitVectors(UP, velocity.clone().normalize());
      root.add(spark);
    }
    this.scene.add(root);
    this.effects.push({
      root,
      age: 0,
      duration: 0.3,
      materials: [material, hot],
      update: (progress, delta) => {
        const envelope = 1 - progress;
        material.opacity = envelope * 0.9;
        hot.opacity = envelope;
        for (const child of root.children) {
          const velocity = child.userData.velocity as THREE.Vector3;
          child.position.addScaledVector(velocity, delta);
          velocity.y -= delta * 6.5;
          child.scale.y = envelope;
        }
      },
    });
  }

  createProjectile(weapon: 'rocket' | 'plasma', color: number): THREE.Group {
    const root = new THREE.Group();
    root.name = `${weapon}-projectile`;
    if (weapon === 'rocket') {
      const body = new THREE.MeshStandardMaterial({ color: 0xb9a7a0, roughness: 0.28, metalness: 0.88 });
      const shell = new THREE.MeshPhysicalMaterial({ color: 0x5f1717, roughness: 0.3, metalness: 0.48, clearcoat: 0.62 });
      const glow = additiveMaterial(0xff5b20, 0.82);
      const hot = additiveMaterial(0xfff0bd, 0.96);
      const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.34, 12), shell);
      fuselage.name = 'rocket-fuselage';
      fuselage.rotation.x = Math.PI * 0.5;
      root.add(fuselage);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.15, 12), body);
      nose.rotation.x = -Math.PI * 0.5;
      nose.position.z = -0.245;
      root.add(nose);
      const warheadBand = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.012, 7, 18), glow);
      warheadBand.name = 'rocket-spin-ring';
      warheadBand.rotation.x = Math.PI * 0.5;
      warheadBand.position.z = -0.13;
      root.add(warheadBand);
      for (let index = 0; index < 3; index += 1) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.15, 0.12), index === 0 ? shell : body);
        fin.name = `rocket-fin-${index}`;
        fin.position.z = 0.16;
        fin.rotation.z = index * Math.PI * 2 / 3;
        root.add(fin);
      }
      const exhaust = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.32, 10, 1, true), glow);
      exhaust.rotation.x = Math.PI * 0.5;
      exhaust.position.z = 0.34;
      root.add(exhaust);
      const exhaustCore = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.22, 8, 1, true), hot);
      exhaustCore.rotation.x = Math.PI * 0.5;
      exhaustCore.position.z = 0.29;
      root.add(exhaustCore);
    } else {
      const glow = additiveMaterial(color, 0.82);
      const hot = additiveMaterial(0xffffff, 1);
      root.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.14, 2), hot));
      const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.27, 2), glow);
      shell.name = 'plasma-shell';
      root.add(shell);
      for (let index = 0; index < 3; index += 1) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.018, 6, 22), glow);
        ring.name = `plasma-ring-${index}`;
        ring.rotation.set(index * 1.05, index * 0.7, index * 0.4);
        root.add(ring);
      }
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.65, 10, 1, true), glow);
      tail.rotation.x = Math.PI * 0.5;
      tail.position.z = 0.37;
      root.add(tail);
      root.scale.setScalar(0.62);
    }
    root.traverse((object) => { object.frustumCulled = false; });
    return root;
  }

  createGrenade(color: number): THREE.Group {
    const root = new THREE.Group();
    root.name = 'grenade';
    const shell = new THREE.MeshStandardMaterial({ color: 0x252b31, roughness: 0.34, metalness: 0.76 });
    const glow = additiveMaterial(color, 0.8);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), shell);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.018, 6, 18), glow);
    band.rotation.x = Math.PI * 0.5;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 8), glow);
    cap.position.y = 0.18;
    root.add(body, band, cap);
    root.traverse((object) => { object.frustumCulled = false; });
    return root;
  }

  orientGrenade(root: THREE.Group, velocity: THREE.Vector3, elapsed: number): void {
    if (velocity.lengthSq() > 0.04) root.quaternion.setFromUnitVectors(FORWARD, velocity.clone().normalize());
    root.rotateZ(elapsed * 9.5);
    const cap = root.children.find((child) => child instanceof THREE.Mesh && child.position.y > 0.1);
    if (cap) cap.rotation.z = elapsed * 12;
  }

  grenadeExplosion(position: THREE.Vector3, color: number): void {
    this.impact(position, color, 'rocket');
    this.burst(position, color, 18);
  }

  rocketExplosion(position: THREE.Vector3, color: number): void {
    this.impact(position, color, 'rocket');
    const root = new THREE.Group();
    root.name = 'rocket-blast-wave';
    root.position.copy(position);
    root.lookAt(this.camera.position);
    const glow = additiveMaterial(0xff5b20, 0.82);
    const hot = additiveMaterial(0xfff4c1, 0.96);
    const materials = [glow, hot];
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), hot);
    const wave = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 32), glow);
    wave.position.z = -0.02;
    root.add(core, wave);
    this.scene.add(root);
    this.effects.push({
      root,
      age: 0,
      duration: 0.62,
      materials,
      update: (progress) => {
        const envelope = Math.pow(1 - progress, 1.25);
        hot.opacity = envelope;
        glow.opacity = envelope * 0.86;
        core.scale.setScalar(0.8 + progress * 3.4);
        wave.scale.setScalar(0.6 + progress * 4.6);
        wave.rotation.z += 0.08;
      },
    });
    this.burst(position, color, 24);
  }

  updateGrapple(start: THREE.Vector3, end: THREE.Vector3, active: boolean): void {
    if (!active) {
      this.clearGrapple();
      return;
    }
    if (!this.grappleRoot) {
      this.grappleRoot = new THREE.Group();
      this.grappleRoot.name = 'grapple-vfx';
      this.grappleRoot.renderOrder = 1000;
      const cableMaterial = additiveMaterial(0x6df4ff, 0.98, false);
      this.grappleMaterials.push(cableMaterial);
      const initialRope = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
      this.grappleCable = new THREE.Mesh(new THREE.TubeGeometry(initialRope, 8, 0.035, 6, false), cableMaterial);
      this.grappleCable.name = 'grapple-cable';
      this.grappleCable.frustumCulled = false;
      this.grappleCable.renderOrder = 1000;
      this.grappleHook = new THREE.Mesh(
        new THREE.TorusGeometry(0.19, 0.04, 8, 18),
        additiveMaterial(0xffffff, 1, false),
      );
      this.grappleMaterials.push(this.grappleHook.material as THREE.Material);
      this.grappleHook.frustumCulled = false;
      this.grappleHook.renderOrder = 1001;
      this.grappleHook.rotation.x = Math.PI * 0.5;
      this.grappleHookCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.095, 1), additiveMaterial(0x6df4ff, 1, false));
      this.grappleHookCore.frustumCulled = false;
      this.grappleHookCore.renderOrder = 1001;
      this.grappleMaterials.push(this.grappleHookCore.material as THREE.Material);
      this.grappleRoot.add(this.grappleCable, this.grappleHook, this.grappleHookCore);
      this.scene.add(this.grappleRoot);
    }
    this.grappleRoot.visible = true;
    const cable = this.grappleCable;
    const hook = this.grappleHook;
    if (!cable || !hook) return;
    // Starting exactly at the camera near plane makes even a thin cable's
    // cross-section balloon across the view. Pull it a short distance forward
    // so the cable visibly leaves the lower-left launcher without occluding the screen.
    const cableStart = start.clone();
    const cableDirection = end.clone().sub(start);
    if (cableDirection.lengthSq() > 0.01) cableStart.addScaledVector(cableDirection.normalize(), 0.38);
    const ropeDirection = end.clone().sub(cableStart);
    const distance = ropeDirection.length();
    const side = new THREE.Vector3().crossVectors(ropeDirection, UP);
    if (side.lengthSq() < 0.001) side.set(1, 0, 0);
    else side.normalize();
    const sag = Math.min(0.7, distance * 0.055);
    const flex = Math.sin(this.ropePhase) * Math.min(0.24, distance * 0.018);
    const points = [0.12, 0.34, 0.58, 0.82].map((t) => {
      const point = cableStart.clone().lerp(end, t);
      point.y -= Math.sin(t * Math.PI) * sag;
      point.addScaledVector(side, Math.sin(t * Math.PI) * flex);
      return point;
    });
    const ropeCurve = new THREE.CatmullRomCurve3([cableStart, ...points, end], false, 'catmullrom', 0.18);
    const previousGeometry = cable.geometry;
    cable.geometry = new THREE.TubeGeometry(ropeCurve, 18, 0.035, 6, false);
    previousGeometry.dispose();
    this.ropePhase += 0.055;
    hook.position.copy(end);
    if (this.grappleHookCore) this.grappleHookCore.position.copy(end);
  }

  clearGrapple(): void {
    if (this.grappleRoot) this.grappleRoot.visible = false;
  }

  orientProjectile(root: THREE.Group, direction: THREE.Vector3, elapsed: number, weapon: WeaponId): void {
    root.quaternion.setFromUnitVectors(FORWARD, direction.clone().normalize());
    if (weapon === 'rocket') {
      const spinRing = root.getObjectByName('rocket-spin-ring');
      if (spinRing) spinRing.rotation.z = elapsed * 9;
      for (const child of root.children) {
        if (child.name.startsWith('rocket-fin-')) {
          const index = Number.parseInt(child.name.slice('rocket-fin-'.length), 10) || 0;
          child.rotation.z = index * Math.PI * 2 / 3 + elapsed * 0.8;
        }
      }
    } else if (weapon === 'plasma') {
      for (const child of root.children) {
        if (child.name.startsWith('plasma-ring')) {
          child.rotation.x += 0.08 + (child.id % 3) * 0.02;
          child.rotation.z = elapsed * (1.8 + (child.id % 4) * 0.3);
        } else if (child.name === 'plasma-shell') {
          const pulse = 0.92 + Math.sin(elapsed * 22) * 0.12;
          child.scale.setScalar(pulse);
        }
      }
    }
  }

  update(delta: number): void {
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      effect.age += delta;
      const progress = THREE.MathUtils.clamp(effect.age / effect.duration, 0, 1);
      effect.update(progress, delta);
      if (progress < 1) continue;
      effect.root.parent?.remove(effect.root);
      this.disposeRoot(effect.root, effect.materials);
      this.effects.splice(index, 1);
    }
    for (let index = this.marks.length - 1; index >= 0; index -= 1) {
      const mark = this.marks[index];
      mark.age += delta;
      const fade = 1 - THREE.MathUtils.smoothstep(mark.age, mark.duration - 5, mark.duration);
      mark.material.opacity = (mark.weapon === 'rocket' ? 0.78 : 0.68) * fade;
      mark.accentMaterial.opacity *= fade > 0.98 ? 1 : fade;
      if (mark.age >= mark.duration) this.removeMark(index);
    }
  }

  dispose(): void {
    for (const effect of this.effects) {
      effect.root.parent?.remove(effect.root);
      this.disposeRoot(effect.root, effect.materials);
    }
    this.effects.length = 0;
    while (this.marks.length) this.removeMark(this.marks.length - 1);
    if (this.continuousLaser) {
      this.scene.remove(this.continuousLaser.root);
      this.continuousLaser.coreGeometry.dispose();
      this.continuousLaser.haloGeometry.dispose();
      this.continuousLaser.coreMaterial.dispose();
      this.continuousLaser.haloMaterial.dispose();
      this.continuousLaser = undefined;
    }
    if (this.grappleRoot) {
      this.grappleRoot.parent?.remove(this.grappleRoot);
      this.disposeRoot(this.grappleRoot, this.grappleMaterials);
      this.grappleRoot = undefined;
      this.grappleCable = undefined;
      this.grappleHook = undefined;
      this.grappleHookCore = undefined;
      this.grappleMaterials.length = 0;
    }
  }

  get activeEffects(): number {
    return this.effects.length + (this.continuousLaser?.root.visible ? 1 : 0);
  }

  get activeMarks(): number {
    return this.marks.length;
  }

  get activeTracers(): number {
    return this.effects.filter((effect) => effect.kind === 'tracer').length;
  }

  get continuousLaserActive(): boolean {
    return this.continuousLaser?.root.visible ?? false;
  }

  get continuousLaserBend(): number {
    return this.continuousLaserActive ? this.laserBend : 0;
  }

  private createContinuousLaser(color: number): ContinuousLaser {
    const root = new THREE.Group();
    root.name = 'laser-continuous-beam';
    root.visible = false;
    const coreMaterial = additiveMaterial(0xeafff1, 0.95);
    const haloMaterial = additiveMaterial(color, 0.3);
    const coreGeometry = new THREE.CylinderGeometry(0.018, 0.012, 1, 8, 1, true);
    const haloGeometry = new THREE.CylinderGeometry(0.085, 0.05, 1, 10, 1, true);
    const segments: ContinuousLaser['segments'] = [];
    for (let index = 0; index < this.laserPoints.length - 1; index += 1) {
      const halo = new THREE.Mesh(haloGeometry, haloMaterial);
      const core = new THREE.Mesh(coreGeometry, coreMaterial);
      halo.name = `laser-halo-segment-${index}`;
      core.name = `laser-core-segment-${index}`;
      halo.frustumCulled = false;
      core.frustumCulled = false;
      root.add(halo, core);
      segments.push({ core, halo });
    }
    this.scene.add(root);
    return { root, segments, coreGeometry, haloGeometry, coreMaterial, haloMaterial };
  }

  private disposeRoot(root: THREE.Object3D, materials: THREE.Material[]): void {
    const geometries = new Set<THREE.BufferGeometry>();
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of new Set(materials)) material.dispose();
  }

  private removeMark(index: number): void {
    const mark = this.marks[index];
    mark.root.parent?.remove(mark.root);
    this.disposeRoot(mark.root, [mark.material, mark.accentMaterial]);
    this.marks.splice(index, 1);
  }
}
