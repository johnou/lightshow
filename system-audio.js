import { spawn } from 'node:child_process';

export class SystemAudio {
  constructor(onLevel, onError) { this.onLevel = onLevel; this.onError = onError; this.child = null; }
  start(binary, args = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio:['ignore','pipe','pipe'] });
      this.child = child;
      let ready = false, errors = '', pending = '';
      const timeout = setTimeout(() => { if (!ready && this.child === child) { this.stop(); reject(new Error('Audio capture did not start. Check the permission prompt on the Mac.')); } }, 45000);
      child.stderr.on('data', chunk => { errors += chunk.toString(); if (!ready && errors.includes('ready\n')) { ready = true; clearTimeout(timeout); resolve(); } });
      child.stdout.on('data', chunk => { pending += chunk.toString(); const lines = pending.split('\n'); pending = lines.pop(); for (const line of lines) { const values = line.trim().split(/\s+/).map(Number); if (values.length === 2 && values.every(Number.isFinite)) this.onLevel({ bass:values[0], loudness:values[1] }); } });
      child.on('error', error => { clearTimeout(timeout); if (!ready) reject(error); else if (this.child === child) this.onError(error.message); });
      child.on('exit', () => { clearTimeout(timeout); if (this.child !== child) return; this.child = null; const message = errors.trim() || 'System audio capture stopped.'; if (!ready) reject(new Error(message)); else this.onError(message); });
    });
  }
  stop() { const child = this.child; this.child = null; child?.kill(); }
}
