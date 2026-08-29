export type HudStanding = {
  callsign: string;
  score: number;
  rank?: number;
  isPlayer?: boolean;
  isLeader?: boolean;
};

export type HudObjectiveState = {
  location?: string;
  phase?: string;
  contestState?: string;
  nextEventLabel?: string;
  nextEventSeconds?: number;
};

export type HudStyleState = {
  medal: string;
  /** Normalized 0–1 style meter value. */
  meter?: number;
};

export type HudWeatherState = {
  phase: string;
  detail?: string;
};

export type HudJetpackState = {
  /** Normalized 0–1 charge. */
  charge: number;
  phase: 'ready' | 'burning' | 'available' | 'cooldown' | 'recharging' | 'depleted';
};

export type HudState = {
  health: number;
  armor: number;
  speed: number;
  score: number;
  botLead: number;
  timeRemaining: number;
  weapon: string;
  secondary: string;
  ammo: number;
  coreProgress: number;
  coreStatus: string;
  matchStatus: string;
  fps: number;
  powerups: string[];
  railTimer: number;
  jetpack: HudJetpackState;
  standings?: readonly HudStanding[];
  objective?: HudObjectiveState;
  style?: HudStyleState | null;
  weather?: HudWeatherState | null;
};

type OverlayMode = 'ready' | 'paused' | 'complete';

export class Hud {
  private readonly health = this.element('#health-value');
  private readonly armor = this.element('#armor-value');
  private readonly speed = this.element('#speed-value');
  private readonly jetpackReadout = this.element('#jetpack-readout');
  private readonly jetpackValue = this.element('#jetpack-value');
  private readonly jetpackTrack = this.element('#jetpack-track');
  private readonly jetpackFill = this.element('#jetpack-fill');
  private readonly jumpButton = this.element<HTMLButtonElement>('#jump-button');
  private readonly touchJetpackValue = this.element('#touch-jetpack-value');
  private readonly score = this.element('#score-value');
  private readonly botLead = this.element('#bot-lead-value');
  private readonly timer = this.element('#timer-value');
  private readonly weapon = this.element('#weapon-name');
  private readonly secondary = this.element('#weapon-secondary');
  private readonly ammo = this.element('#ammo-value');
  private readonly standingRows = this.elements<HTMLElement>('[data-standing-slot]');
  private readonly coreTrack = this.element('.core-track');
  private readonly coreFill = this.element('#core-fill');
  private readonly coreLocation = this.element('#core-location');
  private readonly corePhase = this.element('#core-phase');
  private readonly coreStatus = this.element('#core-status');
  private readonly coreProgressLabel = this.element('#core-progress-label');
  private readonly objectiveEvent = this.element('#objective-event');
  private readonly matchStatus = this.element('#match-status');
  private readonly fps = this.element('#fps-value');
  private readonly powerups = this.element('#powerup-list');
  private readonly railTimer = this.element('#rail-timer');
  private readonly arenaContext = this.element('#arena-context');
  private readonly styleSlot = this.element('#style-slot');
  private readonly styleMedal = this.element('#style-medal');
  private readonly styleMeter = this.element('#style-meter');
  private readonly styleMeterFill = this.element('#style-meter-fill');
  private readonly weatherSlot = this.element('#weather-slot');
  private readonly weatherPhase = this.element('#weather-phase');
  private readonly weatherDetail = this.element('#weather-detail');
  private readonly crosshair = this.element('#crosshair');
  private readonly scopeOverlay = this.element('#scope-overlay');
  private readonly scopeRange = this.element('#scope-range');
  private readonly scopeZoom = this.element('#scope-zoom');
  private readonly damageVignette = this.element('#damage-vignette');
  private readonly countdownOverlay = this.element('#countdown-overlay');
  private readonly countdownValue = this.element('#countdown-value');
  private readonly startOverlay = this.element('#start-overlay');
  private readonly respawnOverlay = this.element('#respawn-overlay');
  private readonly respawnText = this.element('#respawn-text');
  private readonly killFeed = this.element('#kill-feed');
  private readonly overlayTagline = this.element('#overlay-tagline');
  private readonly overlayFootnote = this.element('#overlay-footnote');
  private readonly startButton = this.element<HTMLButtonElement>('#start-button');
  private readonly matchReport = this.element('#match-report');
  private readonly matchReportTitle = this.element('#match-report-title');
  private readonly matchReportStats = this.element('#match-report-stats');
  private lastScopeVisible: boolean | undefined;
  private lastScopeProgress = '';
  private lastScopeScale = '';
  private lastScopeRange = '';
  private lastScopeZoom = '';

