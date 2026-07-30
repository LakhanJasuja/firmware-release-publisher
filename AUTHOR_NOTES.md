# Author Notes - Firmware Release Publisher

Authoring notes for the reviewer. Covers what the task assesses, how the six
parts fit together, the design decisions and traps, the resolved open questions,
and the two required grading proofs.

## 1. Task summary

A build-from-spec task. The candidate implements one worker module,
`publisher/release-publisher.mjs`, that:

1. ingests `fixtures/build_manifest.csv` into DuckDB (`releases.duckdb`);
2. reconciles the manifest with SQL (collapse exact duplicates; drop builds
   cancelled by `WITHDRAWAL` rows; keep bundles with ≥1 surviving build);
3. reads the current signing-key metadata from the Express gateway;
4. signs each bundle's canonical descriptor with a detached **OpenSSL CMS**
   signature using the **current** key;
5. submits signed descriptors to the gateway, persists receipts + idempotency
   tokens in DuckDB, and prints deterministic status lines matching the golden
   report.

The production incident (`UNTRUSTED_SIGNATURE`) is caused entirely by the legacy
publisher signing with the **revoked** key; the gateway is correct and bug-free.

## 2. The six parts

| Part | File(s) | Role |
| --- | --- | --- |
| Task metadata | `task.toml` | Harbor env limits, category/subcategories, timeouts. |
| Instruction | `instruction.md` | Candidate-facing brief; resolves both open questions. |
| Environment | `environment/` | Dockerfile (builds keypairs + deps), fixtures, golden report, and the provided Express `distribution-gateway/`. Candidate slot `publisher/` ships **empty**. |
| Tests | `tests/test.sh`, `tests/test_outputs.py` | Verifier: resets state, starts the gateway, runs the report, grades binary 0/1. |
| Solution | `solution/publish.sh`, `solution/release-publisher.mjs` | Reference oracle: installs the publisher into the candidate slot and runs it. |
| Author notes | `AUTHOR_NOTES.md` | This file. |

## 3. Environment design

- **Keys are generated at image build time** (`environment/Dockerfile`), not
  shipped as static PEM: `keys/current/` (in force) and `keys/revoked/` (the
  rotated-out key). This makes CMS signatures verify cryptographically and makes
  the rotation scenario reproducible.
- **The gateway is fully correct and plants no bugs.** It exposes only
  `GET /v1/signing-key/current` and `POST /v1/publications`; its JSON ledger under
  `data/` is created lazily and is not reachable over HTTP. Signature checks shell
  out to real `openssl cms -verify` against the current certificate.
- `releases.duckdb` is **not** pre-created; the publisher creates it at run time.
  `.gitignore` keeps it and `node_modules/` out of the baseline tree.

## 4. Difficulty devices / traps

1. **Wrong-key trap.** Signing with `keys/revoked/` reproduces the production
   `UNTRUSTED_SIGNATURE`; only the current key verifies. Graded on an independent
   accept path (current) and reject path (revoked), not just via the publisher's
   own stdout.
2. **Exact byte canonicalization.** Signed bytes must equal sent bytes - UTF-8
   JSON, keys sorted lexicographically, no insignificant whitespace.
3. **Reconciliation semantics.** Fully-withdrawn bundles disappear; exact-
   duplicate rows collapse.
4. **Idempotency.** A second run is byte-identical and creates no duplicate
   gateway publications; the gateway's own store is ground truth.
5. **Determinism.** Output is ordered by `bundle_id`; the one non-deterministic
   field (`RECEIPT=<publication_id>`) is masked by the verifier rather than pinned.
6. **Boundaries.** HTTP-only interaction; no reading the gateway's private store;
   no verification bypass.

## 5. Resolved open questions

The scaffold left two reconciliation questions open; both are resolved in
`instruction.md` and encoded in the verifier:

- **Duplicate rule:** a "duplicate manifest row" is a row identical across
  **every** column. Only the exact-across-all-columns invariant is graded.
- **Withdrawal rule:** a `WITHDRAWAL` cancels the `BUILD` whose `entry_id` equals
  the withdrawal's `supersedes_id`. Only the resulting **bundle-membership**
  invariant is graded (per-build exact amount-level netting is intentionally not
  graded).

## 6. Fixture -> expected outcome

`environment/fixtures/build_manifest.csv` (~40 rows) exercises all three
reconciliation behaviours and yields three publishable bundles:

- **BND-101, BND-102, BND-103** - publishable (have surviving builds).
- **BND-104** - every build withdrawn -> dropped entirely.
- Exact-duplicate `BUILD` rows (e.g. MFR-0001 / MFR-0007 / MFR-0014 repeated)
  collapse to one.

Golden output: `environment/reports/publications.expected.txt` (two lines per
publishable bundle, ordered by `bundle_id`; receipt masked at grading time).

## 7. Verifier behaviour

`tests/test.sh` resets `releases.duckdb` and the gateway ledger, starts the
gateway on 7070, waits for `/healthz`, runs pytest, and writes a binary reward.
`tests/test_outputs.py` maps one test per `functional_criteria` entry:

- `report_output_matches` - golden diff (receipt masked).
- `withdrawals_and_duplicates_reconciled` - independently recompute the bundle
  set from the CSV and compare.
- `bundles_signed_with_current_key_accepted` - current-key signature accepted.
- `revoked_key_signature_rejected` - revoked-key signature -> `UNTRUSTED_SIGNATURE`.
- `receipts_and_tokens_persisted_in_duckdb` - read `releases.duckdb`.
- `idempotent_rerun_no_duplicate_publications` - re-run identical; token replay.

The same suite runs for the reference oracle and for the candidate.

## 8. Required grading proofs

- **Empty candidate slot -> reward 0.** With `environment/publisher/` empty,
  `npm run report` fails (no publisher), the golden diff fails, and
  `tests/test.sh` writes `0`.
- **Reference solution -> reward 1.** After `solution/publish.sh` installs
  `solution/release-publisher.mjs` into `publisher/` and runs it, the suite
  passes and `tests/test.sh` writes `1`.

Both were demonstrated in a clean run before submission.

## 9. Originality

The domain (firmware release publishing), all identifiers, schemas, routes,
ports, error codes, and sample data were invented for this task; see
`_originality_note.md`. No reference solution logic was copied from any source
task.
