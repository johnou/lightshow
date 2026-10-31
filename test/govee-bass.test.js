import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoveeBass } from '../govee-bass.js';

test('ordinary Govee control follows bass peaks without resending colors every frame', async () => {
  const sent=[];
  const bass=new GoveeBass(async (ip,cmd,data) => sent.push({ip,cmd,data}));
  const lights=[{id:'one',ip:'192.168.1.53'}], palette=[[255,40,0]];
  await bass.update(lights,palette,80,0,0);
  const quiet=sent.at(-1).data.value;
  bass.update(lights,palette,80,1,100);
  await bass.update(lights,palette,80,0,250);
  assert.ok(sent.at(-1).data.value > quiet);
  assert.equal(sent.at(-1).data.value,80);
  assert.equal(sent.filter(x=>x.cmd==='colorwc').length,1);
  assert.equal(sent.some(x=>x.cmd==='razer'),false);
  await bass.update(lights,palette,80,0,500);
  assert.equal(sent.at(-1).data.value,quiet);
  await bass.reset();
});
