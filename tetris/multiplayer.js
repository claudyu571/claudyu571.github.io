'use strict';

// ─── Multiplayer (Firebase Firestore) ────────────────────────────────────────
// Exposes a global `MP` object used by main.js.
// Depends on `db` from firebase-config.js being loaded first.

const MP = (() => {

  const LOBBIES        = 'tetris_lobbies';
  const CODE_CHARS     = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  const EXPIRY_MS      = 24 * 60 * 60 * 1000; // 24 h
  const SYNC_THROTTLE  = 80; // ms — max ~12 writes/s per player

  let _code       = null;  // active room code
  let _slot       = null;  // 'player1' | 'player2'
  let _unsub      = null;  // Firestore listener unsubscribe fn
  let _syncTimer  = null;
  let _pendingState = null;

  // ─── helpers ───────────────────────────────────────────────────────────────

  function col() {
    return db.collection(LOBBIES);
  }

  function ref(code) {
    return col().doc(code || _code);
  }

  function generateCode() {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c;
  }

  // ─── Room lifecycle ────────────────────────────────────────────────────────

  async function createRoom(playerName) {
    // Opportunistically clean up a few stale rooms before creating
    _pruneExpired().catch(() => {});

    for (let attempt = 0; attempt < 12; attempt++) {
      const code = generateCode();
      try {
        await ref(code).set({
          roomCode: code,
          status:   'waiting',   // waiting | lobby | playing | finished
          player1: {
            name:      _sanitizeName(playerName, 'PLAYER1'),
            ready:     false,
            gameState: null,
          },
          player2:       null,
          winner:        null,
          createdAt:     firebase.firestore.FieldValue.serverTimestamp(),
          lastActivity:  firebase.firestore.FieldValue.serverTimestamp(),
        });
        _code = code;
        _slot = 'player1';
        return { ok: true, code };
      } catch (_) {
        // Collision — try a new code
      }
    }
    return { ok: false, error: 'Could not create room. Please try again.' };
  }

  async function joinRoom(rawCode, playerName) {
    const code = rawCode.toUpperCase().trim();
    if (code.length !== 6) return { ok: false, error: 'Code must be 6 characters.' };

    try {
      const snap = await ref(code).get();

      if (!snap.exists) return { ok: false, error: 'Room not found.' };

      const d = snap.data();

      // Expiry check
      if (d.lastActivity) {
        const age = Date.now() - (d.lastActivity.toMillis ? d.lastActivity.toMillis() : d.lastActivity);
        if (age > EXPIRY_MS) {
          ref(code).delete().catch(() => {});
          return { ok: false, error: 'Room has expired.' };
        }
      }

      if (d.status !== 'waiting') {
        return { ok: false, error: d.player2 ? 'Room is full.' : 'Game already in progress.' };
      }
      if (d.player2) return { ok: false, error: 'Room is full.' };

      await ref(code).update({
        status:  'lobby',
        player2: {
          name:      _sanitizeName(playerName, 'PLAYER2'),
          ready:     false,
          gameState: null,
        },
        lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
      });

      _code = code;
      _slot = 'player2';
      return { ok: true, code };
    } catch (e) {
      return { ok: false, error: 'Failed to join. Please try again.' };
    }
  }

  async function setReady(isReady) {
    if (!_code || !_slot) return;
    await ref().update({
      [`${_slot}.ready`]:  isReady,
      lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  async function setGameStarted() {
    if (!_code) return;
    await ref().update({
      status: 'playing',
      lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  // ─── Game state sync ───────────────────────────────────────────────────────

  // Throttled — call every game-loop tick
  function syncGameState(state) {
    if (!_code || !_slot) return;
    _pendingState = state;
    if (_syncTimer) return;                     // already scheduled
    _syncTimer = setTimeout(() => {
      _syncTimer = null;
      const s = _pendingState;
      _pendingState = null;
      ref().update({
        [`${_slot}.gameState`]: s,
        lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }, SYNC_THROTTLE);
  }

  // Immediate — for game-over / lock events
  function syncGameStateNow(state) {
    if (!_code || !_slot) return Promise.resolve();
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    return ref().update({
      [`${_slot}.gameState`]: state,
      lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  async function signalGameOver() {
    if (!_code || !_slot) return;
    const oppSlot = _slot === 'player1' ? 'player2' : 'player1';
    try {
      const snap = await ref().get();
      const d = snap.data();
      if (d && d.status === 'playing') {
        await ref().update({
          status: 'finished',
          winner: oppSlot,
          [`${_slot}.gameState.gameOver`]: true,
          lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (_) {}
  }

  // ─── Realtime listener ─────────────────────────────────────────────────────

  function subscribe(callback) {
    if (_unsub) _unsub();
    _unsub = ref().onSnapshot(
      snap => {
        if (!snap.exists) { callback({ deleted: true }); return; }
        callback({ data: snap.data() });
      },
      err => { console.error('[MP] listener error', err); }
    );
  }

  function unsubscribe() {
    if (_unsub) { _unsub(); _unsub = null; }
  }

  // ─── Cleanup / leave ──────────────────────────────────────────────────────

  async function leaveRoom() {
    unsubscribe();
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }

    if (_code && _slot) {
      try {
        const snap = await ref().get();
        if (snap.exists) {
          const d = snap.data();
          if (d.status === 'waiting' || d.status === 'lobby') {
            await ref().delete();
          } else if (d.status === 'playing') {
            const opp = _slot === 'player1' ? 'player2' : 'player1';
            await ref().update({
              status: 'finished',
              winner: opp,
              lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      } catch (_) {}
    }

    _code = null;
    _slot = null;
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  function _sanitizeName(name, fallback) {
    const n = (name || '').trim().slice(0, 12).toUpperCase();
    return n || fallback;
  }

  async function _pruneExpired() {
    const cutoff = new Date(Date.now() - EXPIRY_MS);
    const stale = await col().where('lastActivity', '<', cutoff).limit(10).get();
    if (stale.empty) return;
    const batch = db.batch();
    stale.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return {
    get roomCode()  { return _code; },
    get playerSlot(){ return _slot; },
    createRoom,
    joinRoom,
    setReady,
    setGameStarted,
    syncGameState,
    syncGameStateNow,
    signalGameOver,
    subscribe,
    unsubscribe,
    leaveRoom,
  };

})();
