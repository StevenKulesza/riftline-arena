type RiftSettings = {
  sensitivity: number;
  muted: boolean;
  reducedMotion: boolean;
};

const element = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const playTab = element<HTMLButtonElement>('#play-tab');
const intelTab = element<HTMLButtonElement>('#intel-tab');
const optionsTab = element<HTMLButtonElement>('#options-tab');
const optionsBack = element<HTMLButtonElement>('#options-back');
const playMenu = element('#play-menu');
const intelMenu = element('#intel-menu');
const optionsMenu = element('#options-menu');
const startOverlay = element('#start-overlay');
const startPanel = element('.start-panel');
const sensitivityOption = element<HTMLInputElement>('#sensitivity-option');
const sensitivityValue = element<HTMLOutputElement>('#sensitivity-value');
const audioOption = element<HTMLButtonElement>('#audio-option');
const motionOption = element<HTMLButtonElement>('#motion-option');
const fullscreenOption = element<HTMLButtonElement>('#fullscreen-option');
const mapChoices = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-map-choice]'));

const menuMusic = new Audio('/assets/audio/music/rift-menu-loop-clean-v1.mp3');
menuMusic.loop = true;
menuMusic.preload = 'auto';
menuMusic.volume = 0.32;

const readSettings = (): RiftSettings => ({
  sensitivity: Number(localStorage.getItem('rift:sensitivity') ?? '1'),
  muted: localStorage.getItem('rift:muted') === 'true',
  reducedMotion: localStorage.getItem('rift:reduced-motion') === 'true',
});

const emitSettings = (): void => {
  document.dispatchEvent(new CustomEvent<RiftSettings>('rift:settings', { detail: readSettings() }));
};

const overlayIsVisible = (): boolean => Boolean(startOverlay && !startOverlay.classList.contains('hidden'));

const syncMusic = (): void => {
  const shouldPlay = overlayIsVisible() && !readSettings().muted && document.visibilityState === 'visible';
  if (!shouldPlay) {
    menuMusic.pause();
    return;
  }
  void menuMusic.play().catch(() => {
    // Browsers require a gesture; the next menu click/key retries playback.
  });
};

const syncMapChoice = (): void => {
  const quickSense = new URLSearchParams(window.location.search).get('map') === 'quicksense';
  for (const choice of mapChoices) {
    const active = choice.dataset.mapChoice === (quickSense ? 'quicksense' : 'monsoon');
    choice.classList.toggle('active', active);
    choice.setAttribute('aria-pressed', String(active));
  }
  const tagline = element<HTMLElement>('#overlay-tagline');
  if (tagline) tagline.innerHTML = `${quickSense ? 'QUICKSENSE // FLOW TEST RANGE' : 'WCA1 // RIFT SECTOR'} <strong>· First to 20</strong>`;
  const arenaMeta = document.querySelector<HTMLElement>('.deploy-meta > span');
  if (arenaMeta) arenaMeta.innerHTML = `<small>Arena</small>${quickSense ? 'QUICKSENSE' : 'WCA1 // RIFT SECTOR'}`;
};

const selectMap = (choice: HTMLButtonElement): void => {
  const map = choice.dataset.mapChoice;
  if (!map) return;
  const url = new URL(window.location.href);
  if (map === 'quicksense') url.searchParams.set('map', 'quicksense');
  else url.searchParams.delete('map');
  window.location.assign(url.toString());
};

const refreshOptions = (): void => {
  const settings = readSettings();
  const sensitivity = Number.isFinite(settings.sensitivity) ? settings.sensitivity : 1;
  if (sensitivityOption) sensitivityOption.value = String(sensitivity);
  if (sensitivityValue) sensitivityValue.value = `${sensitivity.toFixed(1)}×`;
  if (audioOption) {
    audioOption.textContent = settings.muted ? 'Off' : 'On';
    audioOption.setAttribute('aria-pressed', String(!settings.muted));
  }
  if (motionOption) {
    motionOption.textContent = settings.reducedMotion ? 'On' : 'Off';
    motionOption.setAttribute('aria-pressed', String(settings.reducedMotion));
  }
  if (fullscreenOption) {
    const active = Boolean(document.fullscreenElement);
    fullscreenOption.textContent = active ? 'Exit' : 'Enter';
    fullscreenOption.setAttribute('aria-pressed', String(active));
  }
};

const setView = (view: 'play' | 'intel' | 'options'): void => {
  const showPlay = view === 'play';
  const showIntel = view === 'intel';
  const showOptions = view === 'options';
  playMenu?.classList.toggle('active', showPlay);
  intelMenu?.classList.toggle('active', showIntel);
  optionsMenu?.classList.toggle('active', showOptions);
  playMenu?.setAttribute('aria-hidden', String(!showPlay));
  intelMenu?.setAttribute('aria-hidden', String(!showIntel));
  optionsMenu?.setAttribute('aria-hidden', String(!showOptions));
  playTab?.classList.toggle('active', showPlay);
  intelTab?.classList.toggle('active', showIntel);
  optionsTab?.classList.toggle('active', showOptions);
  playTab?.setAttribute('aria-selected', String(showPlay));
  intelTab?.setAttribute('aria-selected', String(showIntel));
  optionsTab?.setAttribute('aria-selected', String(showOptions));
  if (startPanel) startPanel.dataset.menuView = view;
  const focusTarget = showOptions
    ? sensitivityOption
    : showIntel
      ? element<HTMLElement>('#dossier-hero-title')
      : element<HTMLButtonElement>('#start-button');
  focusTarget?.focus({ preventScroll: true });
  syncMusic();
};

playTab?.addEventListener('click', () => setView('play'));
intelTab?.addEventListener('click', () => setView('intel'));
optionsBack?.addEventListener('click', () => setView('play'));
optionsTab?.addEventListener('click', () => setView('options'));
sensitivityOption?.addEventListener('input', () => {
  localStorage.setItem('rift:sensitivity', sensitivityOption.value);
  refreshOptions();
  emitSettings();
});
audioOption?.addEventListener('click', () => {
  localStorage.setItem('rift:muted', String(!readSettings().muted));
  refreshOptions();
  emitSettings();
  syncMusic();
});
motionOption?.addEventListener('click', () => {
  localStorage.setItem('rift:reduced-motion', String(!readSettings().reducedMotion));
  refreshOptions();
  emitSettings();
});
fullscreenOption?.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
});
mapChoices.forEach((choice) => choice.addEventListener('click', () => selectMap(choice)));
document.addEventListener('fullscreenchange', refreshOptions);
document.addEventListener('visibilitychange', syncMusic);
document.addEventListener('pointerdown', syncMusic);
document.addEventListener('keydown', syncMusic);
if (startOverlay) new MutationObserver(syncMusic).observe(startOverlay, { attributes: true, attributeFilter: ['class'] });

refreshOptions();
syncMapChoice();
emitSettings();
if (startPanel) startPanel.dataset.menuView = 'play';
