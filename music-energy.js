export class MusicEnergy {
  constructor() {
    this.short = 0;
    this.long = 0;
    this.lastTime = null;
    this.started = null;
    this.state = 'steady';
    this.candidate = null;
    this.candidateSince = 0;
    this.bands = [0, 0, 0];
  }

  feed(level, now = Date.now(), bands = {}) {
    const value = Math.max(0, Math.min(1, level));
    if (this.lastTime === null || now - this.lastTime > 3000) {
      this.short = this.long = value;
      this.started = now;
      this.state = 'steady';
      this.candidate = null;
      this.bands = [bands.bass || 0, bands.mid || 0, bands.high || 0];
    }
    const elapsed = Math.max(0, Math.min(now - (this.lastTime ?? now), 1000));
    this.lastTime = now;
    this.short += (value - this.short) * (1 - Math.exp(-elapsed / 800));
    this.long += (value - this.long) * (1 - Math.exp(-elapsed / 10000));
    const blend = 1 - Math.exp(-elapsed / 180);
    this.bands = ['bass','mid','high'].map((band, i) => this.bands[i] + (Math.max(0, Math.min(1, bands[band] || 0)) - this.bands[i]) * blend);
    const next = this.short < 0.025 ? 'quiet' : now - this.started < 3000 ? 'steady' : this.short < this.long * 0.65 ? 'quiet' : this.short > this.long * 1.35 ? 'intense' : 'steady';
    if (next !== this.candidate) { this.candidate = next; this.candidateSince = now; }
    if (now - this.candidateSince >= 800) this.state = next;
  }

  snapshot() { return { level: this.short, state: this.state, bands: this.bands }; }
}
