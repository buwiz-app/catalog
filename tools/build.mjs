#!/usr/bin/env node
// Builds catalog.json from sources.json by reading each plugin's own files on
// GitHub at a resolved commit. Node 22, no dependencies.
//
//   node tools/build.mjs             rebuild and write catalog.json
//   node tools/build.mjs --check     rebuild and fail if catalog.json differs
//   node tools/build.mjs --validate  schema-check the committed catalog.json (no network)
//
// GITHUB_TOKEN, when set, is sent to api.github.com (rate limits).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validate, validateText, serialize, ID_RE, REPO_RE, LIMITS, safePath } from './validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'catalog.json');
const SOURCES = path.join(ROOT, 'sources.json');
const TOKEN = process.env.GITHUB_TOKEN || '';
const LOGO_MAX = 1024 * 1024;
const LOGO_EXT = /\.(png|svg|jpe?g|webp|gif)$/i;

// OSI-approved licenses the build accepts (SPDX ids).
export const OSI = new Set([
  '0BSD', 'AFL-3.0', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Apache-2.0', 'Artistic-2.0', 'BSD-2-Clause', 'BSD-3-Clause',
  'BSL-1.0', 'CDDL-1.0', 'EPL-1.0', 'EPL-2.0', 'EUPL-1.2', 'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only',
  'GPL-3.0-or-later', 'ISC', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'MIT', 'MIT-0', 'MPL-2.0', 'MS-PL', 'NCSA', 'OSL-3.0', 'PostgreSQL', 'UPL-1.0', 'Unlicense', 'Zlib',
]);

// The Bot's resolver order (rox-broker hub/market/resolve.rs).
const MANIFEST_RANK = ['.buwiz-plugin/', '.cursor-plugin/', '.claude-plugin/', '.grok-plugin/', '.codex-plugin/', '.plugin/'];
const MANIFEST_RE = /(^|\/)(?:\.[a-z0-9]+-plugin\/|\.plugin\/)?plugin\.json$/;
const MARKET_RE = /(^|\/)(?:\.[a-z0-9]+-plugin|\.agents\/plugins|\.github\/plugin|\.plugin)\/marketplace\.json$/;
const SKIP_RE = /(^|\/)(node_modules|test|tests|fixtures|examples?)\//;
const NO_REDISTRIBUTION = /\b(?:may|must|shall|can)\s*not\s+(?:be\s+)?redistribut|\bredistribution\s+(?:is\s+)?(?:not\s+permitted|prohibited|forbidden)|\bdo\s+not\s+redistribute/i;

const rankOf = (f) => {
  const i = MANIFEST_RANK.findIndex((m) => f.includes(m));
  return i < 0 ? MANIFEST_RANK.length : i;
};

// ---------- paths ----------

export function clean(p) {
  const parts = [];
  for (const s of String(p).split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(s);
  }
  return parts.join('/');
}

const join = (a, b) => clean(a ? `${a}/${b}` : b);
const dirname = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');

export function pluginDirOf(manifest) {
  const d = dirname(manifest);
  return /(^|\/)\.(?:[a-z0-9]+-)?plugin$/.test(d) ? dirname(d) : d;
}

// ---------- text helpers ----------

const str = (v) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim() : null);
const https = (v) => {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password && s.length <= LIMITS.url ? s : null;
  } catch {
    return null;
  }
};
const cut = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');

export function frontmatter(md) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(md || '');
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[kv[1]] = v;
  }
  return out;
}

