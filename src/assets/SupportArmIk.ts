import * as THREE from 'three';

/** Small allocation-free CCD solver that layers a support-hand grip over authored clips. */
export class SupportArmIk {
  private root?: THREE.Object3D;
  private upper?: THREE.Object3D;
  private lower?: THREE.Object3D;
  private wrist?: THREE.Object3D;
  private readonly jointPosition = new THREE.Vector3();
  private readonly wristPosition = new THREE.Vector3();
  private readonly currentDirection = new THREE.Vector3();
  private readonly desiredDirection = new THREE.Vector3();
  private readonly deltaWorld = new THREE.Quaternion();
  private readonly deltaTarget = new THREE.Quaternion();
  private readonly identity = new THREE.Quaternion();
  private readonly jointWorld = new THREE.Quaternion();
  private readonly parentWorldInverse = new THREE.Quaternion();
  private readonly bestUpper = new THREE.Quaternion();
  private readonly bestLower = new THREE.Quaternion();

  attach(root: THREE.Object3D, side: 'L' | 'R' = 'L'): void {
    this.root = root;
    this.upper = root.getObjectByName(`UpperArm${side}`);
    this.lower = root.getObjectByName(`LowerArm${side}`);
    this.wrist = root.getObjectByName(`Wrist${side}`);
  }

  solve(targetWorld: THREE.Vector3): number {
    if (!this.root || !this.upper || !this.lower || !this.wrist) return Number.POSITIVE_INFINITY;
    this.root.updateWorldMatrix(true, true);
    this.wrist.getWorldPosition(this.wristPosition);
    let bestErrorSquared = this.wristPosition.distanceToSquared(targetWorld);
    this.bestUpper.copy(this.upper.quaternion);
    this.bestLower.copy(this.lower.quaternion);
    for (let iteration = 0; iteration < 24; iteration += 1) {
      if (iteration % 2 === 0) {
        this.rotateJoint(this.lower, targetWorld, 0.72);
        this.rotateJoint(this.upper, targetWorld, 0.72);
      } else {
        this.rotateJoint(this.upper, targetWorld, 0.72);
        this.rotateJoint(this.lower, targetWorld, 0.72);
      }
      this.wrist.getWorldPosition(this.wristPosition);
      const errorSquared = this.wristPosition.distanceToSquared(targetWorld);
      if (errorSquared < bestErrorSquared) {
        bestErrorSquared = errorSquared;
        this.bestUpper.copy(this.upper.quaternion);
        this.bestLower.copy(this.lower.quaternion);
      }
      if (errorSquared < 0.0004) break;
    }
    this.upper.quaternion.copy(this.bestUpper);
    this.lower.quaternion.copy(this.bestLower);
    this.root.updateWorldMatrix(true, true);
    this.wrist.getWorldPosition(this.wristPosition);
    return this.wristPosition.distanceTo(targetWorld);
  }

  private rotateJoint(joint: THREE.Object3D, targetWorld: THREE.Vector3, weight: number): void {
    if (!this.wrist || !joint.parent) return;
    joint.updateWorldMatrix(true, false);
    this.wrist.updateWorldMatrix(true, false);
    joint.getWorldPosition(this.jointPosition);
    this.wrist.getWorldPosition(this.wristPosition);
    this.currentDirection.subVectors(this.wristPosition, this.jointPosition);
    this.desiredDirection.subVectors(targetWorld, this.jointPosition);
    if (this.currentDirection.lengthSq() < 1e-7 || this.desiredDirection.lengthSq() < 1e-7) return;
    this.currentDirection.normalize();
    this.desiredDirection.normalize();
    this.deltaTarget.setFromUnitVectors(this.currentDirection, this.desiredDirection);
    this.deltaWorld.slerpQuaternions(this.identity, this.deltaTarget, weight);
    joint.getWorldQuaternion(this.jointWorld);
    this.jointWorld.premultiply(this.deltaWorld);
    joint.parent.getWorldQuaternion(this.parentWorldInverse).invert();
    joint.quaternion.copy(this.parentWorldInverse.multiply(this.jointWorld)).normalize();
    joint.updateWorldMatrix(true, true);
  }
}
