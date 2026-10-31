import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { MusicPlayer } from '../music-player.js';

test('a silent soundtrack plays and analyzes on macOS', async t => {
  if (process.platform !== 'darwin' || spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status !== 0) return t.skip('Requires macOS and ffmpeg');
  const dir = await mkdtemp(join(tmpdir(), 'lightshow-audio-test-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const samples = 16000, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF',0); data.writeUInt32LE(data.length-8,4); data.write('WAVEfmt ',8); data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22); data.writeUInt32LE(8000,24); data.writeUInt32LE(16000,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(samples*2,40);
  const path=join(dir,'silence.wav'); await writeFile(path,data);
  const errors=[], frames=[]; const player=new MusicPlayer(message => errors.push(message), () => {}, frame => frames.push(frame)); t.after(() => player.stop());
  await player.start(path,true); await sleep(1200);
  assert.equal(player.active,true); assert.equal(player.level,0); assert.deepEqual(errors,[]); assert.ok(frames.length > 0 && frames.every(frame => frame.length === 1600));
  player.stop(); assert.equal(player.active,false);
});
