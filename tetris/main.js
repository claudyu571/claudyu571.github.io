'use strict';

(function () {

// ─── Constants ────────────────────────────────────────────────────────────────

const COLS = 10;
const ROWS = 20;
let CELL = 32; // px per cell — recalculated dynamically
let BOARD_W = COLS * CELL;
let BOARD_H = ROWS * CELL;

const LOCK_DELAY = 500; // ms before a grounded piece locks
const TOAST_DURATION = 800; // ms
const LEVEL_TOAST_DURATION = 1200;

const LINE_LABELS = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS!'];

// ─── State ────────────────────────────────────────────────────────────────────

let state = 'MENU'; // MENU | PLAYING | PAUSED | GAME_OVER
let board, activePiece, nextPiece, bag;
let score, level, totalLines;
let dropTimer, lockTimer, lockMoves;
let lastTimestamp;
let animFrame;
let toastText, toastTimer;
let levelToastText, levelToastTimer;
let clearedLineIndices, flashTimer;
let softDropActive;
let reducedMotion;

// ─── DOM References ───────────────────────────────────────────────────────────

let canvas, ctx;
let overlayMenu, overlayPause, overlayGameOver, overlayLeaderboard, overlayControls;
let elScore, elLevel, elLines, elNextCanvas, elNextCtx;
let elScoreAnnounce, elLevelAnnounce;
let elFinalScore, elBestScore, elNewBest, elNameInput;
let elLbBody;

// ─── Resize / Scaling ────────────────────────────────────────────────────────

function resizeCanvas() {
  const isMobile = window.innerWidth <= 500;
  const pad = isMobile ? 6 : 12;
  const gap = isMobile ? 6 : 12;
  const mobileBarH = isMobile ? 96 : 0;

  // Both side panels fixed at 160px
  const panels = isMobile ? 0 : 160 * 2 + gap * 2;

  const availW = window.innerWidth  - pad * 2 - panels;
  const availH = window.innerHeight - pad * 2 - mobileBarH;

  CELL = Math.max(14, Math.floor(Math.min(availH / ROWS, availW / COLS)));
  BOARD_W = COLS * CELL;
  BOARD_H = ROWS * CELL;

  if (canvas) {
    canvas.width  = BOARD_W;
    canvas.height = BOARD_H;
  }

  if (elNextCanvas) {
    const pCell = Math.min(CELL, 28); // cap so panel stays compact (4*28+24 = 136px)
    elNextCanvas.width  = 4 * pCell;
    elNextCanvas.height = 4 * pCell;
  }

  // Patterns are sized to CELL — must rebuild on resize
  for (const k of Object.keys(patternCache)) delete patternCache[k];

  // Redraw whatever state we're in
  if (state === 'PLAYING' || state === 'PAUSED') {
    render();
    drawNextPiece();
  } else if (ctx) {
    ctx.fillStyle = '#09110e';
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  }
}

// ─── Canvas Patterns ─────────────────────────────────────────────────────────

const patternCache = {};

function buildPattern(ctx, type, color) {
  const key = type + color;
  if (patternCache[key]) return patternCache[key];

  const sz = CELL;
  const offscreen = document.createElement('canvas');
  offscreen.width = sz;
  offscreen.height = sz;
  const c = offscreen.getContext('2d');

  c.fillStyle = color;
  c.fillRect(0, 0, sz, sz);
  c.strokeStyle = 'rgba(0,0,0,0.35)';
  c.fillStyle = 'rgba(0,0,0,0.28)';
  c.lineWidth = 1.5;

  switch (type) {
    case 'stripe_h':
      for (let y = 6; y < sz; y += 9) {
        c.fillRect(0, y, sz, 4);
      }
      break;
    case 'dot':
      c.beginPath();
      c.arc(sz / 2, sz / 2, sz / 5, 0, Math.PI * 2);
      c.fill();
      break;
    case 'diagonal_r':
      for (let i = -sz; i < sz * 2; i += 8) {
        c.beginPath();
        c.moveTo(i, 0);
        c.lineTo(i + sz, sz);
        c.stroke();
      }
      break;
    case 'diagonal_l':
      for (let i = -sz; i < sz * 2; i += 8) {
        c.beginPath();
        c.moveTo(i, sz);
        c.lineTo(i + sz, 0);
        c.stroke();
      }
      break;
    case 'cross':
      c.beginPath();
      c.moveTo(sz / 2, 4); c.lineTo(sz / 2, sz - 4);
      c.moveTo(4, sz / 2); c.lineTo(sz - 4, sz / 2);
      c.lineWidth = 3;
      c.stroke();
      break;
    case 'checker': {
      const half = sz / 2;
      c.fillRect(0, 0, half, half);
      c.fillRect(half, half, half, half);
      break;
    }
    case 'solid':
    default:
      break;
  }

  // Cell border / bevel
  c.strokeStyle = 'rgba(255,255,255,0.2)';
  c.lineWidth = 1;
  c.strokeRect(1, 1, sz - 2, sz - 2);
  c.strokeStyle = 'rgba(0,0,0,0.4)';
  c.strokeRect(2, 2, sz - 4, sz - 4);

  const pat = ctx.createPattern(offscreen, 'no-repeat');
  patternCache[key] = pat;
  return pat;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function drawCell(targetCtx, x, y, pieceType, alpha = 1) {
  const piece = PIECES[pieceType];
  const px = x * CELL;
  const py = y * CELL;

  targetCtx.save();
  targetCtx.globalAlpha = alpha;
  targetCtx.translate(px, py);

  const pat = buildPattern(targetCtx, PIECE_PATTERNS[pieceType], piece.color);
  if (pat) {
    targetCtx.fillStyle = pat;
  } else {
    targetCtx.fillStyle = piece.color;
  }
  targetCtx.fillRect(0, 0, CELL, CELL);

  targetCtx.restore();
}

function drawGhostCell(targetCtx, x, y, pieceType) {
  const piece = PIECES[pieceType];
  const px = x * CELL;
  const py = y * CELL;

  targetCtx.save();
  targetCtx.globalAlpha = 0.28;
  targetCtx.fillStyle = piece.color;
  targetCtx.fillRect(px, py, CELL, CELL);
  targetCtx.restore();

  // Dashed border at full opacity for contrast (WCAG fix)
  targetCtx.save();
  targetCtx.strokeStyle = piece.color;
  targetCtx.lineWidth = 1.5;
  targetCtx.setLineDash([4, 3]);
  targetCtx.strokeRect(px + 1, py + 1, CELL - 2, CELL - 2);
  targetCtx.restore();
}

function drawBoard() {
  // Background
  ctx.fillStyle = '#09110e';
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);

  // Grid lines
  ctx.strokeStyle = 'rgba(144,181,147,0.10)';
  ctx.lineWidth = 0.5;
  for (let c = 0; c <= COLS; c++) {
    ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, BOARD_H); ctx.stroke();
  }
  for (let r = 0; r <= ROWS; r++) {
    ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(BOARD_W, r * CELL); ctx.stroke();
  }

  // Locked cells
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const type = board[r][c];
      if (!type) continue;

      // Flash effect on cleared lines
      if (!reducedMotion && clearedLineIndices && clearedLineIndices.includes(r) && flashTimer > 0) {
        const t = flashTimer / 200;
        ctx.save();
        ctx.globalAlpha = t;
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
        ctx.restore();
        continue;
      }

      drawCell(ctx, c, r, type);
    }
  }
}

