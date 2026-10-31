import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { LedFxEngine, effectConfig, parsePixels } from '../ledfx-engine.js';

test('converts a scene palette to real LedFx Energy options', () => {
  assert.deepEqual(effectConfig([[255,16,0],[0,32,254],[3,4,5]]), {color_lows:'#ff1000',color_mids:'#0020fe',color_high:'#030405',blur:0,mirror:false});
  assert.equal(effectConfig([[1,2,3]]).color_high,'#010203');
  assert.throws(() => effectConfig([[256,2,3]]), /Invalid scene palette/);
});

test('decodes only complete output frames from the intended dummy device', () => {
  const msg={event_type:'visualisation_update',vis_id:'lightshow-output',is_device:true,shape:[1,2],pixels:Buffer.from([1,2,3,4,5,6]).toString('base64')};
  assert.deepEqual(parsePixels(msg,2),[[1,2,3],[4,5,6]]);
  assert.equal(parsePixels({...msg,shape:[1,3]},2),null);
  assert.equal(parsePixels({...msg,is_device:false},2),null);
  assert.equal(parsePixels({...msg,pixels:'AA=='},2),null);
});

test('paces bursts, drops oldest excess audio, and cancels its timer', async () => {
  const sent=[]; const engine=new LedFxEngine({python:'unused'});
  engine.ready=true; engine.stopping=false;
  engine.ws={bufferedAmount:0,readyState:3,send:msg=>sent.push(JSON.parse(msg)),close(){}};
  engine.nextSend=performance.now()+5; engine.schedule();
  for (let i=0;i<10;i++) engine.feed(Buffer.alloc(1600,i));
  assert.equal(engine.stats.accepted,10); assert.equal(engine.stats.dropped,4); assert.equal(engine.stats.queued,6);
  await sleep(75);
  assert.ok(sent.length>=3 && sent.length<=6); assert.equal(Buffer.from(sent[0].data,'base64')[0],4);
  await engine.stop(); const after=sent.length; await sleep(40); assert.equal(sent.length,after);
  assert.equal(engine.stats.ready,false);
});

test('drops queued audio when websocket output is congested', async () => {
  const engine=new LedFxEngine({python:'unused'}); engine.ready=true; engine.stopping=false;
  engine.ws={bufferedAmount:65536,readyState:3,send(){throw Error('unexpected send');},close(){}};
  engine.nextSend=performance.now()+2; engine.schedule();
  for(let i=0;i<3;i++) engine.feed(Buffer.alloc(1600));
  await sleep(30); assert.equal(engine.stats.dropped,3); assert.equal(engine.stats.sent,0); assert.equal(engine.stats.queued,0);
  await engine.stop();
});

test('rejects invalid frames and cleans up a failed startup', async () => {
  const engine=new LedFxEngine({python:'/path/that/does/not/exist',startupTimeoutMs:500});
  assert.throws(() => engine.feed(Buffer.alloc(10)), /1600-byte/);
  await assert.rejects(engine.start({ids:['one'],palette:[[255,0,0]]}), /ENOENT/);
  assert.equal(engine.configDir,null); assert.equal(engine.child,null);
});
