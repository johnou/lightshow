import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMusicURL } from '../youtube-links.js';
test('normalizes songs and playlists to YouTube Music without tracking parameters', () => {
  assert.equal(normalizeMusicURL('https://youtu.be/abcdefghijk?si=secret'), 'https://music.youtube.com/watch?v=abcdefghijk');
  assert.equal(normalizeMusicURL('https://music.youtube.com/playlist?list=PLabc123&si=foo'), 'https://music.youtube.com/playlist?list=PLabc123');
  assert.equal(normalizeMusicURL('https://www.youtube.com/watch?v=abcdefghijk&list=PLabc'), 'https://music.youtube.com/watch?v=abcdefghijk&list=PLabc');
});
test('rejects unrelated hosts, malformed links and unsupported paths', () => {
  for (const url of ['https://youtube.com.attacker.invalid/watch?v=abc','http://music.youtube.com/watch?v=abc','https://music.youtube.com/redirect?url=x','https://music.youtube.com/watch?v=abc%2Fdef','https://music.youtube.com/']) assert.throws(() => normalizeMusicURL(url));
});
