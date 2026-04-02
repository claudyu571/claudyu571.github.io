'use strict';

// ─── Tetrimino Definitions ────────────────────────────────────────────────────

// Colors follow the official Tetris Guideline (used in Tetris 99, Tetris Effect)
const PIECES = {
  I: {
    color: '#01EDFA', // Cyan
    matrices: [
      [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
      [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],
      [[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],
      [[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]],
    ],
  },
  O: {
    color: '#FEFB34', // Yellow
    matrices: [
      [[1,1],[1,1]],
      [[1,1],[1,1]],
      [[1,1],[1,1]],
      [[1,1],[1,1]],
    ],
  },
  T: {
    color: '#DD0AB2', // Magenta/Purple
    matrices: [
      [[0,1,0],[1,1,1],[0,0,0]],
      [[0,1,0],[0,1,1],[0,1,0]],
      [[0,0,0],[1,1,1],[0,1,0]],
      [[0,1,0],[1,1,0],[0,1,0]],
    ],
  },
  S: {
    color: '#53DA3F', // Green
    matrices: [
      [[0,1,1],[1,1,0],[0,0,0]],
      [[0,1,0],[0,1,1],[0,0,1]],
      [[0,0,0],[0,1,1],[1,1,0]],
      [[1,0,0],[1,1,0],[0,1,0]],
    ],
  },
  Z: {
    color: '#EA141C', // Red
    matrices: [
      [[1,1,0],[0,1,1],[0,0,0]],
      [[0,0,1],[0,1,1],[0,1,0]],
      [[0,0,0],[1,1,0],[0,1,1]],
      [[0,1,0],[1,1,0],[1,0,0]],
    ],
  },
  J: {
    color: '#0077D3', // Blue
    matrices: [
      [[1,0,0],[1,1,1],[0,0,0]],
      [[0,1,1],[0,1,0],[0,1,0]],
      [[0,0,0],[1,1,1],[0,0,1]],
      [[0,1,0],[0,1,0],[1,1,0]],
    ],
  },
  L: {
    color: '#FFC82E', // Orange
    matrices: [
      [[0,0,1],[1,1,1],[0,0,0]],
      [[0,1,0],[0,1,0],[0,1,1]],
      [[0,0,0],[1,1,1],[1,0,0]],
      [[1,1,0],[0,1,0],[0,1,0]],
    ],
  },
};

// Pattern IDs for colorblind accessibility — drawn on canvas per piece
const PIECE_PATTERNS = {
  I: 'stripe_h',   // horizontal stripes
  O: 'solid',      // solid (square shape is enough)
  T: 'dot',        // center dot
  S: 'diagonal_r', // diagonal right
  Z: 'diagonal_l', // diagonal left
  J: 'cross',      // cross
  L: 'checker',    // checkerboard
};

const PIECE_TYPES = Object.keys(PIECES);

// ─── Board ────────────────────────────────────────────────────────────────────

function createBoard(rows = 20, cols = 10) {
  return Array.from({ length: rows }, () => Array(cols).fill(null));
}

// ─── Piece ────────────────────────────────────────────────────────────────────

function spawnPiece(type) {
  const piece = PIECES[type];
  const matrix = piece.matrices[0];
  const cols = matrix[0].length;
  return {
    type,
    color: piece.color,
    matrix,
    rotation: 0,
    x: Math.floor((10 - cols) / 2),
    y: type === 'I' ? -1 : 0,
  };
}

function rotatePiece(piece, dir) {
  // dir: 1 = clockwise, -1 = counter-clockwise
  const matrices = PIECES[piece.type].matrices;
  const next = (piece.rotation + dir + 4) % 4;
  return { ...piece, rotation: next, matrix: matrices[next] };
}

// SRS wall kick offsets [from_rotation][kick_index] = [dx, dy]
const WALL_KICKS = {
  '0>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  '1>0': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
  '1>2': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
  '2>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
  '2>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
  '3>2': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  '3>0': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
  '0>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
};

const WALL_KICKS_I = {
  '0>1': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
  '1>0': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
  '1>2': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
  '2>1': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
  '2>3': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
  '3>2': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
  '3>0': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
  '0>3': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
};

// ─── Collision ────────────────────────────────────────────────────────────────

function isValidPosition(board, piece, dx = 0, dy = 0) {
  const rows = board.length;
  const cols = board[0].length;
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r].length; c++) {
      if (!piece.matrix[r][c]) continue;
      const nx = piece.x + c + dx;
      const ny = piece.y + r + dy;
      if (nx < 0 || nx >= cols) return false;
      if (ny >= rows) return false;
      if (ny >= 0 && board[ny][nx]) return false;
    }
  }
  return true;
}

function tryRotate(board, piece, dir) {
  const rotated = rotatePiece(piece, dir);
  const key = `${piece.rotation}>${rotated.rotation}`;
  const kicks = piece.type === 'I' ? WALL_KICKS_I[key] : WALL_KICKS[key];
  if (!kicks) return null;
  for (const [dx, dy] of kicks) {
    if (isValidPosition(board, rotated, dx, dy)) {
      return { ...rotated, x: rotated.x + dx, y: rotated.y + dy };
    }
  }
  return null;
}

// ─── Lock & Clear ─────────────────────────────────────────────────────────────

function lockPiece(board, piece) {
  const newBoard = board.map(row => [...row]);
  for (let r = 0; r < piece.matrix.length; r++) {
    for (let c = 0; c < piece.matrix[r].length; c++) {
      if (!piece.matrix[r][c]) continue;
      const ny = piece.y + r;
      const nx = piece.x + c;
      if (ny >= 0) newBoard[ny][nx] = piece.type;
    }
  }
  return newBoard;
}

function clearLines(board) {
  const remaining = board.filter(row => row.some(cell => !cell));
  const linesCleared = board.length - remaining.length;
  const cols = board[0].length;
  const empty = Array.from({ length: linesCleared }, () => Array(cols).fill(null));
  return { newBoard: [...empty, ...remaining], linesCleared };
}

function getClearedLineIndices(board) {
  return board.reduce((acc, row, i) => {
    if (row.every(cell => cell)) acc.push(i);
    return acc;
  }, []);
}

// ─── Ghost Piece ──────────────────────────────────────────────────────────────

function getGhostPiece(board, piece) {
  let ghost = { ...piece };
  while (isValidPosition(board, ghost, 0, 1)) {
    ghost = { ...ghost, y: ghost.y + 1 };
  }
  return ghost;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const LINE_SCORE = [0, 40, 100, 300, 1200];

function calcScore(linesCleared, level) {
  return (LINE_SCORE[linesCleared] || 0) * (level + 1);
}

function calcLevel(totalLines) {
  return Math.floor(totalLines / 10);
}

function calcDropInterval(level) {
  // Nintendo Tetris speed curve (ms)
  const frames = [48,43,38,33,28,23,18,13,8,6,5,5,5,4,4,4,3,3,3,2,2,2,2,2,2,2,2,2,2,1];
  const f = frames[Math.min(level, frames.length - 1)];
  return Math.round(f * (1000 / 60));
}

// ─── Random Bag ───────────────────────────────────────────────────────────────

function createBag() {
  const bag = [...PIECE_TYPES];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined') {
  module.exports = {
    PIECES, PIECE_PATTERNS, PIECE_TYPES,
    createBoard, spawnPiece, rotatePiece,
    isValidPosition, tryRotate,
    lockPiece, clearLines, getClearedLineIndices,
    getGhostPiece,
    calcScore, calcLevel, calcDropInterval,
    createBag,
  };
}
