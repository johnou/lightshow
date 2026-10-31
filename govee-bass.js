import { setTimeout as sleep } from 'node:timers/promises';
import { BeatDetector } from './beat-detector.js';
import { MusicEnergy } from './music-energy.js';
import { ShowRunner } from './show-runner.js';

export class GoveeBass {
  constructor(send) {
    this.send = send;
    this.lights = new Map();
    this.errors = [];
    this.energy = new MusicEnergy();
    this.runner = new ShowRunner(async (ids, colors, brightness) => {
      const results = await Promise.allSettled(ids.map(async (id, i) => {
        const light = this.lights.get(id);
        if (!light) return;
        await this.send(light.ip, 'turn', { value:1 });
        await sleep(50);
        await this.send(light.ip, 'brightness', { value:brightness });
        await sleep(50);
        const [r,g,b] = colors[i];
        await this.send(light.ip, 'colorwc', { color:{r,g,b}, colorTemInKelvin:0 });
      }));
      this.errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
    }, { energy:() => this.energy.snapshot() });
    this.detector = new BeatDetector(() => this.runner.beat());
  }

  async configure(show, lights) {
    if (!show.musicSync || show.goveeStreaming || !lights.length) return this.reset();
    if (this.runner.inFlight) await this.runner.inFlight;
    this.lights = new Map(lights.map(light => [light.id, light]));
    const settings = { ...show, ids:[...this.lights.keys()], musicStyle:'beat' };
    if (this.runner.status().running) this.runner.update(settings);
    else {
      this.energy = new MusicEnergy();
      this.detector = new BeatDetector(() => this.runner.beat());
      await this.runner.start(settings);
      if (this.runner.inFlight) await this.runner.inFlight;
    }
    this.detector.setOffset(show.beatOffset || 0);
  }

  feed(sample, now = Date.now()) {
    if (!this.runner.status().running) return;
    this.energy.feed(sample.loudness, now, sample);
    this.detector.feed(sample.bass, now);
  }

  async reset() {
    await this.runner.stop();
    this.lights.clear();
    this.errors = [];
  }
}

export async function configureGoveeOutputs(bass, stream, show, lights) {
  if (show.goveeStreaming) await bass.reset();
  await stream.reconcile(show.goveeStreaming ? lights.map(({id,ip}) => ({id,ip})) : [], show.brightness);
  await bass.configure(show, lights);
}
