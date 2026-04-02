const CELL_SIZE = 33;
const TICK_MS = 120;
const MIN_TICK_MS = 50;
const SPEED_STEP = 3; // ms reduction per point scored
const LEADERBOARD_COLLECTIONS = {
  classic:  "leaderboard_classic",
  advanced: "leaderboard_advanced",
};
const PLAYER_NAME_KEY = "snake.playerName.v1";
const GAME_MODE_KEY = "snake.gameMode.v1";
const WRAP_AROUND_KEY = "snake.wrapAround.v1";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const boardFrame = document.getElementById("board-frame");
const scoreEl = document.getElementById("score");
const bestScoreEl = document.getElementById("best-score");
const statusEl = document.getElementById("status");
const playerDisplay = document.getElementById("player-display");
const modeEyebrow = document.getElementById("mode-eyebrow");
const modeClassicBtn = document.getElementById("mode-classic-btn");
const modeAdvancedBtn = document.getElementById("mode-advanced-btn");
const gemHelp = document.getElementById("gem-help");
const leaderboardModeNote = document.getElementById("leaderboard-mode-note");
const advancedOptions = document.getElementById("advanced-options");
const wrapToggle = document.getElementById("wrap-toggle");
const dpadUp    = document.getElementById("dpad-up");
const dpadDown  = document.getElementById("dpad-down");
const dpadLeft  = document.getElementById("dpad-left");
const dpadRight = document.getElementById("dpad-right");
const pauseBtn = document.getElementById("pause-btn");
const restartBtn = document.getElementById("restart-btn");
const changePlayerBtn = document.getElementById("change-player-btn");
const leaderboardBody = document.getElementById("leaderboard-body");

const boardOverlayEl = document.getElementById("board-overlay");
const overlayTitleEl = document.getElementById("overlay-title");
const overlayMessageEl = document.getElementById("overlay-message");

const nameModal = document.getElementById("name-modal");
const nameInput = document.getElementById("player-name");
const nameError = document.getElementById("name-error");
const startBtn = document.getElementById("start-btn");

let gridCols = 20;
let gridRows = 20;
let gameMode = "classic"; // "classic" | "advanced"
let wrapAround = false;
let state = null;
let intervalId = null;
let currentTickMs = 120;
let gameStarted = false;
let playerName = "";
let personalBest = 0;
let newBestCelebrated = false;
let celebration = null; // { life: 1.0 } when active

// Cached DOM text values — skip writes when nothing has changed.
let _lastScoreText = "";
let _lastStatusText = "";
let _lastPauseBtnText = "";

const KEY_DIR = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  a: "left",
  s: "down",
  d: "right",
  W: "up",
  A: "left",
  S: "down",
  D: "right",
};

function sanitizeName(rawName) {
  return rawName.trim().slice(0, 20);
}

function loadSavedGameMode() {
  try {
    const saved = localStorage.getItem(GAME_MODE_KEY);
    return saved === "advanced" ? "advanced" : "classic";
  } catch {
    return "classic";
  }
}

function saveGameMode(mode) {
  try {
    localStorage.setItem(GAME_MODE_KEY, mode);
  } catch {
    // Ignore storage failures.
  }
}

function loadSavedWrapAround() {
  try {
    return localStorage.getItem(WRAP_AROUND_KEY) === "true";
  } catch {
    return false;
  }
}

function saveWrapAround(value) {
  try {
    localStorage.setItem(WRAP_AROUND_KEY, String(value));
  } catch {
    // Ignore storage failures.
  }
}

function applyGameMode(mode) {
  gameMode = mode;
  modeEyebrow.textContent = mode === "advanced" ? "Advanced Mode" : "Classic Mode";
  modeClassicBtn.classList.toggle("active", mode === "classic");
  modeClassicBtn.setAttribute("aria-pressed", String(mode === "classic"));
  modeAdvancedBtn.classList.toggle("active", mode === "advanced");
  modeAdvancedBtn.setAttribute("aria-pressed", String(mode === "advanced"));
  gemHelp.classList.toggle("hidden", mode !== "advanced");
  advancedOptions.classList.toggle("hidden", mode !== "advanced");
  document.getElementById("boost-card")?.classList.toggle("hidden", mode !== "advanced");
  saveGameMode(mode);
  subscribeToLeaderboard(mode);
  fetchPersonalBest(playerName, mode);
  resetGame();
}

