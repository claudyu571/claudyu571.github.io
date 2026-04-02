(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------
  const boardEl      = document.getElementById('board');
  const timerEl      = document.getElementById('timer');
  const errorCountEl = document.getElementById('error-count');
  const bestTimeEl   = document.getElementById('best-time');
  const statusEl     = document.getElementById('status');
  const diffEyebrow  = document.getElementById('difficulty-eyebrow');
  const pencilToggle = document.getElementById('pencil-toggle');
  const numpadEl     = document.getElementById('numpad');
  const winOverlay   = document.getElementById('win-overlay');
  const winMessage   = document.getElementById('win-message');
  const winNameInput = document.getElementById('win-name-input');

  const diffBtns = {
    easy:   document.getElementById('diff-easy-btn'),
    medium: document.getElementById('diff-medium-btn'),
    hard:   document.getElementById('diff-hard-btn'),
  };

  // ---------------------------------------------------------------------------
  // Firestore collections (one per difficulty)
  // ---------------------------------------------------------------------------
  const COLLECTIONS = {
    easy:   'sudoku_leaderboard_easy',
    medium: 'sudoku_leaderboard_medium',
    hard:   'sudoku_leaderboard_hard',
  };

  // ---------------------------------------------------------------------------
  // LocalStorage keys (only for preferences, not scores)
  // ---------------------------------------------------------------------------
  const DIFF_KEY   = 'sudoku.difficulty.v1';
  const PLAYER_KEY = 'sudoku.playerName.v1';

  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------
  let cells       = [];
  let solution    = [];
  let selectedIdx = -1;
  let pencilMode  = false;
  let difficulty  = loadDifficulty();
  let gameStatus  = 'idle';   // 'idle' | 'playing' | 'won'
  let errorCount  = 0;
  let elapsedSecs = 0;
  let timerId     = null;
  let history     = [];

  // Leaderboard state
  let lbTab         = difficulty;  // tab currently shown
  let lbUnsubscribe = null;        // current onSnapshot cleanup fn
  let lbBestCache   = {};          // { easy: entry|null, ... } — best entry per difficulty
  let highlightName = null;        // name to highlight after score submit

  // Pre-computed peer index sets
  const peerCache = buildPeerCache();

  // ---------------------------------------------------------------------------
  // Peer cache
  // ---------------------------------------------------------------------------
  function buildPeerCache() {
    const cache = new Map();
    for (let idx = 0; idx < 81; idx++) {
      const peers = new Set();
      const row = Math.floor(idx / 9);
      const col = idx % 9;
      const boxR = Math.floor(row / 3) * 3;
      const boxC = Math.floor(col / 3) * 3;
      for (let i = 0; i < 9; i++) {
        peers.add(row * 9 + i);
        peers.add(i * 9 + col);
        peers.add((boxR + Math.floor(i / 3)) * 9 + boxC + (i % 3));
      }
      peers.delete(idx);
      cache.set(idx, peers);
    }
    return cache;
  }

  // ---------------------------------------------------------------------------
  // LocalStorage helpers (preferences only)
  // ---------------------------------------------------------------------------
  function loadDifficulty() {
    try {
      const v = localStorage.getItem(DIFF_KEY);
      return ['easy', 'medium', 'hard'].includes(v) ? v : 'medium';
    } catch { return 'medium'; }
  }

  function saveDifficulty(d) {
    try { localStorage.setItem(DIFF_KEY, d); } catch {}
  }

  function loadPlayerName() {
    try { return localStorage.getItem(PLAYER_KEY) || ''; } catch { return ''; }
  }

  function savePlayerName(name) {
    try { localStorage.setItem(PLAYER_KEY, name); } catch {}
  }

  function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Firestore leaderboard
  // ---------------------------------------------------------------------------
  function subscribeToLeaderboard(diff) {
    if (lbUnsubscribe) { lbUnsubscribe(); lbUnsubscribe = null; }
    lbTab = diff;

    // Update tab buttons immediately
    ['easy', 'medium', 'hard'].forEach(d => {
      document.getElementById(`lb-${d}-btn`).classList.toggle('active', d === diff);
    });

    document.getElementById('lb-body').innerHTML =
      '<tr><td colspan="4" class="lb-empty">Loading…</td></tr>';

    lbUnsubscribe = db.collection(COLLECTIONS[diff])
      .orderBy('time')
      .limit(10)
      .onSnapshot(
        snapshot => {
          const entries = snapshot.docs
            .map(doc => doc.data())
            .sort((a, b) => a.time - b.time || a.errors - b.errors);

          lbBestCache[diff] = entries[0] || null;
          if (diff === difficulty) renderStats();

          renderLeaderboardEntries(entries, highlightName);
        },
        () => {
          document.getElementById('lb-body').innerHTML =
            '<tr><td colspan="4" class="lb-empty">Could not load.</td></tr>';
        }
      );
  }

  function addScoreToFirestore(diff, name, time, errors) {
    return db.collection(COLLECTIONS[diff]).add({
      name,
      time,
      errors,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ---------------------------------------------------------------------------
  // Leaderboard rendering
  // ---------------------------------------------------------------------------
  function renderLeaderboardEntries(entries, hlName) {
    const tbody = document.getElementById('lb-body');

    if (!entries || entries.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="lb-empty">No entries yet.</td></tr>';
      return;
    }

    const rankLabels = ['', '🥇', '🥈', '🥉'];
    const rankClass  = ['', 'gold', 'silver', 'bronze'];

    tbody.innerHTML = entries.map((e, i) => {
      const rank = i + 1;
      const isHL = hlName && e.name === hlName;
      const label = rank <= 3 ? rankLabels[rank] : rank;
      const cls   = rank <= 3 ? rankClass[rank] : '';
      // Escape name to prevent XSS
      const safeName = e.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<tr${isHL ? ' class="lb-highlight"' : ''}>
        <td><span class="lb-rank ${cls}">${label}</span></td>
        <td class="lb-name" title="${safeName}">${safeName}</td>
        <td class="col-r">${formatTime(e.time)}</td>
        <td class="col-r">${e.errors}</td>
      </tr>`;
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Board building & rendering
  // ---------------------------------------------------------------------------
  function buildBoard() {
    boardEl.innerHTML = '';
    for (let i = 0; i < 81; i++) {
      const el = document.createElement('div');
      el.className = 'cell';
      el.dataset.idx = i;
      el.setAttribute('role', 'gridcell');
      el.setAttribute('tabindex', '-1');
      boardEl.appendChild(el);
    }
  }

  function renderBoard() {
    const cellEls = boardEl.querySelectorAll('.cell');
    const selVal  = selectedIdx >= 0 ? cells[selectedIdx].value : 0;
    const peers   = selectedIdx >= 0 ? peerCache.get(selectedIdx) : null;

    cellEls.forEach((el, i) => {
      const c = cells[i];
      el.className = 'cell';

      if (c.given)          el.classList.add('given');
      else if (c.isError)   el.classList.add('error');
      else if (c.value !==0) el.classList.add('user-entry');

      if (i === selectedIdx) {
        el.classList.add('selected');
      } else if (peers) {
        if (selVal !== 0 && c.value === selVal) el.classList.add('same-num');
        else if (peers.has(i))                  el.classList.add('peer');
      }

      if (c.pencil.size > 0 && c.value === 0) {
        el.innerHTML = buildPencilHTML(c.pencil);
      } else {
        el.textContent = c.value !== 0 ? String(c.value) : '';
      }
    });
  }

  function buildPencilHTML(pencilSet) {
    let html = '<div class="pencil-grid">';
    for (let n = 1; n <= 9; n++) {
      html += `<span class="pencil-digit">${pencilSet.has(n) ? n : ''}</span>`;
    }
    html += '</div>';
    return html;
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------
  function renderStats() {
    timerEl.textContent      = formatTime(elapsedSecs);
    errorCountEl.textContent = String(errorCount);
    statusEl.textContent     = gameStatus === 'won' ? 'Solved!' : 'Playing';

    const best = lbBestCache[difficulty];
    bestTimeEl.textContent = best ? formatTime(best.time) : '—';
  }

  function renderDifficultyUI() {
    const label = difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
    diffEyebrow.textContent = label;
    Object.entries(diffBtns).forEach(([key, btn]) => {
      btn.classList.toggle('active', key === difficulty);
    });
  }

  // ---------------------------------------------------------------------------
  // Timer
  // ---------------------------------------------------------------------------
  function startTimer() {
    stopTimer();
    timerId = setInterval(() => {
      elapsedSecs++;
      timerEl.textContent = formatTime(elapsedSecs);
    }, 1000);
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  // ---------------------------------------------------------------------------
  // New game
  // ---------------------------------------------------------------------------
  function newGame() {
    stopTimer();
    elapsedSecs  = 0;
    errorCount   = 0;
    history      = [];
    selectedIdx  = -1;
    gameStatus   = 'playing';
    pencilMode   = false;
    highlightName = null;
    pencilToggle.checked = false;
    numpadEl.classList.remove('pencil-active');

    const puzzle = SudokuLogic.generate(difficulty);
    cells    = puzzle.cells;
    solution = puzzle.solution;

    buildBoard();
    renderBoard();
    renderDifficultyUI();
    renderStats();
    subscribeToLeaderboard(difficulty);
    startTimer();
  }

  // ---------------------------------------------------------------------------
  // Cell selection
  // ---------------------------------------------------------------------------
  function selectCell(idx) {
    if (idx < 0 || idx >= 81) return;
    selectedIdx = idx;
    renderBoard();
  }

  // ---------------------------------------------------------------------------
  // History / undo
  // ---------------------------------------------------------------------------
  function pushHistory() {
    history.push(cells.map(c => ({ ...c, pencil: new Set(c.pencil) })));
    if (history.length > 50) history.shift();
  }

  function undo() {
    if (history.length === 0 || gameStatus !== 'playing') return;
    cells = history.pop();
    SudokuLogic.validate(cells, solution);
    renderBoard();
    renderStats();
  }

  // ---------------------------------------------------------------------------
  // Digit entry
  // ---------------------------------------------------------------------------
  function enterDigit(num) {
    if (selectedIdx === -1 || gameStatus !== 'playing') return;
    const c = cells[selectedIdx];
    if (c.given) return;

    pushHistory();

    if (pencilMode) {
      c.value = 0;
      if (c.pencil.has(num)) c.pencil.delete(num);
      else                   c.pencil.add(num);
    } else {
      const wasError = c.isError;
      c.value = num;
      c.pencil.clear();
      peerCache.get(selectedIdx).forEach(pi => cells[pi].pencil.delete(num));
      SudokuLogic.validate(cells, solution);
      if (c.isError && !wasError) errorCount++;
      if (SudokuLogic.isComplete(cells, solution)) {
        handleWin();
        return;
      }
    }

    renderBoard();
    renderStats();
  }

  function eraseCell() {
    if (selectedIdx === -1 || gameStatus !== 'playing') return;
    const c = cells[selectedIdx];
    if (c.given) return;
    if (c.value === 0 && c.pencil.size === 0) return;

    pushHistory();
    c.value   = 0;
    c.pencil  = new Set();
    c.isError = false;
    renderBoard();
    renderStats();
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------
  function resetGame() {
    if (gameStatus === 'idle') return;
    stopTimer();
    cells.forEach(c => {
      if (!c.given) { c.value = 0; c.pencil = new Set(); c.isError = false; }
    });
    history     = [];
    errorCount  = 0;
    elapsedSecs = 0;
    selectedIdx = -1;
    gameStatus  = 'playing';
    renderBoard();
    renderStats();
    startTimer();
  }

  // ---------------------------------------------------------------------------
  // Win
  // ---------------------------------------------------------------------------
  function handleWin() {
    stopTimer();
    gameStatus = 'won';
    renderBoard();
    renderStats();

    const errText = errorCount === 1 ? '1 error' : `${errorCount} errors`;
    winMessage.textContent = `Solved in ${formatTime(elapsedSecs)} with ${errText}.`;
    winNameInput.value = loadPlayerName();
    winOverlay.classList.remove('hidden');
    setTimeout(() => winNameInput.focus(), 50);
  }

  function submitScore() {
    const name = winNameInput.value.trim() || 'Anonymous';
    savePlayerName(name);
    highlightName = name;
    winOverlay.classList.add('hidden');
    // Write to Firestore; the onSnapshot listener will re-render automatically
    addScoreToFirestore(difficulty, name, elapsedSecs, errorCount).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  boardEl.addEventListener('click', e => {
    const el = e.target.closest('.cell');
    if (!el) return;
    selectCell(Number(el.dataset.idx));
  });

  window.addEventListener('keydown', e => {
    if (gameStatus !== 'playing') return;

    const digit = parseInt(e.key, 10);
    if (!isNaN(digit) && digit >= 1 && digit <= 9) {
      e.preventDefault(); enterDigit(digit); return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
      e.preventDefault(); eraseCell(); return;
    }
    if (e.key === 'u' || e.key === 'U') {
      e.preventDefault(); undo(); return;
    }
    const moves = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };
    if (moves[e.key] !== undefined) {
      e.preventDefault();
      const next = selectedIdx + moves[e.key];
      if (next >= 0 && next < 81) selectCell(next);
    }
  });

  numpadEl.addEventListener('pointerdown', e => {
    const btn = e.target.closest('.num-btn');
    if (!btn) return;
    e.preventDefault();
    const num = Number(btn.dataset.num);
    if (num === 0) eraseCell(); else enterDigit(num);
  });

  pencilToggle.addEventListener('change', () => {
    pencilMode = pencilToggle.checked;
    numpadEl.classList.toggle('pencil-active', pencilMode);
  });

  Object.entries(diffBtns).forEach(([key, btn]) => {
    btn.addEventListener('click', () => {
      difficulty = key;
      saveDifficulty(difficulty);
      newGame();
    });
  });

  document.getElementById('new-game-btn').addEventListener('click', () => newGame());
  document.getElementById('undo-btn').addEventListener('click', () => undo());
  document.getElementById('reset-btn').addEventListener('click', () => resetGame());

  document.getElementById('win-save-btn').addEventListener('click', () => submitScore());

  document.getElementById('win-skip-btn').addEventListener('click', () => {
    winOverlay.classList.add('hidden');
  });

  document.getElementById('win-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitScore(); }
  });

  ['easy', 'medium', 'hard'].forEach(d => {
    document.getElementById(`lb-${d}-btn`).addEventListener('click', () => {
      highlightName = null;  // clear highlight when manually switching tabs
      subscribeToLeaderboard(d);
    });
  });

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  renderDifficultyUI();
  newGame();
})();
