export class BeatDetector {
  constructor(onBeat) { this.onBeat = onBeat; this.average = 0; this.previous = 0; this.lastBeat = -Infinity; }
  feed(level, now = Date.now()) {
    const value = Math.max(0, Math.min(1, level));
    const threshold = Math.max(0.06, this.average * 1.35);
    if (value > threshold && value > this.previous + 0.01 && now - this.lastBeat >= 250) {
      this.lastBeat = now;
      this.onBeat();
    }
    this.average = this.average * 0.96 + value * 0.04;
    this.previous = value;
  }
}
