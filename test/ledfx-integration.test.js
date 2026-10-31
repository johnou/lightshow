import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LedFxEngine } from '../ledfx-engine.js';

const python = process.env.LIGHTSHOW_LEDFX_TEST_PYTHON || fileURLToPath(new URL('../.lightshow-tools/ledfx-venv/bin/python', import.meta.url));

test('real LedFx responds to synthetic music and shuts down cleanly', { skip:!existsSync(python), timeout:45000 }, async () => {
  const frames = [], errors = [];
  let started = 0;
  const engine = new LedFxEngine({ python, onFrame:frame => frames.push({ at:performance.now() - started, frame }), onError:error => errors.push(error) });
  let dir;
  try {
    await engine.start({ ids:['a','b','c','d','e'], palette:[[255,0,0],[0,255,0],[0,0,255]] });
    dir = engine.configDir;
    started = performance.now();
    let n = 0;
    while (performance.now() - started < 8000) {
      const pcm = Buffer.alloc(1600), t = performance.now() - started, phase = (t % 500) / 1000;
      const amplitude = t < 1500 ? 0 : phase < 0.15 ? 0.8 * Math.exp(-phase * 25) : 0;
      for (let i = 0; i < 800; i++) pcm.writeInt16LE(Math.round(32767 * amplitude * Math.sin(2 * Math.PI * 90 * (n * 800 + i) / 48000)), i * 2);
      engine.feed(pcm);
      n++;
      await sleep(1000 / 60);
    }
    await sleep(250);
    const mean = list => list.reduce((sum, entry) => sum + entry.frame.flat().reduce((a, b) => a + b, 0), 0) / Math.max(1, list.length);
    const silent = mean(frames.filter(frame => frame.at < 1300));
    const audible = mean(frames.filter(frame => frame.at > 3500));
    assert.ok(frames.length > 30, 'LedFx produced output frames');
    assert.ok(new Set(frames.map(entry => JSON.stringify(entry.frame))).size > 1, 'output colors changed');
    assert.ok(audible > silent + 1, `audio affected colors: silence ${silent}, music ${audible}`);
    assert.equal(errors.length, 0);
    await engine.setPalette([[255,100,0],[70,0,255],[0,200,80]]);
  } finally {
    await engine.stop();
  }
  assert.equal(engine.stats.ready, false);
  assert.equal(existsSync(dir), false);
});