// A README's first `# ` heading, if it is plain text.
export function readmeTitle(md) {
  for (const line of (md || '').split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return /[<>\[\]()!`*_]/.test(m[1]) ? null : m[1];
  }
  return null;
}

// SPDX id from a license file's text (the common OSI licenses only).
export function detectLicense(text) {
  const t = (text || '').slice(0, 4000);
  if (/Apache License,?\s+Version 2\.0/i.test(t) || /Licensed under the Apache License, Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/^\s*MIT License/i.test(t) || /Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return 'MIT';
  if (/Mozilla Public License,?\s+(Version|v\.)\s*2\.0/i.test(t)) return 'MPL-2.0';
  if (/ISC License/i.test(t)) return 'ISC';
  if (/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i.test(t)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/i.test(t)) return 'LGPL-3.0';
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 3/i.test(t)) return 'GPL-3.0';
  if (/GNU GENERAL PUBLIC LICENSE\s+Version 2/i.test(t)) return 'GPL-2.0';
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return 'Unlicense';
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name|names of its contributors/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  return null;
}

// ---------- GitHub ----------

async function get(url, { json = true, api = false } = {}) {
  const headers = { 'User-Agent': 'buwiz-catalog-build' };
  if (api) {
    headers.Accept = 'application/vnd.github+json';
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  }
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers });
    if (r.status === 404) return null;
    if (r.ok) return json ? r.json() : r.text();
    if (attempt < 3 && (r.status >= 500 || r.status === 429)) {
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`GET ${url}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

const api = (p) => get(`https://api.github.com/${p}`, { api: true });
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const rawUrl = (full, sha, file) => `https://raw.githubusercontent.com/${full}/${sha}/${enc(file)}`;

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// A repository at a ref: its canonical name, commit, files and a reader.
async function openRepo(repo, ref) {
  if (!REPO_RE.test(repo)) throw new Error(`${repo}: not https://github.com/<owner>/<repo>`);
  const name = repo.slice('https://github.com/'.length);
  const meta = await api(`repos/${name}`);
  if (!meta) throw new Error(`${repo}: not found`);
  const full = meta.full_name;
  const commit = await api(`repos/${full}/commits/${encodeURIComponent(ref || meta.default_branch)}`);
  if (!commit) throw new Error(`${repo}: ref ${ref} not found`);
  const sha = commit.sha;
  const tree = await api(`repos/${full}/git/trees/${sha}?recursive=1`);
  if (tree.truncated) throw new Error(`${repo}: tree too large for the GitHub API`);
  const sizes = new Map(tree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.size]));
  const cache = new Map();
  const read = (f) => {
    if (!sizes.has(f)) return Promise.resolve(null);
    if (!cache.has(f)) cache.set(f, get(rawUrl(full, sha, f), { json: false }));
    return cache.get(f);
  };
  const readJson = async (f) => {
    try {
      return JSON.parse((await read(f)) ?? 'null');
    } catch {
      return null;
    }
  };
  return {
    repo: `https://github.com/${full}`,
    full,
    owner: meta.owner.login,
    sha,
    date: commit.commit.committer.date,
    spdx: meta.license?.spdx_id && meta.license.spdx_id !== 'NOASSERTION' ? meta.license.spdx_id : null,
    files: [...sizes.keys()].sort(),
    sizes,
    read,
    readJson,
  };
}

// ---------- what a plugin ships (mirrors resolve.rs mcpOf / skillsOf) ----------

const looksLikeServer = (v) => v && typeof v === 'object' && !Array.isArray(v) && (str(v.url) || str(v.command));

function takeServers(j, into) {
  if (!j || typeof j !== 'object') return;
  let s = j.mcpServers || (j.mcp && typeof j.mcp === 'object' ? j.mcp : null);
  if (!s && Object.values(j).some(looksLikeServer)) s = j;
  if (s && typeof s === 'object' && !Array.isArray(s)) for (const [k, v] of Object.entries(s)) if (looksLikeServer(v)) into.add(k);
}

async function serversOf(r, dir, manifest, inline) {
  const out = new Set();
  if (inline && typeof inline === 'object') takeServers({ mcpServers: inline }, out);
  const decl = manifest?.mcpServers;
  if (decl && typeof decl === 'object' && !Array.isArray(decl)) takeServers(manifest, out);
  else {
    for (const p of [].concat(decl ?? []).filter((x) => typeof x === 'string')) {
      const f = join(dir, p);
      if (f !== null) takeServers(await r.readJson(f), out);
    }
  }
  if (!out.size) {
    for (const f of ['mcp.json', '.mcp.json']) {
      takeServers(await r.readJson(dir ? `${dir}/${f}` : f), out);
      if (out.size) break;
    }
  }
  return [...out];
}

async function skillsOf(r, dir, manifest) {
  const roots = [].concat(manifest?.skills ?? []).filter((x) => typeof x === 'string').map((p) => join(dir, p)).filter((x) => x !== null);
  if (!roots.length) roots.push(dir ? `${dir}/skills` : 'skills');
  const found = [];
  for (const root of roots) {
    const pre = root ? `${root}/` : '';
    for (const f of r.files) {
      if (!f.startsWith(pre) || !/(^|\/)SKILL\.md$/i.test(f)) continue;
      const rest = f.slice(pre.length).split('/');
      if (rest.length === 2) found.push([rest[0], f]);
      else if (rest.length === 1 && root) found.push([root.split('/').pop(), f]);
    }
  }
  const names = await pool(found, 8, async ([dirName, f]) => str(frontmatter(await r.read(f)).name) || dirName);
  return [...new Set(names.map((n) => cut(n, LIMITS.itemName)))];
}

// ---------- one catalog entry ----------

function licenseOf(v) {
  const s = str(v);
  if (!s) return null;
  if (OSI.has(s)) return s;
  const hit = [...OSI].find((x) => x.toLowerCase() === s.toLowerCase());
  return hit || null;
}

async function licenseFile(r, dir) {
  const f = r.files.find((x) => dirname(x) === dir && /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(x.split('/').pop()));
  return f ? detectLicense(await r.read(f)) : null;
}

// Throws {skip: reason} when the plugin can't be listed.
export async function entryOf(r, dir, mkt = null, mktOwner = null) {
  const manifestFiles = r.files
    .filter((f) => MANIFEST_RE.test(f) && !SKIP_RE.test(f) && pluginDirOf(f) === dir)
    .sort((a, b) => rankOf(a) - rankOf(b) || (a < b ? -1 : 1));
  const manifests = (await Promise.all(manifestFiles.map((f) => r.readJson(f)))).filter((m) => m && typeof m === 'object' && !Array.isArray(m));
  const top = manifests[0] ?? null;
  const all = [...manifests, ...(mkt ? [mkt] : [])];
  const first = (pick) => {
    for (const m of all) {
      const v = pick(m);
      if (v) return v;
    }
    return null;
  };
  const generated = [];

  const readme = r.files.find((f) => dirname(f) === dir && /^readme\.md$/i.test(f.split('/').pop()));
  const readmeText = readme ? await r.read(readme) : null;
  if (readmeText && NO_REDISTRIBUTION.test(readmeText)) throw { skip: 'its README restricts redistribution' };

  const pluginName = first((m) => str(m.name));
  const id = slug(pluginName || dir.split('/').pop() || r.full.split('/')[1]);
  if (!ID_RE.test(id)) throw { skip: `no usable id (${JSON.stringify(pluginName)})` };

  const license =
    first((m) => licenseOf(m.license)) ||
    (await licenseFile(r, dir)) ||
    licenseOf(r.spdx) ||
    (dir !== '' ? await licenseFile(r, '') : null);
  if (!license) {
    const declared = first((m) => str(m.license)) || r.spdx;
    throw { skip: declared ? `license ${declared} is not on the OSI list` : 'no license' };
  }

  const name = cut(first((m) => str(m.displayName)) || readmeTitle(readmeText) || pluginName || id, LIMITS.name);

  let description = first((m) => str(m.description));
  if (!description) {
    description = `Plugin from ${r.full}`;
    generated.push('description');
  }

  const categories = [...new Set(all.flatMap((m) => [].concat(m.category ?? [], m.categories ?? []).map((c) => (typeof c === 'string' ? slug(c) : '')).filter(Boolean)))]
    .slice(0, LIMITS.categories)
    .sort();

  const author = first((m) => (typeof m.author === 'string' ? str(m.author) && { name: str(m.author) } : str(m.author?.name) && m.author));
  let publisher;
  if (author) {
    publisher = { name: cut(str(author.name), LIMITS.publisher) };
    const url = https(author.url);
    if (url) publisher.url = url;
  } else if (str(mktOwner?.name)) {
    publisher = { name: cut(str(mktOwner.name), LIMITS.publisher) };
    if (https(mktOwner.url)) publisher.url = https(mktOwner.url);
  } else {
    publisher = { name: r.owner, url: `https://github.com/${r.owner}` };
    generated.push('publisher');
  }

  const entry = {
    id,
    name,
    description: cut(description, LIMITS.description),
    categories,
    publisher,
  };
  const homepage = first((m) => https(m.homepage));
  if (homepage) entry.homepage = homepage;
  entry.license = license;
  entry.source = { repo: r.repo, sha: r.sha, path: dir };

  const logoRel = first((m) => {
    const l = str(m.logo) || str(m.icon);
    return l && !/^[a-z]+:/i.test(l) ? l : null;
  });
  if (logoRel) {
    const f = join(dir, logoRel);
    if (f && r.sizes.has(f) && LOGO_EXT.test(f) && r.sizes.get(f) <= LOGO_MAX) entry.logo = rawUrl(r.full, r.sha, f);
    else warn(`${id}: logo ${logoRel} is missing, too large or not an image; left out`);
  }

  entry.servers = (await serversOf(r, dir, top, mkt?.mcpServers)).map((s) => cut(s, LIMITS.itemName)).sort();
  entry.skills = (await skillsOf(r, dir, top)).sort();

  const uc = first((m) => (m.userConfig && typeof m.userConfig === 'object' && !Array.isArray(m.userConfig) ? m.userConfig : null));
  if (uc) {
    const fields = Object.entries(uc)
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(k))
      .map(([key, f]) => ({ key, label: cut(str(f?.title) || key, LIMITS.label), secret: f?.sensitive === true }))
      .slice(0, LIMITS.fields);
    if (fields.length) entry.fields = fields;
  }
  if (generated.length) entry.generated = generated.sort();
  return entry;
}