function getPlayerBest() {
  return personalBest ?? 0;
}

const _prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function triggerNewBest() {
  newBestCelebrated = true;
  if (!_prefersReducedMotion) {
    celebration = { life: 1.0 };
    boardFrame.classList.add("new-best");
    setTimeout(() => boardFrame.classList.remove("new-best"), 900);
  }
}

function isModalOpen() {
  return !nameModal.classList.contains("hidden");
}

function resizeBoard() {
  const frameRect = boardFrame.getBoundingClientRect();
  const availW = Math.max(CELL_SIZE, frameRect.width);
  const availH = Math.max(CELL_SIZE, frameRect.height);

  gridCols = Math.max(10, Math.floor(availW / CELL_SIZE));
  gridRows = Math.max(10, Math.floor(availH / CELL_SIZE));

  const boardW = gridCols * CELL_SIZE;
  const boardH = gridRows * CELL_SIZE;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(boardW * dpr);
  canvas.height = Math.floor(boardH * dpr);
  canvas.style.width = `${boardW}px`;
  canvas.style.height = `${boardH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function getBaseTickMs() {
  const score = state ? state.score : 0;
  return Math.max(MIN_TICK_MS, TICK_MS - score * SPEED_STEP);
}

function getTickMs() {
  const base = getBaseTickMs();
  if (!state || !state.activeEffects) return base;
  const m = (state.scoreMultiplier > 1 ? state.scoreMultiplier : 1);
  if (state.activeEffects.some((e) => e.type === "speed")) return Math.max(35, Math.floor(base * (0.55 / m)));
  if (state.activeEffects.some((e) => e.type === "slow")) return Math.min(400, Math.floor(base * (1.65 * m)));
  return base;
}

function updateTickSpeed() {
  const newTickMs = getTickMs();
  if (newTickMs !== currentTickMs) {
    currentTickMs = newTickMs;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = setInterval(tick, currentTickMs);
    }
  }
}

function setControlsEnabled(enabled) {
  pauseBtn.disabled = !enabled;
  restartBtn.disabled = !enabled;
}

function loadSavedPlayerName() {
  try {
    return sanitizeName(localStorage.getItem(PLAYER_NAME_KEY) || "");
  } catch (error) {
    return "";
  }
}

function savePlayerName(name) {
  try {
    localStorage.setItem(PLAYER_NAME_KEY, name);
  } catch (error) {
    // Ignore storage failures and continue with in-memory state.
  }
}

// ── Firestore leaderboard ──────────────────────────────────────────────────
let leaderboardUnsubscribe = null;
let _personalBestEpoch = 0; // incremented on each fetch; stale callbacks are ignored

function getLeaderboardCollection(mode) {
  return db.collection(LEADERBOARD_COLLECTIONS[mode] || LEADERBOARD_COLLECTIONS.classic);
}

function subscribeToLeaderboard(mode) {
  if (leaderboardUnsubscribe) leaderboardUnsubscribe();

  leaderboardUnsubscribe = getLeaderboardCollection(mode)
    .orderBy("score", "desc")
    .limit(5)
    .onSnapshot(
      (snapshot) => {
        const entries = snapshot.docs
          .map((doc) => doc.data())
          .sort(compareEntries);
        renderLeaderboard(entries, mode);
      },
      () => renderLeaderboard([], mode)
    );
}

function addScoreToFirestore(name, score, mode) {
  if (!name || score <= 0) return;
  getLeaderboardCollection(mode)
    .add({ name, score, timestamp: firebase.firestore.FieldValue.serverTimestamp() })
    .catch(() => {});
}

function fetchPersonalBest(name, mode) {
  _personalBestEpoch += 1;
  const epoch = _personalBestEpoch;

  if (!name) { personalBest = 0; renderPersonalBest(); return; }

  getLeaderboardCollection(mode)
    .where("name", "==", name)
    .get()
    .then((snapshot) => {
      if (epoch !== _personalBestEpoch) return; // stale — a newer fetch is in flight
      personalBest = snapshot.empty
        ? 0
        : Math.max(...snapshot.docs.map((d) => d.data().score));
      renderPersonalBest();
    })
    .catch(() => {
      if (epoch === _personalBestEpoch) { personalBest = 0; renderPersonalBest(); }
    });
}
// ───────────────────────────────────────────────────────────────────────────

function compareEntries(a, b) {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  // Server timestamps are Firestore Timestamp objects (or null while pending).
  const ta = a.timestamp ? a.timestamp.toMillis?.() ?? a.timestamp : 0;
  const tb = b.timestamp ? b.timestamp.toMillis?.() ?? b.timestamp : 0;
  return ta - tb;
}

function renderPersonalBest() {
  bestScoreEl.textContent = personalBest != null ? String(personalBest) : "-";
}

function renderMultiplier() {
  const boostCard = document.getElementById("boost-card");
  const boostEl = document.getElementById("boost-display");
  if (!boostCard || !boostEl) return;

  const m = state ? state.scoreMultiplier : 1;
  const left = state ? state.multiplierFoodLeft : 0;

  if (m > 1) {
    boostEl.textContent = `${m}\u00d7 (${left})`;
    boostCard.classList.add("boost-active");
  } else {
    boostEl.textContent = "1\u00d7";
    boostCard.classList.remove("boost-active");
  }
}

function renderLeaderboard(entries = [], mode = gameMode) {
  leaderboardModeNote.textContent = `Top 5 \u00b7 ${mode === "advanced" ? "Advanced" : "Classic"}`;
  leaderboardBody.innerHTML = "";

  if (entries.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.className = "empty";
    cell.textContent = "No scores yet.";
    row.appendChild(cell);
    leaderboardBody.appendChild(row);
    return;
  }

  entries.forEach((entry, index) => {
    const row = document.createElement("tr");
    const rankCell = document.createElement("td");
    const nameCell = document.createElement("td");
    const scoreCell = document.createElement("td");

    rankCell.textContent = String(index + 1);
    nameCell.textContent = entry.name;
    scoreCell.textContent = String(entry.score);

    row.appendChild(rankCell);
    row.appendChild(nameCell);
    row.appendChild(scoreCell);
    leaderboardBody.appendChild(row);
  });
}

function recordScore(score) {
  addScoreToFirestore(playerName, score, gameMode);
}

function setPlayer(name) {
  playerName = name;
  playerDisplay.textContent = playerName || "-";
  nameInput.value = playerName;
}

function openNameModal() {
  if (state?.status === "playing") {
    state = SnakeLogic.togglePause(state);
  }

  startBtn.textContent = gameStarted ? "Save and Restart" : "Start";
  nameError.textContent = "";
  nameModal.classList.remove("hidden");
  nameInput.focus();
  nameInput.select();
  render();
}

function closeNameModal() {
  nameModal.classList.add("hidden");
}

function startGame() {
  const name = sanitizeName(nameInput.value);
  if (!name) {
    nameError.textContent = "Please enter your name.";
    nameInput.focus();
    return;
  }

  setPlayer(name);
  savePlayerName(name);
  closeNameModal();
  gameStarted = true;
  setControlsEnabled(true);
  resetGame();

  if (!intervalId) {
    intervalId = window.setInterval(tick, TICK_MS);
  }
}

function resetGame() {
  if (!gameStarted) {
    return;
  }

  if (currentTickMs !== TICK_MS) {
    currentTickMs = TICK_MS;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = setInterval(tick, currentTickMs);
    }
  }

  pops.length = 0;
  celebration = null;
  personalBest = null; // fetched async — null prevents false celebrations
  newBestCelebrated = false;
  renderPersonalBest();
  fetchPersonalBest(playerName, gameMode);
  const isAdvanced = gameMode === "advanced";
  state = SnakeLogic.createInitialState({ gridCols, gridRows, enableGems: isAdvanced, enableObstacles: isAdvanced, wrapAround: isAdvanced && wrapAround });
  render();
}

function togglePause() {
  if (!gameStarted || !state || isModalOpen()) {
    return;
  }

  state = SnakeLogic.togglePause(state);
  render();
}

function playSoundEvents(events = []) {
  events.forEach((e) => {
    if (e.type === "eat")      SoundEngine.eat();
    else if (e.type === "gem") SoundEngine.gem(e.gemType);
    else if (e.type === "win") SoundEngine.win();
    else if (e.type === "gameover") SoundEngine.gameOver();
  });
}

function tick() {
  if (!gameStarted || !state || isModalOpen()) {
    return;
  }

  const previousStatus = state.status;
  state = SnakeLogic.step(state);

  if (
    previousStatus === "playing" &&
    (state.status === "gameover" || state.status === "win")
  ) {
    recordScore(state.score);
  }

  playSoundEvents(state.events);
  spawnPopEvents(state.events);

  if (!newBestCelebrated && personalBest !== null && state.score > personalBest) {
    personalBest = state.score;
    renderPersonalBest();
    triggerNewBest();
  }

  // Recalculate tick speed when score, gems, or active effects change.
  if (state.events && state.events.some((e) => e.type === "eat" || e.type === "gem" || e.type === "effectChange")) {
    updateTickSpeed();
  }

  render();
}

function getStatusText() {
  if (!gameStarted) {
    return "Waiting";
  }

  if (!state) {
    return "Ready";
  }

  if (state.status === "paused") {
    return "Paused";
  }

  if (state.status === "gameover") {
    return "Game Over";
  }

  if (state.status === "win") {
    return "Victory";
  }

  if (state.activeEffects && state.activeEffects.length > 0) {
    const effect = state.activeEffects[0];
    if (effect.type === "speed") return "Speed!";
    if (effect.type === "slow") return "Slowed";
  }

  return "Running";
}

function updateOverlay() {
  if (!gameStarted || !state || isModalOpen()) {
    boardOverlayEl.classList.add("hidden");
    return;
  }

  if (state.status === "paused") {
    overlayTitleEl.textContent = "Paused";
    overlayMessageEl.textContent =
      "Press Space, P, or the Pause button to continue.";
    boardOverlayEl.classList.remove("hidden");
    return;
  }

  if (state.status === "gameover") {
    overlayTitleEl.textContent = "Game Over";
    overlayMessageEl.textContent =
      "Press R or use Restart to begin a new run.";
    boardOverlayEl.classList.remove("hidden");
    return;
  }

  if (state.status === "win") {
    overlayTitleEl.textContent = "Board Cleared";
    overlayMessageEl.textContent =
      "You filled the entire grid. Press R or use Restart to play again.";
    boardOverlayEl.classList.remove("hidden");
    return;
  }

  boardOverlayEl.classList.add("hidden");
}

function drawBackground() {
  const boardW = gridCols * CELL_SIZE;
  const boardH = gridRows * CELL_SIZE;

  ctx.fillStyle = "#09110e";
  ctx.fillRect(0, 0, boardW, boardH);

  ctx.strokeStyle = "rgba(144, 181, 147, 0.14)";
  ctx.lineWidth = 1;

  for (let index = 0; index <= gridCols; index += 1) {
    const x = index * CELL_SIZE + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, boardH);
    ctx.stroke();
  }

  for (let index = 0; index <= gridRows; index += 1) {
    const y = index * CELL_SIZE + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(boardW, y);
    ctx.stroke();
  }
}

function drawCell(x, y, color) {
  const padding = Math.max(1, Math.floor(CELL_SIZE * 0.1));
  const size = CELL_SIZE - padding * 2;

  ctx.fillStyle = color;
  ctx.fillRect(
    x * CELL_SIZE + padding,
    y * CELL_SIZE + padding,
    size,
    size
  );
}

// ── New best celebration ────────────────────────────────────────────────────
function drawCelebration() {
  if (!celebration) return;

  celebration.life -= 0.033; // ~30 ticks = ~3.6s
  if (celebration.life <= 0) {
    celebration = null;
    return;
  }

  const boardW = gridCols * CELL_SIZE;
  const boardH = gridRows * CELL_SIZE;

  // Golden board tint — only in the first 20% of life
  if (celebration.life > 0.8) {
    const flashAlpha = ((celebration.life - 0.8) / 0.2) * 0.12;
    ctx.fillStyle = `rgba(255, 215, 0, ${flashAlpha})`;
    ctx.fillRect(0, 0, boardW, boardH);
  }

  // "NEW BEST!" text — fades in quickly then out slowly
  const alpha = celebration.life > 0.85
    ? (1 - celebration.life) / 0.15       // fade in over first 15%
    : celebration.life / 0.85;            // fade out over remaining 85%

  const fontSize = Math.max(14, Math.floor(CELL_SIZE * 1.1));

  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.font = `900 ${fontSize}px "Trebuchet MS", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffd700";
  ctx.shadowColor = "#ffd700";
  ctx.shadowBlur = 22;
  ctx.fillText("NEW BEST!", boardW / 2, boardH / 2);
  ctx.restore();
}
// ───────────────────────────────────────────────────────────────────────────

