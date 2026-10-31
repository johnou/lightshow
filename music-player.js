import { spawn } from 'node:child_process';

export class MusicPlayer {
  constructor(onError, onLevel = () => {}, onPCM = () => {}) { this.onError = onError; this.onLevel = onLevel; this.onPCM = onPCM; this.player = null; this.analyzer = null; this.active = false; this.level = 1; }

  async start(path, react) {
    if (process.platform !== 'darwin') throw new Error('Soundtrack playback currently requires macOS.');
    this.active = true;
    this.level = 1;
    const player = this.play(path);
    const analyzer = react ? this.analyze(path) : null;
    try { await Promise.all([this.waitForSpawn(player), ...(analyzer ? [this.waitForSpawn(analyzer)] : [])]); }
    catch (error) { this.stop(); throw new Error(`Could not start soundtrack: ${error.message}`); }
  }

  waitForSpawn(child) { return new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }

  play(path) {
    const child = spawn('/usr/bin/afplay', [path], { stdio:'ignore' });
    this.player = child;
    child.on('error', error => { if (this.active && this.player === child) this.onError(`Soundtrack playback failed: ${error.message}`); });
    child.on('exit', code => { if (!this.active || this.player !== child) return; if (code === 0) this.play(path); else this.onError('The Mac could not play the soundtrack. Try a different audio file.'); });
    return child;
  }

  analyze(path) {
    const child = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-re','-stream_loop','-1','-i',path,'-f','s16le','-ac','1','-ar','48000','pipe:1'], { stdio:['ignore','pipe','ignore'] });
    this.analyzer = child;
    let pending = Buffer.alloc(0), bass = 0, lowMid = 0;
    const alpha = 1 - Math.exp(-2 * Math.PI * 180 / 48000);
    const midAlpha = 1 - Math.exp(-2 * Math.PI * 2000 / 48000);
    child.stdout.on('data', buffer => {
      pending = Buffer.concat([pending, buffer]);
      while (pending.length >= 1600) {
        let bassSum = 0, fullSum = 0, midSum = 0, highSum = 0;
        for (let i=0; i<1600; i+=2) { const sample = pending.readInt16LE(i)/32768; bass += alpha * (sample - bass); lowMid += midAlpha * (sample - lowMid); bassSum += bass*bass; fullSum += sample*sample; midSum += (lowMid-bass)**2; highSum += (sample-lowMid)**2; }
        this.level = Math.min(1, Math.sqrt(bassSum/800)*6);
        this.onLevel({ bass:this.level, loudness:Math.min(1, Math.sqrt(fullSum/800)*4), mid:Math.min(1, Math.sqrt(midSum/800)*6), high:Math.min(1, Math.sqrt(highSum/800)*8) });
        this.onPCM(pending.subarray(0, 1600));
        pending = pending.subarray(1600);
      }
    });
    child.on('error', error => { if (this.active && this.analyzer === child) this.onError(`Music reaction requires ffmpeg: ${error.message}`); });
    child.on('exit', code => { if (this.active && this.analyzer === child && code !== 0) this.onError('Could not analyze the soundtrack.'); });
    return child;
  }

  stop() { this.active = false; this.player?.kill(); this.analyzer?.kill(); this.player = null; this.analyzer = null; this.level = 1; }
}
