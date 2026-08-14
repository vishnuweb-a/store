/**
 * Minimal Supabase PostgREST client for the serverless functions.
 *
 * Uses plain fetch rather than @supabase/supabase-js: that package is a
 * dependency of apps/web (the browser bundle), and the functions deploy from
 * the repo root, so importing it here would couple the server tier to the
 * workspace's hoisting. The three verbs below are all the payment code needs.
 */
import { supabaseConfig } from './config.js';
import { fetchWithTimeout } from './http.js';

const TIMEOUT_MS = 10_000;

function headers(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function request(path, options) {
  const { url, key } = supabaseConfig();
  const response = await fetchWithTimeout(
    `${url}/rest/v1/${path}`,
    { ...options, headers: headers(key, options.headers) },
    TIMEOUT_MS,
  );

  const text = await response.text();

  if (!response.ok) {
    // PostgREST error bodies contain no secrets, but they can contain row data,
    // so only the code and message shape are surfaced to the caller.
    let detail = 'database request failed';

    try {
      const parsed = JSON.parse(text);
      detail = parsed.message || parsed.error || detail;
    } catch {
      // Non-JSON error body; keep the generic message.
    }

    const error = new Error(detail);
    error.status = response.status;
    error.isDatabaseError = true;

    throw error;
  }

  if (!text) {
    return [];
  }

  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

/**
 * @param {string} table
 * @param {string} query - PostgREST query string, e.g. `select=*&id=eq.1`
 * @returns {Promise<Object[]>}
 */
export function select(table, query) {
  return request(`${table}?${query}`, { method: 'GET' });
}

/**
 * @param {string} table
 * @param {Object|Object[]} rows
 * @param {{onConflict?: string, ignoreDuplicates?: boolean}} [options]
 * @returns {Promise<Object[]>}
 */
export function insert(table, rows, options = {}) {
  const prefer = ['return=representation'];

  if (options.onConflict) {
    prefer.push(options.ignoreDuplicates ? 'resolution=ignore-duplicates' : 'resolution=merge-duplicates');
  }

  const query = options.onConflict ? `?on_conflict=${encodeURIComponent(options.onConflict)}` : '';

  return request(`${table}${query}`, {
    method: 'POST',
    headers: { Prefer: prefer.join(',') },
    body: JSON.stringify(rows),
  });
}

/**
 * @param {string} table
 * @param {string} query - PostgREST filter, e.g. `order_ref=eq.FRV123`
 * @param {Object} patch
 * @returns {Promise<Object[]>} The updated rows
 */
export function update(table, query, patch) {
  return request(`${table}?${query}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
}
