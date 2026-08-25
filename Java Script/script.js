/* ============================================================================
   FLIP ZONE — Anti-Gravity Platformer
   A single-file game engine: input, physics, collision, rendering, audio,
   levels, and UI wiring. Organized into clearly commented sections so any
   part (levels, physics constants, audio) can be tuned independently.
   ============================================================================ */

'use strict';

/* ============================================================================
   1. CANVAS & GLOBAL CONSTANTS
   ============================================================================ */

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const VW = canvas.width;   // virtual/world viewport width  (960)
const VH = canvas.height;  // virtual/world viewport height (540)

// World geometry — fixed floor/ceiling band, only the floor has gaps.
// Flipping gravity lets the player travel via the ceiling to cross a gap.
const FLOOR_Y = 500;   // y of the floor's top surface
const FLOOR_H = 40;
const CEIL_Y = 0;       // y of the ceiling's top
const CEIL_H = 40;      // ceiling's bottom surface sits at y = CEIL_H
const PLAYABLE_TOP = CEIL_H;
const PLAYABLE_BOTTOM = FLOOR_Y;

// Physics (px/second, px/second^2 — frame-rate independent via dt)
const MOVE_SPEED = 260;
const AIR_CONTROL = 0.85;      // slightly less responsive mid-air
const GRAVITY_ACCEL = 1500;
const JUMP_VELOCITY = 620;
const MAX_FALL_SPEED = 900;
const FLIP_COOLDOWN = 0.35;    // seconds between allowed flips
const DEATH_Y_MARGIN = 400;    // how far past floor/ceiling before it's a death

const PLAYER_W = 30;
const PLAYER_H = 30;

/* ============================================================================
   2. PERSISTENT STORAGE (settings + progress)
   ============================================================================ */

const STORAGE_SETTINGS_KEY = 'flipzone_settings_v1';
const STORAGE_PROGRESS_KEY = 'flipzone_progress_v1';

function loadSettings() {
  const defaults = {
    musicVolume: 60,
    sfxVolume: 80,
    muted: false,
    particles: true,
    screenShake: true,
    quality: 'high'
  };
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
    return raw ? Object.assign(defaults, JSON.parse(raw)) : defaults;
  } catch (e) {
    console.warn('Settings failed to load, using defaults.', e);
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Settings failed to save.', e);
  }
}

function loadProgress() {
  const defaults = { unlocked: 1, stats: {} }; // stats[levelIndex] = {coins,total,deaths}
  try {
    const raw = localStorage.getItem(STORAGE_PROGRESS_KEY);
    return raw ? Object.assign(defaults, JSON.parse(raw)) : defaults;
  } catch (e) {
    console.warn('Progress failed to load, using defaults.', e);
    return defaults;
  }
}

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_PROGRESS_KEY, JSON.stringify(progress));
  } catch (e) {
    console.warn('Progress failed to save.', e);
  }
}

let settings = loadSettings();
let progress = loadProgress();

/* ============================================================================
   3. AUDIO ENGINE (Web Audio API — no external files needed)
   ============================================================================ */

const AudioEngine = {
  ctx: null,
  musicGain: null,
  sfxGain: null,
  musicTimer: null,
  musicStep: 0,

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.musicGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain.connect(this.ctx.destination);
    this.sfxGain.connect(this.ctx.destination);
    this.applyVolumes();
  },

  applyVolumes() {
    if (!this.ctx) return;
    const muteMul = settings.muted ? 0 : 1;
    this.musicGain.gain.value = (settings.musicVolume / 100) * 0.35 * muteMul;
    this.sfxGain.gain.value = (settings.sfxVolume / 100) * muteMul;
  },

  // One-shot beep/tone with a simple attack-decay envelope.
  playTone(freq, duration, type = 'sine', peak = 0.5, slideTo = null) {
    if (!this.ctx || settings.muted) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + duration);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  },

  sfxJump() { this.playTone(420, 0.14, 'square', 0.35, 620); },
  sfxFlip() { this.playTone(180, 0.22, 'sawtooth', 0.4, 720); },
  sfxCoin() { this.playTone(880, 0.12, 'triangle', 0.35, 1320); },
  sfxCheckpoint() { this.playTone(520, 0.35, 'triangle', 0.4, 1040); },
  sfxDeath() { this.playTone(220, 0.4, 'sawtooth', 0.45, 60); },
  sfxComplete() { this.playTone(660, 0.5, 'triangle', 0.4, 1320); },
  sfxClick() { this.playTone(300, 0.06, 'square', 0.2); },

  // Tiny procedural arpeggio loop for background music.
  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    const scale = [220, 261.6, 329.6, 392, 440, 392, 329.6, 261.6]; // A minor-ish loop
    this.musicStep = 0;
    const stepTime = 0.28;
    const playStep = () => {
      if (!this.ctx) return;
      const freq = scale[this.musicStep % scale.length];
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.5, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + stepTime * 0.9);
      osc.connect(gain).connect(this.musicGain);
      osc.start(t0);
      osc.stop(t0 + stepTime);

      // Soft bass note every 4 steps
      if (this.musicStep % 4 === 0) {
        const bass = this.ctx.createOscillator();
        const bg = this.ctx.createGain();
        bass.type = 'sine';
        bass.frequency.setValueAtTime(freq / 4, t0);
        bg.gain.setValueAtTime(0.0001, t0);
        bg.gain.exponentialRampToValueAtTime(0.6, t0 + 0.03);
        bg.gain.exponentialRampToValueAtTime(0.0001, t0 + stepTime * 3.5);
        bass.connect(bg).connect(this.musicGain);
        bass.start(t0);
        bass.stop(t0 + stepTime * 3.5);
      }
      this.musicStep++;
    };
    playStep();
    this.musicTimer = setInterval(playStep, stepTime * 1000);
  },

  stopMusic() {
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
  }
};

