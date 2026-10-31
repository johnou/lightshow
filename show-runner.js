export function immersiveColors(palette, count, step, bands = [0, 0, 0]) {
  const phrase = Math.floor(step / 4);
  return Array.from({ length:count }, (_, i) => {
    const primary = palette[(phrase + i) % palette.length];
    const next = palette[(phrase + i + 1) % palette.length];
    const band = Math.max(0, Math.min(1, bands[i % 3] || 0));
    const mix = Math.min(0.8, 0.12 + band * 0.48 + (step % 4) * 0.06);
    const intensity = 0.55 + 0.45 * Math.sqrt(band);
    return primary.map((value, channel) => Math.round((value * (1 - mix) + next[channel] * mix) * intensity));
  });
}

export class ShowRunner {
  constructor(send, options = {}) {
    this.send = send;
    this.onStop = options.onStop || (() => {});
    this.energy = options.energy || (() => ({ level:1, state:'steady' }));
    this.tempo = options.tempo || (() => null);
    this.show = null;
    this.timer = null;
    this.inFlight = null;
    this.generation = 0;
    this.error = null;
    this.lastFrame = 0;
  }

  status() {
    return { running: Boolean(this.show), ...(this.show || {}), error: this.error };
  }

  async start(settings) {
    await this.stop();
    this.error = null;
    this.show = { ...settings };
    const generation = ++this.generation;
    this.step = 0;
    this.beatCount = 0;
    this.tick(generation);
    return this.status();
  }

  update(settings) {
    if (!this.show) throw new Error('No show is running.');
    this.show = { ...this.show, ...settings };
    return this.status();
  }

  beat() {
    if (!this.show?.musicSync || this.inFlight || Date.now() - this.lastFrame < Math.max(250, this.show.ids.filter(id => id.startsWith('hue:')).length * 110)) return false;
    const energy = this.energy();
    this.beatCount++;
    const interval = this.show.musicStyle === 'immersive' ? (energy.state === 'quiet' ? 2 : 1) : energy.state === 'quiet' ? 4 : energy.state === 'intense' ? 1 : 2;
    if (this.beatCount % interval !== 0) return false;
    clearTimeout(this.timer);
    this.tick(this.generation);
    return true;
  }

  async tick(generation) {
    if (!this.show || generation !== this.generation) return;
    const show = this.show;
    this.lastFrame = Date.now();
    const energy = this.energy();
    const immersive = show.musicSync && show.musicStyle === 'immersive';
    const colors = immersive ? immersiveColors(show.palette, show.ids.length, this.step, energy.bands) : show.ids.map((_, i) => {
      const position = show.musicSync && ['haunted', 'party'].includes(show.scene) ? i % 2 : i;
      return show.palette[(this.step + position) % show.palette.length];
    });
    const level = show.musicSync ? Math.max(0, Math.min(1, energy.level)) : 1;
    const brightness = Math.max(1, Math.round(show.brightness * (show.musicSync ? 0.35 + Math.sqrt(level) * 0.65 : 1)));
    const transitionMs = immersive ? Math.max(150, Math.min(500, (this.tempo() || 500) * 0.6)) : 0;
    try {
      this.inFlight = this.send(show.ids, colors, brightness, show.musicSync, transitionMs);
      await this.inFlight;
      this.step++;
    } catch (error) {
      if (generation === this.generation) {
        this.error = error.message;
        this.show = null;
        this.generation++;
        await this.onStop();
      }
    } finally {
      this.inFlight = null;
    }
    if (this.show && !this.show.musicSync && generation === this.generation) this.timer = setTimeout(() => this.tick(generation), this.show.pace);
  }

  async fail(message) {
    await this.stop();
    this.error = message;
  }

  async stop() {
    this.show = null;
    this.generation++;
    clearTimeout(this.timer);
    if (this.inFlight) await this.inFlight.catch(() => {});
    await this.onStop();
    return this.status();
  }
}
