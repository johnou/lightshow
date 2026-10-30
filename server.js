import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const configPath = fileURLToPath(new URL('./.lightshow.json', import.meta.url));
const port = Number(process.env.PORT || 4177);
let config = {};
try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch {}
const govee = new Map();
let hueLights = new Map();
const origins = new Set(['https://johnou.github.io', 'https://just.johno.it', `http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const isPrivateIp = ip => isIP(ip) === 4 && (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
function hueRequest(ip, path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: ip, path, method, rejectUnauthorized: false, timeout: 5000, headers: { 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; if (data.length > 1_000_000) req.destroy(); });
      res.on('end', () => { try { const result = JSON.parse(data); const error = Array.isArray(result) && result.find(x => x.error); if (error) reject(new Error(error.error.description)); else resolve(result); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('Hue Bridge timed out'))); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function refreshHue() {
  if (!config.hue?.ip || !config.hue?.username) return [];
  const lights = await hueRequest(config.hue.ip, `/api/${config.hue.username}/lights`);
  hueLights = new Map(Object.entries(lights).map(([id, light]) => [`hue:${id}`, { id: `hue:${id}`, name: light.name, brand: 'Hue', reachable: light.state.reachable, color: Boolean(light.state.xy || light.state.hue !== undefined) }]));
  return [...hueLights.values()];
}
function scanGovee() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true }); let finished = false;
    const done = error => { if (finished) return; finished = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve([...govee.values()]); };
    const timer = setTimeout(() => done(), 2200);
    socket.on('error', done);
    socket.on('message', (packet, remote) => { try { const { msg } = JSON.parse(packet.toString()); if (msg.cmd !== 'scan' || !msg.data?.device || !isPrivateIp(remote.address)) return; const d = msg.data; govee.set(`govee:${d.device}`, { id: `govee:${d.device}`, name: `Govee ${d.sku || 'light'} · ${d.device.slice(-5)}`, brand: 'Govee', ip: remote.address, reachable: true, color: true }); } catch {} });
    socket.bind(4002, () => { socket.setMulticastTTL(2); const payload = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } })); socket.send(payload, 4001, '239.255.255.250', error => { if (error) done(error); }); });
  });
}
function sendGovee(ip, cmd, data) { return new Promise((resolve, reject) => { const socket = dgram.createSocket('udp4'); const payload = Buffer.from(JSON.stringify({ msg: { cmd, data } })); socket.send(payload, 4003, ip, error => { socket.close(); error ? reject(error) : resolve(); }); }); }
function rgbToHue([r, g, b]) { r /= 255; g /= 255; b /= 255; const max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max-min; let h = 0; if (delta) { if (max === r) h = ((g-b)/delta)%6; else if (max === g) h = (b-r)/delta+2; else h = (r-g)/delta+4; h = (h*60+360)%360; } return { hue: Math.round(h/360*65535), sat: max ? Math.round(delta/max*254) : 0 }; }
async function setLight(light, rgb, brightness) {
  if (light.brand === 'Hue') { const state = { on: true, bri: Math.max(1, Math.round(brightness*2.54)), transitiontime: 8 }; if (light.color) Object.assign(state, rgbToHue(rgb)); await hueRequest(config.hue.ip, `/api/${config.hue.username}/lights/${encodeURIComponent(light.id.slice(4))}/state`, 'PUT', state); }
  else { await sendGovee(light.ip, 'turn', { value: 1 }); await sendGovee(light.ip, 'brightness', { value: brightness }); await sendGovee(light.ip, 'colorwc', { color: { r: rgb[0], g: rgb[1], b: rgb[2] }, colorTemInKelvin: 0 }); }
}
async function bodyOf(req) { let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 16_384) throw new Error('Request too large'); } return JSON.parse(data || '{}'); }
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !origins.has(origin)) return json(res, 403, { error: 'Origin not allowed' });
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Private-Network', 'true'); }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') { let hue = []; let hueError = ''; try { hue = await refreshHue(); } catch (error) { hueError = error.message; } return json(res, 200, { lights: [...hue, ...govee.values()], paired: !!config.hue, hueError }); }
    if (url.pathname === '/api/hue/pair' && req.method === 'POST') { const { ip, username } = await bodyOf(req); if (!isPrivateIp(ip)) throw new Error('Enter a private IPv4 address for your Bridge.'); if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{10,128}$/.test(username)) throw new Error('Enter an existing authorized Bridge username.'); await hueRequest(ip, `/api/${username}/lights`); config.hue = { ip, username }; await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); return json(res, 200, { lights: await refreshHue() }); }
    if (url.pathname === '/api/govee/scan' && req.method === 'POST') return json(res, 200, { lights: await scanGovee() });
    if (url.pathname === '/api/show' && req.method === 'POST') { const { ids, colors, brightness } = await bodyOf(req); if (!Array.isArray(ids) || ids.length > 100 || !Array.isArray(colors) || colors.length !== ids.length || !Number.isInteger(brightness) || brightness < 1 || brightness > 100 || colors.some(c => !Array.isArray(c) || c.length !== 3 || c.some(v => !Number.isInteger(v) || v < 0 || v > 255))) throw new Error('Invalid show request.'); const all = new Map([...hueLights, ...govee]); if (ids.some(id => !all.has(id))) throw new Error('A selected light is no longer available. Refresh your lights.'); const results = await Promise.allSettled(ids.map((id, i) => setLight(all.get(id), colors[i], brightness))); const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message); return json(res, errors.length ? 502 : 200, { sent: ids.length-errors.length, errors }); }
    if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); const path = resolve(root, '.' + pathname); if (!path.startsWith(root + sep)) return json(res, 403, { error: 'Forbidden' }); const data = await readFile(path); const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' }[extname(path)] || 'application/octet-stream'; res.writeHead(200, { 'Content-Type': mime }); res.end(data);
  } catch (error) { json(res, 400, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Lightshow companion running at http://localhost:${port}`));