/* ============================================================================
   4. LEVEL DEFINITIONS
   Each level is declared compactly: overall width, a list of floor gaps
   (pits), extra floating/moving platforms, spikes, coins, checkpoints and
   a goal. Floor platform rectangles are derived automatically by
   subtracting the gaps from the full width, so hand-authored gap lists
   can't accidentally overlap floor geometry.
   ============================================================================ */

function makeLevel(def) {
  // Build solid floor segments from the width + gap list.
  const gaps = def.floorGaps.slice().sort((a, b) => a[0] - b[0]);
  const floorPlatforms = [];
  let cursor = 0;
  for (const [gx, gw] of gaps) {
    if (gx > cursor) floorPlatforms.push({ x: cursor, y: FLOOR_Y, w: gx - cursor, h: FLOOR_H, type: 'floor' });
    cursor = gx + gw;
  }
  if (cursor < def.width) floorPlatforms.push({ x: cursor, y: FLOOR_Y, w: def.width - cursor, h: FLOOR_H, type: 'floor' });

  const ceiling = [{ x: 0, y: CEIL_Y, w: def.width, h: CEIL_H, type: 'ceiling' }];

  const staticPlatforms = (def.platforms || []).map(p => ({ ...p, type: 'floater' }));

  return {
    width: def.width,
    playerStart: def.playerStart,
    platforms: [...floorPlatforms, ...ceiling, ...staticPlatforms],
    movingPlatforms: (def.movingPlatforms || []).map(mp => ({
      ...mp, baseX: mp.x, baseY: mp.y, curX: mp.x, curY: mp.y, prevX: mp.x, prevY: mp.y
    })),
    spikes: def.spikes || [],
    coins: (def.coins || []).map(c => ({ ...c, collected: false, bob: Math.random() * Math.PI * 2 })),
    checkpoints: (def.checkpoints || []).map(cp => ({ x: cp, y: FLOOR_Y - 70, active: false })),
    goal: { x: def.goalX, y: PLAYABLE_TOP, w: 40, h: PLAYABLE_BOTTOM - PLAYABLE_TOP },
    name: def.name
  };
}

