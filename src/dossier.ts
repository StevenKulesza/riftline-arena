import {
  buildBotPolicy,
  getBotArchetype,
  type BotArchetypeId,
  type BotDifficultyId,
  type BotPolicySnapshot,
} from './systems/BotArchetypes';

type RolePresentation = Readonly<{
  index: string;
  behavior: string;
  description: string;
  tacticNote: string;
  accent: string;
  image: string;
}>;

const ROLE_PRESENTATION: Readonly<Record<BotArchetypeId, RolePresentation>> = Object.freeze({
  hunter: Object.freeze({
    index: '01',
    behavior: 'Relentless aggressor',
    description: 'Seeks direct engagements and sustains pressure. Prioritizes targets that open space and break defensive setups.',
    tacticNote: 'Maintains contact. Re-acquires the highest-value threat after interruption.',
    accent: '#ff5d68',
    image: '/assets/ui/dossier/hunter.webp',
  }),
  anchor: Object.freeze({
    index: '02',
    behavior: 'Objective holdfast',
    description: 'Controls the Flux Core approach and punishes overextension. Prefers stable sightlines and defensible combat ranges.',
    tacticNote: 'Holds objective geometry. Breaks position only for immediate player pressure.',
    accent: '#48c9ff',
    image: '/assets/ui/dossier/anchor.webp',
  }),
  runner: Object.freeze({
    index: '03',
    behavior: 'Velocity pathfinder',
    description: 'Chains authored routes into rapid objective pressure. Uses movement lines to arrive before slower combat frames.',
    tacticNote: 'Commits to route flow. Diverts for the Core or a high-value pickup window.',
    accent: '#64f1b2',
    image: '/assets/ui/dossier/runner.webp',
  }),
  thief: Object.freeze({
    index: '04',
    behavior: 'Resource denial',
    description: 'Steals powerups and precision channels before opponents can establish control, then disengages into safer lanes.',
    tacticNote: 'Tracks item timing. Repositions after acquisition instead of holding a prolonged duel.',
    accent: '#d27cff',
    image: '/assets/ui/dossier/thief.webp',
  }),
});

const ARCHETYPE_IDS = Object.freeze(Object.keys(ROLE_PRESENTATION) as BotArchetypeId[]);
const DIFFICULTY_IDS: readonly BotDifficultyId[] = Object.freeze(['easy', 'normal', 'hard', 'expert']);

const query = <T extends HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const shell = query<HTMLElement>('#dossier-shell');
const heroImage = query<HTMLImageElement>('#dossier-hero-image');
const heroTitle = query<HTMLElement>('#dossier-hero-title');
const indexLabel = query<HTMLElement>('#dossier-index');
const behaviorLabel = query<HTMLElement>('#dossier-behavior');
const description = query<HTMLElement>('#dossier-description');
const weaponList = query<HTMLElement>('#dossier-weapon-list');
const priorityList = query<HTMLOListElement>('#dossier-priority-list');
const tacticNote = query<HTMLElement>('#dossier-tactic-note');
const aggression = query<HTMLElement>('#dossier-aggression');
const range = query<HTMLElement>('#dossier-range');
const objective = query<HTMLElement>('#dossier-objective');
const pickup = query<HTMLElement>('#dossier-pickup');
const intelBack = query<HTMLButtonElement>('#intel-back');
const roleButtons = [...document.querySelectorAll<HTMLButtonElement>('.dossier-role')];
const difficultyButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-difficulty]')];

const isArchetypeId = (value: string | null): value is BotArchetypeId => (
  value !== null && (ARCHETYPE_IDS as readonly string[]).includes(value)
);
const isDifficultyId = (value: string | null): value is BotDifficultyId => (
  value !== null && (DIFFICULTY_IDS as readonly string[]).includes(value)
);
const titleCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

let selectedRole: BotArchetypeId = isArchetypeId(localStorage.getItem('rift:intel-role'))
  ? localStorage.getItem('rift:intel-role') as BotArchetypeId
  : 'hunter';
let selectedDifficulty: BotDifficultyId = isDifficultyId(localStorage.getItem('rift:bot-difficulty'))
  ? localStorage.getItem('rift:bot-difficulty') as BotDifficultyId
  : 'easy';

for (const role of ARCHETYPE_IDS) {
  const image = new Image();
  image.src = ROLE_PRESENTATION[role].image;
}

const announcePolicy = (policy: BotPolicySnapshot): void => {
  document.dispatchEvent(new CustomEvent<BotPolicySnapshot>('rift:bot-policy-preview', { detail: policy }));
};

const renderDifficulty = (): void => {
  if (shell) shell.dataset.difficulty = selectedDifficulty;
  for (const button of difficultyButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.difficulty === selectedDifficulty));
  }
  announcePolicy(buildBotPolicy(selectedRole, selectedDifficulty));
};

const renderRole = (moveFocus: boolean): void => {
  const profile = getBotArchetype(selectedRole);
  const presentation = ROLE_PRESENTATION[selectedRole];
  if (shell) {
    shell.dataset.role = selectedRole;
    shell.style.setProperty('--dossier-accent', presentation.accent);
  }
  for (const button of roleButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.role === selectedRole));
  }
  if (heroImage) {
    heroImage.src = presentation.image;
    heroImage.alt = `${profile.behaviorLabel} combat frame`;
  }
  if (indexLabel) indexLabel.textContent = `${presentation.index} // ${profile.id}`;
  if (heroTitle) heroTitle.innerHTML = profile.behaviorLabel.split(' ').map(titleCase).join('<br />');
  if (behaviorLabel) behaviorLabel.textContent = presentation.behavior;
  if (description) description.textContent = presentation.description;
  if (weaponList) weaponList.textContent = profile.weaponAffinity.map(titleCase).join(' · ');
  if (tacticNote) tacticNote.textContent = presentation.tacticNote;
  if (aggression) aggression.textContent = `${Math.round(profile.aggression * 100)}%`;
  if (range) range.textContent = `${profile.preferredRange.min}–${profile.preferredRange.max}m`;
  if (objective) objective.textContent = `${Math.round(profile.objectiveCommitment * 100)}%`;
  if (pickup) pickup.textContent = `${Math.round(profile.pickupGreed * 100)}%`;
  if (priorityList) {
    const items = [...priorityList.querySelectorAll<HTMLLIElement>('li')];
    profile.targetPriorities.forEach((target, index) => {
      const item = items[index];
      if (!item) return;
      const number = item.querySelector<HTMLElement>('b');
      const label = item.querySelector<HTMLElement>('span');
      if (number) number.textContent = String(index + 1);
      if (label) label.textContent = titleCase(target);
    });
  }
  localStorage.setItem('rift:intel-role', selectedRole);
  renderDifficulty();
  if (moveFocus) heroTitle?.focus({ preventScroll: true });
};

for (const button of roleButtons) {
  button.addEventListener('click', () => {
    if (!isArchetypeId(button.dataset.role ?? null)) return;
    selectedRole = button.dataset.role as BotArchetypeId;
    renderRole(true);
  });
}

for (const button of difficultyButtons) {
  button.addEventListener('click', () => {
    if (!isDifficultyId(button.dataset.difficulty ?? null)) return;
    selectedDifficulty = button.dataset.difficulty as BotDifficultyId;
    localStorage.setItem('rift:bot-difficulty', selectedDifficulty);
    renderDifficulty();
  });
}

intelBack?.addEventListener('click', () => query<HTMLButtonElement>('#play-tab')?.click());

renderRole(false);