// ── Score pops ─────────────────────────────────────────────────────────────
const pops = [];

// Single source of truth for gem colours and pop labels.
const GEM_DEFS = {
  bonus:      { color: "#ffd700", popText: "+5"      },
  shrink:     { color: "#00cfff", popText: "shrink"  },
  speed:      { color: "#ff8800", popText: "speed!"  },
  slow:       { color: "#aa44ff", popText: "slow"    },
  multiplier: { color: "#ff44aa", popText: "\u00d72!" },
};

function spawnPop(gridX, gridY, text, color) {
  pops.push({
    x: gridX * CELL_SIZE + CELL_SIZE / 2,
    y: gridY * CELL_SIZE + CELL_SIZE * 0.25,
    text,
    color,
    life: 1.0,
    dy: 0,
  });
}

function spawnPopEvents(events = []) {
  events.forEach((e) => {
    if (e.type === "eat") {
      spawnPop(e.x, e.y, `+${e.points}`, "#edf4ee");
    } else if (e.type === "gem") {
      const def = GEM_DEFS[e.gemType];
      if (def) spawnPop(e.x, e.y, def.popText, def.color);
    }
  });
}

function updateAndDrawPops() {
  const fontSize = Math.max(10, Math.floor(CELL_SIZE * 0.52));
  ctx.font = `700 ${fontSize}px "Trebuchet MS", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    p.life -= 0.13;
    p.dy   -= 1.8;

    if (p.life <= 0) {
      pops.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 6;
    ctx.fillText(p.text, p.x, p.y + p.dy);
    ctx.restore();
  }
}
// ───────────────────────────────────────────────────────────────────────────

function drawObstacle(x, y) {
  const px = x * CELL_SIZE;
  const py = y * CELL_SIZE;

  ctx.fillStyle = "#3a4855";
  ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);

  // Top/left highlight
  ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
  ctx.fillRect(px, py, CELL_SIZE, 2);
  ctx.fillRect(px, py, 2, CELL_SIZE);

  // Bottom/right shadow
  ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
  ctx.fillRect(px, py + CELL_SIZE - 2, CELL_SIZE, 2);
  ctx.fillRect(px + CELL_SIZE - 2, py, 2, CELL_SIZE);
}

function drawGem(x, y, type, expiresAt) {
  const color = (GEM_DEFS[type] ?? { color: "#ffffff" }).color;
  const cx = x * CELL_SIZE + CELL_SIZE / 2;
  const cy = y * CELL_SIZE + CELL_SIZE / 2;
  const r = Math.max(3, Math.floor(CELL_SIZE * 0.34));

  // Pulse opacity during the last 2 seconds as a warning.
  const msLeft = expiresAt - Date.now();
  const alpha = msLeft < 2000
    ? 0.4 + 0.6 * ((msLeft % 600) / 600)
    : 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fillStyle = color;
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-r, -r, r * 2, r * 2);

  // Inner highlight
  ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
  ctx.fillRect(-r * 0.45, -r * 0.45, r * 0.7, r * 0.7);
  ctx.restore();
}

function render() {
  const scoreText = state ? String(state.score) : "0";
  const statusText = getStatusText();
  const pauseText = state?.status === "paused" ? "Resume" : "Pause";
  if (scoreText  !== _lastScoreText)   { scoreEl.textContent  = _lastScoreText  = scoreText;  }
  if (statusText !== _lastStatusText)  { statusEl.textContent = _lastStatusText = statusText; }
  if (pauseText  !== _lastPauseBtnText){ pauseBtn.textContent = _lastPauseBtnText = pauseText; }
  renderMultiplier();

  drawBackground();

  if (state) {
    if (state.food) {
      drawCell(state.food.x, state.food.y, "#ff7869");
    }

    state.obstacles.forEach((o) => drawObstacle(o.x, o.y));

    state.gems.forEach((gem) => {
      drawGem(gem.x, gem.y, gem.type, gem.expiresAt);
    });

    state.snake.forEach((segment, index) => {
      drawCell(segment.x, segment.y, index === 0 ? "#7cf08d" : "#2da44e");
    });
  }

  drawCelebration();
  updateAndDrawPops();
  updateOverlay();
}

// ── D-pad ──────────────────────────────────────────────────────────────────
function handleDpadInput(dir) {
  if (!gameStarted || isModalOpen()) return;
  if (state && state.status === "playing") {
    state = SnakeLogic.queueDirection(state, dir);
  }
}

[
  [dpadUp,    "up"],
  [dpadDown,  "down"],
  [dpadLeft,  "left"],
  [dpadRight, "right"],
].forEach(([btn, dir]) => {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handleDpadInput(dir);
  });
});
// ───────────────────────────────────────────────────────────────────────────

// ── Swipe detection ────────────────────────────────────────────────────────
let swipeStartX = null;
let swipeStartY = null;
const SWIPE_THRESHOLD = Math.max(20, CELL_SIZE * 0.6);

boardFrame.addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  swipeStartX = t.clientX;
  swipeStartY = t.clientY;
}, { passive: true });

boardFrame.addEventListener("touchend", (e) => {
  if (swipeStartX === null || isModalOpen() || !gameStarted) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeStartX;
  const dy = t.clientY - swipeStartY;
  swipeStartX = null;
  swipeStartY = null;

  if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;

  const dir = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? "right" : "left")
    : (dy > 0 ? "down" : "up");

  if (state && state.status === "playing") {
    state = SnakeLogic.queueDirection(state, dir);
  }
}, { passive: true });
// ───────────────────────────────────────────────────────────────────────────

wrapToggle.addEventListener("change", () => {
  wrapAround = wrapToggle.checked;
  saveWrapAround(wrapAround);
  resetGame();
});

modeClassicBtn.addEventListener("click", () => {
  if (gameMode !== "classic") {
    applyGameMode("classic");
  }
});

modeAdvancedBtn.addEventListener("click", () => {
  if (gameMode !== "advanced") {
    applyGameMode("advanced");
  }
});

pauseBtn.addEventListener("click", togglePause);
restartBtn.addEventListener("click", resetGame);
changePlayerBtn.addEventListener("click", openNameModal);
startBtn.addEventListener("click", startGame);

nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    startGame();
  }
});

nameInput.addEventListener("input", () => {
  if (nameError.textContent) {
    nameError.textContent = "";
  }
});

window.addEventListener("keydown", (event) => {
  if (isModalOpen()) {
    return;
  }

  if (!gameStarted) {
    return;
  }

  const key = event.key;

  if (KEY_DIR[key]) {
    event.preventDefault();
    if (state && state.status === "playing") {
      state = SnakeLogic.queueDirection(state, KEY_DIR[key]);
    }
    return;
  }

  if (key === " " || key === "Spacebar" || key === "p" || key === "P") {
    event.preventDefault();
    togglePause();
    return;
  }

  if (key === "r" || key === "R") {
    event.preventDefault();
    resetGame();
  }
});

window.addEventListener("resize", () => {
  resizeBoard();
  render();
});

if ("ResizeObserver" in window) {
  const boardObserver = new ResizeObserver(() => {
    resizeBoard();
    render();
  });
  boardObserver.observe(boardFrame);
}

// Resume AudioContext on first interaction (browser autoplay policy)
["keydown", "pointerdown", "touchstart"].forEach((evt) => {
  document.addEventListener(evt, () => SoundEngine.resume(), { once: true, passive: true });
});

const _savedName = loadSavedPlayerName();
setPlayer(_savedName);
wrapAround = loadSavedWrapAround();
wrapToggle.checked = wrapAround;
applyGameMode(loadSavedGameMode()); // subscribes to leaderboard + fetches personal best
resizeBoard();
render();

if (_savedName) {
  // Skip the modal and jump straight into the game.
  gameStarted = true;
  setControlsEnabled(true);
  resetGame();
  intervalId = window.setInterval(tick, TICK_MS);
} else {
  setControlsEnabled(false);
  openNameModal();
}