const LEVEL_DEFS = [
  // ---- Level 1: tutorial — learn moving, jumping, and one mandatory flip ----
  {
    name: 'Liftoff',
    width: 2600,
    playerStart: { x: 80, y: FLOOR_Y - PLAYER_H },
    floorGaps: [[700, 150], [1600, 280]],
    platforms: [{ x: 1180, y: 380, w: 120, h: 20 }],
    spikes: [{ x: 320, y: FLOOR_Y - 24, w: 50, h: 24, side: 'floor' }],
    coins: [
      { x: 200, y: 450 }, { x: 460, y: 450 }, { x: 780, y: 300 }, { x: 950, y: 450 },
      { x: 1200, y: 340 }, { x: 1450, y: 450 }, { x: 1700, y: 280 }, { x: 2000, y: 450 },
      { x: 2250, y: 450 }, { x: 2450, y: 450 }
    ],
    checkpoints: [1350],
    goalX: 2520
  },

  // ---- Level 2: more gaps, a moving platform, spikes on the ground ----
  {
    name: 'Momentum',
    width: 3000,
    playerStart: { x: 80, y: FLOOR_Y - PLAYER_H },
    floorGaps: [[480, 140], [1150, 300], [2100, 160]],
    platforms: [{ x: 720, y: 360, w: 110, h: 20 }],
    movingPlatforms: [
      { x: 1420, y: 340, w: 100, h: 20, axis: 'x', range: 180, speed: 1.1 }
    ],
    spikes: [
      { x: 900, y: FLOOR_Y - 24, w: 60, h: 24, side: 'floor' },
      { x: 1780, y: FLOOR_Y - 24, w: 80, h: 24, side: 'floor' },
      { x: 2450, y: FLOOR_Y - 24, w: 60, h: 24, side: 'floor' }
    ],
    coins: [
      { x: 220, y: 450 }, { x: 620, y: 300 }, { x: 780, y: 300 }, { x: 1000, y: 450 },
      { x: 1470, y: 280 }, { x: 1650, y: 450 }, { x: 1950, y: 450 }, { x: 2270, y: 300 },
      { x: 2600, y: 450 }, { x: 2850, y: 450 }
    ],
    checkpoints: [1000, 2300],
    goalX: 2920
  },

  // ---- Level 3: ceiling spikes introduced, more flip-mandatory gaps ----
  {
    name: 'Inversion',
    width: 3400,
    playerStart: { x: 80, y: FLOOR_Y - PLAYER_H },
    floorGaps: [[400, 150], [1000, 300], [1750, 150], [2500, 300]],
    platforms: [{ x: 2150, y: 380, w: 100, h: 20 }],
    movingPlatforms: [
      { x: 650, y: 340, w: 100, h: 20, axis: 'y', range: 120, speed: 1.3 },
      { x: 2950, y: 360, w: 110, h: 20, axis: 'x', range: 160, speed: 1.0 }
    ],
    spikes: [
      { x: 200, y: FLOOR_Y - 24, w: 50, h: 24, side: 'floor' },
      { x: 1450, y: FLOOR_Y - 24, w: 70, h: 24, side: 'floor' },
      // Ceiling spikes only sit above solid floor, never above a gap.
      { x: 550, y: CEIL_H, w: 60, h: 24, side: 'ceiling' },
      { x: 1900, y: CEIL_H, w: 60, h: 24, side: 'ceiling' },
      { x: 3100, y: FLOOR_Y - 24, w: 70, h: 24, side: 'floor' }
    ],
    coins: [
      { x: 220, y: 450 }, { x: 480, y: 250 }, { x: 850, y: 450 }, { x: 1120, y: 280 },
      { x: 1450, y: 450 }, { x: 1820, y: 250 }, { x: 2200, y: 320 }, { x: 2650, y: 250 },
      { x: 2900, y: 450 }, { x: 3200, y: 450 }
    ],
    checkpoints: [850, 2400],
    goalX: 3320
  },

  // ---- Level 4: longer, denser hazards, two moving platforms in sequence ----
  {
    name: 'Freefall',
    width: 3800,
    playerStart: { x: 80, y: FLOOR_Y - PLAYER_H },
    floorGaps: [[380, 160], [950, 300], [1550, 160], [2150, 300], [2850, 300]],
    platforms: [{ x: 1750, y: 380, w: 90, h: 20 }],
    movingPlatforms: [
      { x: 1200, y: 350, w: 100, h: 20, axis: 'y', range: 140, speed: 1.4 },
      { x: 2400, y: 330, w: 110, h: 20, axis: 'x', range: 200, speed: 1.2 },
      { x: 3150, y: 360, w: 100, h: 20, axis: 'y', range: 110, speed: 1.6 }
    ],
    spikes: [
      { x: 180, y: FLOOR_Y - 24, w: 50, h: 24, side: 'floor' },
      { x: 700, y: CEIL_H, w: 70, h: 24, side: 'ceiling' },
      { x: 1400, y: FLOOR_Y - 24, w: 80, h: 24, side: 'floor' },
      { x: 1950, y: CEIL_H, w: 70, h: 24, side: 'ceiling' },
      { x: 2600, y: FLOOR_Y - 24, w: 90, h: 24, side: 'floor' },
      { x: 3400, y: CEIL_H, w: 70, h: 24, side: 'ceiling' }
    ],
    coins: [
      { x: 220, y: 450 }, { x: 500, y: 250 }, { x: 850, y: 450 }, { x: 1120, y: 280 },
      { x: 1650, y: 450 }, { x: 1900, y: 280 }, { x: 2300, y: 450 }, { x: 2550, y: 250 },
      { x: 3000, y: 450 }, { x: 3300, y: 300 }, { x: 3600, y: 450 }
    ],
    checkpoints: [700, 1900, 3400],
    goalX: 3700
  },

  // ---- Level 5: finale — everything combined, tightest margins ----
  {
    name: 'Singularity',
    width: 4200,
    playerStart: { x: 80, y: FLOOR_Y - PLAYER_H },
    floorGaps: [[380, 160], [900, 300], [1450, 300], [2050, 160], [2600, 300], [3200, 300]],
    platforms: [{ x: 2350, y: 380, w: 90, h: 20 }],
    movingPlatforms: [
      { x: 1050, y: 340, w: 100, h: 20, axis: 'y', range: 150, speed: 1.5 },
      { x: 1650, y: 330, w: 110, h: 20, axis: 'x', range: 200, speed: 1.3 },
      { x: 2750, y: 350, w: 100, h: 20, axis: 'y', range: 130, speed: 1.6 },
      { x: 3350, y: 330, w: 110, h: 20, axis: 'x', range: 220, speed: 1.4 }
    ],
    spikes: [
      { x: 200, y: FLOOR_Y - 24, w: 60, h: 24, side: 'floor' },
      { x: 700, y: CEIL_H, w: 80, h: 24, side: 'ceiling' },
      { x: 1250, y: FLOOR_Y - 24, w: 80, h: 24, side: 'floor' },
      { x: 1900, y: CEIL_H, w: 80, h: 24, side: 'ceiling' },
      { x: 2280, y: FLOOR_Y - 24, w: 60, h: 24, side: 'floor' },
      { x: 2950, y: CEIL_H, w: 80, h: 24, side: 'ceiling' },
      { x: 3550, y: FLOOR_Y - 24, w: 90, h: 24, side: 'floor' },
      { x: 3950, y: CEIL_H, w: 70, h: 24, side: 'ceiling' }
    ],
    coins: [
      { x: 220, y: 450 }, { x: 500, y: 250 }, { x: 820, y: 450 }, { x: 1150, y: 280 },
      { x: 1500, y: 450 }, { x: 1800, y: 280 }, { x: 2150, y: 450 }, { x: 2450, y: 300 },
      { x: 2850, y: 450 }, { x: 3100, y: 280 }, { x: 3500, y: 450 }, { x: 3800, y: 300 }, { x: 4050, y: 450 }
    ],
    checkpoints: [1200, 2400, 3600],
    goalX: 4100
  }
];

