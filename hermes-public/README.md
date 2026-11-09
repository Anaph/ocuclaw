# Hermes Workspace integration candidate

Tested baseline: **Hermes 0.21.1**, tag `v2026.9.7`, commit
`2237be355906fbe6065ce1815711eee52b2d646e`. Exact original-file hashes are in
`compatibility.json`. SDK 0.0.16 remains pinned in the phone app.

This is a public adapter around **the existing Hermes cron subsystem**. Creation,
updates, parsing, next-run computation, pause/resume/run-now, execution, provider
registration, catch-up and delivery still belong to Hermes. There is no phone
scheduler and no plugin write to `jobs.json`.

`cron/phone_workspace.py` provides validated edits, revision checks, preview proofs,
durable operation receipts, execution/session bindings and addressed live questions
from detached cron workers. Its SQLite journal is a projection and rendezvous;
it does not schedule or retry agent work. A question is visible only while its
exact producer PID/start-time remains alive and its original deadline has not
passed. Completed-result projections retain seven days even when no client is open.

The preparation command adds small public seams to the owners of native job locks,
cron lifecycle/cancellation and gateway question/approval registries. It never reads
private Hermes queues from the plugin. Cancellation feeds the existing native
cancellation path and does not pause the schedule. Job edits take the same native
cross-process lock as CLI/Desktop, with locking failure refusing the phone edit.

The pinned native scheduler resolves cron expressions in the profile's wall-clock
timezone. Nonexistent recurring times are skipped, and an ambiguous recurring
time runs once at its first occurrence. Intervals and relative delays count
elapsed minutes. A one-shot at an ambiguous time needs an explicit offset.
A nonexistent one-shot local time is rejected. New execution
files and session IDs include the execution identifier so repeated local times
preserve separate results.

## Prepare, review, test

Use a **clean local checkout** of the pinned commit and an output directory outside
it. This command only writes reviewed candidate files and their SHA-256 receipt:

```sh
python3 scripts/prepare_hermes_workspace.py /path/to/clean/hermes --output-root /tmp/hermes-workspace-overlay
```

An unsupported source hash or structure is rejected. The input checkout is not
modified. Apply the overlay to a separate disposable candidate checkout for tests;
do not overlay symlinks into the clean input. With the candidate's dependencies
available in an isolated Python 3.11+ test environment:

```sh
PYTHONPATH=/path/to/hermes-candidate python tests_integration/test_hermes_workspace.py
```

Tests use temporary `HERMES_HOME` directories. They exercise real native job APIs,
a real script execution without inference/phone/VPS, cross-process questions,
profile isolation, restart receipts, source revision conflicts and cancellation
addressing. Live inference, STT, Android/G2 and VPS acceptance remain separate.

Deployment must first inspect the running VPS revision and preserve its source,
configuration and databases. Do not copy these files onto another Hermes revision;
prepare and test a compatible candidate instead. No VPS was changed to build this.
