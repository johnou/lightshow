import { setTimeout as sleep } from 'node:timers/promises';

const ACTIVATE = 'uwABsQEK';
const DEACTIVATE = 'uwABsQAL';

// Packet format derived from LedFx 2.2.1's GPL-3.0 Govee device implementation.
export function goveeStreamPacket(rgb) {
  const bytes = [0xbb, 0x00, 0xfa, 0xb0, 0x00, 0x01, ...rgb];
  return Buffer.from([...bytes, bytes.reduce((checksum, byte) => checksum ^ byte, 0)]);
}

const clampBrightness = value => Math.max(0, Math.min(100, Math.round(value)));
const colorPayload = rgb => ({ color:{ r:rgb[0], g:rgb[1], b:rgb[2] }, colorTemInKelvin:0 });
const framePayload = rgb => ({ pt:goveeStreamPacket(rgb).toString('base64') });

/**
 * Owns only Govee streaming output. send(ip, command, data) resolves when a
 * datagram is handed to the OS; the device does not acknowledge the command.
 * Status reports submitted commands, not verified bulb capability or state.
 */
export class GoveeStream {
  constructor(send, options = {}) {
    this.send = send;
    this.onWarning = options.onWarning || (() => {});
    this.wait = options.wait || sleep;
    this.startTimer = options.startTimer || setInterval;
    this.stopTimer = options.stopTimer || clearInterval;
    this.intervalMs = options.intervalMs || 100;
    this.sessions = new Map();
    this.frames = new Map();
    this.failures = new Map();
    this.brightness = 100;
    this.running = false;
    this.timer = null;
    this.operation = Promise.resolve();
  }

  enqueue(operation) {
    const next = this.operation.then(operation);
    this.operation = next.catch(() => {});
    return next;
  }

  status() {
    return { running:this.running, submitted:[...this.sessions.keys()], failures:[...this.failures].map(([id, message]) => ({ id, message })) };
  }

  start(lights, brightness = 100) {
    return this.enqueue(async () => {
      this.validate(lights, brightness);
      this.running = true;
      this.brightness = clampBrightness(brightness);
      await this.applySelection(lights);
      if (this.timer === null) this.timer = this.startTimer(() => { void this.flush(); }, this.intervalMs);
      return this.status();
    });
  }

  reconcile(lights, brightness = this.brightness) {
    return this.enqueue(async () => {
      this.validate(lights, brightness);
      if (!this.running) return this.status();
      this.brightness = clampBrightness(brightness);
      await this.applySelection(lights);
      return this.status();
    });
  }

  validate(lights, brightness) {
    if (!Array.isArray(lights) || !Number.isFinite(brightness)) throw new TypeError('Invalid Govee selection or brightness.');
    const ids = new Set(), ips = new Set();
    for (const light of lights) {
      if (typeof light?.id !== 'string' || !light.id || typeof light.ip !== 'string' || !light.ip || ids.has(light.id) || ips.has(light.ip)) throw new TypeError('Each selected Govee light must have a unique id and address.');
      ids.add(light.id); ips.add(light.ip);
    }
  }

  async applySelection(lights) {
    const wanted = new Map(lights.map(light => [light.id, light]));
    const removed = [...this.sessions.values()].filter(session => wanted.get(session.id)?.ip !== session.ip);
    for (const session of removed) this.sessions.delete(session.id);
    await Promise.all(removed.map(session => this.release(session)));
    for (const id of this.failures.keys()) if (!wanted.has(id)) this.failures.delete(id);
    await Promise.all(lights.filter(light => !this.sessions.has(light.id)).map(light => this.activate(light)));
  }

  async activate(light) {
    const session = { id:light.id, ip:light.ip, inFlight:null, lastSubmitted:null, restoreBrightness:this.brightness, lastBrightness:this.brightness, error:null };
    let brightnessChanged = false;
    try {
      await this.send(session.ip, 'turn', { value:1 });
      await this.wait(100);
      await this.send(session.ip, 'brightness', { value:this.brightness });
      brightnessChanged = true;
      await this.wait(100);
      await this.send(session.ip, 'razer', { pt:ACTIVATE });
      this.sessions.set(session.id, session);
      this.failures.delete(session.id);
    } catch (error) {
      try { await this.send(session.ip, 'razer', { pt:DEACTIVATE }); } catch {}
      if (brightnessChanged) { try { await this.send(session.ip, 'brightness', { value:session.restoreBrightness }); } catch {} }
      this.report(session, error);
    }
  }

  update(colors, brightness = this.brightness) {
    if (!(colors instanceof Map) || !Number.isFinite(brightness)) throw new TypeError('A color map and finite brightness are required.');
    const next = new Map();
    for (const [id, rgb] of colors) {
      if (typeof id !== 'string' || !Array.isArray(rgb) || rgb.length !== 3 || rgb.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new TypeError('Invalid Govee color.');
      next.set(id, [...rgb]);
    }
    this.frames = next;
    this.brightness = clampBrightness(brightness);
  }

  async flush() {
    if (!this.running) return;
    const sends = [];
    for (const session of this.sessions.values()) {
      const rgb = this.frames.get(session.id);
      if (!rgb || session.inFlight) continue;
      const brightness = this.brightness;
      const task = (async () => {
        try {
          if (brightness !== session.lastBrightness) { await this.send(session.ip, 'brightness', { value:brightness }); session.lastBrightness = brightness; }
          await this.send(session.ip, 'razer', framePayload(rgb));
          session.lastSubmitted = { rgb:[...rgb], brightness };
          session.error = null;
          this.failures.delete(session.id);
        } catch (error) { this.report(session, error); }
      })();
      session.inFlight = task;
      sends.push(task.finally(() => { if (session.inFlight === task) session.inFlight = null; }));
    }
    await Promise.all(sends);
  }

  report(session, error) {
    const message = error?.message || String(error);
    this.failures.set(session.id, message);
    if (message !== session.error) { session.error = message; this.onWarning({ id:session.id, message }); }
  }

  async release(session) {
    if (session.inFlight) await session.inFlight;
    try { await this.send(session.ip, 'razer', { pt:DEACTIVATE }); } catch (error) { this.report(session, error); }
    await this.wait(150);
    try { await this.send(session.ip, 'brightness', { value:session.lastSubmitted?.brightness ?? session.restoreBrightness }); } catch (error) { this.report(session, error); }
    if (session.lastSubmitted) {
      await this.wait(100);
      try { await this.send(session.ip, 'colorwc', colorPayload(session.lastSubmitted.rgb)); } catch (error) { this.report(session, error); }
    }
  }

  stop() {
    return this.enqueue(async () => {
      this.running = false;
      if (this.timer !== null) this.stopTimer(this.timer);
      this.timer = null;
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.all(sessions.map(session => this.release(session)));
      this.frames.clear();
      return this.status();
    });
  }
}
