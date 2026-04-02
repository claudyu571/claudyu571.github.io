const SoundEngine = (() => {
  let ctx = null;

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return ctx;
  }

  function resume() {
    getCtx().resume();
  }

  // Play a single oscillator tone with an optional frequency sweep.
  function tone({ freq = 440, endFreq = null, type = "sine", duration = 0.1, gain = 0.22, startAt = 0 }) {
    const c = getCtx();
    const osc = c.createOscillator();
    const vol = c.createGain();

    osc.connect(vol);
    vol.connect(c.destination);

    const t = c.currentTime + startAt;

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) {
      osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
    }

    vol.gain.setValueAtTime(gain, t);
    vol.gain.exponentialRampToValueAtTime(0.001, t + duration);

    osc.start(t);
    osc.stop(t + duration + 0.01);

    // Disconnect nodes once the oscillator has finished to free Web Audio resources.
    osc.onended = () => {
      osc.disconnect();
      vol.disconnect();
    };
  }

  // ── Sound definitions ────────────────────────────────────────────────────

  function eat() {
    tone({ freq: 523, duration: 0.075, gain: 0.18 }); // C5 blip
  }

  function gem(type) {
    switch (type) {
      case "bonus":
        // Bright high ding
        tone({ freq: 880, duration: 0.16, gain: 0.22 });
        break;
      case "shrink":
        // Descending swoosh
        tone({ freq: 660, endFreq: 330, duration: 0.2, gain: 0.2 });
        break;
      case "speed":
        // Rising zip
        tone({ freq: 440, endFreq: 900, duration: 0.13, gain: 0.2 });
        break;
      case "slow":
        // Descending drawl
        tone({ freq: 440, endFreq: 200, type: "triangle", duration: 0.25, gain: 0.2 });
        break;
      case "multiplier":
        // Two-note ascending chime
        tone({ freq: 660, type: "triangle", duration: 0.14, gain: 0.22, startAt: 0 });
        tone({ freq: 880, type: "triangle", duration: 0.14, gain: 0.22, startAt: 0.12 });
        break;
      default:
        tone({ freq: 660, duration: 0.14, gain: 0.2 });
    }
  }

  function gameOver() {
    // Low descending sweep
    tone({ freq: 380, endFreq: 120, type: "sawtooth", duration: 0.45, gain: 0.28 });
  }

  function win() {
    // Ascending C major arpeggio: C5 E5 G5 C6
    [523, 659, 784, 1047].forEach((freq, i) => {
      tone({ freq, duration: 0.16, gain: 0.2, startAt: i * 0.1 });
    });
  }

  // ────────────────────────────────────────────────────────────────────────

  return { resume, eat, gem, gameOver, win };
})();
