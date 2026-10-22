'use strict';

const manifest = require('./papercusp.json');
const API = 'https://api.linkedin.com/rest/posts';
const HEADERS = { 'LinkedIn-Version': '202609', 'X-Restli-Protocol-Version': '2.0.0' };
const LIMIT = 10000;
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const postId = (v) => typeof v === 'string' && /^urn:li:(?:share|ugcPost):[0-9]+$/.test(v);
const version = (v) => typeof v === 'string' && /^urn:li:(?:share|ugcPost):[0-9]+@[0-9]+$/.test(v);
const fault = (kind, message, extra) => Object.assign(new Error(`linkedin-company:${message}`), { kind }, extra || {});
// The host also enforces this descriptor wall before OAuth, identity and host.fetch.
// A caller-supplied config/argument cannot grant partner approval to this package.
function approved() {
  if (manifest.provider.verification.blockedOn) throw fault('auth', 'partner_approval_required');
}
function organization(config) {
  const id = config?.organizationId;
  if (typeof id !== 'string' || !/^[0-9]+$/.test(id)) throw fault('transient', 'invalid_organization_id');
  return `urn:li:organization:${id}`;
}
function header(headers, name) {
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
}
async function api(host, source, url, body) {
  let response;
  try {
    response = await host.fetch({ source, request: { url, method: body ? 'POST' : 'GET',
      headers: { ...HEADERS, ...(body ? { 'content-type': 'application/json' } : { 'X-RestLi-Method': 'FINDER' }) },
      ...(body ? { body: JSON.stringify(body) } : {}) } });
  } catch {
    throw fault('transient', body ? 'post_ambiguous_do_not_retry' : 'read_unconfirmed', { retrySafe: !body });
  }
  if ([401, 403].includes(response.status)) throw fault('auth', 'organization_grant_refused');
  if (response.status === 429) {
    const retry = Number(header(response.headers, 'retry-after'));
    throw fault('rate-limited', 'throttled', Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {});
  }
  if (response.status < 200 || response.status >= 300) {
    throw fault('transient', body && (response.status >= 500 || response.status === 409) ? 'post_ambiguous_do_not_retry' : 'request_refused', { retrySafe: !body, status: response.status });
  }
  return response;
}
function fresh(author, known = []) { return { v: 1, author, start: 0, known, seen: [], done: false }; }
function decode(raw, author) {
  if (raw === null || raw === undefined) return fresh(author);
  let s;
  try { s = JSON.parse(raw); } catch { throw fault('cursor-expired', 'cursor_unreadable'); }
  if (!object(s) || s.v !== 1 || typeof s.author !== 'string' || !/^urn:li:organization:[0-9]+$/.test(s.author)
    || !Number.isSafeInteger(s.start) || s.start < 0 || s.start > 1000000 || typeof s.done !== 'boolean'
    || ![s.known, s.seen].every((a) => Array.isArray(a) && a.length <= LIMIT && a.every(version))) {
    throw fault('cursor-expired', 'cursor_unrecognised');
  }
  if (s.author !== author) return fresh(author);
  return s.done ? fresh(author, s.seen) : s;
}
function record(row, author) {
  if (!object(row) || !postId(row.id) || row.author !== author || row.lifecycleState !== 'PUBLISHED'
    || typeof row.commentary !== 'string' || !Number.isSafeInteger(row.lastModifiedAt) || row.lastModifiedAt < 0
    || !Number.isFinite(new Date(row.lastModifiedAt).getTime())) throw fault('transient', 'malformed_organization_post');
  const occurredAt = new Date(row.lastModifiedAt).toISOString();
  return { datatype: 'social-post', nativeId: row.id, event: 'post', occurredAt, version: `${row.id}@${row.lastModifiedAt}`,
    payload: { id: row.id, platform: 'linkedin-company', kind: 'post', text: row.commentary, occurredAt,
      author, subjectId: row.id, url: `https://www.linkedin.com/feed/update/${encodeURIComponent(row.id)}/` } };
}
function nextStart(paging, author, start) {
  if (!object(paging) || !Array.isArray(paging.links)) throw fault('transient', 'malformed_paging');
  const next = paging.links.filter((link) => link?.rel === 'next');
  if (next.length === 0) return null;
  if (next.length !== 1 || typeof next[0].href !== 'string') throw fault('cursor-expired', 'pagination_unrecognised');
  let url;
  try { url = new URL(next[0].href, API); } catch { throw fault('cursor-expired', 'pagination_unrecognised'); }
  // Bind pagination to the requested collection; only its numeric offset is
  // retained. The next request is rebuilt from API and never follows this URL.
  const resource = new URL(API);
  const p = url.searchParams;
  const offset = p.get('start');
  if (url.origin !== resource.origin || url.pathname !== resource.pathname || url.username || url.password || url.hash
    || p.get('q') !== 'author' || p.get('author') !== author || p.get('sortBy') !== 'LAST_MODIFIED'
    || p.get('count') !== '100' || !offset || !/^[0-9]+$/.test(offset)
    || !Number.isSafeInteger(Number(offset)) || Number(offset) <= start || Number(offset) > 1000000
    || [...p.keys()].some((key) => !['q', 'author', 'sortBy', 'count', 'start'].includes(key))
    || [...p.keys()].some((key) => p.getAll(key).length !== 1)) throw fault('cursor-expired', 'pagination_unrecognised');
  return Number(offset);
}
async function syncPage(request, host) {
  approved();
  const author = organization(request.config);
  const s = decode(request.cursor, author);
  const query = new URLSearchParams({ q: 'author', author, count: '100', start: String(s.start), sortBy: 'LAST_MODIFIED' });
  const response = await api(host, request.source, `${API}?${query}`);
  let body;
  try { body = JSON.parse(response.body); } catch { throw fault('transient', 'malformed_collection'); }
  if (!object(body) || !Array.isArray(body.elements) || body.elements.length > 100) throw fault('transient', 'malformed_collection');
  const offset = nextStart(body.paging, author, s.start);
  const known = new Set(s.known), seen = new Set(s.seen), records = [];
  for (const row of body.elements) {
    const r = record(row, author);
    if (!known.has(r.version) && !seen.has(r.version)) records.push(r);
    seen.add(r.version);
  }
  if (seen.size > LIMIT) throw fault('transient', 'history_bound_exceeded');
  s.seen = [...seen]; s.done = offset === null; s.start = offset ?? 0;
  return { records, nextCursor: JSON.stringify(s), hasMore: !s.done,
    catchUp: request.catchUpFrom ? { path: 'backfill', reason: 'cursor-expired' }
      : { path: request.cursor ? 'cursor-replay' : 'cold-start' } };
}
async function invoke(request, host) {
  approved();
  if (request.capability !== 'social.post') throw fault('transient', 'capability_unsupported');
  const author = organization(request.config), a = request.args || {};
  if (a.destination !== author && a.destination !== request.config.organizationId) throw fault('auth', 'organization_destination_required');
  if (typeof a.text !== 'string' || !a.text.trim() || [...a.text].length > 3000) throw fault('transient', 'invalid_text');
  if (a.media !== undefined && (!Array.isArray(a.media) || a.media.length)) throw fault('transient', 'media_unsupported');
  if (a.imageUrl || a.videoUrl) throw fault('transient', 'media_unsupported');
  if (a.visibility !== undefined && a.visibility !== 'public') throw fault('transient', 'public_visibility_required');
  const response = await api(host, request.source, API, {
    author, commentary: a.text.trim(), visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
  });
  const externalId = header(response.headers, 'x-restli-id');
  if (!postId(externalId)) throw fault('transient', 'post_ambiguous_no_id_do_not_retry', { retrySafe: false });
  return { externalId, url: `https://www.linkedin.com/feed/update/${encodeURIComponent(externalId)}/` };
}
module.exports = { name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [],
  providerAdapter: { describe: () => manifest.provider, syncPage, invoke } };
