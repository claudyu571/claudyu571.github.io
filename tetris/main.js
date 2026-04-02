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
let lastClearWasTetris; // back-to-back Tetris/T-spin chain tracking
let lastActionWasRotation; // T-spin detection: was last player action a rotation?
let startLevel = 0; // starting level chosen in menu
let prevNextType = null; // cache key for next-piece preview
let prevHoldKey  = null; // cache key for hold-piece preview (type + dimmed state)
let gridCache = null; // offscreen canvas for static grid lines

// ─── Multiplayer state ────────────────────────────────────────────────────────
let multiplayerMode = false;
let mpSyncTimer = 0;          // countdown until next Firebase sync
let mpGameStarting = false;   // guard against double-start race
let mpReady = false;          // this player's ready state in lobby
let opponentState = null;     // latest data from Firebase for the opponent

// ─── DOM References ───────────────────────────────────────────────────────────

let canvas, ctx;
let overlayMenu, overlayPause, overlayGameOver, overlayLeaderboard, overlayControls;
let elScore, elLevel, elLines, elNextCanvas, elNextCtx;
let elHoldCanvas, elHoldCtx;
let elCombo, elComboBox;
let elScoreAnnounce, elLevelAnnounce;
let elFinalScore, elBestScore, elNewBest, elNameInput;
let elLbBody, elSideLbBody;

// Multiplayer DOM refs
let overlayMpMenu, overlayMpJoin, overlayMpWaiting, overlayMpLobby, overlayMpResult;
let elMpRoomCodeDisplay, elMpRoomInput, elMpJoinError;
let elMpP1Name, elMpP2Name, elMpP1Status, elMpP2Status;
let elMpReadyBtn, elMpLobbyCodeDisplay;
let elMpResultTitle, elMpResultScore, elMpResultOppScore;
let elOppBoard, elOppCtx, elOppNameDisplay, elOppScore, elOppLevel;
let elMpOpponentWrap;

// ─── Resize / Scaling ────────────────────────────────────────────────────────

function resizeCanvas() {
  const isMobile = window.innerWidth <= 500;
  const pad = isMobile ? 6 : 12;
  const gap = isMobile ? 6 : 12;
  const mobileBarH = isMobile ? 96 : 0;

  // Both side panels fixed at 192px; in multiplayer subtract opponent board width
  const oppW   = (!isMobile && multiplayerMode) ? OPP_W + gap : 0;
  const panels = isMobile ? 0 : 192 * 2 + gap * 2;

  const availW = window.innerWidth  - pad * 2 - panels - oppW;
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

  // Opponent canvas always fixed size
  if (elOppBoard) {
    elOppBoard.width  = OPP_W;
    elOppBoard.height = OPP_H;
  }

  // Patterns are sized to CELL — must rebuild on resize
  for (const k of Object.keys(patternCache)) delete patternCache[k];

  // Rebuild static grid cache and force preview redraws at new size
  buildGridCache();
  prevNextType = null;
  prevHoldKey  = null;

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

// ─── Multiplayer: board encoding ──────────────────────────────────────────────
const PIECE_TO_INT = { I:1, O:2, T:3, S:4, Z:5, J:6, L:7 };
const INT_TO_PIECE = ['', 'I', 'O', 'T', 'S', 'Z', 'J', 'L'];

function encodeBoard(b) {
  // Flat 200-element array (Firestore does not support nested arrays)
  const flat = new Array(ROWS * COLS);
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      flat[r * COLS + c] = b[r][c] ? (PIECE_TO_INT[b[r][c]] || 0) : 0;
  return flat;
}
function decodeBoard(enc) {
  if (!enc || enc.length !== ROWS * COLS) return null;
  const board = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++)
      row.push(INT_TO_PIECE[enc[r * COLS + c]] || null);
    board.push(row);
  }
  return board;
}

// ─── Multiplayer: opponent board rendering ────────────────────────────────────
const OPP_CELL = 14; // px per cell on opponent canvas
const OPP_W    = COLS * OPP_CELL;
const OPP_H    = ROWS * OPP_CELL;

