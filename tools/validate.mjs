// Schema check for catalog.json (v 1). No network, no dependencies.
// validate(catalog) returns a list of error strings; empty means valid.

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
export const REPO_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  plugins: 2000,
  name: 100,
  description: 2000,
  publisher: 100,
  url: 500,
  license: 64,
  path: 256,
  categories: 10,
  servers: 100,
  skills: 300,
  itemName: 100,
  fields: 50,
  label: 200,
};

export const GENERATED = ['description', 'publisher', 'servers'];

const PLUGIN_KEYS = ['id', 'name', 'description', 'categories', 'publisher', 'homepage', 'license', 'source', 'logo', 'servers', 'skills', 'fields', 'generated'];
const REQUIRED = ['id', 'name', 'description', 'categories', 'publisher', 'source', 'servers', 'skills'];

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

export function isHttps(u) {
  if (typeof u !== 'string' || u.length > LIMITS.url) return false;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' && !p.username && !p.password;
  } catch {
    return false;
  }
}

export function safePath(p) {
  if (typeof p !== 'string' || p.length > LIMITS.path) return false;
  if (p === '') return true;
  if (p.startsWith('/') || p.endsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function stringList(errs, at, v, max, itemRe) {
  if (!Array.isArray(v)) return errs.push(`${at}: must be an array`);
  if (v.length > max) errs.push(`${at}: more than ${max} items`);
  const seen = new Set();
  v.forEach((s, i) => {
    if (!isStr(s, LIMITS.itemName)) errs.push(`${at}[${i}]: must be a non-empty string of at most ${LIMITS.itemName} characters`);
    else if (itemRe && !itemRe.test(s)) errs.push(`${at}[${i}]: ${JSON.stringify(s)} is not a valid value`);
    if (seen.has(s)) errs.push(`${at}: duplicate ${JSON.stringify(s)}`);
    seen.add(s);
  });
  const sorted = [...v].sort();
  if (sorted.some((s, i) => s !== v[i])) errs.push(`${at}: must be sorted`);
}

export function validatePlugin(p, at = 'plugin') {
  const errs = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return [`${at}: must be an object`];
  for (const k of Object.keys(p)) if (!PLUGIN_KEYS.includes(k)) errs.push(`${at}: unknown key ${JSON.stringify(k)}`);
  for (const k of REQUIRED) if (!(k in p)) errs.push(`${at}: missing ${k}`);
  if ('id' in p && !(typeof p.id === 'string' && ID_RE.test(p.id))) errs.push(`${at}.id: must match ${ID_RE}`);
  if ('name' in p && !isStr(p.name, LIMITS.name)) errs.push(`${at}.name: must be 1-${LIMITS.name} characters`);
  if ('description' in p && !isStr(p.description, LIMITS.description)) errs.push(`${at}.description: must be 1-${LIMITS.description} characters`);
  if ('categories' in p) stringList(errs, `${at}.categories`, p.categories, LIMITS.categories, CATEGORY_RE);
  if ('publisher' in p) {
    const pub = p.publisher;
    if (!pub || typeof pub !== 'object' || Array.isArray(pub)) errs.push(`${at}.publisher: must be an object`);
    else {
      for (const k of Object.keys(pub)) if (k !== 'name' && k !== 'url') errs.push(`${at}.publisher: unknown key ${JSON.stringify(k)}`);
      if (!isStr(pub.name, LIMITS.publisher)) errs.push(`${at}.publisher.name: must be 1-${LIMITS.publisher} characters`);
      if ('url' in pub && !isHttps(pub.url)) errs.push(`${at}.publisher.url: must be an https URL`);
    }
  }
  if ('homepage' in p && !isHttps(p.homepage)) errs.push(`${at}.homepage: must be an https URL`);
  if ('license' in p && !isStr(p.license, LIMITS.license)) errs.push(`${at}.license: must be 1-${LIMITS.license} characters`);
  const src = p.source;
  if ('source' in p) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) errs.push(`${at}.source: must be an object`);
    else {
      for (const k of Object.keys(src)) if (!['repo', 'sha', 'path'].includes(k)) errs.push(`${at}.source: unknown key ${JSON.stringify(k)}`);
      if (!(typeof src.repo === 'string' && REPO_RE.test(src.repo))) errs.push(`${at}.source.repo: must be https://github.com/<owner>/<repo>`);
      if (!(typeof src.sha === 'string' && SHA_RE.test(src.sha))) errs.push(`${at}.source.sha: must be 40 lowercase hex characters`);
      if (!safePath(src.path)) errs.push(`${at}.source.path: must be '' or a relative path without '.', '..' or a trailing slash`);
    }
  }
  if ('logo' in p) {
    if (!isHttps(p.logo)) errs.push(`${at}.logo: must be an https URL`);
    else if (src && typeof src.repo === 'string' && typeof src.sha === 'string') {
      const prefix = `https://raw.githubusercontent.com/${src.repo.slice('https://github.com/'.length)}/${src.sha}/`;
      if (!p.logo.startsWith(prefix)) errs.push(`${at}.logo: must be a file in source.repo at source.sha (${prefix}...)`);
    }
  }
  if ('servers' in p) stringList(errs, `${at}.servers`, p.servers, LIMITS.servers);
  if ('skills' in p) stringList(errs, `${at}.skills`, p.skills, LIMITS.skills);
  if ('fields' in p) {
    if (!Array.isArray(p.fields)) errs.push(`${at}.fields: must be an array`);
    else {
      if (p.fields.length > LIMITS.fields) errs.push(`${at}.fields: more than ${LIMITS.fields} items`);
      const seen = new Set();
      p.fields.forEach((f, i) => {
        const fa = `${at}.fields[${i}]`;
        if (!f || typeof f !== 'object' || Array.isArray(f)) return errs.push(`${fa}: must be an object`);
        for (const k of Object.keys(f)) if (!['key', 'label', 'secret'].includes(k)) errs.push(`${fa}: unknown key ${JSON.stringify(k)}`);
        if (!(typeof f.key === 'string' && FIELD_KEY_RE.test(f.key))) errs.push(`${fa}.key: must match ${FIELD_KEY_RE}`);
        else if (seen.has(f.key)) errs.push(`${fa}.key: duplicate ${f.key}`);
        seen.add(f.key);
        if (!isStr(f.label, LIMITS.label)) errs.push(`${fa}.label: must be 1-${LIMITS.label} characters`);
        if (typeof f.secret !== 'boolean') errs.push(`${fa}.secret: must be a boolean`);
      });
    }
  }
  if ('generated' in p) {
    stringList(errs, `${at}.generated`, p.generated, GENERATED.length);
    if (Array.isArray(p.generated)) for (const g of p.generated) if (!GENERATED.includes(g)) errs.push(`${at}.generated: unknown ${JSON.stringify(g)}`);
  }
  return errs;
}