  update(state: HudState): void {
    this.health.textContent = String(Math.max(0, Math.ceil(state.health)));
    this.armor.textContent = String(Math.max(0, Math.ceil(state.armor)));
    this.speed.textContent = `${Math.round(state.speed * 3.6)}`;
    this.updateJetpack(state.jetpack);
    this.score.textContent = String(state.score);
    this.botLead.textContent = String(state.botLead);
    this.updateStandings(state);
    const minutes = Math.floor(Math.max(0, state.timeRemaining) / 60).toString().padStart(2, '0');
    const seconds = Math.floor(Math.max(0, state.timeRemaining) % 60).toString().padStart(2, '0');
    this.timer.textContent = `${minutes}:${seconds}`;
    this.weapon.textContent = state.weapon;
    this.secondary.textContent = `RMB // ${state.secondary}`;
    this.ammo.textContent = state.ammo < 0 ? '∞' : String(state.ammo);
    this.updateObjective(state);
    this.updateContext(state);
    this.matchStatus.textContent = state.matchStatus;
    const displayedFps = Number.isFinite(state.fps) ? Math.max(0, Math.min(999, state.fps)) : 0;
    this.fps.textContent = `${Math.round(displayedFps)} FPS`;
    this.powerups.textContent = state.powerups.length ? state.powerups.join(' · ') : 'NO ACTIVE BOOST';
    this.railTimer.textContent = state.railTimer <= 0 ? 'RAIL READY' : `RAIL ${Math.ceil(state.railTimer)}s`;
    this.health.parentElement?.classList.toggle('critical', state.health <= 30);
    this.health.closest<HTMLElement>('.vital')?.style.setProperty('--meter', `${Math.min(100, state.health)}%`);
    this.armor.closest<HTMLElement>('.vital')?.style.setProperty('--meter', `${Math.min(100, state.armor)}%`);
  }

  private updateJetpack(jetpack: HudJetpackState): void {
    const charge = Number.isFinite(jetpack.charge) ? Math.max(0, Math.min(1, jetpack.charge)) : 0;
    const percent = Math.round(charge * 100);
    const phaseLabel = jetpack.phase.toUpperCase();
    this.jetpackValue.textContent = String(percent);
    this.jetpackReadout.dataset.state = jetpack.phase;
    this.jetpackFill.style.setProperty('--jetpack-charge', `${percent}%`);
    this.jetpackTrack.setAttribute('aria-valuenow', String(percent));
    this.jetpackTrack.setAttribute('aria-valuetext', `${percent} percent, ${jetpack.phase}`);
    this.touchJetpackValue.textContent = `${percent}%`;
    this.jumpButton.dataset.jetpackState = jetpack.phase;
    this.jumpButton.style.setProperty('--jetpack-charge', `${percent}%`);
    this.jumpButton.setAttribute('aria-label', `Jump; jetpack ${percent} percent, ${jetpack.phase}`);
    this.jumpButton.title = `Jetpack ${phaseLabel} · ${percent}%`;
  }

  hideStart(): void {
    this.startOverlay.classList.add('hidden');
  }

  setSniperScope(progress: number, distance: number, zoom: number): void {
    const amount = Math.max(0, Math.min(1, progress));
    const visible = amount > 0.015;
    const scopeProgress = amount.toFixed(3);
    const scopeScale = (1.08 - amount * 0.08).toFixed(3);
    const scopeRange = `${Math.round(distance * 3.28084)} FT`;
    const scopeZoom = `${zoom.toFixed(1)}×`;
    if (visible !== this.lastScopeVisible) {
      this.scopeOverlay.classList.toggle('active', visible);
      this.crosshair.classList.toggle('scope-hidden', visible);
      this.lastScopeVisible = visible;
    }
    if (scopeProgress !== this.lastScopeProgress) {
      this.scopeOverlay.style.setProperty('--scope-progress', scopeProgress);
      this.lastScopeProgress = scopeProgress;
    }
    if (scopeScale !== this.lastScopeScale) {
      this.scopeOverlay.style.setProperty('--scope-scale', scopeScale);
      this.lastScopeScale = scopeScale;
    }
    if (scopeRange !== this.lastScopeRange) {
      this.scopeRange.textContent = scopeRange;
      this.lastScopeRange = scopeRange;
    }
    if (scopeZoom !== this.lastScopeZoom) {
      this.scopeZoom.textContent = scopeZoom;
      this.lastScopeZoom = scopeZoom;
    }
  }

  showMatchReport(title: string, stats: Array<[string, string]>): void {
    this.matchReportTitle.textContent = title;
    this.matchReportStats.replaceChildren(...stats.map(([label, value]) => {
      const item = document.createElement('span');
      const caption = document.createElement('small');
      const reading = document.createElement('b');
      caption.textContent = label;
      reading.textContent = value;
      item.append(caption, reading);
      return item;
    }));
    this.matchReport.hidden = false;
  }

