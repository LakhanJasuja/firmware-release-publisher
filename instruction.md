# Firmware Release Publisher

Release Engineering rotated the firmware **code-signing key** and revoked the old
signing certificate. The legacy publisher was never updated, so it still signs
release bundles with the **revoked** key. Every bundle it submits to the
distribution gateway is now rejected with `UNTRUSTED_SIGNATURE`, and firmware
releases are blocked.

Your job is to implement the publisher so that release bundles are reconciled,
signed with the **current** key, submitted to the gateway, and recorded so the
run is idempotent - reproducing a deterministic, graded status report.

## Deliverable

Implement a single file:

```
/app/publisher/release-publisher.mjs
```

It is run (by you and by the grader) with:

```
npm run report        # = node publisher/release-publisher.mjs --report
```

You may only add files under `publisher/`. Do **not** modify the
`distribution-gateway/`, the fixtures, or the golden report.

## What the publisher must do

1. **Ingest.** Load `fixtures/build_manifest.csv` into a DuckDB database file at
   `releases.duckdb` (create it at run time; it is not pre-created).

2. **Reconcile with SQL.** Derive the set of **publishable bundles**:
   - **Collapse exact duplicates.** Rows that are identical across *every* column
     are the same record emitted twice - count them once.
   - **Apply withdrawals.** A `WITHDRAWAL` row cancels the `BUILD` whose
     `entry_id` equals the withdrawal's `supersedes_id`. A cancelled build is not
     part of any release.
   - A bundle is **publishable** if, after the two rules above, it still has at
     least one surviving `BUILD`. A bundle whose every build was withdrawn is
     skipped entirely.
   - For each publishable bundle also compute `artifact_count` (number of
     surviving builds) and `total_bytes` (sum of their `size_bytes`).

3. **Discover the current key.** `GET /v1/signing-key/current` on the gateway
   returns `{ key_id, algorithm, certificate_ref, status }`. Use its `key_id` in
   the output.

4. **Sign.** For each publishable bundle build the canonical descriptor (below)
   and produce a **detached OpenSSL CMS signature (PEM)** over its exact bytes,
   using the **current** keypair:
   - private key: `CURRENT_KEY_PATH` (default `/app/keys/current/current.key.pem`)
   - certificate: `CURRENT_CERT_PATH` (default `/app/keys/current/current.cert.pem`)

5. **Submit.** `POST /v1/publications` with
   `{ descriptor, signature, request_token }`. Use the deterministic token
   `token-<bundle_id>`. A success response is
   `{ publication_id, request_token, status: "PUBLISHED" }`.

6. **Persist + idempotency.** Store each bundle's `request_token`,
   `publication_id`, `key_id`, `status`, `descriptor`, `artifact_count`, and
   `total_bytes` in `releases.duckdb`. On a re-run, replay the stored receipt
   instead of re-signing/re-submitting, so no duplicate publication is created on
   the gateway.

7. **Report.** Print exactly two lines per publishable bundle, ordered
   ascending by `bundle_id`:

   ```
   BUNDLE <bundle_id> SIGNED KEY=<key_id>
   BUNDLE <bundle_id> PUBLISHED RECEIPT=<publication_id> TOKEN=<request_token> STATUS=PUBLISHED
   ```

   This must reproduce `reports/publications.expected.txt` (the grader masks only
   the random `RECEIPT` value).

## Manifest schema

```
entry_id,bundle_id,component_id,version,size_bytes,record_type,supersedes_id,recorded_at
```

- `record_type` is `BUILD` or `WITHDRAWAL`.
- A `WITHDRAWAL` row's `supersedes_id` is the `entry_id` of the `BUILD` it cancels.

## Canonical descriptor

The signed bytes and the bytes sent as `descriptor` must be **identical**. Use
UTF-8 JSON, object keys sorted lexicographically, no insignificant whitespace,
with exactly these three fields:

```
{"artifact_count":<int>,"bundle_id":"<id>","total_bytes":<int>}
```

If the signed bytes differ from the sent bytes by even one character, the gateway
rejects the signature.

## Signing / verification contract

The gateway verifies with:

```
openssl cms -verify -inform PEM -in <sig.pem> -content <descriptor.bin> \
  -certfile $CURRENT_CERT_PATH -CAfile $CURRENT_CERT_PATH \
  -purpose any -no_check_time -binary
```

Sign the detached CMS signature with `openssl cms -sign -binary -outform PEM`
using the current keypair. Signing with the revoked key
(`/app/keys/revoked/`) will not verify against the current certificate and is
rejected as `UNTRUSTED_SIGNATURE`.

## Rules / boundaries

- Interact with the gateway **only over HTTP**. Do not read or modify its private
  ledger at `distribution-gateway/data/gateway.json`.
- Do **not** disable or bypass signature verification.
- Do **not** sign with the revoked key.
- Do **not** hardcode the golden text, receipt ids, or counts - derive everything
  from the manifest so the program stays correct if the manifest changes.
- Keep output ordering deterministic (sort by `bundle_id`).

## Definition of done

- `npm run report` reproduces `reports/publications.expected.txt` (receipt masked).
- The publishable bundle set is correct (fully-withdrawn bundles dropped, exact
  duplicates collapsed).
- Every submission is `PUBLISHED` - nothing is `UNTRUSTED_SIGNATURE`.
- `releases.duckdb` holds the receipts and request tokens used.
- Re-running produces byte-identical output and creates no duplicate publications.
