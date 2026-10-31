import { setTimeout as sleep } from 'node:timers/promises';

export class GoveeBass {
  constructor(send) {
    this.send = send;
    this.colors = new Map();
    this.peak = 0;
    this.last = -Infinity;
    this.pending = null;
    this.errors = [];
  }

  update(lights, palette, brightness, bass, now = Date.now()) {
    this.peak = Math.max(this.peak, bass);
    if (this.pending || now - this.last < 250) return;
    this.last = now;
    const level = Math.max(1, Math.round(brightness * (0.03 + 0.97 * Math.sqrt(Math.min(1, this.peak * 6)))));
    this.peak = 0;
    const wanted = new Set(lights.map(light => light.id));
    for (const id of this.colors.keys()) if (!wanted.has(id)) this.colors.delete(id);
    this.pending = Promise.allSettled(lights.map(async (light, i) => {
      const [r,g,b] = palette[i % palette.length];
      const key = `${light.ip}:${r},${g},${b}`;
      if (this.colors.get(light.id) !== key) {
        await this.send(light.ip, 'turn', { value:1 });
        await sleep(100);
        await this.send(light.ip, 'colorwc', { color:{r,g,b}, colorTemInKelvin:0 });
        await sleep(100);
        this.colors.set(light.id, key);
      }
      await this.send(light.ip, 'brightness', { value:level });
    })).then(results => { this.errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message); }).finally(() => { this.pending = null; });
    return this.pending;
  }

  async reset() {
    await this.pending;
    this.colors.clear();
    this.peak = 0;
    this.last = -Infinity;
    this.errors = [];
  }
}
