import { dtls } from 'node-dtls-client';

export function entertainmentAreas(resources) {
  const lights = new Map();
  for (const light of resources.filter(r => r.type === 'light' && r.owner?.rid && /^\/lights\/\d+$/.test(r.id_v1 || ''))) {
    const owner = light.owner.rid;
    lights.set(owner, [...(lights.get(owner) || []), `hue:${light.id_v1.split('/').at(-1)}`]);
  }
  const services = new Map(resources.filter(r => r.type === 'entertainment').map(r => [r.id, lights.get(r.owner?.rid)]));
  return resources.filter(r => r.type === 'entertainment_configuration').map(area => ({
    id:area.id, name:area.metadata?.name || area.name || 'Entertainment area', status:area.status,
    channels:(area.channels || []).map(channel => ({ id:channel.channel_id, lights:[...new Set((channel.members || []).flatMap(member => services.get(member.service?.rid) || [undefined]))] }))
  }));
}

export function selectEntertainmentArea(areas, ids) {
  const selected = new Set(ids);
  return areas.filter(area => area.status === 'inactive' && /^[0-9a-f-]{36}$/i.test(area.id) && area.channels.length && area.channels.every(channel => Number.isInteger(channel.id) && channel.id >= 0 && channel.id <= 255 && channel.lights.length && channel.lights.every(id => selected.has(id))))
    .sort((a,b) => b.channels.length - a.channels.length)[0] || null;
}

export function entertainmentSelection(ids, knownHueIds, includeAll) {
  if (!includeAll || !ids.some(id => id.startsWith('hue:'))) return ids;
  return [...new Set([...ids, ...knownHueIds])];
}

export function hueStreamFrame(area, colors, brightness, sequence = 0) {
  const header = Buffer.concat([Buffer.from('HueStream'), Buffer.from([2,0,sequence & 255,0,0,0,0]), Buffer.from(area.id, 'ascii')]);
  const channels = area.channels.map(channel => {
    const color = colors.get(channel.lights[0]) || [0,0,0];
    const data = Buffer.alloc(7); data[0] = channel.id;
    for (let i=0; i<3; i++) data.writeUInt16BE(Math.round(color[i] * 257 * brightness / 100), 1+i*2);
    return data;
  });
  return Buffer.concat([header, ...channels]);
}

export function interpolateColors(from, to, amount) {
  const t = Math.max(0, Math.min(1, amount));
  return new Map([...to].map(([id, color]) => [id, color.map((value, i) => (from.get(id) || color)[i] * (1 - t) + value * t)]));
}

export class HueEntertainment {
  constructor(request, createSocket = options => dtls.createSocket(options)) {
    this.request = request;
    this.createSocket = createSocket;
    this.area = null;
    this.socket = null;
    this.timer = null;
    this.frame = null;
    this.motion = null;
    this.sequence = 0;
    this.warning = '';
    this.connected = false;
    this.socketFailed = false;
  }

  async start(config, ids) {
    await this.stop();
    this.warning = '';
    if (!config?.clientkey || !config?.username || !ids.some(id => id.startsWith('hue:'))) return;
    try {
      const resources = await this.request(config, '/clip/v2/resource');
      const area = selectEntertainmentArea(entertainmentAreas(resources.data || []), ids);
      if (!area) { this.warning = 'No inactive Hue Entertainment area matches the selected lights.'; return; }
      await this.request(config, `/clip/v2/resource/entertainment_configuration/${area.id}`, 'PUT', { action:'start' });
      this.area = area;
      this.config = config;
      const socket = this.createSocket({ type:'udp4', address:config.ip, port:2100, psk:{ [config.username]:Buffer.from(config.clientkey, 'hex') }, ciphers:['TLS_PSK_WITH_AES_128_GCM_SHA256'], timeout:10000 });
      this.socket = socket;
      this.socketFailed = false;
      await new Promise((resolve, reject) => { socket.once('connected', resolve); socket.once('error', error => { this.socketFailed = true; reject(error); }); socket.once('close', () => { this.socketFailed = true; reject(new Error('Hue Entertainment connection closed.')); }); });
      this.connected = true;
      socket.on('error', error => { this.socketFailed = true; this.warning = `Hue Entertainment: ${error.message}`; this.stop().catch(() => {}); });
      socket.on('close', () => { if (this.socket === socket) { this.socketFailed = true; this.warning = 'Hue Entertainment connection closed.'; this.stop().catch(() => {}); } });
    } catch (error) {
      this.warning = `Hue Entertainment: ${error.message}`;
      await this.stop();
    }
  }

  update(ids, colors, brightness, transitionMs = 0) {
    if (!this.area || !this.socket) return new Set();
    const streamed = new Set(this.area.channels.flatMap(channel => channel.lights));
    if (!this.connected) return streamed;
    const byId = new Map(ids.map((id, i) => [id, colors[i]]));
    const now = Date.now();
    const target = new Map([...byId].map(([id, color]) => [id, color.map(value => value * brightness / 100)]));
    const current = this.motion ? interpolateColors(this.motion.from, this.motion.to, this.motion.duration ? (now - this.motion.started) / this.motion.duration : 1) : target;
    this.motion = { from:current, to:target, started:now, duration:transitionMs };
    this.frame = transitionMs ? hueStreamFrame(this.area, current, 100, this.sequence++) : hueStreamFrame(this.area, byId, brightness, this.sequence++);
    this.socket.send(this.frame, error => { if (error) { this.warning = `Hue Entertainment: ${error.message}`; this.stop().catch(() => {}); } });
    if (!this.timer) this.timer = setInterval(() => {
      if (!this.frame || !this.socket) return;
      if (this.motion?.duration) this.frame = hueStreamFrame(this.area, interpolateColors(this.motion.from, this.motion.to, (Date.now() - this.motion.started) / this.motion.duration), 100, this.sequence++);
      this.socket.send(this.frame, () => {});
    }, 40);
    return streamed;
  }

  async stop() {
    clearInterval(this.timer); this.timer = null; this.frame = null; this.motion = null;
    const socket = this.socket, area = this.area, config = this.config, failed = this.socketFailed;
    this.socket = null; this.area = null; this.config = null; this.connected = false;
    if (socket && !failed) { try { socket.close(); } catch {} }
    if (area && config) { try { await this.request(config, `/clip/v2/resource/entertainment_configuration/${area.id}`, 'PUT', { action:'stop' }); } catch {} }
  }
}