  clearMatchReport(): void {
    this.matchReport.hidden = true;
    this.matchReportStats.replaceChildren();
  }

  showStart(mode: OverlayMode = 'ready'): void {
    this.startOverlay.dataset.mode = mode;
    if (mode === 'paused') {
      this.overlayTagline.innerHTML = 'Combat frame held <strong>· Resume when ready</strong>';
      this.overlayFootnote.textContent = 'Pointer release is safe · audio is paused';
    } else if (mode === 'complete') {
      this.overlayTagline.innerHTML = 'Arena result <strong>· Review the line</strong>';
      this.overlayFootnote.textContent = 'Restart to redeploy · first to 20 or highest score at 06:00';
    } else {
      this.overlayTagline.innerHTML = 'WCA1 // Rift Sector <strong>· First to 20</strong>';
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
    this.scopeOverlay.classList.remove('hit', 'kill');
    void this.crosshair.offsetWidth;
    this.crosshair.classList.add(kill ? 'kill' : 'hit');
    this.scopeOverlay.classList.add(kill ? 'kill' : 'hit');
    window.setTimeout(() => {
      this.crosshair.classList.remove('hit', 'kill');
      this.scopeOverlay.classList.remove('hit', 'kill');
    }, kill ? 180 : 100);
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

  pulseJetpack(feedback: 'depleted' | 'ready'): void {
    const accent = feedback === 'depleted' ? '#ff5d92' : '#b8ffe8';
    const glow = feedback === 'depleted'
      ? 'drop-shadow(0 0 8px rgba(255, 93, 146, 0.85))'
      : 'drop-shadow(0 0 9px rgba(137, 255, 224, 0.9))';
    const keyframes: Keyframe[] = [
      { transform: 'scale(1)', filter: 'none' },
      { transform: 'scale(1.12)', color: accent, filter: glow, offset: 0.42 },
      { transform: 'scale(1)', filter: 'none' },
    ];
    const options: KeyframeAnimationOptions = { duration: 420, easing: 'ease-out' };
    this.jetpackReadout.animate(keyframes, options);
    this.jumpButton.animate(keyframes, options);
  }

  pulseObjective(): void {
    this.coreStatus.animate(
      [{ transform: 'scale(1)', color: '#bdefff' }, { transform: 'scale(1.12)', color: '#ffffff' }, { transform: 'scale(1)', color: '#bdefff' }],
      { duration: 320, easing: 'ease-out' },
    );
  }

  private updateStandings(state: HudState): void {
    const fallback: HudStanding[] = [
      { callsign: 'RIFT-01', score: state.score, isPlayer: true },
      { callsign: 'RIVAL-01', score: state.botLead },
      { callsign: 'RIVAL-02', score: 0 },
      { callsign: 'RIVAL-03', score: 0 },
    ];
    const supplied = state.standings?.length ? [...state.standings.slice(0, 4)] : fallback;
    while (supplied.length < 4) {
      supplied.push({ callsign: `RIVAL-${String(supplied.length).padStart(2, '0')}`, score: 0 });
    }

    const ranked = supplied.map((entry, sourceIndex) => ({
      ...entry,
      callsign: entry.callsign.trim() || `COMBATANT-${sourceIndex + 1}`,
      score: Number.isFinite(entry.score) ? Math.trunc(entry.score) : 0,
      sourceIndex,
    }));
    const hasExplicitRanks = ranked.every((entry) => Number.isFinite(entry.rank));
    ranked.sort((left, right) => hasExplicitRanks
      ? (left.rank ?? 0) - (right.rank ?? 0)
      : right.score - left.score || Number(right.isPlayer) - Number(left.isPlayer) || left.sourceIndex - right.sourceIndex);
    const hasExplicitLeader = ranked.some((entry) => entry.isLeader);

    this.standingRows.forEach((row, index) => {
      const entry = ranked[index];
      if (!entry) return;
      const rank = hasExplicitRanks ? Math.max(1, Math.trunc(entry.rank ?? index + 1)) : index + 1;
      const isLeader = Boolean(entry.isLeader) || (!hasExplicitLeader && index === 0);
      const isPlayer = Boolean(entry.isPlayer);
      const stateLabels = [isPlayer ? 'YOU' : '', isLeader ? 'LEAD' : ''].filter(Boolean);
      const stateLabel = stateLabels.length ? stateLabels.join(' · ') : 'RIVAL';
      const score = Math.max(-99, Math.min(999, entry.score));

      row.classList.toggle('is-player', isPlayer);
      row.classList.toggle('is-leader', isLeader);
      row.dataset.player = String(isPlayer);
      row.dataset.leader = String(isLeader);
      row.setAttribute('aria-label', `Rank ${rank}, ${entry.callsign}, ${score} points, ${stateLabel.toLowerCase()}`);
      this.setText(this.child(row, '.standing-rank'), String(rank).padStart(2, '0'));
      this.setText(this.child(row, '.standing-callsign'), entry.callsign);
      this.setText(this.child(row, '.standing-state'), stateLabel);
      this.setText(this.child(row, '.standing-score'), score < 0 ? String(score) : String(score).padStart(2, '0'));
    });
  }

  private updateObjective(state: HudState): void {
    const progress = Math.max(0, Math.min(1, state.coreProgress));
    const progressPercent = Math.round(progress * 100);
    const location = state.objective?.location?.trim() || 'RIFT NEXUS';
    const phase = state.objective?.phase?.trim() || this.inferCorePhase(state.coreStatus);
    const contestState = state.objective?.contestState?.trim() || state.coreStatus;
    const statusCountdown = /CORE IN\s+(\d+(?:\.\d+)?)s/i.exec(state.coreStatus);
    const explicitSeconds = state.objective?.nextEventSeconds;
    const nextEventSeconds = typeof explicitSeconds === 'number' && Number.isFinite(explicitSeconds)
      ? Math.max(0, explicitSeconds)
      : statusCountdown ? Number(statusCountdown[1]) : undefined;
    const nextEventLabel = state.objective?.nextEventLabel?.trim()
      || (statusCountdown ? 'CORE ONLINE' : 'NEXT EVENT');

    this.coreFill.style.width = `${progressPercent}%`;
    this.coreTrack.setAttribute('aria-valuenow', String(progressPercent));
    this.coreTrack.setAttribute('aria-valuetext', `${progressPercent} percent`);
    this.setText(this.coreProgressLabel, `${String(progressPercent).padStart(3, '0')}%`);
    this.setText(this.coreLocation, location);
    this.setText(this.corePhase, phase);
    this.setText(this.coreStatus, contestState);
    this.setText(
      this.objectiveEvent,
      `${nextEventLabel} ${nextEventSeconds === undefined ? '--:--' : this.formatDuration(nextEventSeconds)}`,
    );
  }

  private updateContext(state: HudState): void {
    const style = state.style ?? null;
    const weather = state.weather ?? null;
    this.styleSlot.hidden = !style;
    this.weatherSlot.hidden = !weather;
    this.arenaContext.hidden = !style && !weather;

    if (style) {
      const meter = Math.max(0, Math.min(1, style.meter ?? 0));
      const meterPercent = Math.round(meter * 100);
      this.setText(this.styleMedal, style.medal.trim() || 'STYLE');
      this.styleMeterFill.style.width = `${meterPercent}%`;
      this.styleMeter.setAttribute('aria-valuenow', String(meterPercent));
      this.styleMeter.setAttribute('aria-valuetext', `${meterPercent} percent`);
    }

    if (weather) {
      this.setText(this.weatherPhase, weather.phase.trim() || 'CLEAR');
      this.setText(this.weatherDetail, weather.detail?.trim() || 'CONDITIONS NOMINAL');
    }
  }

  private inferCorePhase(status: string): string {
    if (/CONTEST/i.test(status)) return 'CONTESTED';
    if (/CAPTURING/i.test(status)) return 'CAPTURE';
    if (/UNCONTESTED/i.test(status)) return 'LIVE';
    if (/CORE IN/i.test(status)) return 'CHARGING';
    return 'ACTIVE';
  }

  private formatDuration(seconds: number): string {
    const bounded = Math.min(99 * 60 + 59, Math.max(0, Math.ceil(seconds)));
    const minutes = Math.floor(bounded / 60).toString().padStart(2, '0');
    const remainder = Math.floor(bounded % 60).toString().padStart(2, '0');
    return `${minutes}:${remainder}`;
  }

  private setText(node: HTMLElement, value: string): void {
    if (node.textContent !== value) node.textContent = value;
  }

  private child<T extends HTMLElement = HTMLElement>(parent: HTMLElement, selector: string): T {
    const node = parent.querySelector<T>(selector);
    if (!node) throw new Error(`Missing HUD child element: ${selector}`);
    return node;
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error(`Missing HUD element: ${selector}`);
    return node;
  }

  private elements<T extends HTMLElement = HTMLElement>(selector: string): T[] {
    return [...document.querySelectorAll<T>(selector)];
  }
}
