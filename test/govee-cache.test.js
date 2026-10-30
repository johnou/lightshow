import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

test('remembered Govee devices load as unavailable until they respond', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lightshow-govee-test-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  await writeFile(join(dir, '.lightshow-govee.json'), JSON.stringify([
    { id:'govee:test', name:'Test bulb', ip:'192.168.1.2', reachable:true },
    { id:'govee:invalid', name:'Invalid bulb', ip:'8.8.8.8', reachable:true }
  ]));
  const port=4187;
  const server=spawn(process.execPath,['server.js'],{env:{...process.env, PORT:String(port),LIGHTSHOW_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  t.after(() => server.kill());
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',code=>reject(new Error(`Server exited ${code}`)));setTimeout(()=>reject(new Error('Server did not start')),5000).unref();});
  const response=await fetch(`http://127.0.0.1:${port}/api/status`);
  const { lights }=await response.json();
  assert.equal(lights.length,1);
  assert.equal(lights[0].name,'Test bulb');
  assert.equal(lights[0].reachable,false);
});
