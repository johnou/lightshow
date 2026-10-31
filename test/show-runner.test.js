import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShowRunner } from '../show-runner.js';

const settings = { ids:['a','b'], palette:[[255,0,0],[0,255,0]], pace:20, brightness:80, musicSync:false };
test('show runs without a client, advances colors, and stops', async () => {
  const calls=[];
  const runner=new ShowRunner(async (...args) => { calls.push(args); });
  await runner.start(settings);
  for (let i = 0; i < 50 && calls.length < 2; i++) await sleep(20);
  assert.ok(calls.length >= 2);
  assert.deepEqual(calls[0][1], [[255,0,0],[0,255,0]]);
  assert.deepEqual(calls[1][1], [[0,255,0],[255,0,0]]);
  await runner.stop();
  const count=calls.length;
  await sleep(50);
  assert.equal(calls.length,count);
  assert.equal(runner.status().running,false);
});
test('stop waits for in-flight commands and failures are reported', async () => {
  let release;
  const runner=new ShowRunner(() => new Promise(resolve => { release=resolve; }));
  await runner.start(settings);
  let stopped=false;
  const stopping=runner.stop().then(() => { stopped=true; });
  await sleep(5); assert.equal(stopped,false);
  release(); await stopping;
  assert.equal(runner.status().running,false);
  const failing=new ShowRunner(async () => { throw new Error('light unreachable'); });
  await failing.start(settings); await sleep(5);
  assert.equal(failing.status().error,'light unreachable');
  assert.equal(failing.status().running,false);
});
test('beats can advance a reactive show and are rate-limited', async () => {
  let count=0;
  const runner=new ShowRunner(async () => { count++; }, { energy:() => ({ level:1, state:'intense' }) });
  await runner.start({ ...settings, pace:60000, musicSync:true });
  await sleep(5); assert.equal(count,1);
  runner.beat(); await sleep(5); assert.equal(count,1);
  runner.lastFrame = Date.now()-1000;
  runner.beat(); await sleep(5); assert.equal(count,2);
  await runner.stop();
});
test('quieter passages change colors less often and intense passages follow every beat', async () => {
  const calls=[]; let state='quiet';
  const runner=new ShowRunner(async (...args) => { calls.push(args); }, { energy:() => ({ level:state === 'quiet' ? 0.04 : 0.8, state }) });
  await runner.start({ ...settings, scene:'haunted', pace:60000, musicSync:true });
  for (let i=0; i<4; i++) { runner.lastFrame=Date.now()-1000; runner.beat(); await sleep(1); }
  assert.equal(calls.length,2);
  const quietBrightness=calls.at(-1)[2];
  state='intense'; runner.lastFrame=Date.now()-1000; runner.beat(); await sleep(1);
  assert.equal(calls.length,3);
  assert.ok(calls.at(-1)[2]>quietBrightness);
  await runner.stop();
});
test('reactive shows do not advance on a free-running timer without a beat', async () => {
  let count=0; const runner=new ShowRunner(async () => { count++; });
  await runner.start({ ...settings, pace:20, musicSync:true });
  await sleep(70); assert.equal(count,1);
  await runner.stop();
});
