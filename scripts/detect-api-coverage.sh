#!/usr/bin/env bash
# detect-api-coverage.sh — Report API route test coverage
#
# Scans apps/api/src/routes/ for route files and checks whether corresponding
# test files exist in apps/api/src/__tests__/ or apps/api/test/.
#
# Exit codes:
#   0 — all routes have at least one matching test file
#   1 — one or more routes are missing tests
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROUTES_DIR="${ROOT_DIR}/apps/api/src/routes"
UNIT_TESTS_DIR="${ROOT_DIR}/apps/api/src/__tests__"
INTEGRATION_TESTS_DIR="${ROOT_DIR}/apps/api/test/integration"

# Colors (use plain text if terminal doesn't support them)
if [ -t 1 ]; then
  GREEN="\033[0;32m"
  RED="\033[0;31m"
  RESET="\033[0m"
  checkmark="${GREEN}✓${RESET}"
  crossmark="${RED}✗${RESET}"
  MISSING_TAG="${RED}MISSING TEST${RESET}"
else
  GREEN=""
  RED=""
  RESET=""
  checkmark="✓"
  crossmark="✗"
  MISSING_TAG="MISSING TEST"
fi

missing_count=0
covered_count=0
total_count=0

printf "\n"
printf "=== API Route Test Coverage Report ===\n"
printf "\n"

for route_file in "$ROUTES_DIR"/*.ts; do
  [ -f "$route_file" ] || continue

  basename_route="$(basename "$route_file" .ts)"
  total_count=$((total_count + 1))

  found_tests=""

  # Check unit test directory for exact name match
  for pattern in "${basename_route}.test.ts" "${basename_route}.route.test.ts"; do
    test_path="${UNIT_TESTS_DIR}/${pattern}"
    if [ -f "$test_path" ]; then
      [ -n "$found_tests" ] && found_tests="${found_tests}, "
      found_tests="${found_tests}$(basename "$test_path")"
    fi
  done

  # Check for related test files (service test, etc.)
  for test_file in "$UNIT_TESTS_DIR"/${basename_route}*.test.ts; do
    [ -f "$test_file" ] || continue
    test_basename="$(basename "$test_file")"
    # Avoid duplicates
    case "$found_tests" in
      *"$test_basename"*) ;;
      *)
        [ -n "$found_tests" ] && found_tests="${found_tests}, "
        found_tests="${found_tests}${test_basename}"
        ;;
    esac
  done

  # Check integration tests
  integ_path="${INTEGRATION_TESTS_DIR}/${basename_route}.test.ts"
  if [ -f "$integ_path" ]; then
    [ -n "$found_tests" ] && found_tests="${found_tests}, "
    found_tests="${found_tests}integration/$(basename "$integ_path")"
  fi

  if [ -n "$found_tests" ]; then
    covered_count=$((covered_count + 1))
    printf "  %s %s (%s)\n" "$checkmark" "$basename_route" "$found_tests"
  else
    missing_count=$((missing_count + 1))
    printf "  %s %s — %s\n" "$crossmark" "$basename_route" "$MISSING_TAG"
  fi
done

# Summary
printf "\n"
printf "%s\n" "--- Summary ---"
printf "  Total routes:    %d\n" "$total_count"
printf "  With tests:      %d\n" "$covered_count"
printf "  Missing tests:   %d\n" "$missing_count"

if [ "$total_count" -gt 0 ]; then
  coverage_pct=$((covered_count * 100 / total_count))
  printf "  Coverage:        %d%%\n" "$coverage_pct"
fi

printf "\n"

if [ "$missing_count" -gt 0 ]; then
  printf "%sSome API routes are missing tests.%s\n" "$RED" "$RESET"
  exit 1
else
  printf "%sAll API routes have corresponding tests!%s\n" "$GREEN" "$RESET"
  exit 0
fi
