#!/usr/bin/env node
/**
 * release-publisher.mjs — firmware release publisher.
 *
 * Pipeline (run via `npm run report`):
 *   1. Load fixtures/build_manifest.csv into releases.duckdb.
 *   2. Reconcile with SQL: collapse exact-duplicate rows, drop builds cancelled
 *      by WITHDRAWAL records, and derive the publishable bundle set
 *      (bundle_id, artifact_count, total_bytes).
 *   3. For each publishable bundle: build the canonical descriptor, sign it with
 *      the CURRENT code-signing key (detached OpenSSL CMS, PEM), and POST it to
 *      the distribution gateway with a deterministic request token.
 *   4. Persist the gateway receipt + request token in releases.duckdb so a
 *      re-run replays stored receipts instead of re-submitting.
 *   5. Print two deterministic status lines per bundle, ordered by bundle_id.
 *
 * The gateway is only ever touched over HTTP; its private ledger is never read.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import duckdb from 'duckdb';

// --- locations ---------------------------------------------------------------
// Everything is resolved relative to the package root (the directory holding
// package.json), so the publisher works no matter what cwd it is launched from.
const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANIFEST_CSV = path.join(APP_ROOT, 'fixtures', 'build_manifest.csv');
const DB_FILE = path.join(APP_ROOT, 'releases.duckdb');

// The current signing keypair is installed at a fixed path in the container.
// Both are overridable via environment so the publisher can be exercised in a
// local sandbox (mirrors the gateway's own CURRENT_CERT_PATH override).
const CURRENT_KEY_PATH =
  process.env.CURRENT_KEY_PATH || '/app/keys/current/current.key.pem';
const CURRENT_CERT_PATH =
  process.env.CURRENT_CERT_PATH || '/app/keys/current/current.cert.pem';

const GATEWAY_BASE = process.env.GATEWAY_BASE_URL || 'http://127.0.0.1:7070';

// --- duckdb helpers ----------------------------------------------------------
// The duckdb package exposes a callback API; wrap the two calls we need.
function dbAll(conn, sql, ...params) {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbRun(conn, sql, ...params) {
  return new Promise((resolve, reject) => {
    conn.run(sql, ...params, (err) => (err ? reject(err) : resolve()));
  });
}

// --- canonical descriptor ----------------------------------------------------
// UTF-8 JSON, object keys sorted lexicographically, no insignificant whitespace.
// These exact bytes are signed and sent verbatim as the `descriptor` field.
function canonicalDescriptor(bundle) {
  const payload = {
    artifact_count: Number(bundle.artifact_count),
    bundle_id: bundle.bundle_id,
    total_bytes: Number(bundle.total_bytes),
  };
  const sorted = Object.keys(payload)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + JSON.stringify(payload[k]));
  return '{' + sorted.join(',') + '}';
}

// --- signing -----------------------------------------------------------------
// Detached CMS signature (PEM) over the exact canonical descriptor bytes, made
// with the CURRENT keypair. The gateway verifies these bytes verbatim.
function signDescriptor(descriptor) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-sign-'));
  const contentFile = path.join(scratch, 'descriptor.bin');
  try {
    fs.writeFileSync(contentFile, descriptor, 'utf8');
    const pem = execFileSync(
      'openssl',
      [
        'cms', '-sign',
        '-in', contentFile,
        '-signer', CURRENT_CERT_PATH,
        '-inkey', CURRENT_KEY_PATH,
        '-outform', 'PEM',
        '-binary',
      ],
      { encoding: 'utf8' }
    );
    return pem;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --- gateway client ----------------------------------------------------------
async function fetchCurrentKey() {
  const res = await fetch(`${GATEWAY_BASE}/v1/signing-key/current`);
  if (!res.ok) {
    throw new Error(`GET /v1/signing-key/current failed: HTTP ${res.status}`);
  }
  return res.json();
}

async function submitPublication(descriptor, signature, requestToken) {
  const res = await fetch(`${GATEWAY_BASE}/v1/publications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      descriptor,
      signature,
      request_token: requestToken,
    }),
  });
  const body = await res.json();
  if (!res.ok || body.status !== 'PUBLISHED') {
    throw new Error(
      `POST /v1/publications rejected token ${requestToken}: ` +
        `HTTP ${res.status} ${JSON.stringify(body)}`
    );
  }
  return body;
}

// --- main --------------------------------------------------------------------
async function main() {
  const db = new duckdb.Database(DB_FILE);
  const conn = db.connect();

  try {
    // 1. Ingest the raw manifest. The table is rebuilt from the CSV on every
    //    run so the output is always derived from the fixture, never cached.
    await dbRun(conn, `DROP TABLE IF EXISTS manifest_raw`);
    await dbRun(
      conn,
      `CREATE TABLE manifest_raw AS
         SELECT * FROM read_csv(
           ?,
           header = true,
           columns = {
             'entry_id':      'VARCHAR',
             'bundle_id':     'VARCHAR',
             'component_id':  'VARCHAR',
             'version':       'VARCHAR',
             'size_bytes':    'BIGINT',
             'record_type':   'VARCHAR',
             'supersedes_id': 'VARCHAR',
             'recorded_at':   'VARCHAR'
           }
         )`,
      MANIFEST_CSV
    );

    // Receipts persist across runs; created once, then reused for idempotency.
    await dbRun(
      conn,
      `CREATE TABLE IF NOT EXISTS publications (
         bundle_id      VARCHAR PRIMARY KEY,
         request_token  VARCHAR NOT NULL,
         publication_id VARCHAR NOT NULL,
         key_id         VARCHAR NOT NULL,
         status         VARCHAR NOT NULL,
         descriptor     VARCHAR NOT NULL,
         artifact_count BIGINT  NOT NULL,
         total_bytes    BIGINT  NOT NULL
       )`
    );

    // 2. Reconcile.
    //    manifest_dedup: rows identical across EVERY column collapse to one.
    //    withdrawn:      entry_ids cancelled by a WITHDRAWAL's supersedes_id.
    //    publishable:    per-bundle count + byte total over surviving BUILDs;
    //                    bundles whose every build was withdrawn drop out of
    //                    the GROUP BY entirely.
    const bundles = await dbAll(
      conn,
      `WITH manifest_dedup AS (
         SELECT DISTINCT * FROM manifest_raw
       ),
       withdrawn AS (
         SELECT DISTINCT supersedes_id AS entry_id
         FROM manifest_dedup
         WHERE record_type = 'WITHDRAWAL' AND supersedes_id IS NOT NULL
       ),
       surviving_builds AS (
         SELECT *
         FROM manifest_dedup
         WHERE record_type = 'BUILD'
           AND entry_id NOT IN (SELECT entry_id FROM withdrawn)
       )
       SELECT
         bundle_id,
         COUNT(*)        AS artifact_count,
         SUM(size_bytes) AS total_bytes
       FROM surviving_builds
       GROUP BY bundle_id
       ORDER BY bundle_id`
    );

    // 3–5. Publish each bundle (ascending bundle_id) and emit status lines.
    const keyMeta = await fetchCurrentKey();
    const lines = [];

    for (const bundle of bundles) {
      const bundleId = bundle.bundle_id;
      const requestToken = `token-${bundleId}`;
      const descriptor = canonicalDescriptor(bundle);

      // Idempotency: a receipt stored by a previous run is replayed as-is —
      // no re-signing, no re-submission.
      const stored = await dbAll(
        conn,
        `SELECT * FROM publications WHERE bundle_id = ? AND status = 'PUBLISHED'`,
        bundleId
      );

      let receipt;
      if (stored.length > 0) {
        receipt = stored[0];
      } else {
        const signature = signDescriptor(descriptor);
        receipt = await submitPublication(descriptor, signature, requestToken);
        await dbRun(
          conn,
          `INSERT INTO publications
             (bundle_id, request_token, publication_id, key_id, status,
              descriptor, artifact_count, total_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          bundleId,
          receipt.request_token,
          receipt.publication_id,
          keyMeta.key_id,
          receipt.status,
          descriptor,
          Number(bundle.artifact_count),
          Number(bundle.total_bytes)
        );
      }

      lines.push(`BUNDLE ${bundleId} SIGNED KEY=${keyMeta.key_id}`);
      lines.push(
        `BUNDLE ${bundleId} PUBLISHED RECEIPT=${receipt.publication_id} ` +
          `TOKEN=${receipt.request_token} STATUS=${receipt.status}`
      );
    }

    process.stdout.write(lines.join('\n') + '\n');
  } finally {
    conn.close();
    await new Promise((resolve) => db.close(resolve));
  }
}

main().catch((err) => {
  console.error(`release-publisher: ${err.message}`);
  process.exit(1);
});
