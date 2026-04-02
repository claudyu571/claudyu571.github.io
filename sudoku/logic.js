(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function rowOf(idx)  { return Math.floor(idx / 9); }
  function colOf(idx)  { return idx % 9; }
  function boxOf(idx)  { return Math.floor(rowOf(idx) / 3) * 3 + Math.floor(colOf(idx) / 3); }

  // Returns true if placing `num` at `idx` in `board` (flat array[81]) is valid.
  function isValidPlacement(board, idx, num) {
    const row = rowOf(idx);
    const col = colOf(idx);
    const boxRow = Math.floor(row / 3) * 3;
    const boxCol = Math.floor(col / 3) * 3;

    for (let i = 0; i < 9; i++) {
      // row check
      if (board[row * 9 + i] === num) return false;
      // col check
      if (board[i * 9 + col] === num) return false;
      // box check
      if (board[(boxRow + Math.floor(i / 3)) * 9 + boxCol + (i % 3)] === num) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Solver (backtracking) — fills empty (0) cells; returns true on success.
  // Pass `limit` to countSolutions to stop early.
  // ---------------------------------------------------------------------------

  function solve(board, randomize) {
    for (let idx = 0; idx < 81; idx++) {
      if (board[idx] !== 0) continue;

      const digits = randomize ? shuffle([1,2,3,4,5,6,7,8,9]) : [1,2,3,4,5,6,7,8,9];
      for (const d of digits) {
        if (isValidPlacement(board, idx, d)) {
          board[idx] = d;
          if (solve(board, randomize)) return true;
          board[idx] = 0;
        }
      }
      return false; // no valid digit found
    }
    return true; // all cells filled
  }

  // Count solutions up to `limit`; returns count (stops counting at limit).
  function countSolutions(board, limit) {
    let count = 0;
    function bt(idx) {
      if (count >= limit) return;
      if (idx === 81) { count++; return; }
      if (board[idx] !== 0) { bt(idx + 1); return; }
      for (let d = 1; d <= 9; d++) {
        if (isValidPlacement(board, idx, d)) {
          board[idx] = d;
          bt(idx + 1);
          board[idx] = 0;
          if (count >= limit) return;
        }
      }
    }
    bt(0);
    return count;
  }

  // ---------------------------------------------------------------------------
  // Puzzle Generation
  // ---------------------------------------------------------------------------

  function generateSolution() {
    const board = new Array(81).fill(0);
    solve(board, true);
    return board;
  }

  const CLUE_COUNTS = { easy: 45, medium: 35, hard: 25 };

  function digHoles(solution, targetClues) {
    const board = solution.slice();
    const indices = shuffle([...Array(81).keys()]);

    for (const idx of indices) {
      if (board.filter(v => v !== 0).length <= targetClues) break;
      const saved = board[idx];
      board[idx] = 0;
      const test = board.slice();
      if (countSolutions(test, 2) !== 1) {
        board[idx] = saved; // restoring keeps unique solution
      }
    }
    return board;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Generate a puzzle for the given difficulty.
   * Returns { cells: Array[81], solution: Array[81] }
   * cells: array of { value, given, pencil, isError }
   * solution: flat array of correct digits (1-9)
   */
  function generate(difficulty) {
    const sol = generateSolution();
    const targetClues = CLUE_COUNTS[difficulty] || CLUE_COUNTS.medium;
    const puzzle = digHoles(sol, targetClues);

    const cells = puzzle.map(v => ({
      value: v,
      given: v !== 0,
      pencil: new Set(),
      isError: false,
    }));

    return { cells, solution: sol.slice() };
  }

  /**
   * Validate cells against solution, updating isError flags.
   * Mutates and returns the cells array.
   */
  function validate(cells, solution) {
    for (let i = 0; i < 81; i++) {
      cells[i].isError = cells[i].value !== 0 && cells[i].value !== solution[i];
    }
    return cells;
  }

  /**
   * Returns true when every cell has the correct value.
   */
  function isComplete(cells, solution) {
    return cells.every((c, i) => c.value === solution[i]);
  }

  window.SudokuLogic = { generate, validate, isComplete };
})();
