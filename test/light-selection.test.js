import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableLightIds, resolveLightIds } from '../light-selection.js';
test('all-light selection follows availability as devices disconnect and recover', () => {
  const lights = new Map([['a',{id:'a',reachable:true}],['b',{id:'b',reachable:false}],['c',{id:'c',reachable:true}]]);
  assert.deepEqual(availableLightIds(lights), ['a','c']);
  lights.get('a').reachable = false; lights.get('b').reachable = true;
  assert.deepEqual(availableLightIds(lights), ['b','c']);
});

test('all mode uses the server availability even when the client selection is stale', () => {
  const lights=new Map([['a',{id:'a',reachable:true}],['b',{id:'b',reachable:false}],['c',{id:'c',reachable:true}]]);
  assert.deepEqual(resolveLightIds(lights,['old','b'],true),['a','c']);
  assert.deepEqual(resolveLightIds(lights,['a','b'],false),['a']);
  assert.throws(() => resolveLightIds(lights,['b'],false), /No selected lights/);
  assert.deepEqual(resolveLightIds(new Map(),[],true,true),[]);
});
