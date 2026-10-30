export class BeatDetector {
  constructor(onBeat) { this.onBeat = onBeat; this.average = 0; this.lastBeat = 0; }
  feed(level, now = Date.now()) {
    const value = Math.max(0, Math.min(1, level));
    const threshold = Math.max(0.08, this.average * 1.4);
    if (value > threshold && now - this.lastBeat >= 700) { this.lastBeat = now; this.onBeat(); }
    this.average = this.average * 0.92 + value * 0.08;
  }
}
