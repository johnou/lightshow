const FRAME_MS = 25;
const HISTORY = 480;

export class BeatDetector {
  constructor(onBeat) {
    this.onBeat = onBeat;
    this.average = 0;
    this.previous = 0;
    this.lastBeat = -Infinity;
    this.bucket = null;
    this.peak = 0;
    this.previousPeak = 0;
    this.frames = [];
    this.period = null;
    this.nextBeat = null;
    this.lastEstimate = 0;
    this.lastSound = 0;
    this.candidateLag = null;
    this.candidateStreak = 0;
    this.offset = 0;
  }

  setOffset(value) {
    const change = value - this.offset;
    this.offset = value;
    if (this.nextBeat !== null) this.nextBeat += change;
  }

  feed(level, now = Date.now()) {
    const value = Math.max(0, Math.min(1, level));
    if (value > 0.03) this.lastSound = now;
    const bucket = Math.floor(now / FRAME_MS);
    if (this.bucket === null) this.bucket = bucket;
    if (bucket > this.bucket) {
      this.addFrame(this.bucket, this.peak);
      this.bucket = bucket;
      this.peak = value;
    } else this.peak = Math.max(this.peak, value);

    if (this.period && this.nextBeat !== null && now - this.lastSound < 1500) {
      if (now >= this.nextBeat) {
        if (now - this.lastBeat >= 250) { this.lastBeat = now; this.onBeat(); }
        do { this.nextBeat += this.period; } while (this.nextBeat <= now);
      }
    } else if (!this.period) {
      const threshold = Math.max(0.06, this.average * 1.35);
      if (value > threshold && value > this.previous + 0.01 && now - this.lastBeat >= 250) {
        this.lastBeat = now;
        this.onBeat();
      }
    }
    this.average = this.average * 0.96 + value * 0.04;
    this.previous = value;
  }

  addFrame(index, peak) {
    if (this.frames.length && index - this.frames.at(-1).index > 8) {
      this.frames = [];
      this.period = null;
      this.nextBeat = null;
      this.previousPeak = 0;
    }
    while (this.frames.length && this.frames.at(-1).index + 1 < index) this.frames.push({ index:this.frames.at(-1).index + 1, onset:0 });
    this.frames.push({ index, onset:Math.max(0, peak - this.previousPeak) });
    this.previousPeak = peak;
    while (this.frames.length > HISTORY) this.frames.shift();
    if (this.frames.length >= 240 && index - this.lastEstimate >= 40) {
      this.lastEstimate = index;
      this.estimate(index);
    }
  }

  estimate(index) {
    const signal = this.frames.map(frame => frame.onset);
    const correlation = lag => {
      if (lag >= signal.length) return 0;
      let sum = 0;
      for (let i = lag; i < signal.length; i++) sum += signal[i] * signal[i - lag];
      return sum / (signal.length - lag);
    };
    const candidates = [];
    for (let lag = 14; lag <= 36; lag++) {
      const bpm = 60000 / (lag * FRAME_MS);
      const preference = 0.75 + 0.25 * Math.exp(-Math.pow((bpm - 115) / 40, 2));
      candidates.push({ lag, score:correlation(lag) * preference });
    }
    candidates.sort((a, b) => b.score - a.score);
    let best = candidates[0]; const typical = candidates[Math.floor(candidates.length / 2)].score;
    if (best.score < 0.00002 || best.score < typical * 1.08) return;
    if (60000 / (best.lag * FRAME_MS) < 85) {
      const doubleTime = candidates.find(candidate => Math.abs(candidate.lag - best.lag / 2) <= 0.5);
      if (doubleTime && doubleTime.score >= best.score * 0.8) best = doubleTime;
    }
    const previous = candidates.find(candidate => candidate.lag * FRAME_MS === this.period);
    if (previous && best.lag !== previous.lag) {
      if (best.score < previous.score * 1.02) { best = previous; this.candidateStreak = 0; }
      else {
        this.candidateStreak = Math.abs(best.lag - this.candidateLag) <= 1 ? this.candidateStreak + 1 : 1;
        this.candidateLag = best.lag;
        if (this.candidateStreak < 2) best = previous;
      }
    } else this.candidateStreak = 0;
    const phases = Array(best.lag).fill(0);
    for (let i = 0; i < this.frames.length; i++) {
      const frame = this.frames[i];
      phases[frame.index % best.lag] += frame.onset * (0.3 + 0.7 * i / this.frames.length);
    }
    const phase = phases.indexOf(Math.max(...phases));
    const period = best.lag * FRAME_MS;
    let next = (index - ((index - phase + best.lag) % best.lag)) * FRAME_MS - 100 + this.offset;
    const currentTime = index * FRAME_MS;
    while (next <= currentTime) next += period;
    if (this.period && Math.abs(period - this.period) <= 35 && this.nextBeat !== null) {
      const distance = ((next - this.nextBeat + period * 1.5) % period) - period / 2;
      this.nextBeat += Math.max(-25, Math.min(25, distance));
    } else this.nextBeat = next;
    this.period = period;
  }
}
