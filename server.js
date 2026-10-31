import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ShowRunner } from './show-runner.js';
import { MusicPlayer } from './music-player.js';
import { SystemAudio } from './system-audio.js';
import { BeatDetector } from './beat-detector.js';
import { ensureMacHelpers, mediaKey } from './mac-helpers.js';
import { normalizeMusicURL } from './youtube-links.js';
import { availableLightIds, resolveLightIds } from './light-selection.js';
import { networkInterfaces, tmpdir } from 'node:os';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { isIP } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const dataRoot = process.env.LIGHTSHOW_DATA_DIR ? resolve(process.env.LIGHTSHOW_DATA_DIR) : fileURLToPath(new URL('.', import.meta.url));
const configPath = join(dataRoot, '.lightshow.json');
const goveePath = join(dataRoot, '.lightshow-govee.json');
const musicLinksPath = join(dataRoot, '.lightshow-music-links.json');
const port = Number(process.env.PORT || 4177);
const lanEnabled = process.env.LIGHTSHOW_LAN === '1';
const lanAddresses = Object.values(networkInterfaces()).flat().filter(x => x && x.family === 'IPv4' && !x.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.address)).map(x => x.address);
const accessCode = process.env.LIGHTSHOW_CODE || randomBytes(9).toString('base64url');
const sessionToken = randomBytes(32).toString('base64url');
let loginAttempts = [];

