import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { GoveeBass, configureGoveeOutputs } from '../govee-bass.js';

test('Govee uses the original bass detector and classic scene runner with ordinary LAN commands', async () => {
  const sent=[];
  const driver=new GoveeBass(async (ip,cmd,data) => sent.push({ip,cmd,data}));
  const settings={musicSync:true,goveeStreaming:false,palette:[[255,40,0],[0,30,255]],brightness:80,scene:'halloween',pace:3000,beatOffset:0};
  await driver.configure(settings,[{id:'govee:one',ip:'192.168.1.53'}]);
  const first=sent.at(-1).data.color;
  assert.deepEqual(sent.map(x=>x.cmd),['turn','brightness','colorwc']);
  driver.feed({bass:0,loudness:0.5,mid:1,high:1});
  assert.equal(sent.length,3, 'treble does not advance Govee');
  await sleep(270);
  driver.feed({bass:0.8,loudness:0.5,mid:0,high:0});
  driver.feed({bass:0,loudness:0.5,mid:0,high:0});
  await sleep(270);
  driver.feed({bass:1,loudness:0.5,mid:0,high:0});
  if(driver.runner.inFlight) await driver.runner.inFlight;
  assert.notDeepEqual(sent.at(-1).data.color,first,'bass beats advance scene colors');
  assert.equal(sent.some(x=>x.cmd==='razer'),false);
  await driver.reset();
  const count=sent.length;
  driver.feed({bass:1,loudness:1,mid:1,high:1});
  assert.equal(sent.length,count);
});


test('protocol changes release the old Govee writer before starting the new one', async () => {
  const { GoveeStream } = await import('../govee-stream.js');
  const sent=[];
  const send=async (ip,cmd,data) => sent.push({cmd,data});
  const bass=new GoveeBass(send);
  const stream=new GoveeStream(send, {wait:async()=>{},startTimer:()=>1,stopTimer:()=>{}});
  const lights=[{id:'govee:one',ip:'192.168.1.53'}];
  const show={musicSync:true,goveeStreaming:true,palette:[[255,40,0]],brightness:80,scene:'halloween',pace:3000};
  try {
    await stream.start(lights,80);
    stream.update(new Map([[lights[0].id,[0,0,255]]]),80);
    await stream.flush();
    sent.length=0;
    await configureGoveeOutputs(bass,stream,{...show,goveeStreaming:false},lights);
    assert.equal(sent[0].cmd,'razer');
    assert.deepEqual(sent.at(-1),{cmd:'colorwc',data:{color:{r:255,g:40,b:0},colorTemInKelvin:0}});
    assert.equal(bass.runner.status().running,true);
    assert.deepEqual(stream.status().submitted,[]);
    sent.length=0;
    await configureGoveeOutputs(bass,stream,show,lights);
    assert.equal(bass.runner.status().running,false);
    assert.equal(sent.at(-1).cmd,'razer');
    assert.deepEqual(stream.status().submitted,[lights[0].id]);
  } finally { await bass.reset(); await stream.stop(); }
});