const LEVELS = LEVEL_DEFS.map(makeLevel);

/* ============================================================================
   5. GAME STATE
   ============================================================================ */

const Keys = {}; // live keyboard state, keyed by our own action names
let currentLevelIndex = 0;
let level = null;
let camera = { x: 0 };
let particles = [];
let screenShake = 0;
let toastTimer = null;

let gameState = 'menu'; // 'menu' | 'playing' | 'paused' | 'levelcomplete' | 'victory'
let lastTime = 0;

const player = {
  x: 0, y: 0, w: PLAYER_W, h: PLAYER_H,
  vx: 0, vy: 0,
  gravityDir: 1,     // 1 = normal (falls down), -1 = flipped (falls up)
  visualAngle: 0,    // eased rotation for smooth flip animation
  onGround: false,
  flipCooldown: 0,
  landSquash: 0,     // decays after landing, used for a squash/stretch pop
  ridingPlatform: null,
  deaths: 0,
  coinsCollected: 0
};

/* ============================================================================
   6. INPUT
   ============================================================================ */

const KEY_MAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
  ShiftLeft: 'flip', ShiftRight: 'flip', KeyF: 'flip',
  Escape: 'pause', KeyM: 'mute'
};

const justPressed = {}; // edge-triggered actions consumed once per press

window.addEventListener('keydown', (e) => {
  const action = KEY_MAP[e.code];
  if (!action) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space'].includes(e.code)) e.preventDefault();
  if (!Keys[action]) justPressed[action] = true;
  Keys[action] = true;
});

window.addEventListener('keyup', (e) => {
  const action = KEY_MAP[e.code];
  if (!action) return;
  Keys[action] = false;
});

/* ============================================================================
   7. COLLISION HELPERS
   ============================================================================ */

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function allSolids() {
  // Static platforms + the current computed rects of moving platforms.
  const moving = level.movingPlatforms.map(mp => ({ x: mp.curX, y: mp.curY, w: mp.w, h: mp.h, type: 'floater', ref: mp }));
  return [...level.platforms, ...moving];
}

/* ============================================================================
   8. LEVEL LIFECYCLE
   ============================================================================ */

function startLevel(index) {
  currentLevelIndex = index;
  level = LEVELS[index];
  // Reset per-level dynamic state (coins, checkpoints, moving platform phase).
  level.coins.forEach(c => c.collected = false);
  level.checkpoints.forEach(cp => cp.active = false);
  level.movingPlatforms.forEach(mp => { mp.curX = mp.baseX; mp.curY = mp.baseY; mp.prevX = mp.baseX; mp.prevY = mp.baseY; });

  player.x = level.playerStart.x;
  player.y = level.playerStart.y;
  player.vx = 0; player.vy = 0;
  player.gravityDir = 1;
  player.visualAngle = 0;
  player.flipCooldown = 0;
  player.deaths = 0;
  player.coinsCollected = 0;
  player.respawnPoint = { x: level.playerStart.x, y: level.playerStart.y };

  camera.x = 0;
  particles = [];
  document.getElementById('hudLevel').textContent = `Level ${index + 1}: ${level.name}`;
  updateCoinHud();
  setState('playing');
}

function respawnPlayer() {
  player.x = player.respawnPoint.x;
  player.y = player.respawnPoint.y;
  player.vx = 0; player.vy = 0;
  player.gravityDir = 1;
  player.visualAngle = 0;
  player.deaths++;
  AudioEngine.sfxDeath();
  triggerShake(8);
}

function killPlayer() {
  spawnParticles(player.x + player.w / 2, player.y + player.h / 2, '#f92aad', 18);
  respawnPlayer();
}

function updateCoinHud() {
  document.getElementById('hudCoins').textContent = `🪙 ${player.coinsCollected}/${level.coins.length}`;
}

function showToast(text) {
  const toast = document.getElementById('toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  // restart CSS animation
  toast.style.animation = 'none';
  void toast.offsetWidth;
  toast.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 1600);
}

function completeLevel() {
  setState('levelcomplete');
  AudioEngine.sfxComplete();
  const stats = { coins: player.coinsCollected, total: level.coins.length, deaths: player.deaths };
  progress.stats[currentLevelIndex] = stats;
  if (progress.unlocked <= currentLevelIndex + 1 && currentLevelIndex + 1 < LEVELS.length) {
    progress.unlocked = currentLevelIndex + 1 + 1; // unlock next (1-indexed count)
  } else if (currentLevelIndex + 1 >= LEVELS.length) {
    progress.unlocked = Math.max(progress.unlocked, LEVELS.length);
  }
  saveProgress();

  document.getElementById('levelStats').textContent =
    `Coins: ${stats.coins}/${stats.total}  •  Deaths: ${stats.deaths}`;

  if (currentLevelIndex + 1 >= LEVELS.length) {
    // That was the last level — show the victory screen instead.
    setState('victory');
    const totalCoins = Object.values(progress.stats).reduce((s, v) => s + v.coins, 0);
    document.getElementById('victoryStats').textContent = `Total coins collected: ${totalCoins}`;
  }
}

