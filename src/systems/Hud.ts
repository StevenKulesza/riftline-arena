export type HudState = {
  health: number;
  armor: number;
  speed: number;
  score: number;
  botLead: number;
  timeRemaining: number;
  weapon: string;
  ammo: number;
  coreProgress: number;
  coreStatus: string;
  matchStatus: string;
  fps: number;
  powerups: string[];
  railTimer: number;
};

type OverlayMode = 'ready' | 'paused' | 'complete';

export class Hud {
  private readonly health = this.element('#health-value');
  private readonly armor = this.element('#armor-value');
  private readonly speed = this.element('#speed-value');
  private readonly score = this.element('#score-value');
  private readonly botLead = this.element('#bot-lead-value');
  private readonly timer = this.element('#timer-value');
  private readonly weapon = this.element('#weapon-name');
  private readonly ammo = this.element('#ammo-value');
  private readonly coreFill = this.element('#core-fill');
  private readonly coreStatus = this.element('#core-status');
  private readonly matchStatus = this.element('#match-status');
  private readonly fps = this.element('#fps-value');
  private readonly powerups = this.element('#powerup-list');
  private readonly railTimer = this.element('#rail-timer');
  private readonly crosshair = this.element('#crosshair');
  private readonly damageVignette = this.element('#damage-vignette');
  private readonly countdownOverlay = this.element('#countdown-overlay');
  private readonly countdownValue = this.element('#countdown-value');
  private readonly startOverlay = this.element('#start-overlay');
  private readonly respawnOverlay = this.element('#respawn-overlay');
  private readonly respawnText = this.element('#respawn-text');
  private readonly killFeed = this.element('#kill-feed');
  private readonly overlayKicker = this.element('#overlay-kicker');
  private readonly overlayTagline = this.element('#overlay-tagline');
  private readonly overlayNetwork = this.element('#overlay-network');
  private readonly overlayFootnote = this.element('#overlay-footnote');
  private readonly startButton = this.element<HTMLButtonElement>('#start-button');

  update(state: HudState): void {
    this.health.textContent = String(Math.max(0, Math.ceil(state.health)));
    this.armor.textContent = String(Math.max(0, Math.ceil(state.armor)));
    this.speed.textContent = `${Math.round(state.speed * 3.6)}`;
    this.score.textContent = String(state.score);
    this.botLead.textContent = String(state.botLead);
    const minutes = Math.floor(Math.max(0, state.timeRemaining) / 60).toString().padStart(2, '0');
    const seconds = Math.floor(Math.max(0, state.timeRemaining) % 60).toString().padStart(2, '0');
    this.timer.textContent = `${minutes}:${seconds}`;
    this.weapon.textContent = state.weapon;
    this.ammo.textContent = state.ammo < 0 ? '∞' : String(state.ammo);
    this.coreFill.style.width = `${Math.round(Math.min(1, state.coreProgress) * 100)}%`;
    this.coreStatus.textContent = state.coreStatus;
    this.matchStatus.textContent = state.matchStatus;
    const displayedFps = Number.isFinite(state.fps) ? Math.max(0, Math.min(999, state.fps)) : 0;
    this.fps.textContent = `${Math.round(displayedFps)} FPS`;
    this.powerups.textContent = state.powerups.length ? state.powerups.join(' · ') : 'NO ACTIVE BOOST';
    this.railTimer.textContent = state.railTimer <= 0 ? 'RAIL READY' : `RAIL ${Math.ceil(state.railTimer)}s`;
    this.health.parentElement?.classList.toggle('critical', state.health <= 30);
    this.health.closest<HTMLElement>('.vital')?.style.setProperty('--meter', `${Math.min(100, state.health)}%`);
    this.armor.closest<HTMLElement>('.vital')?.style.setProperty('--meter', `${Math.min(100, state.armor)}%`);
  }

  hideStart(): void {
    this.startOverlay.classList.add('hidden');
  }

  showStart(mode: OverlayMode = 'ready'): void {
    this.startOverlay.dataset.mode = mode;
    if (mode === 'paused') {
      this.overlayKicker.textContent = 'Match control // Paused';
      this.overlayTagline.innerHTML = 'Combat frame held <strong>· Resume when ready</strong>';
      this.overlayNetwork.textContent = 'SESSION HELD';
      this.overlayFootnote.textContent = 'Pointer release is safe · audio is paused';
    } else if (mode === 'complete') {
      this.overlayKicker.textContent = 'Match report // Session complete';
      this.overlayTagline.innerHTML = 'Arena result <strong>· Review the line</strong>';
      this.overlayNetwork.textContent = 'SESSION CLOSED';
      this.overlayFootnote.textContent = 'Restart to redeploy · first to 20 or highest score at 06:00';
    } else {
      this.overlayKicker.textContent = 'Arena FPS // Live combat';
      this.overlayTagline.innerHTML = 'WCA1 // Rift Sector <strong>· First to 20</strong>';
      this.overlayNetwork.textContent = 'NETWORK READY';
      this.overlayFootnote.textContent = 'Six minute arena match · mouse captures on deploy';
    }
    this.startOverlay.classList.remove('hidden');
    this.startButton.focus({ preventScroll: true });
  }

  setRespawn(seconds: number, cause = ''): void {
    const active = seconds > 0;
    this.respawnOverlay.classList.toggle('hidden', !active);
    if (active) this.respawnText.textContent = `${cause ? `${cause} · ` : ''}REDEPLOY ${seconds.toFixed(1)}`;
  }

  showCountdown(label: 'READY' | '3' | '2' | '1'): void {
    this.countdownValue.textContent = label;
    this.countdownOverlay.dataset.cue = label === 'READY' ? 'ready' : 'number';
    this.countdownOverlay.classList.remove('hidden', 'pulse');
    void this.countdownValue.offsetWidth;
    this.countdownOverlay.classList.add('pulse');
  }

  hideCountdown(): void {
    this.countdownOverlay.classList.add('hidden');
    this.countdownOverlay.classList.remove('pulse');
  }

  hitMarker(kill = false): void {
    this.crosshair.classList.remove('hit', 'kill');
    void this.crosshair.offsetWidth;
    this.crosshair.classList.add(kill ? 'kill' : 'hit');
    window.setTimeout(() => this.crosshair.classList.remove('hit', 'kill'), kill ? 180 : 100);
  }

  damage(direction = ''): void {
    this.damageVignette.dataset.direction = direction;
    this.damageVignette.classList.remove('flash');
    void this.damageVignette.offsetWidth;
    this.damageVignette.classList.add('flash');
  }

  message(text: string): void {
    const line = document.createElement('div');
    line.textContent = text;
    this.killFeed.prepend(line);
    while (this.killFeed.children.length > 4) this.killFeed.lastElementChild?.remove();
    window.setTimeout(() => line.remove(), 4200);
  }

  pulseObjective(): void {
    this.coreStatus.animate(
      [{ transform: 'scale(1)', color: '#bdefff' }, { transform: 'scale(1.12)', color: '#ffffff' }, { transform: 'scale(1)', color: '#bdefff' }],
      { duration: 320, easing: 'ease-out' },
    );
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error(`Missing HUD element: ${selector}`);
    return node;
  }
}
