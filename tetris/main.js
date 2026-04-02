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
let holdPieceType, holdUsed; // hold slot
let score, level, totalLines;
let dropTimer, lockTimer, lockMoves;
let lastTimestamp;
let animFrame;
let toastText, toastTimer;
let levelToastText, levelToastTimer;
let clearedLineIndices, flashTimer;
let softDropActive;
let reducedMotion;
let scorePops; // floating score popups [{x, y, text, color, life, dy}]
let combo; // consecutive line clears without a miss

// ─── DOM References ───────────────────────────────────────────────────────────

let canvas, ctx;
let overlayMenu, overlayPause, overlayGameOver, overlayLeaderboard, overlayControls;
let elScore, elLevel, elLines, elNextCanvas, elNextCtx;
let elHoldCanvas, elHoldCtx;
let elCombo, elComboBox;
let elScoreAnnounce, elLevelAnnounce;
let elFinalScore, elBestScore, elNewBest, elNameInput;
let elLbBody, elSideLbBody;

// ─── Resize / Scaling ────────────────────────────────────────────────────────

function resizeCanvas() {
  const isMobile = window.innerWidth <= 500;
  const pad = isMobile ? 6 : 12;
  const gap = isMobile ? 6 : 12;
  const mobileBarH = isMobile ? 96 : 0;

  // Both side panels fixed at 192px
  const panels = isMobile ? 0 : 192 * 2 + gap * 2;

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
    const pCell = Math.min(CELL, 34); // cap so piece previews fit with padding
    elNextCanvas.width  = 4 * pCell;
    elNextCanvas.height = 4 * pCell;
  }

  if (elHoldCanvas) {
    const pCell = Math.min(CELL, 34);
    elHoldCanvas.width  = 4 * pCell;
    elHoldCanvas.height = 4 * pCell;
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

function getFilledBounds(mat) {
  let minR = mat.length, maxR = 0, minC = mat[0].length, maxC = 0;
  for (let r = 0; r < mat.length; r++) {
    for (let c = 0; c < mat[r].length; c++) {
      if (!mat[r][c]) continue;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
    }
  }
  return { minR, maxR, minC, maxC, w: maxC - minC + 1, h: maxR - minR + 1 };
}

function drawNextPiece() {
  if (!nextPiece || !elNextCtx) return;
  const nc = elNextCanvas.width;
  const nr = elNextCanvas.height;
  elNextCtx.clearRect(0, 0, nc, nr);

  const mat = nextPiece.matrix;
  const pCell = Math.floor(nc / 4);
  const bounds = getFilledBounds(mat);
  const offsetX = Math.floor((nc - bounds.w * pCell) / 2);
  const offsetY = Math.floor((nr - bounds.h * pCell) / 2);

  for (let r = 0; r < mat.length; r++) {
    for (let c = 0; c < mat[r].length; c++) {
      if (!mat[r][c]) continue;
      const px = offsetX + (c - bounds.minC) * pCell;
      const py = offsetY + (r - bounds.minR) * pCell;

      elNextCtx.save();
      elNextCtx.translate(px, py);
      const pat = buildPattern(elNextCtx, PIECE_PATTERNS[nextPiece.type], nextPiece.color);
      elNextCtx.fillStyle = pat || nextPiece.color;
      elNextCtx.fillRect(0, 0, pCell, pCell);
      elNextCtx.restore();
    }
  }
}

function drawHoldPiece() {
  if (!elHoldCtx || !elHoldCanvas) return;
  const nc = elHoldCanvas.width;
  const nr = elHoldCanvas.height;
  elHoldCtx.clearRect(0, 0, nc, nr);
  if (!holdPieceType) return;

  const piece = PIECES[holdPieceType];
  const mat = piece.matrices[0];
  const pCell = Math.floor(nc / 4);
  const bounds = getFilledBounds(mat);
  const offsetX = Math.floor((nc - bounds.w * pCell) / 2);
  const offsetY = Math.floor((nr - bounds.h * pCell) / 2);

  const alpha = holdUsed ? 0.4 : 1;

  for (let r = 0; r < mat.length; r++) {
    for (let c = 0; c < mat[r].length; c++) {
      if (!mat[r][c]) continue;
      const px = offsetX + (c - bounds.minC) * pCell;
      const py = offsetY + (r - bounds.minR) * pCell;

      elHoldCtx.save();
      elHoldCtx.globalAlpha = alpha;
      elHoldCtx.translate(px, py);
      const pat = buildPattern(elHoldCtx, PIECE_PATTERNS[holdPieceType], piece.color);
      elHoldCtx.fillStyle = pat || piece.color;
      elHoldCtx.fillRect(0, 0, pCell, pCell);
      elHoldCtx.restore();
    }
  }
}

function spawnScorePop(text, color, row) {
  // Position popup at center of the cleared row area
  const x = BOARD_W / 2;
  const y = row * CELL + CELL / 2;
  scorePops.push({ x, y, text, color, life: 1.0, dy: 0 });
}

function updateAndDrawPops(dt) {
  for (let i = scorePops.length - 1; i >= 0; i--) {
    const p = scorePops[i];
    p.life -= dt * 0.0013; // ~770ms lifespan
    p.dy -= dt * 0.12;     // rise upward
    if (p.life <= 0) { scorePops.splice(i, 1); continue; }

    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life);
    const fontSize = Math.max(10, Math.floor(CELL * 0.52));
    ctx.font = `bold ${fontSize}px "Trebuchet MS", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 6;
    ctx.fillText(p.text, p.x, p.y + p.dy);
    ctx.restore();
  }
}

function drawToast() {
  if (!toastText || toastTimer <= 0) return;
  const alpha = Math.min(1, toastTimer / 200);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = toastText.split('\n');
  const isTetris = toastText.includes('TETRIS!');
  ctx.shadowColor = isTetris ? '#FFE600' : '#00F5FF';
  ctx.shadowBlur = 16;
  for (let i = 0; i < lines.length; i++) {
    const isBonus = lines[i] === 'SAME PIECE!';
    ctx.font = isBonus
      ? `bold 12px 'Press Start 2P', monospace`
      : `bold 18px 'Press Start 2P', monospace`;
    ctx.fillStyle = isBonus ? '#FFE600' : '#FFFFFF';
    ctx.fillText(lines[i], BOARD_W / 2, BOARD_H * 0.42 + i * 28);
  }
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

function render(dt) {
  drawBoard();
  drawGhost();
  drawActivePiece();
  updateAndDrawPops(dt || 0);
  drawToast();
  drawLevelToast();
  drawNextPiece();
  drawHoldPiece();
  updateHUD();
}

function updateHUD() {
  if (elScore) elScore.textContent = String(score).padStart(6, '0');
  if (elLevel) elLevel.textContent = level;
  if (elLines) elLines.textContent = totalLines;
  if (elComboBox) {
    if (combo >= 2) {
      elComboBox.style.display = '';
      elCombo.textContent = `×${combo}`;
    } else {
      elComboBox.style.display = 'none';
    }
  }
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
  holdUsed = false;

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

function holdCurrentPiece() {
  if (!activePiece || holdUsed) return;
  holdUsed = true;
  const prevHold = holdPieceType;
  holdPieceType = activePiece.type;

  if (prevHold) {
    activePiece = spawnPiece(prevHold);
  } else {
    activePiece = spawnPiece(nextPiece.type);
    nextPiece = spawnPiece(nextFromBag());
  }

  lockTimer = null;
  lockMoves = 0;
  dropTimer = calcDropInterval(level);

  if (!isValidPosition(board, activePiece)) {
    triggerGameOver();
  }

  drawHoldPiece();
  drawNextPiece();
}

function checkSamePieceBonus(board, lineIndices) {
  if (lineIndices.length === 0) return false;
  let pieceType = null;
  for (const row of lineIndices) {
    for (let c = 0; c < COLS; c++) {
      const cell = board[row][c];
      if (!cell) return false;
      if (pieceType === null) pieceType = cell;
      else if (cell !== pieceType) return false;
    }
  }
  return true;
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
      // Check same-piece bonus before clearing
      const samePiece = checkSamePieceBonus(board, indices);

      const { newBoard, linesCleared } = clearLines(board);
      board = newBoard;
      clearedLineIndices = null;

      // Combo tracking
      combo++;
      if (combo >= 2 && elComboBox) {
        elComboBox.classList.add('combo-flash');
        setTimeout(() => elComboBox.classList.remove('combo-flash'), 150);
      }

      const prev = level;
      totalLines += linesCleared;
      const newLevel = calcLevel(totalLines);
      let gained = calcScore(linesCleared, level);

      // Apply combo multiplier (starts at combo 2)
      const comboMultiplier = combo >= 2 ? 1 + (combo - 1) * 0.5 : 1;
      gained = Math.floor(gained * comboMultiplier);

      if (samePiece && linesCleared > 0) {
        gained = Math.floor(gained * 1.5);
      }
      score += gained;
      level = newLevel;

      announceScore();
      if (level > prev) announceLevel();

      let label = LINE_LABELS[linesCleared];
      if (samePiece && linesCleared > 0) label += '\nSAME PIECE!';
      showToast(label);
      if (level > prev) showLevelToast(level);

      // Floating score popup at the cleared row
      const midRow = indices[Math.floor(indices.length / 2)];
      let popText = `+${gained}`;
      let popColor = '#edf4ee';
      if (linesCleared === 4) popColor = '#FFE600';
      else if (linesCleared >= 2) popColor = '#00F5FF';
      spawnScorePop(popText, popColor, midRow);

      if (combo >= 2) {
        spawnScorePop(`COMBO ×${combo}`, '#ff44aa', midRow + 1);
      }
      if (samePiece && linesCleared > 0) {
        spawnScorePop('SAME PIECE!', '#FFE600', midRow - 1);
      }

      spawnNext();
    }, reducedMotion ? 0 : 200);
  } else {
    combo = 0;
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

  render(dt);
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
    case 'KeyA':       tryMove(-1, 0); break;
    case 'ArrowRight': e.preventDefault(); tryMove(1, 0); break;
    case 'KeyD':       tryMove(1, 0); break;
    case 'ArrowUp':    e.preventDefault(); tryRotateActive(1); break;
    case 'KeyW':       tryRotateActive(1); break;
    case 'KeyZ':       tryRotateActive(-1); break;
    case 'KeyX':       tryRotateActive(1); break;
    case 'ArrowDown':  e.preventDefault(); softDropActive = true; break;
    case 'KeyS':       softDropActive = true; break;
    case 'Space':      e.preventDefault(); hardDrop(); break;
    case 'KeyC':       // fall through
    case 'ShiftLeft':  // fall through
    case 'ShiftRight': holdCurrentPiece(); break;
  }
}

function handleKeyUp(e) {
  keysDown.delete(e.code);
  if (e.code === 'ArrowDown' || e.code === 'KeyS') softDropActive = false;
}

// DAS (Delayed Auto Shift) for left/right
let dasTimer = null;
let arrTimer = null;
const DAS_DELAY = 170;
const ARR_INTERVAL = 50;

document.addEventListener('keydown', (e) => {
  if (state !== 'PLAYING') { handleKeyDown(e); return; }

  const isLeft  = e.code === 'ArrowLeft'  || e.code === 'KeyA';
  const isRight = e.code === 'ArrowRight' || e.code === 'KeyD';
  if (isLeft || isRight) {
    if (keysDown.has(e.code)) return;
    handleKeyDown(e);
    clearTimeout(dasTimer); clearInterval(arrTimer);
    const dir = isLeft ? -1 : 1;
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
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'KeyA' || e.code === 'KeyD') {
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
  btn('btn-hold',   () => { if (state === 'PLAYING') holdCurrentPiece(); });
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
  holdPieceType = null;
  holdUsed = false;
  scorePops = [];
  combo = 0;
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

  const isNew = score > personalBest;
  if (isNew) personalBest = score;

  if (elFinalScore) elFinalScore.textContent = String(score).padStart(6, '0');
  if (elBestScore) elBestScore.textContent = String(isNew ? score : personalBest).padStart(6, '0');
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

// ─── Leaderboard (Firestore) ─────────────────────────────────────────────────

const LB_COLLECTION = 'tetris_leaderboard';
let leaderboardUnsubscribe = null;
let personalBest = 0;
let _personalBestEpoch = 0;

function getLeaderboardCollection() {
  return db.collection(LB_COLLECTION);
}

function subscribeToLeaderboard() {
  if (leaderboardUnsubscribe) leaderboardUnsubscribe();

  leaderboardUnsubscribe = getLeaderboardCollection()
    .orderBy('score', 'desc')
    .limit(10)
    .onSnapshot(
      (snapshot) => {
        const entries = snapshot.docs
          .map((doc) => doc.data())
          .sort(compareEntries);
        renderLeaderboard(entries);
      },
      () => renderLeaderboard([])
    );
}

function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ta = a.timestamp ? a.timestamp.toMillis?.() ?? a.timestamp : 0;
  const tb = b.timestamp ? b.timestamp.toMillis?.() ?? b.timestamp : 0;
  return ta - tb;
}

function addScoreToFirestore(name, s, lvl) {
  if (!name || s <= 0) return;
  getLeaderboardCollection()
    .add({
      name: name.slice(0, 12).toUpperCase() || 'PLAYER',
      score: s,
      level: lvl,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    })
    .catch(() => {});
}

function fetchPersonalBest(name) {
  _personalBestEpoch += 1;
  const epoch = _personalBestEpoch;

  if (!name) { personalBest = 0; return; }

  getLeaderboardCollection()
    .where('name', '==', name.slice(0, 12).toUpperCase())
    .get()
    .then((snapshot) => {
      if (epoch !== _personalBestEpoch) return;
      personalBest = snapshot.empty
        ? 0
        : Math.max(...snapshot.docs.map((d) => d.data().score));
    })
    .catch(() => {
      if (epoch === _personalBestEpoch) personalBest = 0;
    });
}

function getSavedName() {
  return localStorage.getItem('tetris_name') || '';
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderLeaderboard(entries) {
  // Overlay leaderboard (full table)
  if (elLbBody) {
    const rankLabels = ['1ST', '2ND', '3RD'];
    if (!entries || entries.length === 0) {
      elLbBody.innerHTML = `<tr><td colspan="4" class="lb-empty">No scores yet. Be the first.</td></tr>`;
    } else {
      elLbBody.innerHTML = entries.slice(0, 10).map((entry, i) => `
        <tr class="${i < 3 ? 'lb-top' : ''}">
          <td>${rankLabels[i] || (i + 1)}</td>
          <td>${escapeHtml(entry.name)}</td>
          <td>${String(entry.score).padStart(6, '0')}</td>
          <td>${entry.level}</td>
        </tr>
      `).join('');
    }
  }

  // Side panel leaderboard (compact)
  if (elSideLbBody) {
    if (!entries || entries.length === 0) {
      elSideLbBody.innerHTML = `<tr><td colspan="3" class="lb-empty">No scores yet.</td></tr>`;
    } else {
      elSideLbBody.innerHTML = entries.slice(0, 5).map((entry, i) => `
        <tr>
          <td>${i + 1}.</td>
          <td>${escapeHtml(entry.name)}</td>
          <td>${String(entry.score).padStart(6, '0')}</td>
        </tr>
      `).join('');
    }
  }
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

  elHoldCanvas = document.getElementById('hold-canvas');
  if (elHoldCanvas) {
    elHoldCtx = elHoldCanvas.getContext('2d');
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
  elCombo = document.getElementById('hud-combo');
  elComboBox = document.getElementById('combo-box');

  elScoreAnnounce = document.getElementById('score-announce');
  elLevelAnnounce = document.getElementById('level-announce');

  elFinalScore = document.getElementById('final-score');
  elBestScore  = document.getElementById('best-score');
  elNewBest    = document.getElementById('new-best');
  elNameInput  = document.getElementById('name-input');
  elLbBody     = document.getElementById('lb-body');
  elSideLbBody = document.getElementById('side-lb-body');

  // Menu buttons
  bindBtn('btn-play',   () => startGame());
  bindBtn('btn-lb',     () => showOverlay('leaderboard'));
  bindBtn('btn-how',    () => showOverlay('controls'));
  bindBtn('btn-resume', () => resumeGame());
  bindBtn('btn-quit',   () => {
    state = 'MENU';
    cancelAnimationFrame(animFrame);
    // Clear canvases so nothing lingers behind the menu overlay
    if (elNextCtx && elNextCanvas) elNextCtx.clearRect(0, 0, elNextCanvas.width, elNextCanvas.height);
    if (elHoldCtx && elHoldCanvas) elHoldCtx.clearRect(0, 0, elHoldCanvas.width, elHoldCanvas.height);
    if (ctx) { ctx.fillStyle = '#09110e'; ctx.fillRect(0, 0, BOARD_W, BOARD_H); }
    nextPiece = null;
    activePiece = null;
    holdPieceType = null;
    showOverlay('menu');
  });
  bindBtn('btn-again',  () => startGame());
  bindBtn('btn-save',   () => {
    const name = elNameInput ? elNameInput.value.trim() : '';
    localStorage.setItem('tetris_name', name);
    addScoreToFirestore(name || 'PLAYER', score, level);
    fetchPersonalBest(name || 'PLAYER');
    showOverlay('leaderboard');
  });
  bindBtn('btn-lb-close',       () => showOverlay('menu'));
  bindBtn('btn-controls-close', () => showOverlay('menu'));
  bindBtn('btn-lb-from-go',     () => showOverlay('leaderboard'));

  setupMobileControls();

  // Start real-time leaderboard listener & fetch personal best
  subscribeToLeaderboard();
  const savedName = getSavedName();
  if (savedName) fetchPersonalBest(savedName);

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
