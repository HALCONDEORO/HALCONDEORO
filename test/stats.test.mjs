import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchRepos, metrics, renderSvg, generate, escapeXml } from '../scripts/stats.mjs';
const fixture = JSON.parse(await readFile(new URL('./fixtures/repos.json', import.meta.url)));
const ok = data => ({ ok: true, json: async () => data });

test('pagination requests every page, including an empty terminal page', async () => {
  const urls = [];
  const result = await fetchRepos(async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, undefined);
    return ok(urls.length === 1 ? Array(100).fill(fixture[0]) : []);
  });
  assert.equal(result.length, 100);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /type=owner&per_page=100&page=2$/);
});
test('forks are excluded from every metric and recent projects', () => {
  const result = metrics([fixture[0], fixture[2]]);
  assert.deepEqual([result.repositories, result.stars, result.forks], [1, 7, 3]);
  assert.equal(result.recent[0].name, 'original');
});
test('ownership, visibility and duplicate filtering; recent ordering', () => {
  const result = metrics([...fixture, fixture[0]]);
  assert.deepEqual([result.repositories, result.stars, result.forks], [2, 9, 4]);
  assert.deepEqual(result.recent.map(repo => repo.id), [2, 1]);
});
test('invalid metrics fail instead of manufacturing zeros', () => {
  assert.throws(() => metrics([{ ...fixture[0], stargazers_count: null }]), /Invalid/);
});
test('empty repositories count toward metrics but have no recent push', () => {
  const result = metrics([{ ...fixture[0], pushed_at: null }]);
  assert.deepEqual([result.repositories, result.stars, result.forks], [1, 7, 3]);
  assert.deepEqual(result.recent, []);
});
test('recent projects are capped at four', () => {
  assert.equal(metrics(Array.from({ length: 6 }, (_, i) => ({ ...fixture[0], id: i }))).recent.length, 4);
});
test('API failure on a later page preserves last-good artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profile-stats-'));
  const output = join(dir, 'stats.svg');
  try {
    await writeFile(output, 'last-good');
    let calls = 0;
    await assert.rejects(generate({ output, fetchImpl: async () => ++calls === 1 ? ok(Array(100).fill(fixture[0])) : { ok: false, status: 403 } }), /403/);
    assert.equal(await readFile(output, 'utf8'), 'last-good');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('network and malformed API failures propagate', async () => {
  await assert.rejects(fetchRepos(async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(fetchRepos(async () => ok({})), /Invalid/);
});
test('successful generation uses actual injected retrieval time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'profile-stats-'));
  try {
    const output = join(dir, 'stats.svg');
    await generate({ output, fetchImpl: async () => ok(fixture), now: () => new Date('2026-02-03T04:05:06Z') });
    assert.match(await readFile(output, 'utf8'), /2026-02-03T04:05:06.000Z/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('SVG has accessible title, namespace, safe text and no external content', () => {
  const svg = renderSvg(metrics(fixture), '2026-02-03T04:05:06Z');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(svg, /aria-labelledby="title desc"/);
  assert.match(svg, /newer&lt;&amp;/);
  assert.doesNotMatch(svg, /<script|<foreignObject|href=|<image|onload=/i);
  assert.match(svg, /<\/svg>\n$/);
  assert.equal(escapeXml('<>&"\'\u0000'), '&lt;&gt;&amp;&quot;&apos;');
  assert.throws(() => renderSvg(metrics(fixture), 'invalid'), /timestamp/);
});