function drawGhost() {
  if (!activePiece) return;
  const ghost = getGhostPiece(board, activePiece);
  if (ghost.y === activePiece.y) return; // no ghost if already grounded

  for (let r = 0; r < ghost.matrix.length; r++) {
    for (let c = 0; c < ghost.matrix[r].length; c++) {
      if (!ghost.matrix[r][c]) continue;
      const ny = ghost.y + r;
      const nx = ghost.x + c;
      if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS) continue;
      drawGhostCell(ctx, nx, ny, ghost.type);
    }
  }
}

function drawActivePiece() {
  if (!activePiece) return;
  for (let r = 0; r < activePiece.matrix.length; r++) {
    for (let c = 0; c < activePiece.matrix[r].length; c++) {
      if (!activePiece.matrix[r][c]) continue;
      const ny = activePiece.y + r;
      const nx = activePiece.x + c;
      if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS) continue;
      drawCell(ctx, nx, ny, activePiece.type);
    }
  }
}

function drawNextPiece() {
  if (!nextPiece || !elNextCtx) return;
  const nc = elNextCanvas.width;
  const nr = elNextCanvas.height;
  elNextCtx.clearRect(0, 0, nc, nr);

  const mat = nextPiece.matrix;
  // Derive cell size from canvas size so it always fits
  const pCell = Math.floor(nc / 4);
  const pieceW = mat[0].length * pCell;
  const pieceH = mat.length * pCell;
  const offsetX = Math.floor((nc - pieceW) / 2);
  const offsetY = Math.floor((nr - pieceH) / 2);

  for (let r = 0; r < mat.length; r++) {
    for (let c = 0; c < mat[r].length; c++) {
      if (!mat[r][c]) continue;
      const px = offsetX + c * pCell;
      const py = offsetY + r * pCell;

      elNextCtx.save();
      elNextCtx.translate(px, py);
      const pat = buildPattern(elNextCtx, PIECE_PATTERNS[nextPiece.type], nextPiece.color);
      elNextCtx.fillStyle = pat || nextPiece.color;
      elNextCtx.fillRect(0, 0, pCell, pCell);
      elNextCtx.restore();
    }
  }
}

