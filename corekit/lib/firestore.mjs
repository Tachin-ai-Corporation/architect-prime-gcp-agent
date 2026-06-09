// corekit/lib/firestore.mjs — Firestore REST client
// Extracted from agent-brain.mjs Phase 0B
// Generic Firestore REST client with encode/decode, read/write/query/patch/delete.

import { getGceToken } from './gce-auth.mjs';

/**
 * Encode a plain JS object into Firestore REST API field format.
 * Handles strings, numbers, booleans, nulls, arrays, Dates, and nested objects.
 * @param {object} obj - Plain JS object to encode
 * @returns {object} Firestore-encoded fields
 */
export function firestoreEncode(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      fields[k] = { nullValue: null };
    } else if (typeof v === 'string') {
      fields[k] = { stringValue: v };
    } else if (typeof v === 'number') {
      fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    } else if (typeof v === 'boolean') {
      fields[k] = { booleanValue: v };
    } else if (Array.isArray(v)) {
      fields[k] = { arrayValue: { values: v.map(item => ({ stringValue: String(item) })) } };
    } else if (v instanceof Date) {
      fields[k] = { timestampValue: v.toISOString() };
    } else if (typeof v === 'object') {
      fields[k] = { mapValue: { fields: firestoreEncode(v) } };
    }
  }
  return fields;
}

/**
 * Decode Firestore REST API field format back into a plain JS object.
 * Inverse of firestoreEncode — handles all Firestore value types including
 * nested maps, arrays, and mixed-type arrays.
 * @param {object} fields - Firestore-encoded fields object
 * @returns {object} Decoded plain JS object
 */
export function firestoreDecode(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if ('stringValue' in v) obj[k] = v.stringValue;
    else if ('integerValue' in v) obj[k] = parseInt(v.integerValue);
    else if ('doubleValue' in v) obj[k] = v.doubleValue;
    else if ('booleanValue' in v) obj[k] = v.booleanValue;
    else if ('nullValue' in v) obj[k] = null;
    else if ('timestampValue' in v) obj[k] = v.timestampValue;
    else if ('arrayValue' in v) {
      obj[k] = (v.arrayValue.values || []).map(item => {
        if ('mapValue' in item) return firestoreDecode(item.mapValue.fields || {});
        if ('stringValue' in item) return item.stringValue;
        if ('integerValue' in item) return parseInt(item.integerValue);
        if ('booleanValue' in item) return item.booleanValue;
        if ('doubleValue' in item) return item.doubleValue;
        if ('nullValue' in item) return null;
        if ('timestampValue' in item) return item.timestampValue;
        if ('arrayValue' in item) return (item.arrayValue.values || []).map(sub => sub.stringValue || sub.integerValue || '');
        return '';
      });
    } else if ('mapValue' in v) {
      obj[k] = firestoreDecode(v.mapValue.fields);
    }
  }
  return obj;
}

/**
 * Create a Firestore REST client scoped to a project.
 *
 * @param {object} config
 * @param {string} config.projectId - GCP project ID
 * @param {function} [config.logger] - Logger function, defaults to console.log
 * @returns {object} Client with read/write/query/patch/del methods
 */
export function createClient(config) {
  const BASE = `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
  const log = config.logger || ((...args) => console.log('[firestore]', ...args));

  /**
   * Read a single document by path.
   * @param {string} path - Document path, e.g. 'primes/chuck/work/w-123'
   * @returns {Promise<object|null>} Decoded document or null if not found
   */
  async function read(path) {
    const token = await getGceToken();
    const url = `${BASE}/${path}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const doc = await resp.json();
    return firestoreDecode(doc.fields || {});
  }

  /**
   * Write (upsert) a document by path. Uses PATCH semantics.
   * Includes a 1MB output truncation guard to stay under Firestore's document limit.
   *
   * @param {string} path - Document path, e.g. 'primes/chuck/work/w-123'
   * @param {object} data - Plain JS object to write
   * @returns {Promise<object|null>} Written document or null on failure
   */
  async function write(path, data) {
    const token = await getGceToken();
    // Guard against Firestore 1MB document limit — truncate oversized output fields
    if (data?.output && typeof data.output === 'string') {
      const MAX_OUTPUT = 800_000;
      if (data.output.length > MAX_OUTPUT) {
        log('WARN', `write: truncating output from ${data.output.length} to ${MAX_OUTPUT} chars for ${path}`);
        data.output = data.output.substring(0, MAX_OUTPUT)
          + `\n\n[TRUNCATED — full output saved to shared workspace / Drive]`;
      }
    }
    const url = `${BASE}/${path}`;
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields: firestoreEncode(data) }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log('ERROR', `Firestore write failed: ${resp.status} ${text}`);
      return null;
    }
    return await resp.json();
  }

  /**
   * Run a structured query against a collection.
   *
   * @param {string} parentPath - Parent document path, e.g. 'primes/chuck'
   * @param {string} collectionId - Collection to query, e.g. 'work'
   * @param {Array<object>} filters - Array of filter objects: { field, op, value }
   * @param {object} [opts] - Optional: { orderBy, limit }
   * @param {string} [opts.orderBy] - Field path to order by (default: 'created_at')
   * @param {string} [opts.orderDirection] - 'ASCENDING' or 'DESCENDING' (default: 'ASCENDING')
   * @param {number} [opts.limit] - Max results (default: 300)
   * @returns {Promise<Array<object>>} Array of decoded documents with 'id' field added
   */
  async function query(parentPath, collectionId, filters, opts = {}) {
    const token = await getGceToken();
    const url = `${BASE}/${parentPath}:runQuery`;
    const structuredQuery = {
      from: [{ collectionId }],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: filters.map(f => ({
            fieldFilter: {
              field: { fieldPath: f.field },
              op: f.op,
              value: f.value,
            }
          })),
        }
      },
      orderBy: [{
        field: { fieldPath: opts.orderBy || 'created_at' },
        direction: opts.orderDirection || 'ASCENDING',
      }],
      limit: opts.limit || 300,
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ structuredQuery }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log('ERROR', `Firestore query failed: ${resp.status} ${text}`);
      return [];
    }
    const results = await resp.json();
    return results
      .filter(r => r.document)
      .map(r => ({
        id: r.document.name.split('/').pop(),
        ...firestoreDecode(r.document.fields || {}),
      }));
  }

  /**
   * Patch specific fields on a document (partial update).
   *
   * @param {string} path - Document path, e.g. 'primes/chuck/work/w-123'
   * @param {Array<string>} fieldPaths - Field mask: which fields to update
   * @param {object} fields - Already-encoded Firestore fields to set
   * @returns {Promise<object|null>} Updated document or null on failure
   */
  async function patch(path, fieldPaths, fields) {
    const token = await getGceToken();
    const mask = fieldPaths.map(f => `updateMask.fieldPaths=${f}`).join('&');
    const url = `${BASE}/${path}?${mask}`;
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log('ERROR', `Firestore patch failed: ${resp.status} ${text}`);
      return null;
    }
    return await resp.json();
  }

  /**
   * Delete a document by path.
   *
   * @param {string} path - Document path to delete
   * @returns {Promise<boolean>} True if deleted successfully
   */
  async function del(path) {
    const token = await getGceToken();
    const url = `${BASE}/${path}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) {
      const text = await resp.text();
      log('ERROR', `Firestore delete failed: ${resp.status} ${text}`);
      return false;
    }
    return true;
  }

  return { read, write, query, patch, del };
}
