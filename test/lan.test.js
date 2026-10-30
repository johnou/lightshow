import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { networkInterfaces } from 'node:os';

test('LAN controls require a session and reject other origins', async t => {
  const address = Object.values(networkInterfaces()).flat().find(x => x && x.family === 'IPv4' && !x.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.address))?.address;
  if (!address) return t.skip('No private network interface');
  const port = 4188;
  const server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), LIGHTSHOW_LAN:'1', LIGHTSHOW_CODE:'test-code-123' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('exit', code => reject(new Error(`Server exited ${code}`))); setTimeout(() => reject(new Error('Server did not start')), 5000).unref(); });
  const url = `http://127.0.0.1:${port}`;
  const request = (url, options) => new Promise((resolve, reject) => {
    const req = http.request(url, { method:options.method || 'GET', headers:options.headers }, res => {
      res.resume(); res.on('end', () => resolve({ status:res.statusCode, headers:{ get: name => res.headers[name] } }));
    });
    req.on('error', reject); req.end(options.body);
  });
  const origin = `http://${address}:${port}`;
  const headers = { Host: `${address}:${port}`, Origin: origin, 'Content-Type':'application/json' };
  let response = await request(url + '/api/status', { headers });
  assert.equal(response.status, 401);
  response = await request(url + '/api/login', { method:'POST', headers, body:JSON.stringify({code:'wrong'}) });
  assert.equal(response.status, 401);
  response = await request(url + '/api/login', { method:'POST', headers:{ ...headers, Origin:'https://example.com' }, body:JSON.stringify({code:'test-code-123'}) });
  assert.equal(response.status, 403);
  response = await request(url + '/api/login', { method:'POST', headers, body:JSON.stringify({code:'test-code-123'}) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')[0].split(';')[0];
  response = await request(url + '/api/show', { method:'POST', headers:{ ...headers, Cookie:cookie }, body:'{}' });
  assert.equal(response.status, 400);
  response = await request(url + '/api/show', { method:'POST', headers:{ ...headers, Cookie:cookie, Origin:'https://example.com' }, body:'{}' });
  assert.equal(response.status, 403);
});