function drawToast() {
  if (!toastText || toastTimer <= 0) return;
  const alpha = Math.min(1, toastTimer / 200);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `bold 18px 'Press Start 2P', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.shadowColor = toastText === 'TETRIS!' ? '#FFE600' : '#00F5FF';
  ctx.shadowBlur = 16;
  ctx.fillText(toastText, BOARD_W / 2, BOARD_H * 0.42);
  ctx.restore();
}

function drawLevelToast() {
  if (!levelToastText || levelToastTimer <= 0) return;
  const alpha = Math.min(1, levelToastTimer / 300);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `bold 14px 'Press Start 2P', monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#BF5FFF';
  ctx.shadowColor = '#BF5FFF';
  ctx.shadowBlur = 20;
  ctx.fillText(levelToastText, BOARD_W / 2, BOARD_H * 0.52);
  ctx.restore();
}

function render() {
  drawBoard();
  drawGhost();
  drawActivePiece();
  drawToast();
  drawLevelToast();
  drawNextPiece();
  updateHUD();
}

function updateHUD() {
  if (elScore) elScore.textContent = String(score).padStart(6, '0');
  if (elLevel) elLevel.textContent = level;
  if (elLines) elLines.textContent = totalLines;
}

// ─── Game Logic ───────────────────────────────────────────────────────────────

function nextFromBag() {
  if (bag.length === 0) bag = createBag();
  return bag.shift();
}

function spawnNext() {
  activePiece = spawnPiece(nextPiece.type);
  nextPiece = spawnPiece(nextFromBag());
  lockTimer = null;
  lockMoves = 0;

  if (!isValidPosition(board, activePiece)) {
    triggerGameOver();
  }
}

function tryMove(dx, dy) {
  if (!activePiece) return false;
  if (isValidPosition(board, activePiece, dx, dy)) {
    activePiece = { ...activePiece, x: activePiece.x + dx, y: activePiece.y + dy };
    if (dy === 0 && lockTimer !== null && lockMoves < 15) {
      // Reset lock delay on successful lateral move while grounded
      lockTimer = LOCK_DELAY;
      lockMoves++;
    }
    return true;
  }
  return false;
}

function tryRotateActive(dir) {
  if (!activePiece) return;
  const rotated = tryRotate(board, activePiece, dir);
  if (rotated) {
    activePiece = rotated;
    if (lockTimer !== null && lockMoves < 15) {
      lockTimer = LOCK_DELAY;
      lockMoves++;
    }
  }
}

function hardDrop() {
  if (!activePiece) return;
  let dropped = 0;
  while (isValidPosition(board, activePiece, 0, 1)) {
    activePiece = { ...activePiece, y: activePiece.y + 1 };
    dropped++;
  }
  score += dropped * 2;
  announceScore();
  lockActive();
}

