#!/bin/sh
# tests_manual runner: the bundle repo has no test framework. Every
# test_*.py / test_*.cjs must exit 0; branches with the dist-cjs hand-patch
# also keep scripts/check_dist_patch.sh (run when present).
set -eu
cd "$(cd "$(dirname "$0")/.." && pwd)"
status=0
for t in tests_manual/test_*.py; do [ -e "$t" ] || continue; python3 "$t" || status=1; done
if command -v node >/dev/null 2>&1; then
  for t in tests_manual/test_*.cjs; do [ -e "$t" ] || continue; node "$t" || status=1; done
fi
if [ -f scripts/check_dist_patch.sh ]; then sh scripts/check_dist_patch.sh || status=1; fi
[ "$status" -eq 0 ] && echo "run_tests OK" || echo "run_tests FAILED" 
exit "$status"