/* ============================================================================
   9. PHYSICS UPDATE
   ============================================================================ */

function updatePlayer(dt) {
  // --- Horizontal movement ---
  const control = player.onGround ? 1 : AIR_CONTROL;
  let moveX = 0;
  if (Keys.left) moveX -= 1;
  if (Keys.right) moveX += 1;
  player.vx = moveX * MOVE_SPEED * control;

  // --- Gravity flip (edge-triggered, with cooldown) ---
  if (player.flipCooldown > 0) player.flipCooldown -= dt;
  if (justPressed.flip && player.flipCooldown <= 0) {
    player.gravityDir *= -1;
    player.vy *= 0.35; // dampen so the reversal feels controlled, not jarring
    player.flipCooldown = FLIP_COOLDOWN;
    player.onGround = false;
    AudioEngine.sfxFlip();
    spawnParticles(player.x + player.w / 2, player.y + player.h / 2, '#4deeea', 14);
    triggerShake(3);
  }

  // --- Jump (always opposite of current gravity direction) ---
  if (justPressed.jump && player.onGround) {
    player.vy = -JUMP_VELOCITY * player.gravityDir;
    player.onGround = false;
    AudioEngine.sfxJump();
  }

  // --- Gravity ---
  player.vy += GRAVITY_ACCEL * player.gravityDir * dt;
  player.vy = Math.max(-MAX_FALL_SPEED, Math.min(MAX_FALL_SPEED, player.vy));

  // --- If riding a moving platform, carry its delta motion first ---
  if (player.ridingPlatform) {
    player.x += player.ridingPlatform.curX - player.ridingPlatform.prevX;
    player.y += player.ridingPlatform.curY - player.ridingPlatform.prevY;
  }
  player.ridingPlatform = null;

  // --- Move + resolve X axis ---
  player.x += player.vx * dt;
  player.x = Math.max(0, Math.min(level.width - player.w, player.x));
  for (const solid of allSolids()) {
    if (rectsOverlap(player, solid)) {
      if (player.vx > 0) player.x = solid.x - player.w;
      else if (player.vx < 0) player.x = solid.x + solid.w;
    }
  }

  // --- Move + resolve Y axis ---
  player.y += player.vy * dt;
  player.onGround = false;
  for (const solid of allSolids()) {
    if (!rectsOverlap(player, solid)) continue;
    if (player.vy * player.gravityDir >= 0) {
      // Moving in the direction gravity currently pulls -> landing.
      if (player.gravityDir === 1) player.y = solid.y - player.h;
      else player.y = solid.y + solid.h;
      if (player.vy !== 0 && Math.abs(player.vy) > 260) player.landSquash = 1;
      player.vy = 0;
      player.onGround = true;
      if (solid.ref) player.ridingPlatform = solid.ref;
    } else {
      // Moving against gravity (rising) -> bonked a ceiling/underside.
      if (player.gravityDir === 1) player.y = solid.y + solid.h;
      else player.y = solid.y - player.h;
      player.vy = 0;
    }
  }

  // --- Smooth visual rotation toward the current orientation ---
  const targetAngle = player.gravityDir === 1 ? 0 : Math.PI;
  let diff = targetAngle - player.visualAngle;
  // wrap to shortest path
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  player.visualAngle += diff * Math.min(1, dt * 9);
  if (player.landSquash > 0) player.landSquash = Math.max(0, player.landSquash - dt * 4);

  // --- Hazards & collectibles ---
  checkSpikes();
  checkCoins();
  checkCheckpoints();
  checkGoal();

  // --- Death by falling off-world (into a floor gap or similar) ---
  if (player.y > FLOOR_Y + DEATH_Y_MARGIN || player.y + player.h < CEIL_Y - DEATH_Y_MARGIN) {
    killPlayer();
  }
}

function checkSpikes() {
  for (const s of level.spikes) {
    const hit = { x: s.x, y: s.y, w: s.w, h: s.h };
    if (rectsOverlap(player, hit)) killPlayer();
  }
}

function checkCoins() {
  for (const c of level.coins) {
    if (c.collected) continue;
    const hit = { x: c.x - 10, y: c.y - 10, w: 20, h: 20 };
    if (rectsOverlap(player, hit)) {
      c.collected = true;
      player.coinsCollected++;
      AudioEngine.sfxCoin();
      spawnParticles(c.x, c.y, '#ffe45e', 8);
      updateCoinHud();
    }
  }
}

function checkCheckpoints() {
  for (const cp of level.checkpoints) {
    if (cp.active) continue;
    const hit = { x: cp.x - 10, y: PLAYABLE_TOP, w: 20, h: PLAYABLE_BOTTOM - PLAYABLE_TOP };
    if (rectsOverlap(player, hit)) {
      cp.active = true;
      player.respawnPoint = { x: cp.x, y: FLOOR_Y - player.h };
      AudioEngine.sfxCheckpoint();
      showToast('Checkpoint reached!');
    }
  }
}

function checkGoal() {
  if (rectsOverlap(player, level.goal)) completeLevel();
}