let config = {};
try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch {}
const govee = new Map();
let knownGovee = [];
try { knownGovee = JSON.parse(await readFile(goveePath, 'utf8')); } catch {}
let hueLights = new Map();
let musicLinks = [];
try { const links = JSON.parse(await readFile(musicLinksPath, 'utf8')); if (Array.isArray(links)) musicLinks = links.filter(link => link && typeof link.id === 'string' && typeof link.name === 'string' && typeof link.url === 'string').slice(0, 100); } catch {}
let musicLinkOperation = Promise.resolve();
const origins = new Set(['https://johnou.github.io', 'https://just.johno.it', `http://localhost:${port}`, `http://127.0.0.1:${port}`]);
const isPrivateIp = ip => isIP(ip) === 4 && (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
knownGovee = Array.isArray(knownGovee) ? knownGovee.filter(d => d && typeof d.id === 'string' && d.id.startsWith('govee:') && typeof d.name === 'string' && isPrivateIp(d.ip)).slice(0, 100) : [];
for (const light of knownGovee) govee.set(light.id, { ...light, brand: 'Govee', reachable: false, color: true });
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
let scanInFlight;
function scanGovee() {
  if (!scanInFlight) scanInFlight = scanGoveeInner().finally(() => { scanInFlight = undefined; });
  return scanInFlight;
}
function scanGoveeInner() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true }); let finished = false;
    const seen = new Set();
    const retryTimers = [];
    const done = async error => {
      if (finished) return; finished = true; clearTimeout(timer); for (const retry of retryTimers) clearTimeout(retry); socket.close();
      if (error) return reject(error);
      for (const light of govee.values()) light.reachable = seen.has(light.id);
      try { await writeFile(goveePath, JSON.stringify([...govee.values()]), { mode: 0o600 }); resolve([...govee.values()]); } catch (err) { reject(err); }
    };
    const timer = setTimeout(() => done(), 3000);
    socket.on('error', done);
    socket.on('message', (packet, remote) => {
      try {
        const { msg } = JSON.parse(packet.toString());
        if (!isPrivateIp(remote.address)) return;
        if (msg.cmd === 'scan' && msg.data?.device) {
          const d = msg.data;
          const old = [...govee.values()].find(light => light.ip === remote.address);
          if (old && old.id !== `govee:${d.device}`) govee.delete(old.id);
          seen.add(`govee:${d.device}`);
          govee.set(`govee:${d.device}`, { id: `govee:${d.device}`, name: `Govee ${d.sku || 'light'} · ${d.device.slice(-5)}`, brand: 'Govee', ip: remote.address, reachable: true, color: true });
        } else if (msg.cmd === 'devStatus' && msg.data) {
          const known = [...govee.values()].find(light => light.ip === remote.address);
          if (known) { seen.add(known.id); govee.set(known.id, { ...known, reachable: true }); }
        }
      } catch {}
    });
    socket.bind(4002, () => {
      socket.setMulticastTTL(2);
      const payload = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
      socket.send(payload, 4001, '239.255.255.250', error => { if (error) done(error); });
      const status = Buffer.from(JSON.stringify({ msg: { cmd: 'devStatus', data: {} } }));
      const checkKnown = () => { if (!finished) for (const light of govee.values()) socket.send(status, 4003, light.ip, () => {}); };
      checkKnown(); retryTimers.push(setTimeout(checkKnown, 700), setTimeout(checkKnown, 1400));
    });
  });
}
function sendGovee(ip, cmd, data) { return new Promise((resolve, reject) => { const socket = dgram.createSocket('udp4'); const payload = Buffer.from(JSON.stringify({ msg: { cmd, data } })); socket.send(payload, 4003, ip, error => { socket.close(); error ? reject(error) : resolve(); }); }); }
function rgbToHue([r, g, b]) { r /= 255; g /= 255; b /= 255; const max = Math.max(r,g,b), min = Math.min(r,g,b), delta = max-min; let h = 0; if (delta) { if (max === r) h = ((g-b)/delta)%6; else if (max === g) h = (b-r)/delta+2; else h = (r-g)/delta+4; h = (h*60+360)%360; } return { hue: Math.round(h/360*65535), sat: max ? Math.round(delta/max*254) : 0 }; }
async function setLight(light, rgb, brightness, reactive = false) {
  if (light.brand === 'Hue') { const state = { on: true, bri: Math.max(1, Math.round(brightness*2.54)), transitiontime: reactive ? 1 : 8 }; if (light.color) Object.assign(state, rgbToHue(rgb)); await hueRequest(config.hue.ip, `/api/${config.hue.username}/lights/${encodeURIComponent(light.id.slice(4))}/state`, 'PUT', state); }
  else { await sendGovee(light.ip, 'turn', { value: 1 }); await new Promise(resolve => setTimeout(resolve, 50)); await sendGovee(light.ip, 'brightness', { value: brightness }); await new Promise(resolve => setTimeout(resolve, 50)); await sendGovee(light.ip, 'colorwc', { color: { r: rgb[0], g: rgb[1], b: rgb[2] }, colorTemInKelvin: 0 }); }
}
let sleepGuard, availableRefreshTimer, uploadedMusic, musicDir, audioLevel = 0, lastAudioSample = 0, lastAudibleSample = 0, lastAppliedBeat = 0, appliedBeats = 0, showWarnings = [];
let showRunner;
const detectedBeat = () => { if (showRunner?.beat()) { lastAppliedBeat = Date.now(); appliedBeats++; } };
let beatDetector = new BeatDetector(detectedBeat);
const audioSample = level => { audioLevel = level; lastAudioSample = Date.now(); if (level > 0.03) lastAudibleSample = lastAudioSample; beatDetector.feed(level); };
function showStatus() { return { ...showRunner.status(), warnings:showWarnings, audio: { level:audioLevel, lastSampleAgeMs:lastAudioSample ? Date.now()-lastAudioSample : null, lastSoundAgeMs:lastAudibleSample ? Date.now()-lastAudibleSample : null, lastBeatAgeMs:lastAppliedBeat ? Date.now()-lastAppliedBeat : null, beats:appliedBeats } }; }
const audioFailure = message => { if (showRunner) changeShow(() => showRunner.fail(message)); };
const musicPlayer = new MusicPlayer(audioFailure, audioSample);
const systemAudio = new SystemAudio(audioSample, audioFailure);
async function sendShowFrame(ids, colors, brightness, reactive) {
  const all = new Map([...hueLights, ...govee]);
  const results = await Promise.allSettled(ids.map(async (id, i) => {
    const light = all.get(id);
    if (!light) throw new Error(`A selected light is no longer available: ${id}`);
    return setLight(light, colors[i], brightness, reactive);
  }));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
  showWarnings = errors;
}
showRunner = new ShowRunner(sendShowFrame, { energy: () => audioLevel, onStop: () => { musicPlayer.stop(); systemAudio.stop(); clearTimeout(availableRefreshTimer); showWarnings = []; audioLevel = 0; lastAudioSample = 0; lastAudibleSample = 0; lastAppliedBeat = 0; appliedBeats = 0; if (sleepGuard) { sleepGuard.kill(); sleepGuard = null; } } });
let showOperation = Promise.resolve();
function changeShow(operation) {
  const result = showOperation.then(operation);
  showOperation = result.catch(() => {});
  return result;
}
function validateShow(data, allowEmpty = false) {
  const { ids, palette, scene, pace, brightness, musicSync, musicSource } = data;
  const includeAll = data.includeAll === true;
  const all = new Map([...hueLights, ...govee]);
  const resolvedIds = resolveLightIds(all, ids, includeAll, allowEmpty);
  if (!Array.isArray(palette) || !palette.length || palette.length > 32 || palette.some(color => !Array.isArray(color) || color.length !== 3 || color.some(value => !Number.isInteger(value) || value < 0 || value > 255))) throw new Error('Invalid scene colors.');
  if (typeof scene !== 'string' || scene.length > 80 || !Number.isInteger(pace) || pace < 1000 || pace > 60000 || !Number.isInteger(brightness) || brightness < 1 || brightness > 100 || typeof musicSync !== 'boolean' || !['none','file','system'].includes(musicSource) || (musicSync && musicSource === 'none')) throw new Error('Invalid show settings.');
  return { ids:resolvedIds, palette, scene, pace, brightness, musicSync, musicSource, includeAll, musicName: musicSource === 'file' ? uploadedMusic?.name || '' : '' };
}
function reconcileAvailableLights(generation = showRunner.generation) {
  const current = showRunner.status();
  if (!current.running || !current.includeAll || showRunner.generation !== generation) return;
  showRunner.update({ ids:availableLightIds(new Map([...hueLights, ...govee])) });
}
function scheduleAvailableRefresh(delay = 30000) {
  clearTimeout(availableRefreshTimer);
  const show = showRunner.status();
  if (!show.running || !show.includeAll) return;
  const generation = showRunner.generation;
  availableRefreshTimer = setTimeout(async () => {
    await Promise.allSettled([refreshHue(), scanGovee()]);
    await changeShow(() => reconcileAvailableLights(generation));
    if (showRunner.generation === generation) scheduleAvailableRefresh();
  }, delay);
}
async function audioBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('Audio file must be 64 MB or smaller.'); chunks.push(chunk); }
  if (!size) throw new Error('Choose an audio file.');
  return Buffer.concat(chunks);
}
process.on('exit', () => { musicPlayer.stop(); systemAudio.stop(); if (musicDir) { try { rmSync(musicDir, { recursive:true, force:true }); } catch {} } });
async function bodyOf(req) { let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 16_384) throw new Error('Request too large'); } return JSON.parse(data || '{}'); }
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const hostnames = new Set([`localhost:${port}`, `127.0.0.1:${port}`, ...lanAddresses.map(ip => `${ip}:${port}`)]);
  if (!hostnames.has(host)) return json(res, 403, { error: 'Host not allowed' });
  const localOrigin = `http://${host}`;
  const isLanHost = !host.startsWith('localhost:') && !host.startsWith('127.0.0.1:');
  const isLoopback = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1' || req.socket.remoteAddress === '::1';
  if (!isLoopback && !isLanHost) return json(res, 403, { error: 'Host not allowed' });
  if (origin && origin !== localOrigin && !(!isLanHost && origins.has(origin))) return json(res, 403, { error: 'Origin not allowed' });
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Private-Network', 'true'); }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!lanEnabled || !isLanHost || origin !== localOrigin || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: 'Login unavailable' });
      const now = Date.now(); loginAttempts = loginAttempts.filter(time => now - time < 60000);
      if (loginAttempts.length >= 10) return json(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      loginAttempts.push(now);
      const { code } = await bodyOf(req);
      const candidate = Buffer.from(typeof code === 'string' ? code : '');
      const expected = Buffer.from(accessCode);
      if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return json(res, 401, { error: 'Incorrect connection code.' });
      loginAttempts = [];
      res.setHeader('Set-Cookie', `lightshow_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
      return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/') && isLanHost) {
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(item => item.trim().split('=')));
      if (!lanEnabled || cookies.lightshow_session !== sessionToken) return json(res, 401, { error: 'Connection code required', loginRequired: true });
      if (req.method !== 'GET' && origin !== localOrigin) return json(res, 403, { error: 'Origin not allowed' });
    }
    if (url.pathname === '/api/status' && req.method === 'GET') { let hue = []; let hueError = ''; try { hue = await refreshHue(); } catch (error) { hueError = error.message; } return json(res, 200, { lights: [...hue, ...govee.values()], paired: !!config.hue, hueError, show: showStatus() }); }
    if (url.pathname === '/api/show/status' && req.method === 'GET') return json(res, 200, showStatus());
    if (url.pathname === '/api/hue/pair' && req.method === 'POST') { const { ip, username } = await bodyOf(req); if (!isPrivateIp(ip)) throw new Error('Enter a private IPv4 address for your Bridge.'); if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{10,128}$/.test(username)) throw new Error('Enter an existing authorized Bridge username.'); await hueRequest(ip, `/api/${username}/lights`); config.hue = { ip, username }; await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); return json(res, 200, { lights: await refreshHue() }); }
    if (url.pathname === '/api/govee/scan' && req.method === 'POST') { const lights = await scanGovee(); await changeShow(() => reconcileAvailableLights()); return json(res, 200, { lights }); }
    if (url.pathname === '/api/music' && req.method === 'POST') {
      if (showRunner.status().running) throw new Error('Stop the current show before changing its soundtrack.');
      const ext = url.searchParams.get('ext');
      if (!['mp3','m4a','aac','wav','aif','aiff','caf','flac'].includes(ext)) throw new Error('Choose an MP3, M4A, AAC, WAV, AIFF, CAF, or FLAC file.');
      const audio = await audioBody(req);
      if (!musicDir) musicDir = await mkdtemp(join(tmpdir(), 'lightshow-music-'));
      const path = join(musicDir, `track-${randomBytes(8).toString('hex')}.${ext}`);
      await writeFile(path, audio, { mode:0o600 });
      if (uploadedMusic) await rm(uploadedMusic.path, { force:true });
      uploadedMusic = { path, name:(url.searchParams.get('name') || 'Soundtrack').slice(0, 120) };
      return json(res, 200, { name:uploadedMusic.name });
    }
    if (url.pathname === '/api/music/links' && req.method === 'GET') return json(res, 200, { links:musicLinks });
    if (url.pathname === '/api/music/links' && req.method === 'POST') {
      const { name, link } = await bodyOf(req); const normalized = normalizeMusicURL(link);
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Add a name of up to 80 characters.');
      const operation = musicLinkOperation.then(async () => { if (musicLinks.length >= 100) throw new Error('You can save up to 100 links.'); const entry = { id:randomBytes(12).toString('hex'), name:name.trim(), url:normalized }; const updated = [...musicLinks, entry]; await writeFile(musicLinksPath, JSON.stringify(updated), { mode:0o600 }); musicLinks = updated; return entry; });
      musicLinkOperation = operation.catch(() => {}); return json(res, 200, { link:await operation });
    }
    if (url.pathname === '/api/music/links/remove' && req.method === 'POST') {
      const { id } = await bodyOf(req);
      const operation = musicLinkOperation.then(async () => { if (!musicLinks.some(link => link.id === id)) throw new Error('Saved link not found.'); const updated = musicLinks.filter(link => link.id !== id); await writeFile(musicLinksPath, JSON.stringify(updated), { mode:0o600 }); musicLinks = updated; });
      musicLinkOperation = operation.catch(() => {}); await operation; return json(res, 200, { ok:true });
    }
    if (url.pathname === '/api/music/open' && req.method === 'POST') {
      const { link } = await bodyOf(req); const normalized = normalizeMusicURL(link);
      if (process.platform !== 'darwin') throw new Error('Opening YouTube Music on the Mac requires macOS.');
      const open = args => new Promise((resolve, reject) => { const child = spawn('/usr/bin/open', args, { stdio:'ignore' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Could not open YouTube Music.'))); });
      try { await open(['-a', 'YouTube Music', normalized]); } catch { await open([normalized]); }
      return json(res, 200, { ok:true });
    }
    if (url.pathname === '/api/media' && req.method === 'POST') {
      const { action } = await bodyOf(req);
      if (action === 'open') {
        if (process.platform !== 'darwin') throw new Error('YouTube Music controls require macOS.');
        await new Promise((resolve, reject) => { const child=spawn('/usr/bin/open', ['https://music.youtube.com'], { stdio:'ignore' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Could not open YouTube Music on the Mac.'))); });
      } else {
        if (!['playpause','next','previous'].includes(action)) throw new Error('Unknown media action.');
        const helpers = await ensureMacHelpers(); await mediaKey(helpers.media, action, helpers.mediaArgs);
      }
      return json(res, 200, { ok:true });
    }
    if (url.pathname === '/api/show/start' && req.method === 'POST') { const requested = await bodyOf(req); return json(res, 200, await changeShow(async () => {
      if (requested.includeAll === true) await Promise.allSettled([refreshHue(), scanGovee()]);
      const settings = validateShow(requested);
      if (settings.musicSource === 'file' && !uploadedMusic) throw new Error('Choose a soundtrack first.');
      let helpers;
      if (settings.musicSource === 'system' && settings.musicSync) helpers = await ensureMacHelpers();
      await showRunner.start(settings); beatDetector = new BeatDetector(detectedBeat);
      try {
        if (settings.musicSource === 'file') await musicPlayer.start(uploadedMusic.path, settings.musicSync);
        if (settings.musicSource === 'system' && settings.musicSync) await systemAudio.start(helpers.audio, helpers.audioArgs);
        if (!showRunner.status().running) throw new Error(showRunner.status().error || 'The show stopped while starting.');
      } catch (error) { await showRunner.fail(error.message); throw error; }
      if (process.platform === 'darwin') { sleepGuard = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio:'ignore' }); sleepGuard.on('error', () => {}); }
      scheduleAvailableRefresh(1000);
      return showRunner.status();
    })); }
    if (url.pathname === '/api/show/update' && req.method === 'POST') { const settings = validateShow(await bodyOf(req), true); return json(res, 200, await changeShow(() => { const current = showRunner.status(); if (settings.musicSource !== current.musicSource || settings.musicSync !== current.musicSync) throw new Error('Stop the show before changing its soundtrack settings.'); const status = showRunner.update(settings); scheduleAvailableRefresh(1000); return status; })); }
    if (url.pathname === '/api/show/stop' && req.method === 'POST') return json(res, 200, await changeShow(() => showRunner.stop()));
    if (url.pathname === '/api/show' && req.method === 'POST') { const { ids, colors, brightness } = await bodyOf(req); if (!Array.isArray(ids) || ids.length > 100 || !Array.isArray(colors) || colors.length !== ids.length || !Number.isInteger(brightness) || brightness < 1 || brightness > 100 || colors.some(c => !Array.isArray(c) || c.length !== 3 || c.some(v => !Number.isInteger(v) || v < 0 || v > 255))) throw new Error('Invalid show request.'); const all = new Map([...hueLights, ...govee]); if (ids.some(id => !all.has(id))) throw new Error('A selected light is no longer available. Refresh your lights.'); const results = await Promise.allSettled(ids.map((id, i) => setLight(all.get(id), colors[i], brightness))); const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message); return json(res, errors.length ? 502 : 200, { sent: ids.length-errors.length, errors }); }
    if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); const path = resolve(root, '.' + pathname); if (!path.startsWith(root + sep)) return json(res, 403, { error: 'Forbidden' }); const data = await readFile(path); const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' }[extname(path)] || 'application/octet-stream'; res.writeHead(200, { 'Content-Type': mime }); res.end(data);
  } catch (error) { json(res, 400, { error: error.message }); }
});
server.listen(port, lanEnabled ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Lightshow companion running at http://localhost:${port}`);
  if (lanEnabled) {
    for (const ip of lanAddresses) console.log(`Phone on your Wi-Fi: http://${ip}:${port}`);
    console.log(`Connection code: ${accessCode}`);
  }
});

async function shutdown() {
  server.close();
  await changeShow(() => showRunner.stop());
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
