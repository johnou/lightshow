import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoveeStream, goveeStreamPacket } from '../govee-stream.js';

function harness(sendOverride) {
  const calls=[]; let tick, stops=0;
  const send=async (ip,cmd,data) => { calls.push({ip,cmd,data}); if (sendOverride) await sendOverride(ip,cmd,data); };
  const manager=new GoveeStream(send, { wait:async () => {}, startTimer:(fn,ms) => { assert.equal(ms,100); tick=fn; return 0; }, stopTimer:id => { assert.equal(id,0); tick=null; stops++; } });
  return { calls,manager,tick:() => tick?.(),get stops(){ return stops; } };
}
const a={id:'govee:a',ip:'192.168.1.55'}, b={id:'govee:b',ip:'192.168.1.54'};
const black = new Map([[a.id,[0,0,0]]]);

test('encodes one-pixel Razer frames with the expected header and XOR', () => {
  const frame=goveeStreamPacket([0,255,0]);
  assert.equal(frame.toString('hex'),'bb00fab0000100ff000f');
  assert.equal(frame.reduce((a,b) => a ^ b,0),0);
});

test('starts each bulb once, coalesces colors, streams a bounded frame and restores on stop', async () => {
  const h=harness(); await h.manager.start([a,b],60);
  assert.deepEqual(h.manager.status(),{running:true,submitted:[a.id,b.id],failures:[]});
  for (const light of [a,b]) {
    assert.deepEqual(h.calls.filter(call => call.ip===light.ip).map(call => [call.cmd,call.data]),[
      ['turn',{value:1}],['brightness',{value:60}],['razer',{pt:'uwABsQEK'}]
    ]);
  }
  h.manager.update(new Map([[a.id,[255,0,0]],[b.id,[0,255,0]]]),20);
  h.manager.update(new Map([[a.id,[0,0,255]],[b.id,[255,120,0]]]),50);
  await h.manager.flush();
  const byIp=ip => h.calls.filter(call => call.ip===ip);
  const aFrame=Buffer.from(byIp(a.ip).at(-1).data.pt,'base64');
  assert.deepEqual([...aFrame.subarray(6,9)],[0,0,255]);
  const bFrame=Buffer.from(byIp(b.ip).at(-1).data.pt,'base64');
  assert.deepEqual([...bFrame.subarray(6,9)],[255,120,0]);
  await h.manager.reconcile([a,b],50);
  assert.equal(h.calls.filter(call=>call.data.pt==='uwABsQEK').length,2);
  await h.manager.stop();
  assert.equal(h.stops,1);
  assert.deepEqual(byIp(a.ip).slice(-3).map(call=>[call.cmd,call.data]),[
    ['razer',{pt:'uwABsQAL'}],['brightness',{value:50}],['colorwc',{color:{r:0,g:0,b:255},colorTemInKelvin:0}]
  ]);
  const total=h.calls.length; h.tick(); await h.manager.flush(); assert.equal(h.calls.length,total);
});

test('stopping before any frame resets the initialization brightness', async () => {
  const h=harness(); await h.manager.start([a],35); await h.manager.stop();
  assert.deepEqual(h.calls.slice(-2).map(call=>[call.cmd,call.data]),[['razer',{pt:'uwABsQAL'}],['brightness',{value:35}]]);
});

test('selection and IP changes release old sessions before starting replacements', async () => {
  const h=harness(); await h.manager.start([a,b],100); h.manager.update(new Map([[a.id,[3,4,5]],[b.id,[6,7,8]]]),50); await h.manager.flush();
  const moved={...a,ip:'192.168.1.90'}; await h.manager.reconcile([moved],40);
  assert.deepEqual(h.manager.status().submitted,[a.id]);
  assert.equal(h.calls.filter(call=>call.ip===a.ip&&call.data.pt==='uwABsQAL').length,1);
  assert.equal(h.calls.filter(call=>call.ip===b.ip&&call.data.pt==='uwABsQAL').length,1);
  const lastOld=h.calls.findLastIndex(call=>call.ip===a.ip);
  const firstNew=h.calls.findIndex(call=>call.ip===moved.ip);
  assert.ok(lastOld<firstNew);
  await h.manager.stop();
});

test('waits for a pending datagram before releasing the bulb', async () => {
  let release; let block=false;
  const h=harness((_ip,_cmd,data) => block && data.pt!== 'uwABsQAL' ? new Promise(resolve => {release=resolve;}) : undefined);
  await h.manager.start([a],60); h.manager.update(black,60); block=true;
  const pending=h.manager.flush(); let stopped=false; const stopping=h.manager.stop().then(()=>{stopped=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stopped,false); assert.equal(h.calls.some(call=>call.data.pt==='uwABsQAL'),false);
  block=false; release(); await pending; await stopping;
  assert.equal(stopped,true); assert.equal(h.calls.filter(call=>call.data.pt==='uwABsQAL').length,1);
});

test('warns about send errors without claiming that UDP delivery is verified', async () => {
  let fail=false; const warnings=[];
  const h=harness((_ip,_cmd,data) => { if (fail && data.pt!=='uwABsQAL') throw new Error('network unavailable'); });
  h.manager.onWarning=warning=>warnings.push(warning);
  await h.manager.start([a],60); h.manager.update(black,60); fail=true;
  await h.manager.flush(); await h.manager.flush();
  assert.equal(warnings.length,1); assert.match(h.manager.status().failures[0].message,/network unavailable/);
  fail=false; await h.manager.flush(); assert.deepEqual(h.manager.status().failures,[]); await h.manager.stop();
});

test('rolls back brightness when stream activation fails', async () => {
  const h=harness((_ip,_cmd,data) => { if (data.pt==='uwABsQEK') throw new Error('unreachable'); });
  await h.manager.start([a],45);
  assert.deepEqual(h.manager.status().submitted,[]);
  assert.deepEqual(h.calls.slice(-2).map(call=>[call.cmd,call.data]),[['razer',{pt:'uwABsQAL'}],['brightness',{value:45}]]);
  assert.match(h.manager.status().failures[0].message,/unreachable/);
  await h.manager.stop();
});

test('serializes stop requested while a bulb is warming up', async () => {
  let release; let delays=0;
  const h=harness(); h.manager.wait=() => ++delays===1 ? new Promise(resolve=>{release=resolve;}) : Promise.resolve();
  const starting=h.manager.start([a],50); await new Promise(resolve=>setImmediate(resolve));
  const stopping=h.manager.stop(); release(); await starting; await stopping;
  assert.equal(h.manager.status().running,false);
  assert.deepEqual(h.calls.map(call=>call.cmd),['turn','brightness','razer','razer','brightness']);
  assert.equal(h.calls.at(-2).data.pt,'uwABsQAL');
});

test('rejects duplicates and invalid frames before mutating state', async () => {
  const h=harness(); await assert.rejects(h.manager.start([a,{...a}],50),/unique/); assert.equal(h.calls.length,0);
  await h.manager.start([a],50);
  assert.throws(()=>h.manager.update(new Map([[a.id,[256,0,0]]]),50),/Invalid/);
  await h.manager.stop();
});
