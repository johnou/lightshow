export class ShowRunner {
  constructor(send, options = {}) {
    this.send = send;
    this.onStop = options.onStop || (() => {});
    this.energy = options.energy || (() => 1);
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
    clearTimeout(this.timer);
    this.tick(this.generation);
    return true;
  }

  async tick(generation) {
    if (!this.show || generation !== this.generation) return;
    const show = this.show;
    this.lastFrame = Date.now();
    const colors = show.ids.map((_, i) => show.palette[(this.step + i) % show.palette.length]);
    const level = show.musicSync ? Math.max(0, Math.min(1, this.energy())) : 1;
    const brightness = Math.max(1, Math.round(show.brightness * (show.musicSync ? 0.35 + level * 0.65 : 1)));
    try {
      this.inFlight = this.send(show.ids, colors, brightness, show.musicSync);
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
    if (this.show && generation === this.generation) this.timer = setTimeout(() => this.tick(generation), this.show.pace);
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
