export function normalizeMusicURL(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Enter a YouTube Music song or playlist link.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter a valid YouTube Music link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use an HTTPS YouTube Music link.');
  const allowed = new Set(['music.youtube.com', 'www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be']);
  if (!allowed.has(url.hostname)) throw new Error('Use a YouTube or YouTube Music link.');
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  let video = url.searchParams.get('v'), list = url.searchParams.get('list');
  if (url.hostname === 'youtu.be') video = url.pathname.slice(1);
  const browse = url.pathname.match(/^\/browse\/([A-Za-z0-9_-]{1,128})\/?$/);
  if (browse && url.hostname === 'music.youtube.com') return `https://music.youtube.com/browse/${browse[1]}`;
  if (video && !validId(video) || list && !validId(list)) throw new Error('Invalid song or playlist link.');
  if (url.hostname !== 'youtu.be' && !['/watch','/playlist'].includes(url.pathname)) throw new Error('Use a song, album, or playlist link.');
  if (!video && !list) throw new Error('The link does not contain a song or playlist.');
  const result = new URL(video ? 'https://music.youtube.com/watch' : 'https://music.youtube.com/playlist');
  if (video) result.searchParams.set('v', video);
  if (list) result.searchParams.set('list', list);
  return result.href;
}
