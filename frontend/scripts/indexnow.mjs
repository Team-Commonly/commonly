// IndexNow (F428, D295): tells Bing and the other IndexNow engines which commonly.me URLs
// changed, right after a deploy, instead of waiting for a crawl. ChatGPT search finds pages
// largely through Bing, and we had no Bing presence at all.
//
// The key is public by design: IndexNow proves we own the host by finding this same value at
// https://commonly.me/<key>.txt, which generate-seo-pages.mjs writes into the build.
//
// Deploy Dev runs this after the release is verified:
//   node frontend/scripts/indexnow.mjs --before <sitemap fetched before the deploy> --key-was-live <0|1>
// It reads the now-live sitemap and posts the URLs that are new or whose lastmod changed. If the
// key file was not live before this deploy, IndexNow has never heard from us, so it posts every
// URL once. It always exits 0: a failed ping must never fail a deploy.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INDEXNOW_HOST = 'commonly.me';
export const INDEXNOW_KEY = 'commonly-indexnow-20261111';
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
export const indexNowKeyFile = () => `${INDEXNOW_KEY}.txt`;
const KEY_LOCATION = `https://${INDEXNOW_HOST}/${indexNowKeyFile()}`;
// IndexNow takes at most 10,000 URLs per request.
const MAX_URLS = 10000;

/** loc -> lastmod ('' when the entry has none), from sitemap XML. */
export const parseSitemap = (xml = '') => {
  const entries = new Map();
  for (const [, body] of String(xml).matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = body.match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1];
    if (!loc) continue;
    entries.set(loc, body.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1] || '');
  }
  return entries;
};

/**
 * The URLs to announce: every URL when IndexNow has not seen us yet (the key was not live), else
 * the URLs that are new since `before` or whose lastmod moved. Only URLs on our host are kept,
 * since IndexNow rejects a batch with a foreign URL in it.
 */
export const changedUrls = ({ beforeXml = '', afterXml = '', keyWasLive = true }) => {
  const before = parseSitemap(beforeXml);
  const after = parseSitemap(afterXml);
  const ownHost = (url) => {
    try {
      return new URL(url).host === INDEXNOW_HOST;
    } catch {
      return false;
    }
  };
  // A before-sitemap we couldn't read means we can't tell what changed; send everything.
  const sendAll = !keyWasLive || before.size === 0;
  return [...after.entries()]
    .filter(([loc, lastmod]) => sendAll || !before.has(loc) || before.get(loc) !== lastmod)
    .map(([loc]) => loc)
    .filter(ownHost);
};

export const indexNowPayload = (urls) => ({
  host: INDEXNOW_HOST,
  key: INDEXNOW_KEY,
  keyLocation: KEY_LOCATION,
  urlList: urls.slice(0, MAX_URLS),
});

/** POST the batch. Returns a one-line verdict; never throws. */
export const pingIndexNow = async (urls, { fetchImpl = globalThis.fetch } = {}) => {
  if (urls.length === 0) return { ok: true, status: null, sent: 0, note: 'no changed URLs; nothing sent' };
  try {
    const response = await fetchImpl(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(indexNowPayload(urls)),
      signal: AbortSignal.timeout(20000),
    });
    const sent = Math.min(urls.length, MAX_URLS);
    // 200 and 202 both mean accepted (202: the key is still being checked).
    const ok = response.status === 200 || response.status === 202;
    return { ok, status: response.status, sent, note: ok ? 'accepted' : 'rejected' };
  } catch (error) {
    return { ok: false, status: null, sent: 0, note: `request failed: ${error.message}` };
  }
};

const fetchText = async (url, fetchImpl) => {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
};

const argValue = (argv, name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

/** The deploy step. Logs one line per outcome and resolves to that outcome; never rejects. */
export const runAfterDeploy = async ({ argv = process.argv, fetchImpl = globalThis.fetch, log = console.log } = {}) => {
  const site = `https://${INDEXNOW_HOST}`;
  // Cache-busted: Cloudflare can hold the old copy for a while after a deploy.
  const bust = `?indexnow=${Date.now()}`;
  try {
    // IndexNow checks the key file before it accepts anything, so make sure this release serves it.
    const served = (await fetchText(`${KEY_LOCATION}${bust}`, fetchImpl)).trim();
    if (served !== INDEXNOW_KEY) {
      log(`[indexnow] skipped: ${KEY_LOCATION} does not serve the key yet`);
      return { ok: false, sent: 0, note: 'key file not served' };
    }
    const beforePath = argValue(argv, '--before');
    const beforeXml = beforePath ? await readFile(beforePath, 'utf8').catch(() => '') : '';
    const keyWasLive = argValue(argv, '--key-was-live') === '1';
    const afterXml = await fetchText(`${site}/sitemap.xml${bust}`, fetchImpl);
    const urls = changedUrls({ beforeXml, afterXml, keyWasLive });
    const result = await pingIndexNow(urls, { fetchImpl });
    const scope = !keyWasLive ? 'first run, every URL' : 'changed URLs';
    log(`[indexnow] ${result.note}: ${result.sent} of ${parseSitemap(afterXml).size} sitemap URLs (${scope})`
      + `${result.status ? `, HTTP ${result.status}` : ''}`);
    return result;
  } catch (error) {
    log(`[indexnow] skipped: ${error.message}`);
    return { ok: false, sent: 0, note: error.message };
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAfterDeploy().finally(() => {
    process.exitCode = 0;
  });
}
