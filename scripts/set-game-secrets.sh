#!/usr/bin/env bash
#
# set-game-secrets.sh — provision the Beer Game's NON-callback secrets.
#
# The shared classroom<->game callback secret (CLASSROOM_CALLBACK_SECRET) is handled
# by the platform's scripts/spawn-secret.sh. The Beer Game is a guest app (Enno's),
# so it declares a few EXTRA secrets the standard games don't:
#   • CLASSROOM_PROVISION_SECRET  — authenticates the classroom's server-to-server
#                                   call into provisionClassSession/finalizeClassSession
#                                   (generated fresh here).
#   • ADMIN_EMAIL / APP_BASE_URL / MAIL_FROM / SMTP2GO_API_KEY — Enno's built-in
#                                   instructor-signup + email flow. Unused by the
#                                   classroom path, but declared, so they must exist
#                                   for the deploy. Set to sensible values/placeholders.
#
# Writes each to the game project's Secret Manager AND to functions/.secret.local
# (the emulator mirror), following spawn-secret.sh's invariants: values are piped via
# stdin only (never echoed/argv), written with `printf '%s'` (no trailing newline).
#
# Idempotent: existing Secret Manager secrets get a NEW VERSION; .secret.local keys
# are upserted (other keys preserved). Prints nothing secret.
#
# Prereq: Secret Manager API enabled on the project, and gcloud authenticated with
# access to it (see the deploy runbook). Does NOT enable APIs or grant IAM.

set -euo pipefail

PROJECT="beergame-mygames-live"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTIONS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)/functions"
LOCAL_FILE="${FUNCTIONS_DIR}/.secret.local"

if [[ ! -d "$FUNCTIONS_DIR" ]]; then
  echo "  [FATAL] ${FUNCTIONS_DIR} not found — run from the beergame repo." >&2
  exit 2
fi

# ── The extra secrets (name → value). CLASSROOM_PROVISION_SECRET is generated. ──
PROVISION_SECRET="$(openssl rand -base64 32)"

# Parallel arrays (bash 3 compatible — macOS default).
NAMES=(CLASSROOM_PROVISION_SECRET ADMIN_EMAIL APP_BASE_URL MAIL_FROM SMTP2GO_API_KEY)
VALUES=("$PROVISION_SECRET" "ekatok@utdallas.edu" "https://beergame.mygames.live" "ekatok@utdallas.edu" "unused")

overall_ok=1

# write_sm <name> <value>  — value read from stdin only, never as an argument.
write_sm() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    if printf '%s' "$value" | gcloud secrets versions add "$name" --project "$PROJECT" --data-file=- >/dev/null 2>&1; then
      echo "  [OK]   ${name}: added new version  (project ${PROJECT})"
    else
      echo "  [FAIL] ${name}: could not add a new version  (project ${PROJECT})" >&2; overall_ok=0
    fi
  else
    if printf '%s' "$value" | gcloud secrets create "$name" --project "$PROJECT" --replication-policy=automatic --data-file=- >/dev/null 2>&1; then
      echo "  [OK]   ${name}: created  (project ${PROJECT})"
    else
      echo "  [FAIL] ${name}: could not create  (project ${PROJECT})" >&2; overall_ok=0
    fi
  fi
}

# upsert_local <name> <value> — replace this key's line in .secret.local, keep others,
# append with NO trailing newline on the final line (whitespace-mismatch invariant).
upsert_local() {
  local name="$1" value="$2" other=""
  [[ -f "$LOCAL_FILE" ]] && other="$(grep -v "^${name}=" "$LOCAL_FILE" || true)"
  {
    [[ -n "$other" ]] && printf '%s\n' "$other"
    printf '%s' "${name}=${value}"
  } > "$LOCAL_FILE"
}

echo "Provisioning Beer Game extra secrets (project ${PROJECT}):"
for i in "${!NAMES[@]}"; do
  write_sm "${NAMES[$i]}" "${VALUES[$i]}"
  upsert_local "${NAMES[$i]}" "${VALUES[$i]}"
done

unset PROVISION_SECRET VALUES
echo
if [[ "$overall_ok" -eq 1 ]]; then
  echo "✅ Extra secrets provisioned (values not shown). CLASSROOM_PROVISION_SECRET was"
  echo "   generated; when we wire the classroom side it reads the value from Secret Manager."
  exit 0
else
  echo "❌ One or more secrets failed — see [FAIL] lines. Fix before deploying." >&2
  exit 1
fi