function drawOpponentBoard() {
  if (!elOppCtx) return;
  const oc = elOppCtx;

  oc.fillStyle = '#09110e';
  oc.fillRect(0, 0, OPP_W, OPP_H);

  // Grid
  oc.strokeStyle = 'rgba(144,181,147,0.08)';
  oc.lineWidth = 0.5;
  oc.beginPath();
  for (let c = 0; c <= COLS; c++) { oc.moveTo(c*OPP_CELL, 0); oc.lineTo(c*OPP_CELL, OPP_H); }
  for (let r = 0; r <= ROWS; r++) { oc.moveTo(0, r*OPP_CELL); oc.lineTo(OPP_W, r*OPP_CELL); }
  oc.stroke();

  if (!opponentState) return;

  const board = decodeBoard(opponentState.board);
  if (board) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const t = board[r][c];
        if (!t) continue;
        oc.fillStyle = PIECES[t].color;
        oc.fillRect(c*OPP_CELL+1, r*OPP_CELL+1, OPP_CELL-2, OPP_CELL-2);
      }
    }
  }

  // Active piece
  const p = opponentState.piece;
  if (p && PIECES[p.type]) {
    const mat = PIECES[p.type].matrices[p.rotation] || PIECES[p.type].matrices[0];
    oc.fillStyle = PIECES[p.type].color;
    oc.globalAlpha = 0.85;
    for (let r = 0; r < mat.length; r++) {
      for (let c = 0; c < mat[r].length; c++) {
        if (!mat[r][c]) continue;
        const ny = p.y + r, nx = p.x + c;
        if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS) continue;
        oc.fillRect(nx*OPP_CELL+1, ny*OPP_CELL+1, OPP_CELL-2, OPP_CELL-2);
      }
    }
    oc.globalAlpha = 1;
  }

  // Game-over dim
  if (opponentState.gameOver) {
    oc.fillStyle = 'rgba(0,0,0,0.65)';
    oc.fillRect(0, 0, OPP_W, OPP_H);
    oc.fillStyle = '#ff5555';
    oc.font = `bold ${OPP_CELL}px 'Press Start 2P', monospace`;
    oc.textAlign = 'center';
    oc.textBaseline = 'middle';
    oc.fillText('GAME OVER', OPP_W / 2, OPP_H / 2);
  }
}

function buildGridCache() {
  const offscreen = document.createElement('canvas');
  offscreen.width  = BOARD_W;
  offscreen.height = BOARD_H;
  const gc = offscreen.getContext('2d');
  gc.strokeStyle = 'rgba(144,181,147,0.10)';
  gc.lineWidth = 0.5;
  gc.beginPath();
  for (let c = 0; c <= COLS; c++) {
    gc.moveTo(c * CELL, 0); gc.lineTo(c * CELL, BOARD_H);
  }
  for (let r = 0; r <= ROWS; r++) {
    gc.moveTo(0, r * CELL); gc.lineTo(BOARD_W, r * CELL);
  }
  gc.stroke();
  gridCache = offscreen;
}

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

  // Grid lines — drawn once to offscreen cache, stamped each frame
  if (gridCache) ctx.drawImage(gridCache, 0, 0);

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

function drawPiecePreview(canvasEl, canvasCtx, pieceType, alpha) {
  if (!canvasCtx || !canvasEl) return;
  const nc = canvasEl.width;
  const nr = canvasEl.height;
  canvasCtx.clearRect(0, 0, nc, nr);
  if (!pieceType) return;

  const piece = PIECES[pieceType];
  const mat   = piece.matrices[0];
  const pCell = Math.floor(nc / 4);
  const bounds = getFilledBounds(mat);
  const offsetX = Math.floor((nc - bounds.w * pCell) / 2);
  const offsetY = Math.floor((nr - bounds.h * pCell) / 2);

  for (let r = 0; r < mat.length; r++) {
    for (let c = 0; c < mat[r].length; c++) {
      if (!mat[r][c]) continue;
      const px = offsetX + (c - bounds.minC) * pCell;
      const py = offsetY + (r - bounds.minR) * pCell;

      canvasCtx.save();
      canvasCtx.globalAlpha = alpha !== undefined ? alpha : 1;
      canvasCtx.translate(px, py);
      const pat = buildPattern(canvasCtx, PIECE_PATTERNS[pieceType], piece.color);
      canvasCtx.fillStyle = pat || piece.color;
      canvasCtx.fillRect(0, 0, pCell, pCell);
      canvasCtx.restore();
    }
  }
}