// ---------- sources ----------

const warnings = [];
function warn(m) {
  warnings.push(m);
}

export async function build(sources) {
  const excluded = (sources.excluded ?? []).map((x) => ({ ...x, repo: x.repo.toLowerCase() }));
  const isExcluded = (repo, dir) => excluded.find((x) => x.repo === repo.toLowerCase() && (x.path === undefined || x.path === dir));
  const repos = new Map();
  const open = (repo, ref) => {
    const k = `${repo.toLowerCase()}@${ref ?? ''}`;
    if (!repos.has(k)) repos.set(k, openRepo(repo, ref));
    return repos.get(k);
  };
  const jobs = []; // {r, dir, mkt, owner, from}
  const skipped = [];

  for (const m of sources.marketplaces ?? []) {
    if (isExcluded(m.repo)) continue;
    const r = await open(m.repo, m.ref);
    const files = r.files.filter((f) => MARKET_RE.test(f) && !SKIP_RE.test(f)).sort((a, b) => rankOf(a) - rankOf(b) || (a < b ? -1 : 1));
    if (!files.length) throw new Error(`${m.repo}: no marketplace.json`);
    const seen = new Set();
    for (const f of files) {
      const doc = await r.readJson(f);
      const root = clean(doc?.metadata?.pluginRoot ?? '') ?? '';
      for (const p of Array.isArray(doc?.plugins) ? doc.plugins : []) {
        const pname = str(p?.name);
        if (!pname || seen.has(pname.toLowerCase())) continue;
        seen.add(pname.toLowerCase());
        const src = typeof p.source === 'string' ? p.source : p.source == null ? '' : typeof p.source.path === 'string' ? p.source.path : null;
        if (src === null) {
          skipped.push({ repo: r.repo, path: pname, reason: 'its marketplace entry points to another repository' });
          continue;
        }
        const dir = join(root, src);
        if (dir === null || (dir !== '' && !r.files.some((x) => x.startsWith(`${dir}/`)))) {
          skipped.push({ repo: r.repo, path: src, reason: 'its marketplace source is not in the repository' });
          continue;
        }
        const ex = isExcluded(r.repo, dir);
        if (ex) {
          skipped.push({ repo: r.repo, path: dir, reason: ex.reason });
          continue;
        }
        jobs.push({ r, dir, mkt: p, owner: doc.owner, from: `marketplace ${r.full}` });
      }
    }
  }
  for (const p of sources.plugins ?? []) {
    const dir = p.path ?? '';
    if (!safePath(dir)) throw new Error(`${p.repo}: bad path ${JSON.stringify(dir)}`);
    const ex = isExcluded(p.repo, dir);
    if (ex) {
      skipped.push({ repo: p.repo, path: dir, reason: ex.reason });
      continue;
    }
    const r = await open(p.repo, p.ref);
    // the repo's own marketplace entry for this directory, if it has one
    let mkt = null;
    let owner = null;
    for (const f of r.files.filter((x) => MARKET_RE.test(x) && !SKIP_RE.test(x)).sort((a, b) => rankOf(a) - rankOf(b))) {
      const doc = await r.readJson(f);
      const root = clean(doc?.metadata?.pluginRoot ?? '') ?? '';
      const hit = (Array.isArray(doc?.plugins) ? doc.plugins : []).find((e) => typeof e?.source === 'string' && join(root, e.source) === dir);
      if (hit) {
        mkt = hit;
        owner = doc.owner;
        break;
      }
    }
    jobs.push({ r, dir, mkt, owner, from: 'explicit' });
  }

  const plugins = [];
  const counts = {};
  const ids = new Map();
  const dates = [];
  await pool(jobs, 6, async (j) => {
    const r = await j.r;
    try {
      const e = await entryOf(r, j.dir, j.mkt, j.owner);
      if (ids.has(e.id)) throw new Error(`duplicate id ${e.id}: ${ids.get(e.id)} and ${r.full}/${j.dir}`);
      ids.set(e.id, `${r.full}/${j.dir}`);
      plugins.push(e);
      dates.push(r.date);
      counts[j.from] = (counts[j.from] ?? 0) + 1;
    } catch (err) {
      if (err && err.skip) skipped.push({ repo: r.repo, path: j.dir, reason: err.skip });
      else throw err;
    }
  });
  plugins.sort((a, b) => (a.id < b.id ? -1 : 1));
  skipped.sort((a, b) => `${a.repo}/${a.path}`.localeCompare(`${b.repo}/${b.path}`));
  const latest = dates.length ? new Date(Math.max(...dates.map((d) => Date.parse(d)))) : new Date(0);
  const catalog = { v: 1, generatedAt: latest.toISOString().replace(/\.\d{3}Z$/, 'Z'), plugins };
  return { catalog, skipped, counts };
}