export function validate(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['catalog: must be an object'];
  const errs = [];
  for (const k of Object.keys(c)) if (!['v', 'generatedAt', 'plugins'].includes(k)) errs.push(`catalog: unknown key ${JSON.stringify(k)}`);
  if (c.v !== 1) errs.push('catalog.v: must be 1');
  if (!(typeof c.generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(c.generatedAt))) errs.push('catalog.generatedAt: must be an ISO 8601 UTC timestamp');
  if (!Array.isArray(c.plugins)) return [...errs, 'catalog.plugins: must be an array'];
  if (c.plugins.length > LIMITS.plugins) errs.push(`catalog.plugins: more than ${LIMITS.plugins} entries`);
  const ids = new Set();
  let prev = null;
  c.plugins.forEach((p, i) => {
    const at = `plugins[${i}]${p && typeof p.id === 'string' ? ` (${p.id})` : ''}`;
    errs.push(...validatePlugin(p, at));
    if (p && typeof p.id === 'string') {
      if (ids.has(p.id)) errs.push(`${at}: duplicate id`);
      ids.add(p.id);
      if (prev !== null && p.id < prev) errs.push(`${at}: plugins must be sorted by id`);
      prev = p.id;
    }
  });
  return errs;
}

// The file as text: size and parse, then the schema.
export function validateText(text) {
  if (Buffer.byteLength(text) > LIMITS.fileBytes) return [`catalog.json: larger than ${LIMITS.fileBytes} bytes`];
  let c;
  try {
    c = JSON.parse(text);
  } catch (e) {
    return [`catalog.json: not JSON (${e.message})`];
  }
  return validate(c);
}

// The one formatting the repo commits.
export const serialize = (c) => JSON.stringify(c, null, 2) + '\n';