function drawNextPiece() {
  if (!nextPiece || !elNextCtx) return;
  if (nextPiece.type === prevNextType) return; // no change — skip redraw
  prevNextType = nextPiece.type;
  drawPiecePreview(elNextCanvas, elNextCtx, nextPiece.type, 1);
}

function drawHoldPiece() {
  if (!elHoldCtx || !elHoldCanvas) return;
  const key = holdPieceType ? (holdPieceType + (holdUsed ? '_dim' : '')) : null;
  if (key === prevHoldKey) return; // no change — skip redraw
  prevHoldKey = key;
  drawPiecePreview(elHoldCanvas, elHoldCtx, holdPieceType, holdUsed ? 0.4 : 1);
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
  if (multiplayerMode) drawOpponentBoard();
  updateHUD();
}

function updateHUD() {
  if (elScore) elScore.textContent = String(score).padStart(6, '0');
  if (elLevel) elLevel.textContent = level;
  if (elLines) elLines.textContent = totalLines;
  if (elComboBox) {
    if (combo >= 2) {
      if (elComboBox.style.display === 'none') {
        elComboBox.style.display = '';
        elComboBox.classList.add('combo-appear');
        setTimeout(() => elComboBox.classList.remove('combo-appear'), 200);
      }
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
  lastActionWasRotation = false;

  if (!isValidPosition(board, activePiece)) {
    triggerGameOver();
  }
}

function tryMove(dx, dy) {
  if (!activePiece) return false;
  if (isValidPosition(board, activePiece, dx, dy)) {
    activePiece = { ...activePiece, x: activePiece.x + dx, y: activePiece.y + dy };
    if (dx !== 0) lastActionWasRotation = false; // lateral move breaks T-spin eligibility
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
    lastActionWasRotation = true; // track for T-spin detection
    if (lockTimer !== null && lockMoves < 15) {
      lockTimer = LOCK_DELAY;
      lockMoves++;
    }
  }
}

function checkTSpin(boardState, piece) {
  if (piece.type !== 'T') return 'none';
  if (!lastActionWasRotation) return 'none';

  // Check the 4 diagonal corners around the T-piece center (matrix[1][1])
  const cx = piece.x + 1;
  const cy = piece.y + 1;
  const corners = [[cy-1,cx-1],[cy-1,cx+1],[cy+1,cx-1],[cy+1,cx+1]];

  let filled = 0;
  for (const [r, c] of corners) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) filled++; // wall counts as filled
    else if (boardState[r][c]) filled++;
  }

  return filled >= 3 ? 'tspin' : 'none';
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
  // render() will call drawHoldPiece()/drawNextPiece() next frame via cache-aware guards
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
  lastActionWasRotation = false; // hard drop clears T-spin eligibility
  let dropped = 0;
  while (isValidPosition(board, activePiece, 0, 1)) {
    activePiece = { ...activePiece, y: activePiece.y + 1 };
    dropped++;
  }
  score += dropped * 2;
  announceScore();
  lockActive();
}

// T-spin score table: [lines cleared 0..3]
const TSPIN_SCORE = [400, 800, 1200, 1600];

