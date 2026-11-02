// Public content only. Never use this cache for consultation/admin/analytics data.
export const MAX_OFFSET = 5000;
const TTL_MS = 60_000;
const MAX_ENTRIES = 64;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 16;
const states = new WeakMap();

export class PageInputError extends Error {}

export function boundedInteger(raw, fallback, min, max, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(String(raw))) throw new PageInputError(`Invalid ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new PageInputError(`${name} must be between ${min} and ${max}`);
  return value;
}

export function readPage(params, defaultLimit = 50, fixedLimit = false) {
  return {
    limit: fixedLimit ? defaultLimit : boundedInteger(params.limit, defaultLimit, 1, 100, "limit"),
    offset: boundedInteger(params.offset, 0, 0, MAX_OFFSET, "offset (use cursor for deeper pages)"),
  };
}

export function encodeCursor(scope, values) {
  return btoa(unescape(encodeURIComponent(JSON.stringify([1, scope, values]))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(raw, scope, types) {
  if (!raw) return null;
  if (typeof raw !== "string" || raw.length > 2048 || !/^[\w-]+$/.test(raw))
    throw new PageInputError("Invalid cursor");
  try {
    const [version, storedScope, values] = JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, "+").replace(/_/g, "/")))));
    if (version !== 1 || storedScope !== scope || !Array.isArray(values) || values.length !== types.length)
      throw new Error();
    if (values.some((value, i) => typeof value !== types[i] || (typeof value === "number" ? !Number.isSafeInteger(value) : value.length > 256)))
      throw new Error();
    return values;
  } catch {
    throw new PageInputError("Invalid cursor or changed filters");
  }
}

export function pageResult(rows, limit, offset, scope, values) {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    rows: page,
    // Keep numeric offsets for existing administrator clients. Deep reads must use cursor.
    offset: hasMore ? String(offset + limit) : null,
    cursor: hasMore && page.length ? encodeCursor(scope, values(page[page.length - 1])) : null,
    hasMore,
  };
}

function stateFor(db) {
  let state = states.get(db);
  if (!state) {
    state = { entries: new Map(), pending: new Map(), bytes: 0 };
    states.set(db, state);
  }
  return state;
}

function remember(state, key, body, version) {
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > MAX_ENTRY_BYTES) return;
  const previous = state.entries.get(key);
  if (previous) state.bytes -= previous.bytes;
  state.entries.delete(key);
  state.entries.set(key, { body, version, bytes, expires: Date.now() + TTL_MS });
  state.bytes += bytes;
  while (state.entries.size > MAX_ENTRIES || state.bytes > MAX_CACHE_BYTES) {
    const first = state.entries.keys().next().value;
    state.bytes -= state.entries.get(first).bytes;
    state.entries.delete(first);
  }
}

function response(body, cache, version) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    // Revalidate with this Worker: Cache API entries use a separate internal TTL.
    "Cache-Control": "public, max-age=0, must-revalidate",
    "X-Content-Cache": cache,
  };
  if (version !== null) headers["X-Content-Version"] = String(version);
  return new Response(body, { headers });
}

async function readRevision(env, moduleKey) {
  let version = null;
  try {
    const row = await env.DB.prepare("SELECT revision FROM content_cache_versions WHERE module = ?")
      .bind(moduleKey).first();
    if (Number.isSafeInteger(row?.revision) && row.revision >= 0) version = row.revision;
  } catch {
    // Old databases remain readable before migration. Never cache without shared invalidation.
  }
  return version;
}

async function loadPublic(env, url, moduleKey, queryKey, load, state, version) {
  const key = `${url.origin}/__content-cache/v1/${moduleKey}?revision=${version}&query=${encodeURIComponent(queryKey)}`;
  let edge;
  if (version !== null) {
    const hit = state.entries.get(key);
    if (hit && hit.expires > Date.now()) {
      state.entries.delete(key);
      state.entries.set(key, hit);
      return response(hit.body, "memory", version);
    }
    if (hit) {
      state.entries.delete(key);
      state.bytes -= hit.bytes;
    }
    try {
      edge = globalThis.caches?.default;
      const cached = edge && await edge.match(key);
      if (cached) {
        const body = await cached.text();
        // Do not extend an edge entry's life in memory beyond its original expiration.
        const expires = Number(cached.headers.get("X-Content-Expires"));
        if (expires > Date.now()) {
          remember(state, key, body, version);
          const entry = state.entries.get(key);
          if (entry) entry.expires = expires;
          return response(body, "edge", version);
        }
      }
    } catch { /* Cache unavailability must not break the database read. */ }
  }
  const result = await load();
  if (!result.ok) return result;
  const body = await result.text();
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > MAX_RESPONSE_BYTES)
    return new Response(JSON.stringify({ error: "Response too large; use view=summary or a smaller limit" }), {
      status: 413, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  if (version !== null && bytes <= MAX_ENTRY_BYTES) {
    remember(state, key, body, version);
    if (edge) {
      const cached = new Response(body, { headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${TTL_MS / 1000}`,
        "X-Content-Expires": String(Date.now() + TTL_MS),
      } });
      const put = Promise.resolve().then(() => edge.put(key, cached)).catch(() => {});
      if (env.__ctx?.waitUntil) env.__ctx.waitUntil(put);
      else await put;
    }
  }
  const out = response(body, version === null ? "bypass" : "miss", version);
  if (version === null) out.headers.set("Cache-Control", "no-store");
  return out;
}

export async function cachedPublicContent(env, request, moduleKey, queryKey, load) {
  const state = stateFor(env.DB);
  const url = new URL(request.url);
  // Read the shared revision BEFORE joining an in-flight fill. A request after a
  // committed write must never join a request that started before that write.
  const version = await readRevision(env, moduleKey);
  const pendingKey = `${url.origin}|${moduleKey}|${version}|${queryKey}`;
  let pending = state.pending.get(pendingKey);
  if (!pending) {
    if (state.pending.size >= MAX_PENDING) return new Response(JSON.stringify({ error: "Too many concurrent content requests" }), {
      status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "1" },
    });
    pending = loadPublic(env, url, moduleKey, queryKey, load, state, version);
    state.pending.set(pendingKey, pending);
    const cleanup = () => { if (state.pending.get(pendingKey) === pending) state.pending.delete(pendingKey); };
    pending.then(cleanup, cleanup);
  }
  return (await pending).clone();
}
