import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PCM_BYTES = 1600;
const FRAME_MS = 1000 / 60;
const MAX_QUEUE = 6;
const MAX_BUFFERED = 16 * 1024;
const CLIENT = 'Lightshow';
const VIRTUAL = 'lightshow-output';
const EXPECTED_VERSION = '2.2.1';

export function effectConfig(palette) {
  if (!Array.isArray(palette) || !palette.length || palette.length > 32 || palette.some(color => !Array.isArray(color) || color.length !== 3 || color.some(v => !Number.isInteger(v) || v < 0 || v > 255))) throw new Error('Invalid scene palette.');
  const hex = c => `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
  return { color_lows:hex(palette[0]), color_mids:hex(palette[1 % palette.length]), color_high:hex(palette[2 % palette.length]), blur:0, mirror:false };
}

export function parsePixels(message, count, virtual = VIRTUAL) {
  if (message?.event_type !== 'visualisation_update' || message.vis_id !== virtual || message.is_device !== true || !Array.isArray(message.shape) || message.shape[0] !== 1 || message.shape[1] !== count || typeof message.pixels !== 'string') return null;
  const pixels = Buffer.from(message.pixels, 'base64');
  if (pixels.length !== count * 3) return null;
  return Array.from({length:count}, (_, i) => [pixels[i*3], pixels[i*3+1], pixels[i*3+2]]);
}

async function freePort() {
  const server=createServer();
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0, '127.0.0.1', resolve); });
  const port=server.address().port;
  await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export class LedFxEngine {
  constructor({python, onFrame = () => {}, onError = () => {}, startupTimeoutMs = 30000}) {
    if (!python) throw new Error('LedFx Python runtime is required.');
    this.python=python; this.onFrame=onFrame; this.onError=onError; this.startupTimeoutMs=startupTimeoutMs;
    this.child=null; this.ws=null; this.configDir=null; this.timer=null; this.ready=false; this.stopping=false; this.stopPromise=null; this.queue=[];
    this.counters={accepted:0,dropped:0,sent:0,framesReceived:0};
  }

  get stats() { return { ...this.counters, queued:this.queue.length, wsBufferedBytes:this.ws?.bufferedAmount || 0, ready:this.ready }; }

  async request(path, method = 'GET', body) {
    const response=await fetch(`${this.base}${path}`, { method, ...(body === undefined ? {} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}), signal:AbortSignal.timeout(12000) });
    const data=await response.json();
    if (!response.ok || data.status === 'failed' || data.status === 'error') throw new Error(data.error?.message || data.payload?.reason || `LedFx ${path} failed (${response.status}).`);
    return data;
  }

  async start({ids,palette}) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Select between 1 and 100 unique lights.');
    const config=effectConfig(palette);
    await this.stop();
    this.stopping=false; this.failed=false; this.ids=[...ids]; this.queue=[]; this.counters={accepted:0,dropped:0,sent:0,framesReceived:0};
    try {
      this.configDir=await mkdtemp(join(tmpdir(),'lightshow-ledfx-'));
      this.base=`http://127.0.0.1:${await freePort()}`;
      const port=new URL(this.base).port;
      this.logs=''; this.exit=null;
      const child=spawn(this.python,['-m','ledfx','--offline','--no-tray','--host','127.0.0.1','--port',port,'--config',this.configDir], {stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUNBUFFERED:'1'}});
      this.child=child;
      for (const stream of [child.stdout,child.stderr]) stream.on('data', chunk => { this.logs=(this.logs+chunk.toString()).slice(-3000); });
      child.on('error', error => { this.exit=error; if (this.ready && !this.stopping) this.fail(error); });
      child.on('exit', (code,signal) => { this.exit=new Error(`LedFx exited (${signal || code}).`); if (this.ready && !this.stopping) this.fail(this.exit); });
      const deadline=Date.now()+this.startupTimeoutMs;
      let info;
      while (Date.now()<deadline) {
        if (this.exit) throw this.exit;
        try { info=await this.request('/api/info'); break; } catch { await sleep(200); }
      }
      if (!info) throw new Error(`LedFx did not start in ${this.startupTimeoutMs} ms.`);
      if (info.version !== EXPECTED_VERSION) throw new Error(`Expected LedFx ${EXPECTED_VERSION}, found ${info.version}.`);
      const ws=new WebSocket(`${this.base.replace(/^http/, 'ws')}/api/websocket`);
      this.ws=ws;
      ws.addEventListener('message', event => {
        let message; try { message=JSON.parse(String(event.data)); } catch { return; }
        const colors=parsePixels(message,this.ids.length);
        if (!colors || !this.ready) return;
        this.counters.framesReceived++;
        try { this.onFrame(colors); } catch (error) { this.fail(error); }
      });
      ws.addEventListener('close', () => { if (this.ready && !this.stopping) this.fail(new Error('LedFx connection closed.')); });
      ws.addEventListener('error', () => { if (this.ready && !this.stopping) this.fail(new Error('LedFx connection failed.')); });
      await new Promise((resolve,reject) => {
        const timer=setTimeout(() => reject(new Error('LedFx WebSocket timed out.')),5000);
        ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once:true});
        ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to LedFx.')); }, {once:true});
      });
      ws.send(JSON.stringify({id:1,type:'audio_stream_start',client:CLIENT}));
      let deviceIndex;
      while (Date.now()<deadline) {
        if (this.exit) throw this.exit;
        const data=await this.request('/api/audio/devices');
        const entry=Object.entries(data.devices || {}).find(([,name]) => name === `WEB AUDIO: ${CLIENT}`);
        if (entry) { deviceIndex=Number(entry[0]); break; }
        await sleep(150);
      }
      if (deviceIndex === undefined) throw new Error('LedFx did not register the Mac audio input.');
      await this.request('/api/audio/devices','PUT',{audio_device:deviceIndex});
      if (ids.length > 81) await this.request('/api/config','PUT',{visualisation_maxlen:ids.length});
      await this.request('/api/devices','POST',{type:'dummy',config:{name:'Lightshow Output',pixel_count:ids.length}});
      ws.send(JSON.stringify({id:2,type:'subscribe_event',event_type:'visualisation_update',event_filter:{vis_id:VIRTUAL}}));
      await this.request(`/api/virtuals/${VIRTUAL}/effects`,'POST',{type:'energy',config});
      if (this.exit) throw this.exit;
      if (ws.readyState !== WebSocket.OPEN) throw new Error('LedFx connection closed while starting.');
      this.ready=true; this.nextSend=performance.now()+FRAME_MS; this.schedule();
    } catch (error) { await this.stop(); throw error; }
  }

  schedule() {
    this.timer=setTimeout(() => {
      this.timer=null;
      if (!this.ready || this.stopping) return;
      if (this.queue.length) {
        if (this.ws.bufferedAmount > MAX_BUFFERED) { this.counters.dropped+=this.queue.length; this.queue=[]; }
        else {
          const frame=this.queue.shift();
          try { this.ws.send(JSON.stringify({id:3,type:'audio_stream_data_v2',client:CLIENT,data:frame.toString('base64')})); this.counters.sent++; }
          catch (error) { this.fail(error); return; }
        }
      }
      const now=performance.now(); this.nextSend+=FRAME_MS;
      if (this.nextSend < now-FRAME_MS*2) this.nextSend=now+FRAME_MS;
      this.schedule();
    },Math.max(0,this.nextSend-performance.now()));
    this.timer.unref?.();
  }

  feed(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length !== PCM_BYTES) throw new Error('LedFx expects a 1600-byte mono PCM frame.');
    if (!this.ready || this.stopping) return false;
    this.counters.accepted++;
    if (this.queue.length >= MAX_QUEUE) { this.queue.shift(); this.counters.dropped++; }
    this.queue.push(Buffer.from(pcm));
    return true;
  }

  async setPalette(palette) {
    const config=effectConfig(palette);
    if (!this.ready || this.stopping) throw new Error('LedFx is not running.');
    await this.request(`/api/virtuals/${VIRTUAL}/effects`,'PUT',{type:'energy',config});
  }

  fail(error) {
    if (this.failed || this.stopping) return;
    this.failed=true; this.ready=false;
    try { this.onError(error instanceof Error ? error : new Error(String(error))); } catch {} finally { void this.stop(); }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise=this._stop().finally(() => { this.stopPromise=null; });
    return this.stopPromise;
  }

  async _stop() {
    this.stopping=true; this.ready=false;
    clearTimeout(this.timer); this.timer=null; this.queue=[];
    const ws=this.ws; this.ws=null;
    if (ws) { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({id:4,type:'audio_stream_stop',client:CLIENT})); ws.close(); } catch {} }
    const child=this.child; this.child=null;
    if (child && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const done=new Promise(resolve => child.once('exit',resolve));
      child.kill('SIGTERM');
      await Promise.race([done,sleep(4000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([done,sleep(1000)]); }
    }
    const dir=this.configDir; this.configDir=null;
    if (dir) await rm(dir,{recursive:true,force:true});
    this.ids=[];
  }
}