function lockActive() {
  // Check T-spin BEFORE locking (we need original board + piece position)
  const tspinType = checkTSpin(board, activePiece);

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
      const newLevel = Math.max(startLevel, calcLevel(totalLines));

      // Base score: T-spin overrides normal line-clear scoring
      let gained = tspinType === 'tspin'
        ? (TSPIN_SCORE[linesCleared] || TSPIN_SCORE[TSPIN_SCORE.length - 1]) * (level + 1)
        : calcScore(linesCleared, level);

      // Back-to-back bonus (1.5×): consecutive Tetris or T-spin clears
      const isDifficult = (linesCleared === 4) || (tspinType === 'tspin' && linesCleared > 0);
      const backToBack = isDifficult && lastClearWasTetris;
      if (backToBack) gained = Math.floor(gained * 1.5);
      lastClearWasTetris = isDifficult; // update chain tracker

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

      // Toast label
      let label = LINE_LABELS[linesCleared] || '';
      if (tspinType === 'tspin') {
        label = linesCleared > 0 ? `T-SPIN ${label}`.trim() : 'T-SPIN!';
      } else if (samePiece && linesCleared > 0) {
        label += '\nSAME PIECE!';
      }
      if (backToBack && linesCleared > 0) label = 'B2B!\n' + label;
      showToast(label);
      if (level > prev) showLevelToast(level);

      // Floating score popups
      const midRow = indices[Math.floor(indices.length / 2)];
      let popColor = '#edf4ee';
      if (tspinType === 'tspin') popColor = '#BF5FFF';
      else if (linesCleared === 4) popColor = '#FFE600';
      else if (linesCleared >= 2) popColor = '#00F5FF';
      if (backToBack) popColor = '#FF9A3C';
      spawnScorePop(`+${gained}`, popColor, midRow);

      if (tspinType === 'tspin') spawnScorePop('T-SPIN!', '#BF5FFF', midRow - 1);
      if (backToBack && linesCleared > 0) spawnScorePop('B2B!', '#FF9A3C', midRow - (tspinType === 'tspin' ? 2 : 1));
      if (combo >= 2) spawnScorePop(`COMBO ×${combo}`, '#ff44aa', midRow + 1);
      if (samePiece && linesCleared > 0 && tspinType === 'none') spawnScorePop('SAME PIECE!', '#FFE600', midRow - 1);

      spawnNext();
    }, reducedMotion ? 0 : 200);
  } else {
    if (tspinType === 'tspin') {
      // T-spin with no line clear: still counts as difficult for B2B, awards points
      const tspinPoints = TSPIN_SCORE[0] * (level + 1);
      score += tspinPoints;
      lastClearWasTetris = true;
      spawnScorePop('T-SPIN!', '#BF5FFF', Math.floor(ROWS / 2));
      showToast('T-SPIN!');
    } else {
      lastClearWasTetris = false; // non-difficult clear breaks B2B chain
    }
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

  if (dropTimer <= 0) {
    dropTimer = calcDropInterval(level);
    const movedDown = tryMove(0, 1);
    if (!movedDown) {
      // Piece is grounded — start lock delay
      if (lockTimer === null) lockTimer = LOCK_DELAY;
    } else if (softDropActive) {
      score += 1; // 1 point per cell soft-dropped
    }
  }

  // Multiplayer: sync game state to Firebase periodically
  if (multiplayerMode) {
    mpSyncTimer -= dt;
    if (mpSyncTimer <= 0) {
      mpSyncTimer = 150; // sync every 150 ms
      MP.syncGameState({
        board:    encodeBoard(board),
        piece:    activePiece ? { type: activePiece.type, x: activePiece.x, y: activePiece.y, rotation: activePiece.rotation } : null,
        score,
        level,
        lines:    totalLines,
        gameOver: false,
      });
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
  btn('btn-up',     () => { if (state === 'PLAYING') tryRotateActive(1); });
  btn('btn-rcw',    () => { if (state === 'PLAYING') tryRotateActive(1); });
  btn('btn-rccw',   () => { if (state === 'PLAYING') tryRotateActive(-1); });
  btn('btn-down',   () => { if (state === 'PLAYING') tryMove(0, 1); });
  btn('btn-drop',   () => { if (state === 'PLAYING') hardDrop(); });
  btn('btn-hold',   () => { if (state === 'PLAYING') holdCurrentPiece(); });
  btn('btn-pause',  () => {
    if (state === 'PLAYING') pauseGame();
    else if (state === 'PAUSED') resumeGame();
  });
}

// ─── State Transitions ────────────────────────────────────────────────────────

function startGame() {
  board = createBoard(ROWS, COLS);
  score = 0;
  level = startLevel;
  totalLines = 0;
  dropTimer = calcDropInterval(startLevel);
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
  lastClearWasTetris = false;
  lastActionWasRotation = false;
  prevNextType = null;
  prevHoldKey  = null;
  lastTimestamp = null;
  mpSyncTimer = 0;
  mpGameStarting = false;
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
  if (multiplayerMode) return; // no pausing during online multiplayer
  state = 'PAUSED';
  cancelAnimationFrame(animFrame);
  if (elLevelAnnounce) elLevelAnnounce.textContent = 'Game paused';
  showOverlay('pause');
}

function resumeGame() {
  if (state !== 'PAUSED') return;
  showOverlay(null);
  state = 'PLAYING';
  if (elLevelAnnounce) elLevelAnnounce.textContent = 'Game resumed';
  lastTimestamp = null;
  animFrame = requestAnimationFrame(gameLoop);
  canvas.focus();
}

function triggerGameOver() {
  state = 'GAME_OVER';
  cancelAnimationFrame(animFrame);

  // Multiplayer: sync final state then let Firebase decide winner
  if (multiplayerMode) {
    MP.syncGameStateNow({
      board: encodeBoard(board), piece: null,
      score, level, lines: totalLines, gameOver: true,
    }).then(() => MP.signalGameOver());
    return; // result overlay comes from handleRoomUpdate
  }

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
  [overlayMenu, overlayPause, overlayGameOver, overlayLeaderboard, overlayControls,
   overlayMpMenu, overlayMpJoin, overlayMpWaiting, overlayMpLobby, overlayMpResult].forEach(el => {
    if (el) el.hidden = true;
  });
  const targets = {
    'menu':        overlayMenu,
    'pause':       overlayPause,
    'game-over':   overlayGameOver,
    'leaderboard': overlayLeaderboard,
    'controls':    overlayControls,
    'mp-menu':     overlayMpMenu,
    'mp-join':     overlayMpJoin,
    'mp-waiting':  overlayMpWaiting,
    'mp-lobby':    overlayMpLobby,
    'mp-result':   overlayMpResult,
  };
  if (name && targets[name]) {
    targets[name].hidden = false;
    // Move focus to first focusable element
    const first = targets[name].querySelector('button, input');
    if (first) setTimeout(() => first.focus(), 50);
  }
}

// ─── Multiplayer Logic ────────────────────────────────────────────────────────

function mpUpdateLobby(room) {
  const mySlot  = MP.playerSlot;
  const p1 = room.player1 || {};
  const p2 = room.player2 || {};
  const myReady = (mySlot === 'player1' ? p1 : p2).ready || false;
  mpReady = myReady;

  if (elMpLobbyCodeDisplay) elMpLobbyCodeDisplay.textContent = MP.roomCode;
  if (elMpP1Name)   elMpP1Name.textContent   = p1.name || 'P1';
  if (elMpP2Name)   elMpP2Name.textContent   = p2.name || 'Waiting…';
  if (elMpP1Status) {
    elMpP1Status.textContent = p1.ready ? '✓ READY' : 'NOT READY';
    elMpP1Status.className   = 'mp-player-status' + (p1.ready ? ' mp-status-ready' : '');
  }
  if (elMpP2Status) {
    elMpP2Status.textContent = room.player2 ? (p2.ready ? '✓ READY' : 'NOT READY') : '…';
    elMpP2Status.className   = 'mp-player-status' + (p2.ready ? ' mp-status-ready' : '');
  }
  if (elMpReadyBtn) {
    elMpReadyBtn.disabled    = !room.player2; // can't ready without opponent
    elMpReadyBtn.textContent = myReady ? "NOT READY" : "I'M READY";
    elMpReadyBtn.className   = 'btn ' + (myReady ? 'btn-secondary' : 'btn-primary');
  }
}

function mpStartGame(room) {
  if (mpGameStarting || state === 'PLAYING') return;
  mpGameStarting = true;

  const oppSlot = MP.playerSlot === 'player1' ? 'player2' : 'player1';
  const oppName = (room[oppSlot] || {}).name || 'OPPONENT';
  if (elOppNameDisplay) elOppNameDisplay.textContent = oppName;
  if (elOppScore)  elOppScore.textContent  = '000000';
  if (elOppLevel)  elOppLevel.textContent  = '0';
  opponentState = null;

  // If player 1, write 'playing' status; both players' listeners will catch it
  if (MP.playerSlot === 'player1') {
    MP.setGameStarted().catch(() => {});
  }

  multiplayerMode = true;
  mpSyncTimer = 0;
  document.querySelector('.game-wrapper').classList.add('game-wrapper--mp');
  if (elMpOpponentWrap) elMpOpponentWrap.setAttribute('aria-hidden', 'false');
  resizeCanvas(); // recalculate board size accounting for opponent panel
  startGame();   // clears overlays, starts loop
}

function mpShowResult(won, oppFinalScore) {
  cancelAnimationFrame(animFrame);
  state = 'GAME_OVER';

  const title = won ? 'YOU WIN! 🏆' : 'YOU LOSE 💀';
  if (elMpResultTitle) {
    elMpResultTitle.textContent = title;
    elMpResultTitle.className   = 'overlay-title ' + (won ? 'mp-win' : 'mp-lose');
  }
  if (elMpResultScore)    elMpResultScore.textContent    = String(score).padStart(6, '0');
  if (elMpResultOppScore) elMpResultOppScore.textContent = String(oppFinalScore || 0).padStart(6, '0');
  showOverlay('mp-result');
}

async function mpExitToMenu() {
  cancelAnimationFrame(animFrame);
  mpGameStarting  = false;
  multiplayerMode = false;
  opponentState   = null;
  mpReady         = false;
  document.querySelector('.game-wrapper').classList.remove('game-wrapper--mp');
  if (elMpOpponentWrap) elMpOpponentWrap.setAttribute('aria-hidden', 'true');
  resizeCanvas();
  await MP.leaveRoom();
  state = 'MENU';
  showOverlay('menu');
}

function handleRoomUpdate({ data, deleted }) {
  if (deleted) {
    if (state === 'PLAYING') mpShowResult(true, 0); // opponent left — we win
    else mpExitToMenu();
    return;
  }

  const room   = data;
  const mySlot = MP.playerSlot;
  const oppSlot = mySlot === 'player1' ? 'player2' : 'player1';
  const oppData = room[oppSlot];

  // Update opponent display
  if (oppData && oppData.gameState) {
    opponentState = oppData.gameState;
    drawOpponentBoard();
    if (elOppScore) elOppScore.textContent = String(opponentState.score || 0).padStart(6, '0');
    if (elOppLevel) elOppLevel.textContent = opponentState.level || 0;
  }

  // Lobby updates
  if ((room.status === 'waiting' || room.status === 'lobby') && state !== 'PLAYING') {
    showOverlay(room.status === 'lobby' ? 'mp-lobby' : 'mp-waiting');
    if (room.status === 'lobby') mpUpdateLobby(room);
  }

  // Both ready → player 1 triggers game start, player 2 waits for 'playing'
  if (room.status === 'lobby' && room.player1?.ready && room.player2?.ready) {
    mpStartGame(room);
  }
  if (room.status === 'playing' && !mpGameStarting && state !== 'PLAYING' && state !== 'GAME_OVER') {
    mpStartGame(room);
  }

  // Game finished
  if (room.status === 'finished' && (state === 'PLAYING' || state === 'GAME_OVER')) {
    const won         = room.winner === mySlot;
    const oppScore    = (oppData?.gameState?.score) || 0;
    mpShowResult(won, oppScore);
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

  // Multiplayer overlays
  overlayMpMenu    = document.getElementById('overlay-mp-menu');
  overlayMpJoin    = document.getElementById('overlay-mp-join');
  overlayMpWaiting = document.getElementById('overlay-mp-waiting');
  overlayMpLobby   = document.getElementById('overlay-mp-lobby');
  overlayMpResult  = document.getElementById('overlay-mp-result');

  elMpRoomCodeDisplay = document.getElementById('mp-room-code-display');
  elMpRoomInput       = document.getElementById('mp-room-input');
  elMpJoinError       = document.getElementById('mp-join-error');
  elMpP1Name          = document.getElementById('mp-p1-name');
  elMpP2Name          = document.getElementById('mp-p2-name');
  elMpP1Status        = document.getElementById('mp-p1-status');
  elMpP2Status        = document.getElementById('mp-p2-status');
  elMpReadyBtn        = document.getElementById('btn-mp-ready');
  elMpLobbyCodeDisplay = document.getElementById('mp-lobby-code-display');
  elMpResultTitle     = document.getElementById('mp-result-title');
  elMpResultScore     = document.getElementById('mp-result-score');
  elMpResultOppScore  = document.getElementById('mp-result-opp-score');
  elOppNameDisplay    = document.getElementById('opp-name-display');
  elOppScore          = document.getElementById('opp-score');
  elOppLevel          = document.getElementById('opp-level');
  elOppBoard          = document.getElementById('opp-board');
  elMpOpponentWrap    = document.getElementById('mp-opponent-wrap');

  if (elOppBoard) {
    elOppBoard.width  = OPP_W;
    elOppBoard.height = OPP_H;
    elOppCtx = elOppBoard.getContext('2d');
  }

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

  // Starting level selector
  const elStartLevelDisplay = document.getElementById('start-level-display');
  bindBtn('btn-level-dec', () => {
    if (startLevel > 0) { startLevel--; if (elStartLevelDisplay) elStartLevelDisplay.textContent = startLevel; }
  });
  bindBtn('btn-level-inc', () => {
    if (startLevel < 15) { startLevel++; if (elStartLevelDisplay) elStartLevelDisplay.textContent = startLevel; }
  });

  // ── Multiplayer button handlers ───────────────────────────────────────────
  bindBtn('btn-mp', () => showOverlay('mp-menu'));
  bindBtn('btn-mp-menu-back', () => showOverlay('menu'));

  // Create Room
  bindBtn('btn-mp-create', async () => {
    const name = getSavedName() || 'PLAYER';
    const result = await MP.createRoom(name);
    if (!result.ok) { alert(result.error); return; }
    if (elMpRoomCodeDisplay) elMpRoomCodeDisplay.textContent = result.code;
    showOverlay('mp-waiting');
    MP.subscribe(handleRoomUpdate);
  });

  // Show join overlay
  bindBtn('btn-mp-join-show', () => {
    if (elMpRoomInput) elMpRoomInput.value = '';
    if (elMpJoinError) elMpJoinError.textContent = '';
    showOverlay('mp-join');
  });
  bindBtn('btn-mp-join-back', () => showOverlay('mp-menu'));

  // Join Room
  const doJoin = async () => {
    const code = elMpRoomInput ? elMpRoomInput.value.trim() : '';
    if (elMpJoinError) elMpJoinError.textContent = '';
    const name = getSavedName() || 'PLAYER';
    const result = await MP.joinRoom(code, name);
    if (!result.ok) {
      if (elMpJoinError) elMpJoinError.textContent = result.error;
      return;
    }
    showOverlay('mp-lobby');
    MP.subscribe(handleRoomUpdate);
  };
  bindBtn('btn-mp-join', doJoin);
  if (elMpRoomInput) {
    elMpRoomInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
  }

  // Cancel waiting room
  bindBtn('btn-mp-cancel', () => mpExitToMenu());

  // Ready toggle
  bindBtn('btn-mp-ready', async () => {
    const next = !mpReady;
    mpReady = next;
    await MP.setReady(next);
  });

  // Leave lobby
  bindBtn('btn-mp-lobby-leave', () => mpExitToMenu());

  // Result screen
  bindBtn('btn-mp-play-again', async () => {
    cancelAnimationFrame(animFrame);
    mpGameStarting  = false;
    multiplayerMode = false;
    opponentState   = null;
    mpReady         = false;
    document.querySelector('.game-wrapper').classList.remove('game-wrapper--mp');
    if (elMpOpponentWrap) elMpOpponentWrap.setAttribute('aria-hidden', 'true');
    resizeCanvas();
    await MP.leaveRoom();
    showOverlay('mp-menu');
    state = 'MENU';
  });
  bindBtn('btn-mp-to-menu', () => mpExitToMenu());

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

  // Clean up Firebase room if the tab is closed/refreshed mid-game.
  // Use both events; leaveRoom() clears roomCode immediately so it only runs once.
  const mpPageLeave = () => { if (MP.roomCode) MP.leaveRoom(); };
  window.addEventListener('beforeunload', mpPageLeave);
  window.addEventListener('pagehide',     mpPageLeave);

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