// ---------- CLI ----------

async function main() {
  const mode = process.argv[2] ?? '';
  if (mode === '--validate') {
    const text = await readFile(CATALOG, 'utf8');
    const errs = validateText(text);
    if (!errs.length && serialize(JSON.parse(text)) !== text) errs.push('catalog.json: not in the canonical formatting (2-space JSON, trailing newline)');
    for (const e of errs) console.error(e);
    if (errs.length) process.exit(1);
    console.log(`catalog.json valid: ${JSON.parse(text).plugins.length} plugins`);
    return;
  }
  if (mode && mode !== '--check') {
    console.error('usage: node tools/build.mjs [--check | --validate]');
    process.exit(2);
  }
  const sources = JSON.parse(await readFile(SOURCES, 'utf8'));
  const { catalog, skipped, counts } = await build(sources);
  const errs = validate(catalog);
  if (errs.length) {
    for (const e of errs) console.error(e);
    process.exit(1);
  }
  for (const w of warnings) console.error(`warning: ${w}`);
  for (const s of skipped) console.error(`skipped: ${s.repo}${s.path ? `/${s.path}` : ''}: ${s.reason}`);
  for (const [k, n] of Object.entries(counts).sort()) console.error(`${n} from ${k}`);
  const text = serialize(catalog);
  if (mode === '--check') {
    const old = await readFile(CATALOG, 'utf8').catch(() => '');
    if (old !== text) {
      const a = old ? JSON.parse(old).plugins : [];
      const byId = new Map(a.map((p) => [p.id, JSON.stringify(p)]));
      const now = new Map(catalog.plugins.map((p) => [p.id, JSON.stringify(p)]));
      for (const [id, s] of now) if (!byId.has(id)) console.error(`+ ${id}`);
      else if (byId.get(id) !== s) console.error(`~ ${id}`);
      for (const id of byId.keys()) if (!now.has(id)) console.error(`- ${id}`);
      console.error('catalog.json is out of date: run node tools/build.mjs');
      process.exit(1);
    }
    console.log(`catalog.json up to date: ${catalog.plugins.length} plugins`);
    return;
  }
  await writeFile(CATALOG, text);
  console.log(`wrote catalog.json: ${catalog.plugins.length} plugins`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(1);
  });
}
