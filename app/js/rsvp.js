import { durationMs } from './tokenize.js';

const RAMP_WORDS = 5; // ease in after a resume so the first words aren't missed
const RESYNC_MS = 750; // fell this far behind: restart the clock instead of catching up
const REWIND_WORDS = 4; // back up on resume so you re-enter with context, like a podcast

export class Player extends EventTarget {
  constructor() {
    super();
    this.tokens = [];
    this.index = 0;
    this.playing = false;
    this.wpm = 350;
    this.punctuationScale = 1;
    this.rewindOnResume = true;
    this._placedByHand = false;
    this._raf = null;
    this._nextAt = 0;
    this._rampLeft = 0;
  }

  load(tokens, index = 0) {
    this.pause();
    this.tokens = tokens;
    this.index = Math.min(index, Math.max(0, tokens.length - 1));
    this._emit('load');
    this._emit('tick');
  }

  get current() {
    return this.tokens[this.index] ?? null;
  }

  get done() {
    return this.index >= this.tokens.length;
  }

  play() {
    if (this.playing || !this.tokens.length) return;
    if (this.done) this.index = 0;
    // Only after a genuine pause — landing somewhere deliberately, by scrubbing or
    // stepping, should start exactly where you put it.
    if (this.rewindOnResume && !this._placedByHand) {
      this.index = Math.max(0, this.index - REWIND_WORDS);
    }
    this._placedByHand = false;
    this.playing = true;
    this._rampLeft = RAMP_WORDS;
    this._emit('state');
    this._emit('tick');
    this._nextAt = performance.now() + this._holdFor(this.current);
    this._raf = requestAnimationFrame(this._step);
  }

  pause() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (!this.playing) return;
    this.playing = false;
    this._emit('state');
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(index) {
    this.index = Math.max(0, Math.min(index, this.tokens.length - 1));
    this._placedByHand = true;
    this._rampLeft = RAMP_WORDS;
    this._emit('tick');
    if (this.playing) this._nextAt = performance.now() + this._holdFor(this.current);
  }

  step(delta) {
    this.pause();
    this.seek(this.index + delta);
  }

  _holdFor(token) {
    let ms = durationMs(token, this.wpm, this.punctuationScale);
    if (this._rampLeft > 0) {
      ms *= 1 + 0.55 * (this._rampLeft / RAMP_WORDS);
      this._rampLeft--;
    }
    return ms;
  }

  // Driven by animation frames rather than timers: a background or occluded tab
  // clamps setTimeout to roughly one second, which would drag every word out to
  // the same crawl regardless of the speed setting.
  _step = (now) => {
    if (!this.playing) return;

    if (now >= this._nextAt) {
      this.index++;
      if (this.done) {
        this.playing = false;
        this._emit('tick');
        this._emit('state');
        this._emit('finish');
        return;
      }
      this._emit('tick');
      const hold = this._holdFor(this.current);
      // Advancing at most one word per frame guarantees every word is actually
      // painted; the deadline accumulates so the cadence doesn't drift.
      this._nextAt = now - this._nextAt > RESYNC_MS ? now + hold : this._nextAt + hold;
    }

    this._raf = requestAnimationFrame(this._step);
  };

  _emit(type) {
    this.dispatchEvent(new Event(type));
  }
}