function lockActive() {
  board = lockPiece(board, activePiece);
  const indices = getClearedLineIndices(board);

  if (indices.length > 0) {
    if (!reducedMotion) {
      clearedLineIndices = indices;
      flashTimer = 200;
    }

    setTimeout(() => {
      const { newBoard, linesCleared } = clearLines(board);
      board = newBoard;
      clearedLineIndices = null;

      const prev = level;
      totalLines += linesCleared;
      const newLevel = calcLevel(totalLines);
      score += calcScore(linesCleared, level);
      level = newLevel;

      announceScore();
      if (level > prev) announceLevel();

      showToast(LINE_LABELS[linesCleared]);
      if (level > prev) showLevelToast(level);

      spawnNext();
    }, reducedMotion ? 0 : 200);
  } else {
    spawnNext();
  }

  lockTimer = null;
  dropTimer = calcDropInterval(level);
}

function showToast(text) {
  toastText = text;
  toastTimer = TOAST_DURATION;
}

function showLevelToast(lvl) {
  levelToastText = `LEVEL ${lvl}`;
  levelToastTimer = LEVEL_TOAST_DURATION;
}

function announceScore() {
  if (elScoreAnnounce) elScoreAnnounce.textContent = `Score: ${score}`;
}

function announceLevel() {
  if (elLevelAnnounce) elLevelAnnounce.textContent = `Level ${level}`;
}

// ─── Game Loop ────────────────────────────────────────────────────────────────

function gameLoop(timestamp) {
  if (state !== 'PLAYING') return;

  const dt = lastTimestamp ? Math.min(timestamp - lastTimestamp, 200) : 0;
  lastTimestamp = timestamp;

  // Gravity
  dropTimer -= softDropActive ? dt * 10 : dt;
  if (softDropActive && dropTimer > 0) score += 1;

  if (dropTimer <= 0) {
    dropTimer = calcDropInterval(level);
    if (!tryMove(0, 1)) {
      // Piece is grounded — start lock delay
      if (lockTimer === null) lockTimer = LOCK_DELAY;
    }
  }

  // Lock delay countdown
  if (lockTimer !== null) {
    lockTimer -= dt;
    if (lockTimer <= 0) lockActive();
  }

  // Toast timers
  if (toastTimer > 0) toastTimer -= dt;
  if (levelToastTimer > 0) levelToastTimer -= dt;
  if (flashTimer > 0) flashTimer -= dt;

  render();
  animFrame = requestAnimationFrame(gameLoop);
}

// ─── Input ────────────────────────────────────────────────────────────────────

const keysDown = new Set();

function handleKeyDown(e) {
  if (keysDown.has(e.code)) return; // prevent repeat for instant actions
  keysDown.add(e.code);

  if (state === 'MENU') {
    if (e.code === 'Enter' || e.code === 'Space') startGame();
    return;
  }

  if (state === 'GAME_OVER') {
    if (e.code === 'Enter' || e.code === 'Space') {
      if (document.activeElement !== elNameInput) startGame();
    }
    return;
  }

  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (state === 'PLAYING') pauseGame();
    else if (state === 'PAUSED') resumeGame();
    return;
  }

  if (state !== 'PLAYING') return;

  switch (e.code) {
    case 'ArrowLeft':  e.preventDefault(); tryMove(-1, 0); break;
    case 'ArrowRight': e.preventDefault(); tryMove(1, 0); break;
    case 'ArrowUp':    e.preventDefault(); tryRotateActive(1); break;
    case 'KeyZ':       tryRotateActive(-1); break;
    case 'KeyX':       tryRotateActive(1); break;
    case 'ArrowDown':  e.preventDefault(); softDropActive = true; break;
    case 'Space':      e.preventDefault(); hardDrop(); break;
  }
}

function handleKeyUp(e) {
  keysDown.delete(e.code);
  if (e.code === 'ArrowDown') softDropActive = false;
}

// DAS (Delayed Auto Shift) for left/right
let dasTimer = null;
let arrTimer = null;
const DAS_DELAY = 170;
const ARR_INTERVAL = 50;

