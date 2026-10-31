import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { GoveeBass } from '../govee-bass.js';

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