function updateMovingPlatforms(dt, elapsed) {
  for (const mp of level.movingPlatforms) {
    mp.prevX = mp.curX;
    mp.prevY = mp.curY;
    const offset = Math.sin(elapsed * mp.speed) * mp.range;
    if (mp.axis === 'x') mp.curX = mp.baseX + offset;
    else mp.curY = mp.baseY + offset;
  }
}

/* ============================================================================
   10. PARTICLES & SCREEN SHAKE (visual polish, toggle-able in settings)
   ============================================================================ */

function spawnParticles(x, y, color, count) {
  if (!settings.particles) return;
  for (let i = 0; i < count; i++) {
    particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 220,
      vy: (Math.random() - 0.5) * 220,
      life: 0.5 + Math.random() * 0.4,
      age: 0,
      color
    });
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    p.age += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 300 * dt;
  }
  particles = particles.filter(p => p.age < p.life);
}

function triggerShake(amount) {
  if (settings.screenShake) screenShake = Math.max(screenShake, amount);
}

/* ============================================================================
   11. RENDERING
   ============================================================================ */

function drawBackground(elapsed) {
  // Deep-space gradient
  const grad = ctx.createLinearGradient(0, 0, 0, VH);
  grad.addColorStop(0, '#161650');
  grad.addColorStop(1, '#0b0b28');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, VW, VH);

  // Parallax starfield (cheap: deterministic pseudo-random via sine)
  const starCount = settings.quality === 'high' ? 90 : 40;
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let i = 0; i < starCount; i++) {
    const parallax = 0.15 + (i % 3) * 0.1;
    const sx = ((i * 137.5) - camera.x * parallax) % (VW + 100);
    const x = ((sx % (VW + 100)) + (VW + 100)) % (VW + 100) - 50;
    const y = (i * 71) % VH;
    const twinkle = 0.5 + 0.5 * Math.sin(elapsed * 2 + i);
    ctx.globalAlpha = 0.3 + twinkle * 0.5;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.globalAlpha = 1;
}