document.addEventListener('keydown', (e) => {
  if (state !== 'PLAYING') { handleKeyDown(e); return; }

  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    if (keysDown.has(e.code)) return;
    handleKeyDown(e);
    clearTimeout(dasTimer); clearInterval(arrTimer);
    const dir = e.code === 'ArrowLeft' ? -1 : 1;
    dasTimer = setTimeout(() => {
      arrTimer = setInterval(() => {
        if (state === 'PLAYING') tryMove(dir, 0);
        else { clearInterval(arrTimer); }
      }, ARR_INTERVAL);
    }, DAS_DELAY);
  } else {
    handleKeyDown(e);
  }
});

document.addEventListener('keyup', (e) => {
  handleKeyUp(e);
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    clearTimeout(dasTimer); clearInterval(arrTimer);
  }
});

// ─── Mobile Controls ──────────────────────────────────────────────────────────

function setupMobileControls() {
  const btn = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', (e) => { e.preventDefault(); fn(); }, { passive: false });
    el.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
  };

  btn('btn-left',   () => { if (state === 'PLAYING') tryMove(-1, 0); });
  btn('btn-right',  () => { if (state === 'PLAYING') tryMove(1, 0); });
  btn('btn-rotate', () => { if (state === 'PLAYING') tryRotateActive(1); });
  btn('btn-rcw',    () => { if (state === 'PLAYING') tryRotateActive(1); });
  btn('btn-rccw',   () => { if (state === 'PLAYING') tryRotateActive(-1); });
  btn('btn-down',   () => { if (state === 'PLAYING') tryMove(0, 1); });
  btn('btn-drop',   () => { if (state === 'PLAYING') hardDrop(); });
}

// ─── State Transitions ────────────────────────────────────────────────────────

function startGame() {
  board = createBoard(ROWS, COLS);
  score = 0;
  level = 0;
  totalLines = 0;
  dropTimer = calcDropInterval(0);
  lockTimer = null;
  lockMoves = 0;
  toastText = '';
  toastTimer = 0;
  levelToastText = '';
  levelToastTimer = 0;
  clearedLineIndices = null;
  flashTimer = 0;
  softDropActive = false;
  lastTimestamp = null;
  keysDown.clear();

  bag = createBag();
  nextPiece = spawnPiece(nextFromBag());
  spawnNext();

  showOverlay(null);
  state = 'PLAYING';
  cancelAnimationFrame(animFrame);
  animFrame = requestAnimationFrame(gameLoop);
  canvas.focus();
}

function pauseGame() {
  if (state !== 'PLAYING') return;
  state = 'PAUSED';
  cancelAnimationFrame(animFrame);
  showOverlay('pause');
}

function resumeGame() {
  if (state !== 'PAUSED') return;
  showOverlay(null);
  state = 'PLAYING';
  lastTimestamp = null;
  animFrame = requestAnimationFrame(gameLoop);
  canvas.focus();
}

function triggerGameOver() {
  state = 'GAME_OVER';
  cancelAnimationFrame(animFrame);

  const best = getPersonalBest();
  const isNew = score > best;
  if (isNew) setPersonalBest(score);

  if (elFinalScore) elFinalScore.textContent = String(score).padStart(6, '0');
  if (elBestScore) elBestScore.textContent = String(isNew ? score : best).padStart(6, '0');
  if (elNewBest) elNewBest.style.display = isNew ? 'block' : 'none';
  if (elNameInput) elNameInput.value = getSavedName() || '';

  showOverlay('game-over');
}

// ─── Overlays ─────────────────────────────────────────────────────────────────

