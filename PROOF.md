# Grading Proofs - Firmware Release Publisher

Evidence that the task package satisfies the two required proofs **in a clean
container built from `environment/Dockerfile`**:

- **Empty candidate slot -> reward 0** (tests run and fail; not a couldn't-run error)
- **Reference solution applied -> reward 1** (all functional criteria pass)

Both were run in a fresh container image with no host state. The container CLI
below is `finch` (Amazon's Docker-compatible CLI); substitute `docker` verbatim
if you have Docker - the commands are identical.

## 0. Build the image

Build context is `environment/` (that is where the Dockerfile's `COPY` paths are
rooted). The Dockerfile generates the current + revoked signing keypairs at build
time and installs the gateway deps, `duckdb`, and the pytest toolchain.

```bash
cd environment
finch build -t fw-publisher-task:proof -f Dockerfile .
# (docker build -t fw-publisher-task:proof -f Dockerfile .)
```

## Grading model

- The Dockerfile lays the `environment/` contents down at `/app`. The candidate
  deliverable slot `/app/publisher/` ships **empty**.
- The verifier `tests/` is mounted at `/tests`; `tests/test.sh` resets state,
  starts the gateway on `:7070`, waits for readiness, runs pytest, and writes a
  binary reward to `/logs/verifier/reward.txt`.
- The reference solution `solution/` is mounted at `/solution`;
  `solution/publish.sh` installs the reference publisher into `/app/publisher/`
  (install only). Starting the gateway, running `npm run report`, and grading is
  the verifier's job (`tests/test.sh`), not the installer's.

## 1. Proof - empty candidate slot -> reward 0

```bash
finch run --rm -v "$PWD/tests:/tests:ro" -w /app fw-publisher-task:proof \
  bash -lc 'mkdir -p /app/publisher; bash /tests/test.sh; cat /logs/verifier/reward.txt'
```

Observed:

```
../tests/test_outputs.py FF..FF                                          [100%]
PASSED tests/test_outputs.py::test_current_key_signature_accepted
PASSED tests/test_outputs.py::test_revoked_key_signature_rejected
FAILED tests/test_outputs.py::test_report_output_matches_golden
FAILED tests/test_outputs.py::test_withdrawals_and_duplicates_reconciled
FAILED tests/test_outputs.py::test_receipts_and_tokens_persisted_in_duckdb
FAILED tests/test_outputs.py::test_idempotent_rerun_no_duplicate_publications
========================= 4 failed, 2 passed in 0.53s ==========================
pytest exit code: 1
REWARD_FILE=0
```

- **reward = 0.**
- **pytest exit code = 1** (tests ran and failed) - not `>=2` (couldn't run).
- The 4 publisher-dependent tests fail; the 2 gateway signature-path tests still
  pass because they exercise the gateway directly, guarding that verification is
  real and not bypassed. This is what makes grading sensitive to the solution.

## 2. Proof - reference solution applied -> reward 1

```bash
finch run --rm \
  -v "$PWD/tests:/tests:ro" -v "$PWD/solution:/solution:ro" -w /app \
  fw-publisher-task:proof \
  bash -lc 'bash /solution/publish.sh; bash /tests/test.sh; cat /logs/verifier/reward.txt'
```

Observed:

```
release-publisher(solution): installing reference publisher -> /app/publisher/release-publisher.mjs
../tests/test_outputs.py ......                                          [100%]
PASSED tests/test_outputs.py::test_report_output_matches_golden
PASSED tests/test_outputs.py::test_withdrawals_and_duplicates_reconciled
PASSED tests/test_outputs.py::test_current_key_signature_accepted
PASSED tests/test_outputs.py::test_revoked_key_signature_rejected
PASSED tests/test_outputs.py::test_receipts_and_tokens_persisted_in_duckdb
PASSED tests/test_outputs.py::test_idempotent_rerun_no_duplicate_publications
============================== 6 passed in 1.72s ===============================
pytest exit code: 0
REWARD_FILE=1
```

- **reward = 1.** All six functional criteria pass.

## 3. Gateway self-tests (bug-free provided service)

```bash
finch run --rm -w /app/distribution-gateway fw-publisher-task:proof \
  bash -lc 'CURRENT_CERT_PATH=/app/keys/current/current.cert.pem node --test tests/'
```

Observed:

```
# tests 5
# pass 5
# fail 0
```

## Summary

| Scenario | pytest exit | reward |
| --- | --- | --- |
| Empty candidate slot | 1 (ran, failed) | **0** |
| Reference solution applied | 0 | **1** |
| Gateway self-tests | - | 5/5 pass |

Both required proofs hold in a clean container built from `environment/Dockerfile`.
