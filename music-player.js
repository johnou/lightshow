import { spawn } from 'node:child_process';

export class MusicPlayer {
  constructor(onError, onLevel = () => {}) { this.onError = onError; this.onLevel = onLevel; this.player = null; this.analyzer = null; this.active = false; this.level = 1; }

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
    const child = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-re','-stream_loop','-1','-i',path,'-af','lowpass=f=180','-f','s16le','-ac','1','-ar','8000','pipe:1'], { stdio:['ignore','pipe','ignore'] });
    this.analyzer = child;
    child.stdout.on('data', buffer => {
      let sum = 0, count = 0;
      for (let i=0; i+1<buffer.length; i+=2) { const sample = buffer.readInt16LE(i)/32768; sum += sample*sample; count++; }
      if (count) { this.level = Math.min(1, Math.sqrt(sum/count)*6); this.onLevel(this.level); }
    });
    child.on('error', error => { if (this.active && this.analyzer === child) this.onError(`Music reaction requires ffmpeg: ${error.message}`); });
    child.on('exit', code => { if (this.active && this.analyzer === child && code !== 0) this.onError('Could not analyze the soundtrack.'); });
    return child;
  }

  stop() { this.active = false; this.player?.kill(); this.analyzer?.kill(); this.player = null; this.analyzer = null; this.level = 1; }
}
