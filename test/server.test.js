import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const port = 4189;
const base = `http://127.0.0.1:${port}`;
let server, dataDir;
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lightshow-test-'));
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), LIGHTSHOW_DATA_DIR:dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('exit', code => reject(new Error(`Server exited ${code}`))); setTimeout(() => reject(new Error('Server did not start')), 5000).unref(); });
});
after(async () => { server?.kill(); await rm(dataDir, { recursive:true, force:true }); });
test('serves the app and reports device status', async () => {
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Make room for/);
  const status = await fetch(`${base}/api/status`); assert.equal(status.status, 200); assert.ok(Array.isArray((await status.json()).lights));
});
test('rejects untrusted origins and invalid device requests', async () => {
  const badOrigin = await fetch(`${base}/api/status`, { headers: { Origin: 'https://example.com' } }); assert.equal(badOrigin.status, 403);
  const badPair = await fetch(`${base}/api/hue/pair`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ip:'8.8.8.8' }) }); assert.equal(badPair.status, 400);
  const badShow = await fetch(`${base}/api/show`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ids:['hue:99'], colors:[[255,0,0]], brightness:50 }) }); assert.equal(badShow.status, 400);
});
test('provides install icons', async () => { for (const size of [192, 512]) { const response = await fetch(`${base}/icon-${size}.png`); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); } });

test('show controls validate input and expose stopped state', async () => {
  const status = await fetch(`${base}/api/status`);
  assert.equal((await status.json()).show.running, false);
  const start = await fetch(`${base}/api/show/start`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ ids:[], palette:[[1,2,3]], scene:'test', pace:1500, brightness:50, musicSync:false, musicSource:'none' }) });
  assert.equal(start.status, 400);
  const stop = await fetch(`${base}/api/show/stop`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}' });
  assert.equal(stop.status, 200);
  assert.equal((await stop.json()).running, false);
  const upload = await fetch(`${base}/api/music?ext=exe`, { method:'POST', headers:{ 'Content-Type':'application/octet-stream' }, body:'invalid' });
  assert.equal(upload.status, 400);
});
