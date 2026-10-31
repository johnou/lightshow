import { spawn } from 'node:child_process';
import { mkdir, stat, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const directory = join(root, '.lightshow-tools');
let building;
export function ensureMacHelpers() {
  if (process.env.LIGHTSHOW_APP_EXECUTABLE) return Promise.resolve({ audio:process.env.LIGHTSHOW_APP_EXECUTABLE, audioArgs:['--capture-audio'], media:process.env.LIGHTSHOW_APP_EXECUTABLE, mediaArgs:['--media'] });
  if (process.platform !== 'darwin') return Promise.reject(new Error('Mac audio and media controls require macOS.'));
  if (!building) building = build().finally(() => { building = null; });
  return building;
}
async function build() {
  await mkdir(directory, { recursive:true });
  for (const name of ['system-audio', 'media-key']) {
    const source = join(root, 'macos', `${name}.swift`), target = join(directory, name);
    const src = await stat(source); let out;
    try { out = await stat(target); } catch {}
    if (out && out.mtimeMs >= src.mtimeMs) continue;
    const temporary = `${target}.${process.pid}.tmp`, temporarySource = `${target}.${process.pid}.swift`;
    try {
      const entry = name === 'system-audio' ? '\nrunSystemAudio()\n' : '\nguard CommandLine.arguments.count == 2 else { exit(2) }\nrunMediaKey(CommandLine.arguments[1])\n';
      await writeFile(temporarySource, (await readFile(source, 'utf8')) + entry);
      await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/swiftc', ['-swift-version','5','-O',temporarySource,'-o',temporary], { stdio:['ignore','ignore','pipe'] });
        let errors = ''; child.stderr.on('data', chunk => { errors += chunk.toString(); });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Could not build Mac audio helper. ${errors.slice(-500)}`)));
      });
      await rename(temporary, target);
    } finally { await rm(temporary, { force:true }); await rm(temporarySource, { force:true }); }
  }
  return { audio:join(directory, 'system-audio'), media:join(directory, 'media-key') };
}
export function mediaKey(binary, action, args = []) {
  return new Promise((resolve, reject) => {
    const child=spawn(binary,[...args, action],{stdio:['ignore','ignore','pipe']}); let errors='';
    child.stderr.on('data', chunk => { errors += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(errors.trim() || 'Could not send the media command.')));
  });
}
