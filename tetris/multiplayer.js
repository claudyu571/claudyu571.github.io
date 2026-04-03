'use strict';

// ─── Multiplayer (Firebase Firestore) ────────────────────────────────────────
// Exposes a global `MP` object used by main.js.
// Depends on `db` from firebase-config.js being loaded first.

const MP = (() => {

  const LOBBIES        = 'tetris_lobbies';
  const CODE_CHARS     = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  const EXPIRY_MS      = 24 * 60 * 60 * 1000; // 24 h
  const SYNC_THROTTLE  = 80; // ms — max ~12 writes/s per player

  let _code         = null;  // active room code
  let _slot         = null;  // 'player1' | 'player2'
  let _unsub        = null;  // Firestore listener unsubscribe fn
  let _syncTimer    = null;
  let _pendingState = null;
  let _cachedStatus = null;  // last-known room status (avoids async get() on leave)

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

  async function createRoom(playerName, isPublic = false) {
    // Opportunistically clean up a few stale rooms before creating
    _pruneExpired().catch(() => {});

    for (let attempt = 0; attempt < 12; attempt++) {
      const code = generateCode();
      try {
        await ref(code).set({
          roomCode: code,
          status:   'waiting',   // waiting | lobby | playing | finished
          isPublic: isPublic,
          player1: {
            name:      _sanitizeName(playerName, 'PLAYER1'),
            ready:     false,
            gameState: null,
            lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
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

      // A finished room means the previous game ended but cleanup didn't run —
      // allow joining if there's no active listener (i.e. both players are gone)
      if (d.status === 'finished') {
        return { ok: false, error: 'That game has already ended. Ask your friend to create a new room.' };
      }
      if (d.status !== 'waiting') {
        return { ok: false, error: 'Game already in progress.' };
      }
      if (d.player2) return { ok: false, error: 'Room is full.' };

      await ref(code).update({
        status:  'lobby',
        player2: {
          name:      _sanitizeName(playerName, 'PLAYER2'),
          ready:     false,
          gameState: null,
          lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
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
      [`${_slot}.lastSeenAt`]: firebase.firestore.FieldValue.serverTimestamp(),
      lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  async function setGameStarted() {
    if (!_code) return;
    await ref().update({
      status: 'playing',
      [`${_slot}.lastSeenAt`]: firebase.firestore.FieldValue.serverTimestamp(),
      lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  // Reset the room after a game so both players can play again without re-sharing a code
  async function resetRoom() {
    if (!_code || !_slot) return { ok: false };
    try {
      await ref().update({
        status:  'lobby',
        winner:  null,
        'player1.ready':     false,
        'player1.gameState': null,
        'player2.ready':     false,
        'player2.gameState': null,
        lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
      });
      _cachedStatus = 'lobby';
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Find any public waiting room and join it, or create a new public room
  async function quickMatch(playerName) {
    _pruneExpired().catch(() => {});
    try {
      const snap = await col()
        .where('status',   '==', 'waiting')
        .where('isPublic', '==', true)
        .limit(5)
        .get();

      for (const doc of snap.docs) {
        const d = doc.data();
        // Skip own room if somehow still open
        if (d.player1 && d.player1.name === _sanitizeName(playerName, 'PLAYER')) continue;
        // Try to join atomically
        const result = await joinRoom(doc.id, playerName);
        if (result.ok) return result;
      }

      // No open room found — create a public one
      return await createRoom(playerName, true);
    } catch (e) {
      return { ok: false, error: 'Quick match failed. Please try again.' };
    }
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
        [`${_slot}.lastSeenAt`]: firebase.firestore.FieldValue.serverTimestamp(),
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
      [`${_slot}.lastSeenAt`]: firebase.firestore.FieldValue.serverTimestamp(),
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

  async function claimForfeit(staleSlot, winnerSlot, expectedLastSeenMs) {
    if (!_code) return { ok: false };
    try {
      await db.runTransaction(async tx => {
        const roomRef = ref();
        const snap = await tx.get(roomRef);
        if (!snap.exists) return;

        const room = snap.data();
        if (room.status !== 'playing' || room.winner) return;

        const currentLastSeen = _toMillis(room?.[staleSlot]?.lastSeenAt);
        if (currentLastSeen === null) return;
        if (currentLastSeen > expectedLastSeenMs) return;

        tx.update(roomRef, {
          status: 'finished',
          winner: winnerSlot,
          lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ─── Realtime listener ─────────────────────────────────────────────────────

  function subscribe(callback) {
    if (_unsub) _unsub();
    _unsub = ref().onSnapshot(
      snap => {
        if (!snap.exists) { callback({ deleted: true }); return; }
        const data = snap.data();
        _cachedStatus = data.status; // keep a local copy for fast cleanup
        callback({ data });
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

    // Capture and clear state immediately — prevents double-calls (e.g. beforeunload + pagehide)
    const code   = _code;
    const slot   = _slot;
    const status = _cachedStatus;
    _code         = null;
    _slot         = null;
    _cachedStatus = null;

    if (!code || !slot) return;

    try {
      const r = col().doc(code);
      if (status === 'waiting' || status === 'lobby') {
        // Single write — no get() roundtrip needed
        await r.delete();
      } else if (status === 'playing') {
        const opp = slot === 'player1' ? 'player2' : 'player1';
        await r.update({
          status: 'finished',
          winner: opp,
          lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        // Status unknown (subscribe never fired) — fall back to get()
        const snap = await r.get();
        if (snap.exists) {
          const d = snap.data();
          if (d.status === 'waiting' || d.status === 'lobby') {
            await r.delete();
          } else if (d.status === 'playing') {
            const opp = slot === 'player1' ? 'player2' : 'player1';
            await r.update({
              status: 'finished',
              winner: opp,
              lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      }
    } catch (_) {}
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  function _sanitizeName(name, fallback) {
    const n = (name || '').trim().slice(0, 12).toUpperCase();
    return n || fallback;
  }

  function _toMillis(value) {
    if (!value) return null;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value === 'number') return value;
    if (value.seconds != null) return value.seconds * 1000;
    return null;
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
    quickMatch,
    resetRoom,
    setReady,
    setGameStarted,
    syncGameState,
    syncGameStateNow,
    signalGameOver,
    claimForfeit,
    subscribe,
    unsubscribe,
    leaveRoom,
  };

})();
