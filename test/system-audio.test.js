import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SystemAudio } from '../system-audio.js';

test('system audio starts, reads levels and stops without reporting a failure', async t => {
  const dir=await mkdtemp(join(tmpdir(),'lightshow-system-test-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const helper=join(dir,'fake-helper');
  await writeFile(helper, `#!/usr/bin/env node\nconsole.error('ready'); setInterval(() => { console.log('0.42 0.61 0.27 0.18'); console.log('PCM '+Buffer.alloc(1600,7).toString('base64')); }, 20);\n`, { mode:0o755 });
  const levels=[], errors=[], frames=[];
  const audio=new SystemAudio(level=>levels.push(level),error=>errors.push(error), frame=>frames.push(frame));
  t.after(() => audio.stop());
  await audio.start(helper); await sleep(80); audio.stop(); await sleep(20);
  assert.ok(levels.some(level => level.bass === 0.42 && level.loudness === 0.61 && level.mid === 0.27 && level.high === 0.18)); assert.deepEqual(errors,[]);
  assert.ok(frames.some(frame => frame.length === 1600 && frame[0] === 7));
});
