import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OWNER = 'HALCONDEORO';
const API = 'https://api.github.com';

// No token: only anonymous public repository metadata is requested.
export async function fetchRepos(fetchImpl = fetch) {
  const repos = [];
  for (let page = 1; ; page++) {
    const url = `${API}/users/${OWNER}/repos?type=owner&per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Public GitHub API returned ${response.status} on page ${page}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('Invalid repository response');
    repos.push(...batch);
    if (batch.length < 100) return repos;
  }
}

export function metrics(repos) {
  const seen = new Set();
  const own = repos.filter(repo => {
    if (repo.owner?.login?.toLowerCase() !== OWNER.toLowerCase() || repo.private !== false ||
        repo.fork !== false || (repo.visibility !== undefined && repo.visibility !== 'public')) return false;
    if (!Number.isSafeInteger(repo.id) || typeof repo.name !== 'string' ||
        !Number.isSafeInteger(repo.stargazers_count) || repo.stargazers_count < 0 ||
        !Number.isSafeInteger(repo.forks_count) || repo.forks_count < 0 ||
        (repo.pushed_at !== null && (typeof repo.pushed_at !== 'string' || !Number.isFinite(Date.parse(repo.pushed_at))))) {
      throw new Error('Invalid public repository metadata');
    }
    if (seen.has(repo.id)) return false;
    seen.add(repo.id);
    return true;
  });
  return {
    repositories: own.length,
    stars: own.reduce((sum, repo) => sum + repo.stargazers_count, 0),
    forks: own.reduce((sum, repo) => sum + repo.forks_count, 0),
    recent: own.filter(repo => repo.pushed_at !== null).sort((a, b) => b.pushed_at.localeCompare(a.pushed_at) || a.name.localeCompare(b.name)).slice(0, 4),
  };
}

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export function renderSvg(data, timestamp) {
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('Invalid timestamp');
  const recent = data.recent.map((repo, index) =>
    `<text x="24" y="${152 + index * 24}">${escapeXml(repo.name)} · ${escapeXml(repo.pushed_at.slice(0, 10))}</text>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="296" viewBox="0 0 480 296" role="img" aria-labelledby="title desc">
<title id="title">Public GitHub repository statistics</title>
<desc id="desc">${data.repositories} public original repositories owned by ${OWNER}; ${data.stars} stars received; ${data.forks} forks received. Recent projects ordered by last push. Retrieved ${escapeXml(timestamp)}.</desc>
<rect width="480" height="296" rx="12" fill="#101923"/>
<g fill="#e5eaf0" font-family="ui-monospace,monospace" font-size="14">
<text x="24" y="36" font-size="16">PUBLIC REPOSITORIES / ${OWNER}</text>
<text x="24" y="78">${data.repositories} original repos</text>
<text x="190" y="78">${data.stars} stars received</text>
<text x="338" y="78">${data.forks} forks received</text>
<path d="M24 100H456" stroke="#344453"/>
<text x="24" y="128" font-size="12" fill="#aebdca">RECENT PROJECTS · LAST PUSH (UTC)</text>
${recent}
<text x="24" y="272" font-size="11" fill="#aebdca">Retrieved ${escapeXml(timestamp)} · public API · forks excluded</text>
</g></svg>\n`;
}

// Fetch and render fully before touching the previous artifact; rename is atomic.
export async function generate({ fetchImpl = fetch, output = resolve('assets/stats.svg'), now = () => new Date() } = {}) {
  const data = metrics(await fetchRepos(fetchImpl));
  const svg = renderSvg(data, now().toISOString());
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, svg, 'utf8');
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generate().then(data => console.log(`Updated public stats: ${data.repositories} repositories`)).catch(error => {
    console.error(`Stats update failed; last good artifact preserved: ${error.message}`);
    process.exitCode = 1;
  });
}
