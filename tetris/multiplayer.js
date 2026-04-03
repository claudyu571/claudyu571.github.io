'use strict';

// ─── Multiplayer (Firebase Firestore) ────────────────────────────────────────
// Exposes a global `MP` object used by main.js.
// Depends on `db` from firebase-config.js being loaded first.

const MP = (() => {

  const LOBBIES        = 'tetris_lobbies';
  const CODE_CHARS     = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  const EXPIRY_MS      = 24 * 60 * 60 * 1000; // 24 h
  const SYNC_THROTTLE  = 80; // ms — max ~12 writes/s per player
  const QUICK_MATCH_MAX_ATTEMPTS = 3;
  const QUICK_MATCH_QUERY_LIMIT = 8;

  let _code         = null;  // active room code
  let _slot         = null;  // 'player1' | 'player2'
  let _unsub        = null;  // Firestore listener unsubscribe fn
  let _syncTimer    = null;
  let _pendingState = null;
  let _cachedStatus = null;  // last-known room status (avoids async get() on leave)
  const _clientId   = _getClientId();

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
          player1: _buildPlayerState(playerName, 'PLAYER1'),
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

    const result = await _claimWaitingRoom(code, playerName);
    if (result.ok) return result;
    return { ok: false, error: result.error || 'Failed to join. Please try again.' };
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
      const existing = await _getReusableQuickMatchRoom();
      if (existing) return existing;

      for (let attempt = 0; attempt < QUICK_MATCH_MAX_ATTEMPTS; attempt++) {
        const result = await _claimOrCreateQuickMatchRoom(playerName);
        if (result.ok) return result;
        if (!result.retry) return { ok: false, error: result.error || 'Quick match failed. Please try again.' };
      }

      const reusable = await _getReusableQuickMatchRoom();
      if (reusable) return reusable;

      return { ok: false, error: 'Quick match failed. Please try again.' };
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

  function _buildPlayerState(name, fallback) {
    return {
      name:      _sanitizeName(name, fallback),
      clientId:  _clientId,
      ready:     false,
      gameState: null,
      lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
  }

  async function _claimWaitingRoom(code, playerName, { publicOnly = false } = {}) {
    try {
      const result = await db.runTransaction(async tx => {
        const roomRef = ref(code);
        const snap = await tx.get(roomRef);

        if (!snap.exists) {
          return { ok: false, error: 'Room not found.', reason: 'missing' };
        }

        const room = snap.data();
        const age = room.lastActivity ? Date.now() - _toMillis(room.lastActivity) : 0;
        if (age > EXPIRY_MS) {
          tx.delete(roomRef);
          return { ok: false, error: 'Room has expired.', reason: 'expired' };
        }

        if (publicOnly && !room.isPublic) {
          return { ok: false, reason: 'not_public' };
        }

        if (room.status === 'finished') {
          return {
            ok: false,
            error: 'That game has already ended. Ask your friend to create a new room.',
            reason: 'finished',
          };
        }

        if (room.status !== 'waiting' || room.player2) {
          return {
            ok: false,
            error: publicOnly ? null : (room.player2 ? 'Room is full.' : 'Game already in progress.'),
            reason: room.player2 ? 'full' : 'claimed',
          };
        }

        if (publicOnly && room.player1?.clientId === _clientId) {
          return { ok: false, reason: 'own_room' };
        }

        tx.update(roomRef, {
          status:  'lobby',
          player2: _buildPlayerState(playerName, 'PLAYER2'),
          lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
        });

        return { ok: true, code };
      });

      if (result.ok) {
        _code = code;
        _slot = 'player2';
      }

      return result;
    } catch (e) {
      console.error('[MP] claim waiting room failed', e);
      return { ok: false, error: e?.message || 'Failed to join. Please try again.', reason: 'error' };
    }
  }

  function _getClientId() {
    return (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
      ? globalThis.crypto.randomUUID()
      : `mp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  async function _claimOrCreateQuickMatchRoom(playerName) {
    try {
      const waitingRooms = await _listQuickMatchCandidates();

      for (const room of waitingRooms) {
        if (room.player1?.clientId === _clientId) {
          _code = room.code;
          _slot = 'player1';
          return { ok: true, code: room.code, slot: 'player1' };
        }

        const claimed = await _claimWaitingRoom(room.code, playerName, { publicOnly: true });
        if (claimed.ok) return { ...claimed, slot: 'player2' };
      }

      const secondPass = await _listQuickMatchCandidates();
      for (const room of secondPass) {
        if (room.player1?.clientId === _clientId) {
          _code = room.code;
          _slot = 'player1';
          return { ok: true, code: room.code, slot: 'player1' };
        }

        const claimed = await _claimWaitingRoom(room.code, playerName, { publicOnly: true });
        if (claimed.ok) return { ...claimed, slot: 'player2' };
      }

      const created = await createRoom(playerName, true);
      if (created.ok) return { ...created, slot: 'player1' };
      return { ok: false, error: created.error || 'Could not create room. Please try again.', retry: false };
    } catch (e) {
      console.error('[MP] quick match failed', e);
      return { ok: false, error: e?.message || 'Quick match failed. Please try again.', retry: false };
    }
  }

  async function _listQuickMatchCandidates() {
    const snap = await col()
      .where('status', '==', 'waiting')
      .where('isPublic', '==', true)
      .limit(QUICK_MATCH_QUERY_LIMIT)
      .get();

    return snap.docs
      .map(doc => ({ code: doc.id, ...doc.data() }))
      .filter(room => {
        const age = room.lastActivity ? Date.now() - _toMillis(room.lastActivity) : 0;
        return age <= EXPIRY_MS;
      });
  }

  async function _getReusableQuickMatchRoom() {
    if (!_code || _slot !== 'player1') return null;

    try {
      const snap = await ref(_code).get();
      if (!snap.exists) return null;

      const room = snap.data();
      if (
        room.isPublic &&
        room.status === 'waiting' &&
        room.player1?.clientId === _clientId &&
        !room.player2
      ) {
        return { ok: true, code: _code };
      }
    } catch (_) {}

    return null;
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
