import * as THREE from 'three';

type TouchState = {
  active: boolean;
  id: number | null;
  centerX: number;
  centerY: number;
  radius: number;
};

export class InputController {
  private readonly keys = new Set<string>();
  private readonly movement = new THREE.Vector2();
  private readonly touchMovement = new THREE.Vector2();
  private readonly lookDelta = new THREE.Vector2();
  private readonly touchState: TouchState = { active: false, id: null, centerX: 0, centerY: 0, radius: 1 };
  private fireHeld = false;
  private mousePrimaryHeld = false;
  private jumpQueued = false;
  private dashQueued = false;
  private grappleQueued = false;
  private grenadeQueued = false;
  private altFireHeld = false;
  private altFireQueued = false;
  private requestedWeapon: number | null = null;
  private weaponWheel = 0;
  private pauseQueued = false;
  private muteQueued = false;
  private viewToggleQueued = false;
  private hasInteracted = false;
  private blurClearTimer = 0;
  private dragLookActive = false;
  private lastDragX = 0;
  private lastDragY = 0;
  private lockAllowed = false;
  private lockRequestPending = false;
  private lookSensitivity = 1;
  private hoverLookEnabled = false;
  private touchLookPointer: number | null = null;
  private touchLookX = 0;
  private touchLookY = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stick: HTMLElement,
    private readonly knob: HTMLElement,
    private readonly fireButton: HTMLElement,
    private readonly jumpButton: HTMLElement,
    private readonly skiButton: HTMLElement,
    private readonly grappleButton: HTMLElement,
    private readonly grenadeButton: HTMLElement,
    private readonly dashButton: HTMLElement,
    private readonly weaponButton: HTMLElement,
    private readonly zoomButton: HTMLElement,
    private readonly viewButton: HTMLElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('pointerlockerror', this.onPointerLockError);
    this.canvas.addEventListener('pointerdown', this.onCanvasPointerDown);
    this.canvas.addEventListener('pointermove', this.onCanvasPointerMove);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.stick.addEventListener('pointerdown', this.onStickDown);
    this.stick.addEventListener('pointermove', this.onStickMove);
    this.stick.addEventListener('pointerup', this.onStickUp);
    this.stick.addEventListener('pointercancel', this.onStickUp);
    this.fireButton.addEventListener('pointerdown', this.onFireDown);
    this.fireButton.addEventListener('pointerup', this.onFireUp);
    this.fireButton.addEventListener('pointercancel', this.onFireUp);
    this.jumpButton.addEventListener('pointerdown', this.onJumpDown);
    this.jumpButton.addEventListener('pointerup', this.onJumpUp);
    this.jumpButton.addEventListener('pointercancel', this.onJumpUp);
    this.skiButton.addEventListener('pointerdown', this.onSkiDown);
    this.skiButton.addEventListener('pointerup', this.onSkiUp);
    this.skiButton.addEventListener('pointercancel', this.onSkiUp);
    this.grappleButton.addEventListener('pointerdown', this.onGrappleDown);
    this.grappleButton.addEventListener('pointerup', this.onGrappleUp);
    this.grappleButton.addEventListener('pointercancel', this.onGrappleUp);
    this.grenadeButton.addEventListener('pointerdown', this.onGrenadeDown);
    this.dashButton.addEventListener('pointerdown', this.onDashDown);
    this.weaponButton.addEventListener('pointerdown', this.onWeaponDown);
    this.zoomButton.addEventListener('pointerdown', this.onZoomDown);
    this.zoomButton.addEventListener('pointerup', this.onZoomUp);
    this.zoomButton.addEventListener('pointercancel', this.onZoomUp);
    this.viewButton.addEventListener('pointerdown', this.onViewDown);
  }

  readMovement(target: THREE.Vector2): THREE.Vector2 {
    this.movement.set(0, 0);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.movement.x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.movement.x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.movement.y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.movement.y -= 1;
    target.copy(this.movement).add(this.touchMovement);
    if (target.lengthSq() > 1) target.normalize();
    return target;
  }

  consumeLook(target: THREE.Vector2): THREE.Vector2 {
    target.copy(this.lookDelta).multiplyScalar(this.lookSensitivity);
    this.lookDelta.set(0, 0);
    return target;
  }

  setLookSensitivity(value: number): void {
    this.lookSensitivity = THREE.MathUtils.clamp(value, 0.5, 2);
  }

  consumeJump(): boolean {
    const value = this.jumpQueued;
    this.jumpQueued = false;
    return value;
  }

  consumeDash(): boolean {
    const value = this.dashQueued;
    this.dashQueued = false;
    return value;
  }

  consumeGrapple(): boolean {
    const value = this.grappleQueued;
    this.grappleQueued = false;
    return value;
  }

  consumeGrenade(): boolean {
    const value = this.grenadeQueued;
    this.grenadeQueued = false;
    return value;
  }

  consumeAltFire(): boolean {
    const value = this.altFireQueued;
    this.altFireQueued = false;
    return value;
  }

  isAltFireHeld(): boolean {
    return this.altFireHeld || this.keys.has('KeyC') || this.zoomButton.dataset.held === 'true';
  }

  isGrappleHeld(): boolean {
    return this.keys.has('KeyG') || this.grappleButton.dataset.held === 'true';
  }

  consumeWeaponRequest(): number | null {
    if (this.requestedWeapon !== null) {
      const value = this.requestedWeapon;
      this.requestedWeapon = null;
      return value;
    }
    if (this.weaponWheel !== 0) {
      const value = this.weaponWheel > 0 ? 100 : -100;
      this.weaponWheel = 0;
      return value;
    }
    return null;
  }

  consumePause(): boolean {
    const value = this.pauseQueued;
    this.pauseQueued = false;
    return value;
  }

  consumeMute(): boolean {
    const value = this.muteQueued;
    this.muteQueued = false;
    return value;
  }

  consumeViewToggle(): boolean {
    const value = this.viewToggleQueued;
    this.viewToggleQueued = false;
    return value;
  }

  isFireHeld(): boolean {
    return this.fireHeld || this.mousePrimaryHeld || this.keys.has('KeyF');
  }

  isSkiHeld(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.skiButton.dataset.held === 'true';
  }

  isJumpHeld(): boolean {
    return this.keys.has('Space') || this.jumpButton.dataset.held === 'true';
  }

  isZoomHeld(): boolean {
    return this.keys.has('KeyC') || this.keys.has('ControlLeft') || this.keys.has('ControlRight')
      || this.isAltFireHeld();
  }

  interacted(): boolean {
    return this.hasInteracted || this.keys.size > 0 || this.touchState.active;
  }

  pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  setPointerLockAllowed(allowed: boolean): void {
    this.lockAllowed = allowed;
    if (!allowed) this.hoverLookEnabled = false;
    if (!allowed && this.pointerLocked()) document.exitPointerLock?.();
  }

  /** Re-acquire pointer lock from a user-gesture path (click, key, etc.). */
  requestGameplayPointerLock(): void {
    if (!this.lockAllowed || this.pointerLocked() || this.lockRequestPending) return;
    this.lockRequestPending = true;
    const clearPending = (): void => {
      this.lockRequestPending = false;
    };
    const useHoverFallback = (): void => {
      this.lockRequestPending = false;
      this.hoverLookEnabled = true;
    };
    try {
      // Avoid unadjustedMovement — many Linux/Wayland sessions reject it and surface
      // an unhandled promise rejection, which breaks aim entirely.
      const result = this.canvas.requestPointerLock() as Promise<void> | void;
      if (result && typeof (result as Promise<void>).then === 'function') {
        void (result as Promise<void>).then(clearPending, useHoverFallback);
      } else {
        window.setTimeout(clearPending, 250);
      }
    } catch {
      useHoverFallback();
    }
  }

  dispose(): void {
    window.clearTimeout(this.blurClearTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('pointerlockerror', this.onPointerLockError);
    this.canvas.removeEventListener('pointerdown', this.onCanvasPointerDown);
    this.canvas.removeEventListener('pointermove', this.onCanvasPointerMove);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.stick.removeEventListener('pointerdown', this.onStickDown);
    this.stick.removeEventListener('pointermove', this.onStickMove);
    this.stick.removeEventListener('pointerup', this.onStickUp);
    this.stick.removeEventListener('pointercancel', this.onStickUp);
    this.fireButton.removeEventListener('pointerdown', this.onFireDown);
    this.fireButton.removeEventListener('pointerup', this.onFireUp);
    this.fireButton.removeEventListener('pointercancel', this.onFireUp);
    this.jumpButton.removeEventListener('pointerdown', this.onJumpDown);
    this.jumpButton.removeEventListener('pointerup', this.onJumpUp);
    this.jumpButton.removeEventListener('pointercancel', this.onJumpUp);
    this.skiButton.removeEventListener('pointerdown', this.onSkiDown);
    this.skiButton.removeEventListener('pointerup', this.onSkiUp);
    this.skiButton.removeEventListener('pointercancel', this.onSkiUp);
    this.grappleButton.removeEventListener('pointerdown', this.onGrappleDown);
    this.grappleButton.removeEventListener('pointerup', this.onGrappleUp);
    this.grappleButton.removeEventListener('pointercancel', this.onGrappleUp);
    this.grenadeButton.removeEventListener('pointerdown', this.onGrenadeDown);
    this.dashButton.removeEventListener('pointerdown', this.onDashDown);
    this.weaponButton.removeEventListener('pointerdown', this.onWeaponDown);
    this.zoomButton.removeEventListener('pointerdown', this.onZoomDown);
    this.zoomButton.removeEventListener('pointerup', this.onZoomUp);
    this.zoomButton.removeEventListener('pointercancel', this.onZoomUp);
    this.viewButton.removeEventListener('pointerdown', this.onViewDown);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
    this.hasInteracted = true;
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat) this.jumpQueued = true;
    }
    if (!event.repeat && event.code === 'KeyE') {
      this.dashQueued = true;
    }
    if (!event.repeat && event.code === 'CapsLock') {
      event.preventDefault();
      this.dashQueued = true;
    }
    if (!event.repeat && event.code === 'KeyG') this.grappleQueued = true;
    if (!event.repeat && event.code === 'KeyQ') this.grenadeQueued = true;
    if (!event.repeat && event.code === 'KeyC') {
      event.preventDefault();
      this.altFireQueued = true;
    }
    if (/^Digit[1-8]$/.test(event.code)) this.requestedWeapon = Number(event.code.slice(-1)) - 1;
    if (!event.repeat && (event.code === 'KeyP' || event.code === 'Escape')) this.pauseQueued = true;
    if (!event.repeat && event.code === 'KeyM') this.muteQueued = true;
    if (!event.repeat && event.code === 'KeyV') this.viewToggleQueued = true;

  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = (): void => {
    // Pointer-lock transitions can blur the window without releasing physical keys.
    window.clearTimeout(this.blurClearTimer);
    this.blurClearTimer = window.setTimeout(() => {
      if (this.pointerLocked() || document.hasFocus()) return;
      this.keys.clear();
      this.fireHeld = false;
      this.altFireHeld = false;
      this.mousePrimaryHeld = false;
      this.dragLookActive = false;
      this.touchLookPointer = null;
      this.touchMovement.set(0, 0);
      this.jumpButton.dataset.held = 'false';
      this.grappleQueued = false;
      this.grenadeQueued = false;
      this.grappleButton.dataset.held = 'false';
    }, 0);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.pointerLocked()) {
      this.lookDelta.x += event.movementX;
      this.lookDelta.y += event.movementY;
      this.mousePrimaryHeld = (event.buttons & 1) === 1;
      return;
    }

    // Embedded browsers and some Wayland sessions reject pointer lock. Once the
    // canvas has been engaged, hover motion remains a stable aiming fallback and
    // is independent of simultaneous keyboard movement.
    if (!this.dragLookActive && !this.hoverLookEnabled) return;
    const deltaX = Number.isFinite(event.movementX) && event.movementX !== 0
      ? event.movementX
      : event.clientX - this.lastDragX;
    const deltaY = Number.isFinite(event.movementY) && event.movementY !== 0
      ? event.movementY
      : event.clientY - this.lastDragY;
    this.lookDelta.x += deltaX;
    this.lookDelta.y += deltaY;
    this.lastDragX = event.clientX;
    this.lastDragY = event.clientY;
    this.mousePrimaryHeld = (event.buttons & 1) === 1;
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button === 2) {
      this.altFireHeld = true;
      this.altFireQueued = true;
      this.hasInteracted = true;
      this.requestGameplayPointerLock();
      return;
    }
    if (event.button !== 0) return;
    this.mousePrimaryHeld = true;
    this.hasInteracted = true;
    this.dragLookActive = true;
    this.lastDragX = event.clientX;
    this.lastDragY = event.clientY;
    this.requestGameplayPointerLock();
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button === 2) {
      this.altFireHeld = false;
      return;
    }
    if (event.button !== 0) return;
    this.mousePrimaryHeld = false;
    this.dragLookActive = false;
  };

  private readonly onPointerLockChange = (): void => {
    this.lockRequestPending = false;
    if (this.pointerLocked()) {
      this.dragLookActive = false;
      this.hoverLookEnabled = false;
      return;
    }
    if (this.lockAllowed && this.hasInteracted) this.hoverLookEnabled = true;
    this.fireHeld = false;
    this.altFireHeld = false;
    this.mousePrimaryHeld = false;
  };

  private readonly onPointerLockError = (): void => {
    this.lockRequestPending = false;
    this.hoverLookEnabled = true;
    this.dragLookActive = this.mousePrimaryHeld;
  };

  private readonly onCanvasPointerDown = (event: PointerEvent): void => {
    this.hasInteracted = true;
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
      if (this.touchLookPointer !== null) return;
      event.preventDefault();
      this.touchLookPointer = event.pointerId;
      this.touchLookX = event.clientX;
      this.touchLookY = event.clientY;
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events may not be capturable.
      }
      return;
    }
    if (event.button === 0) {
      this.fireHeld = true;
      this.dragLookActive = true;
      this.hoverLookEnabled = true;
      this.lastDragX = event.clientX;
      this.lastDragY = event.clientY;
    }
    if (event.button === 2) {
      this.altFireHeld = true;
      this.altFireQueued = true;
    }
    if (event.pointerType === 'mouse') this.requestGameplayPointerLock();
  };

  private readonly onCanvasPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.touchLookPointer) return;
    event.preventDefault();
    // Touch needs a little more gain than relative mouse input, but clamp
    // individual samples so a browser gesture hand-off cannot whip the view.
    const deltaX = THREE.MathUtils.clamp(event.clientX - this.touchLookX, -48, 48);
    const deltaY = THREE.MathUtils.clamp(event.clientY - this.touchLookY, -48, 48);
    this.lookDelta.x += deltaX * 1.35;
    this.lookDelta.y += deltaY * 1.35;
    this.touchLookX = event.clientX;
    this.touchLookY = event.clientY;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.touchLookPointer) {
      this.touchLookPointer = null;
      return;
    }
    if (event.button === 0) {
      this.fireHeld = false;
      this.dragLookActive = false;
    }
    if (event.button === 2) this.altFireHeld = false;
  };

  private readonly onContextMenu = (event: MouseEvent): void => event.preventDefault();

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.weaponWheel += Math.sign(event.deltaY);
  };

  private readonly onStickDown = (event: PointerEvent): void => {
    event.preventDefault();
    const rect = this.stick.getBoundingClientRect();
    this.hasInteracted = true;
    this.touchState.active = true;
    this.touchState.id = event.pointerId;
    this.touchState.centerX = rect.left + rect.width / 2;
    this.touchState.centerY = rect.top + rect.height / 2;
    this.touchState.radius = rect.width * 0.42;
    try {
      this.stick.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events may not be capturable.
    }
    this.updateStick(event.clientX, event.clientY);
  };

  private readonly onStickMove = (event: PointerEvent): void => {
    if (!this.touchState.active || event.pointerId !== this.touchState.id) return;
    event.preventDefault();
    this.updateStick(event.clientX, event.clientY);
  };

  private readonly onStickUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.touchState.id) return;
    this.touchState.active = false;
    this.touchState.id = null;
    this.touchMovement.set(0, 0);
    this.updateKnob();
  };

  private readonly onFireDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hasInteracted = true;
    this.fireHeld = true;
  };

  private readonly onFireUp = (event: PointerEvent): void => {
    event.preventDefault();
    this.fireHeld = false;
  };

  private readonly onJumpDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hasInteracted = true;
    this.jumpQueued = true;
    this.jumpButton.dataset.held = 'true';
  };

  private readonly onJumpUp = (): void => {
    this.jumpButton.dataset.held = 'false';
  };

  private readonly onSkiDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hasInteracted = true;
    this.skiButton.dataset.held = 'true';
  };

  private readonly onSkiUp = (event: PointerEvent): void => {
    event.preventDefault();
    this.skiButton.dataset.held = 'false';
  };

  private readonly onGrappleDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hasInteracted = true;
    this.grappleQueued = true;
    this.grappleButton.dataset.held = 'true';
  };

  private readonly onGrappleUp = (): void => {
    this.grappleButton.dataset.held = 'false';
  };

  private readonly onGrenadeDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hasInteracted = true;
    this.grenadeQueued = true;
  };

  private readonly onDashDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hasInteracted = true;
    this.dashQueued = true;
  };

  private readonly onWeaponDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hasInteracted = true;
    this.weaponWheel += 1;
  };

  private readonly onZoomDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hasInteracted = true;
    this.zoomButton.dataset.held = 'true';
    this.altFireQueued = true;
  };

  private readonly onZoomUp = (): void => {
    this.zoomButton.dataset.held = 'false';
  };

  private readonly onViewDown = (event: PointerEvent): void => {
    event.preventDefault();
    this.hasInteracted = true;
    this.viewToggleQueued = true;
  };

  private updateStick(clientX: number, clientY: number): void {
    this.touchMovement.set(
      (clientX - this.touchState.centerX) / this.touchState.radius,
      -(clientY - this.touchState.centerY) / this.touchState.radius,
    );
    if (this.touchMovement.lengthSq() > 1) this.touchMovement.normalize();
    this.updateKnob();
  }

  private updateKnob(): void {
    const distance = 38;
    this.knob.style.transform = `translate(calc(-50% + ${this.touchMovement.x * distance}px), calc(-50% + ${-this.touchMovement.y * distance}px))`;
  }
}
