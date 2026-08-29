import { Game, type GameLoadProgress } from './game/Game';

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');

if (!canvas) {
  throw new Error('Missing #game-canvas element.');
}

const startButton = document.querySelector<HTMLButtonElement>('#start-button');
const startLabel = startButton?.querySelector<HTMLSpanElement>('span');
const startMeter = startButton?.querySelector<HTMLElement>('i');
const networkStatus = document.querySelector<HTMLElement>('#overlay-network');
const loadingStatus = document.querySelector<HTMLElement>('#overlay-footnote');

const showLoadProgress = ({ fraction, label }: GameLoadProgress): void => {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  if (startButton) {
    startButton.disabled = true;
    startButton.dataset.loading = 'true';
    startButton.setAttribute('aria-busy', 'true');
    startButton.style.setProperty('--load-progress', `${percent}%`);
  }
  if (startLabel) startLabel.textContent = label;
  if (startMeter) startMeter.textContent = `${percent}%`;
  if (networkStatus) networkStatus.textContent = 'STREAMING ARENA';
  if (loadingStatus) loadingStatus.textContent = 'Preparing map assets before deployment · live play stays interruption-free';
};

showLoadProgress({ fraction: 0, label: 'Initializing renderer' });

let game: Game;
try {
  game = await Game.create(canvas, showLoadProgress);
  if (startButton) {
    startButton.disabled = false;
    delete startButton.dataset.loading;
    startButton.removeAttribute('aria-busy');
    startButton.style.removeProperty('--load-progress');
  }
  if (startLabel) startLabel.textContent = 'Enter the rift';
  if (startMeter) startMeter.textContent = '›';
  if (networkStatus) networkStatus.textContent = 'ARENA READY';
  if (loadingStatus) loadingStatus.textContent = 'All map assets and shaders loaded · six minute arena match';
  const searchParams = new URLSearchParams(window.location.search);
  const qaState = searchParams.has('qa') ? searchParams.get('qaState') : null;
  if (qaState) window.__THREE_GAME_TEST_HOOKS__?.setState(qaState);
  game.start();
} catch (error) {
  if (startLabel) startLabel.textContent = 'Arena load failed';
  if (startMeter) startMeter.textContent = '!';
  if (networkStatus) networkStatus.textContent = 'LOAD FAULT';
  if (loadingStatus) loadingStatus.textContent = 'Reload to retry arena initialization';
  throw error;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.dispose();
  });
}