function drawPlatform(p) {
  let fill = '#3a3a7a';
  let stroke = '#5a5ad0';
  if (p.type === 'floor' || p.type === 'ceiling') { fill = '#2c2c66'; stroke = '#4deeea'; }
  if (p.type === 'floater') { fill = '#3a2c66'; stroke = '#f92aad'; }

  const sx = p.x - camera.x;
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  roundRect(sx, p.y, p.w, p.h, 6);
  ctx.fill();
  ctx.stroke();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSpike(s) {
  const sx = s.x - camera.x;
  ctx.fillStyle = '#ff4d6d';
  ctx.strokeStyle = '#ffb3c0';
  ctx.lineWidth = 1.5;
  const teeth = Math.max(1, Math.round(s.w / 24));
  const tw = s.w / teeth;
  for (let i = 0; i < teeth; i++) {
    ctx.beginPath();
    if (s.side === 'floor') {
      ctx.moveTo(sx + i * tw, s.y + s.h);
      ctx.lineTo(sx + i * tw + tw / 2, s.y);
      ctx.lineTo(sx + i * tw + tw, s.y + s.h);
    } else {
      ctx.moveTo(sx + i * tw, s.y);
      ctx.lineTo(sx + i * tw + tw / 2, s.y + s.h);
      ctx.lineTo(sx + i * tw + tw, s.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

function drawCoin(c, elapsed) {
  if (c.collected) return;
  const sx = c.x - camera.x;
  const bob = Math.sin(elapsed * 3 + c.bob) * 4;
  const squash = Math.abs(Math.cos(elapsed * 2 + c.bob));
  ctx.save();
  ctx.translate(sx, c.y + bob);
  ctx.scale(0.5 + squash * 0.5, 1);
  ctx.beginPath();
  ctx.arc(0, 0, 10, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe45e';
  ctx.fill();
  ctx.strokeStyle = '#fff6c8';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawCheckpoint(cp) {
  const sx = cp.x - camera.x;
  ctx.strokeStyle = '#9a9ac0';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(sx, FLOOR_Y);
  ctx.lineTo(sx, FLOOR_Y - 70);
  ctx.stroke();
  ctx.fillStyle = cp.active ? '#4deeea' : '#5a5a8a';
  ctx.beginPath();
  ctx.moveTo(sx, FLOOR_Y - 70);
  ctx.lineTo(sx + 26, FLOOR_Y - 60);
  ctx.lineTo(sx, FLOOR_Y - 50);
  ctx.closePath();
  ctx.fill();
}

function drawGoal(g, elapsed) {
  const sx = g.x - camera.x;
  const glow = 8 + Math.sin(elapsed * 4) * 4;
  ctx.save();
  ctx.shadowColor = '#f92aad';
  ctx.shadowBlur = settings.quality === 'high' ? glow : 0;
  ctx.fillStyle = 'rgba(249,42,173,0.25)';
  ctx.fillRect(sx, g.y, g.w, g.h);
  ctx.strokeStyle = '#f92aad';
  ctx.lineWidth = 3;
  ctx.strokeRect(sx, g.y, g.w, g.h);
  ctx.restore();
}

function drawPlayer() {
  const sx = player.x - camera.x + player.w / 2;
  const sy = player.y + player.h / 2;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(player.visualAngle);
  const squash = 1 - player.landSquash * 0.25;
  const stretch = 1 + player.landSquash * 0.25;
  ctx.scale(stretch, squash);

  // Body
  ctx.fillStyle = '#4deeea';
  ctx.strokeStyle = '#0b0b28';
  ctx.lineWidth = 2.5;
  roundRect(-player.w / 2, -player.h / 2, player.w, player.h, 9);
  ctx.fill();
  ctx.stroke();

  // Antenna (points toward "up" relative to gravity, i.e. away from the surface)
  ctx.strokeStyle = '#f92aad';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, -player.h / 2);
  ctx.lineTo(0, -player.h / 2 - 10);
  ctx.stroke();
  ctx.fillStyle = '#f92aad';
  ctx.beginPath();
  ctx.arc(0, -player.h / 2 - 10, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Eyes (always drawn upright-feeling by counter-rotating slightly via fixed offsets)
  ctx.fillStyle = '#0b0b28';
  const dir = Keys.left ? -1 : (Keys.right ? 1 : 0);
  ctx.beginPath();
  ctx.arc(-6 + dir * 1.5, -2, 3.5, 0, Math.PI * 2);
  ctx.arc(6 + dir * 1.5, -2, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawParticles() {
  for (const p of particles) {
    const alpha = 1 - p.age / p.life;
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - camera.x - 2, p.y - 2, 4, 4);
  }
  ctx.globalAlpha = 1;
}

function render(elapsed) {
  ctx.save();
  if (screenShake > 0) {
    ctx.translate((Math.random() - 0.5) * screenShake, (Math.random() - 0.5) * screenShake);
  }

  drawBackground(elapsed);

  if (level) {
    for (const p of level.platforms) drawPlatform(p);
    for (const mp of level.movingPlatforms) drawPlatform({ x: mp.curX, y: mp.curY, w: mp.w, h: mp.h, type: 'floater' });
    for (const s of level.spikes) drawSpike(s);
    for (const c of level.coins) drawCoin(c, elapsed);
    for (const cp of level.checkpoints) drawCheckpoint(cp);
    drawGoal(level.goal, elapsed);
    if (gameState === 'playing' || gameState === 'paused') drawPlayer();
    drawParticles();
  }

  ctx.restore();
}

/* ============================================================================
   12. MAIN LOOP
   ============================================================================ */

let elapsedTime = 0;

function loop(timestamp) {
  requestAnimationFrame(loop);
  if (!lastTime) lastTime = timestamp;
  let dt = (timestamp - lastTime) / 1000;
  dt = Math.min(dt, 1 / 30); // clamp to avoid huge steps on tab-switch
  lastTime = timestamp;
  elapsedTime += dt;

  if (gameState === 'playing') {
    updateMovingPlatforms(dt, elapsedTime);
    updatePlayer(dt);
    updateParticles(dt);
    if (screenShake > 0) screenShake = Math.max(0, screenShake - dt * 30);

    // Camera follows the player, clamped to level bounds.
    const targetCamX = player.x - VW / 2 + player.w / 2;
    camera.x += (targetCamX - camera.x) * Math.min(1, dt * 6);
    camera.x = Math.max(0, Math.min(level.width - VW, camera.x));
  }

  render(elapsedTime);

  // Clear edge-triggered "just pressed" keys at the end of every frame.
  for (const k in justPressed) delete justPressed[k];
}

/* ============================================================================
   13. UI STATE MACHINE & WIRING
   ============================================================================ */

const overlays = ['mainMenu', 'levelSelectMenu', 'pauseMenu', 'settingsMenu', 'controlsMenu', 'levelCompleteOverlay', 'victoryOverlay'];
let settingsReturnTo = 'mainMenu';
let controlsReturnTo = 'mainMenu';

function hideAllOverlays() {
  overlays.forEach(id => document.getElementById(id).classList.add('hidden'));
}

function showOverlay(id) {
  hideAllOverlays();
  document.getElementById(id).classList.remove('hidden');
}

function setState(next) {
  gameState = next;
  switch (next) {
    case 'menu': showOverlay('mainMenu'); AudioEngine.stopMusic(); break;
    case 'playing': hideAllOverlays(); AudioEngine.startMusic(); break;
    case 'paused': showOverlay('pauseMenu'); break;
    case 'levelcomplete': showOverlay('levelCompleteOverlay'); break;
    case 'victory': showOverlay('victoryOverlay'); AudioEngine.stopMusic(); break;
  }
}

function ensureAudioStarted() {
  AudioEngine.init();
  if (AudioEngine.ctx.state === 'suspended') AudioEngine.ctx.resume();
}

// --- Main menu ---
document.getElementById('playBtn').addEventListener('click', () => {
  ensureAudioStarted(); AudioEngine.sfxClick();
  startLevel(Math.max(0, Math.min(progress.unlocked - 1, LEVELS.length - 1)));
});
document.getElementById('levelSelectBtn').addEventListener('click', () => {
  ensureAudioStarted(); AudioEngine.sfxClick();
  populateLevelGrid();
  showOverlay('levelSelectMenu');
});
document.getElementById('controlsBtn').addEventListener('click', () => {
  ensureAudioStarted(); AudioEngine.sfxClick();
  controlsReturnTo = 'mainMenu';
  showOverlay('controlsMenu');
});
document.getElementById('settingsBtn').addEventListener('click', () => {
  ensureAudioStarted(); AudioEngine.sfxClick();
  settingsReturnTo = 'mainMenu';
  showOverlay('settingsMenu');
});

// --- Level select ---
function populateLevelGrid() {
  const grid = document.getElementById('levelGrid');
  grid.innerHTML = '';
  LEVELS.forEach((lvl, i) => {
    const locked = i + 1 > progress.unlocked;
    const tile = document.createElement('div');
    tile.className = 'level-tile' + (locked ? ' locked' : '');
    const stats = progress.stats[i];
    const starLabel = stats ? `${stats.coins}/${stats.total} 🪙` : (locked ? '🔒' : 'New');
    tile.innerHTML = `Level ${i + 1}<span class="stars">${starLabel}</span>`;
    if (!locked) tile.addEventListener('click', () => { AudioEngine.sfxClick(); startLevel(i); });
    grid.appendChild(tile);
  });
}
document.querySelectorAll('[data-back="mainMenu"]').forEach(btn =>
  btn.addEventListener('click', () => { AudioEngine.sfxClick(); setState('menu'); })
);

// --- Pause ---
document.getElementById('pauseBtn').addEventListener('click', () => {
  if (gameState === 'playing') setState('paused');
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (gameState === 'playing') setState('paused');
    else if (gameState === 'paused') setState('playing');
  }
  if (e.code === 'KeyM') toggleMute();
});
document.getElementById('resumeBtn').addEventListener('click', () => { AudioEngine.sfxClick(); setState('playing'); });
document.getElementById('restartBtn').addEventListener('click', () => { AudioEngine.sfxClick(); startLevel(currentLevelIndex); });
document.getElementById('quitBtn').addEventListener('click', () => { AudioEngine.sfxClick(); setState('menu'); });
document.getElementById('pauseSettingsBtn').addEventListener('click', () => {
  AudioEngine.sfxClick(); settingsReturnTo = 'pauseMenu'; showOverlay('settingsMenu');
});
document.getElementById('pauseControlsBtn').addEventListener('click', () => {
  AudioEngine.sfxClick(); controlsReturnTo = 'pauseMenu'; showOverlay('controlsMenu');
});

// --- Level complete / victory ---
document.getElementById('nextLevelBtn').addEventListener('click', () => {
  AudioEngine.sfxClick();
  const next = currentLevelIndex + 1;
  if (next < LEVELS.length) startLevel(next); else setState('menu');
});
document.getElementById('replayLevelBtn').addEventListener('click', () => { AudioEngine.sfxClick(); startLevel(currentLevelIndex); });
document.getElementById('levelCompleteMenuBtn').addEventListener('click', () => { AudioEngine.sfxClick(); setState('menu'); });
document.getElementById('victoryMenuBtn').addEventListener('click', () => { AudioEngine.sfxClick(); setState('menu'); });

// --- Settings ---
const musicSlider = document.getElementById('musicSlider');
const sfxSlider = document.getElementById('sfxSlider');
const particlesToggle = document.getElementById('particlesToggle');
const screenShakeToggle = document.getElementById('screenShakeToggle');
const qualitySelect = document.getElementById('qualitySelect');

function refreshSettingsUI() {
  musicSlider.value = settings.musicVolume;
  sfxSlider.value = settings.sfxVolume;
  particlesToggle.checked = settings.particles;
  screenShakeToggle.checked = settings.screenShake;
  qualitySelect.value = settings.quality;
  updateMuteIcon();
}

musicSlider.addEventListener('input', () => { settings.musicVolume = +musicSlider.value; AudioEngine.applyVolumes(); saveSettings(); });
sfxSlider.addEventListener('input', () => { settings.sfxVolume = +sfxSlider.value; AudioEngine.applyVolumes(); saveSettings(); AudioEngine.sfxClick(); });
particlesToggle.addEventListener('change', () => { settings.particles = particlesToggle.checked; saveSettings(); });
screenShakeToggle.addEventListener('change', () => { settings.screenShake = screenShakeToggle.checked; saveSettings(); });
qualitySelect.addEventListener('change', () => { settings.quality = qualitySelect.value; saveSettings(); });

document.getElementById('settingsBackBtn').addEventListener('click', () => {
  AudioEngine.sfxClick();
  showOverlay(settingsReturnTo);
});
document.getElementById('controlsBackBtn').addEventListener('click', () => {
  AudioEngine.sfxClick();
  showOverlay(controlsReturnTo);
});

// --- Mute ---
function updateMuteIcon() {
  document.getElementById('muteBtn').textContent = settings.muted ? '🔇' : '🔊';
}
function toggleMute() {
  settings.muted = !settings.muted;
  AudioEngine.applyVolumes();
  updateMuteIcon();
  saveSettings();
}
document.getElementById('muteBtn').addEventListener('click', () => { ensureAudioStarted(); toggleMute(); });

/* ============================================================================
   14. BOOT
   ============================================================================ */

refreshSettingsUI();
setState('menu');
requestAnimationFrame(loop);
