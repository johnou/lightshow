import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { entertainmentAreas, selectEntertainmentArea, entertainmentSelection, hueStreamFrame, interpolateColors, HueEntertainment } from '../hue-entertainment.js';

const areaId = '12345678-1234-1234-1234-123456789abc';
const resources = [
  { type:'light', id:'light-1', id_v1:'/lights/7', owner:{ rid:'device-1' } },
  { type:'light', id:'light-2', id_v1:'/lights/8', owner:{ rid:'device-2' } },
  { type:'entertainment', id:'service-1', owner:{ rid:'device-1' } },
  { type:'entertainment', id:'service-2', owner:{ rid:'device-2' } },
  { type:'entertainment_configuration', id:areaId, status:'inactive', metadata:{name:'Living room'}, channels:[
    { channel_id:0, members:[{service:{rid:'service-1'}}] },
    { channel_id:1, members:[{service:{rid:'service-2'}}] }
  ] }
];
const credentials={ ip:'192.168.1.37', username:'username', clientkey:'00112233445566778899aabbccddeeff' };

test('maps channels to Hue lights and never streams an area containing unselected lights', () => {
  const areas=entertainmentAreas(resources);
  assert.deepEqual(areas[0].channels.map(channel => channel.lights), [['hue:7'],['hue:8']]);
  assert.equal(selectEntertainmentArea(areas,['hue:7']),null);
  assert.equal(selectEntertainmentArea(areas,['hue:7','hue:8']).name,'Living room');
  const unknown=structuredClone(resources); unknown.at(-1).channels[0].members[0].service.rid='unknown';
  assert.equal(selectEntertainmentArea(entertainmentAreas(unknown),['hue:7','hue:8']),null);
});
test('all-lights mode includes known offline Hue members; manual selection remains exact', () => {
  assert.deepEqual(entertainmentSelection(['hue:7','govee:1'],['hue:7','hue:8'],true),['hue:7','govee:1','hue:8']);
  assert.deepEqual(entertainmentSelection(['hue:7'],['hue:7','hue:8'],false),['hue:7']);
  assert.deepEqual(entertainmentSelection(['govee:1'],['hue:7','hue:8'],true),['govee:1']);
});

test('encodes HueStream v2 RGB channels and brightness', () => {
  const area=entertainmentAreas(resources)[0];
  const frame=hueStreamFrame(area,new Map([['hue:7',[255,0,64]],['hue:8',[0,255,0]]]),50,3);
  assert.equal(frame.subarray(0,9).toString(),'HueStream');
  assert.deepEqual([...frame.subarray(9,16)],[2,0,3,0,0,0,0]);
  assert.equal(frame.subarray(16,52).toString(),areaId);
  assert.equal(frame[52],0); assert.equal(frame.readUInt16BE(53),32768); assert.equal(frame.readUInt16BE(57),8224);
  assert.equal(frame[59],1); assert.equal(frame.readUInt16BE(62),32768);
});
test('interpolates a transition without overshooting its target', () => {
  const from=new Map([['hue:7',[0,100,200]]]), to=new Map([['hue:7',[200,0,100]]]);
  assert.deepEqual(interpolateColors(from,to,0.5).get('hue:7'),[100,50,150]);
  assert.deepEqual(interpolateColors(from,to,2).get('hue:7'),[200,0,100]);
});

test('starts, streams to the selected lights, and releases the area', async () => {
  const actions=[], packets=[]; let options;
  const request=async (_config,path,method,body) => { if (!method) return { data:resources }; actions.push(body.action); return { data:[] }; };
  const socket=new EventEmitter(); socket.send=(frame,cb) => { packets.push(frame); cb?.(); }; socket.close=() => socket.emit('close');
  const stream=new HueEntertainment(request, value => { options=value; setImmediate(() => socket.emit('connected')); return socket; });
  await stream.start(credentials,['hue:7','hue:8','govee:one']);
  assert.equal(options.port,2100); assert.deepEqual(options.psk.username,Buffer.from(credentials.clientkey,'hex'));
  assert.deepEqual([...stream.update(['hue:7','hue:8','govee:one'],[[255,0,0],[0,255,0],[0,0,255]],75)],['hue:7','hue:8']);
  assert.equal(packets.length,1); assert.deepEqual(actions,['start']);
  await stream.stop(); assert.deepEqual(actions,['start','stop']); assert.equal(stream.area,null);
});
test('streams intermediate colors during an immersive transition and stops the timer', async () => {
  const packets=[]; const request=async (_config,_path,method) => method ? {data:[]} : {data:resources};
  const socket=new EventEmitter(); socket.send=(frame,cb) => { packets.push(Buffer.from(frame)); cb?.(); }; socket.close=() => socket.emit('close');
  const stream=new HueEntertainment(request, () => { setImmediate(() => socket.emit('connected')); return socket; });
  await stream.start(credentials,['hue:7','hue:8']);
  stream.update(['hue:7','hue:8'],[[0,0,0],[0,0,0]],100);
  stream.update(['hue:7','hue:8'],[[255,0,0],[0,0,0]],100,160);
  await sleep(85);
  const middle=packets.at(-1).readUInt16BE(53);
  assert.ok(middle>0 && middle<65535, `expected an intermediate value, got ${middle}`);
  await sleep(120);
  assert.equal(packets.at(-1).readUInt16BE(53),65535);
  await stream.stop(); const count=packets.length; await sleep(60); assert.equal(packets.length,count);
});

test('releases the area and falls back when the DTLS handshake fails', async () => {
  const actions=[]; const request=async (_config,_path,method,body) => { if (!method) return { data:resources }; actions.push(body.action); return { data:[] }; };
  const socket=new EventEmitter(); socket.close=() => socket.emit('close');
  const stream=new HueEntertainment(request, () => { setImmediate(() => socket.emit('error',new Error('handshake failed'))); return socket; });
  await stream.start(credentials,['hue:7','hue:8']);
  assert.match(stream.warning,/handshake failed/); assert.deepEqual(actions,['start','stop']);
  assert.equal(stream.area,null);
});

test('keepalive frames advance sequence and report asynchronous send failures', async () => {
  const packets=[], actions=[];
  const request=async (_config,_path,method,body) => { if (!method) return {data:resources}; actions.push(body.action); return {data:[]}; };
  const socket=new EventEmitter();
  let sendError=null;
  socket.send=(frame,callback) => { packets.push(Buffer.from(frame)); callback?.(sendError); };
  socket.close=() => socket.emit('close');
  const stream=new HueEntertainment(request, () => { setImmediate(() => socket.emit('connected')); return socket; });
  try {
    await stream.start(credentials,['hue:7','hue:8']);
    stream.update(['hue:7','hue:8'],[[255,0,0],[0,255,0]],50);
    await sleep(95);
    assert.ok(packets.length >= 3);
    for(let i=1;i<packets.length;i++) {
      assert.equal(packets[i][11],(packets[i-1][11]+1)&255);
      assert.deepEqual(packets[i].subarray(52),packets[0].subarray(52));
    }
    sendError=new Error('UDP send failed');
    await sleep(60);
    assert.match(stream.warning,/UDP send failed/);
    assert.equal(stream.area,null);
    assert.equal(stream.timer,null);
    assert.deepEqual(actions,['start','stop']);
  } finally { await stream.stop(); }
});