function showOverlay(name) {
  [overlayMenu, overlayPause, overlayGameOver, overlayLeaderboard, overlayControls].forEach(el => {
    if (el) el.hidden = true;
  });
  const targets = {
    'menu': overlayMenu,
    'pause': overlayPause,
    'game-over': overlayGameOver,
    'leaderboard': overlayLeaderboard,
    'controls': overlayControls,
  };
  if (name && targets[name]) {
    targets[name].hidden = false;
    // Move focus to first focusable element
    const first = targets[name].querySelector('button, input');
    if (first) setTimeout(() => first.focus(), 50);
  }
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

function getLeaderboard() {
  try { return JSON.parse(localStorage.getItem('tetris_lb') || '[]'); } catch { return []; }
}

function saveLeaderboard(lb) {
  localStorage.setItem('tetris_lb', JSON.stringify(lb));
}

function addScore(name, s, lvl) {
  const lb = getLeaderboard();
  lb.push({ name: name.slice(0, 12).toUpperCase() || 'PLAYER', score: s, level: lvl });
  lb.sort((a, b) => b.score - a.score);
  saveLeaderboard(lb.slice(0, 10));
}

function getPersonalBest() {
  try { return parseInt(localStorage.getItem('tetris_best') || '0', 10); } catch { return 0; }
}

function setPersonalBest(s) {
  localStorage.setItem('tetris_best', String(s));
}

function getSavedName() {
  return localStorage.getItem('tetris_name') || '';
}

function renderLeaderboard() {
  if (!elLbBody) return;
  const lb = getLeaderboard();
  const rankLabels = ['1ST', '2ND', '3RD'];
  if (lb.length === 0) {
    elLbBody.innerHTML = `<tr><td colspan="4" class="lb-empty">No scores yet. Be the first.</td></tr>`;
    return;
  }
  elLbBody.innerHTML = lb.slice(0, 10).map((entry, i) => `
    <tr class="${i < 3 ? 'lb-top' : ''}">
      <td>${rankLabels[i] || (i + 1)}</td>
      <td>${entry.name}</td>
      <td>${String(entry.score).padStart(6, '0')}</td>
      <td>${entry.level}</td>
    </tr>
  `).join('');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  canvas = document.getElementById('board');
  ctx = canvas.getContext('2d');

  elNextCanvas = document.getElementById('next-canvas');
  if (elNextCanvas) {
    elNextCtx = elNextCanvas.getContext('2d');
  }

  resizeCanvas();
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(resizeCanvas, 80);
  });

  overlayMenu        = document.getElementById('overlay-menu');
  overlayPause       = document.getElementById('overlay-pause');
  overlayGameOver    = document.getElementById('overlay-game-over');
  overlayLeaderboard = document.getElementById('overlay-leaderboard');
  overlayControls    = document.getElementById('overlay-controls');

  elScore = document.getElementById('hud-score');
  elLevel = document.getElementById('hud-level');
  elLines = document.getElementById('hud-lines');

  elScoreAnnounce = document.getElementById('score-announce');
  elLevelAnnounce = document.getElementById('level-announce');

  elFinalScore = document.getElementById('final-score');
  elBestScore  = document.getElementById('best-score');
  elNewBest    = document.getElementById('new-best');
  elNameInput  = document.getElementById('name-input');
  elLbBody     = document.getElementById('lb-body');

  // Menu buttons
  bindBtn('btn-play',   () => startGame());
  bindBtn('btn-lb',     () => { renderLeaderboard(); showOverlay('leaderboard'); });
  bindBtn('btn-how',    () => showOverlay('controls'));
  bindBtn('btn-resume', () => resumeGame());
  bindBtn('btn-quit',   () => {
    state = 'MENU';
    cancelAnimationFrame(animFrame);
    // Clear canvases so nothing lingers behind the menu overlay
    if (elNextCtx && elNextCanvas) elNextCtx.clearRect(0, 0, elNextCanvas.width, elNextCanvas.height);
    if (ctx) { ctx.fillStyle = '#09110e'; ctx.fillRect(0, 0, BOARD_W, BOARD_H); }
    nextPiece = null;
    activePiece = null;
    showOverlay('menu');
  });
  bindBtn('btn-again',  () => startGame());
  bindBtn('btn-save',   () => {
    const name = elNameInput ? elNameInput.value.trim() : '';
    localStorage.setItem('tetris_name', name);
    addScore(name || 'PLAYER', score, level);
    renderLeaderboard();
    showOverlay('leaderboard');
  });
  bindBtn('btn-lb-close',       () => showOverlay('menu'));
  bindBtn('btn-controls-close', () => showOverlay('menu'));
  bindBtn('btn-lb-from-go',     () => { renderLeaderboard(); showOverlay('leaderboard'); });

  setupMobileControls();

  showOverlay('menu');
  state = 'MENU';

  // Draw empty board on canvas so it's not blank
  board = createBoard(ROWS, COLS);
  ctx.fillStyle = '#09110e';
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
}

function bindBtn(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
}

document.addEventListener('DOMContentLoaded', init);

})();
