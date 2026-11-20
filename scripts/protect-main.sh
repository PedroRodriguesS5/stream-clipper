#!/usr/bin/env bash
# Makes the CI checks required on main: no direct pushes, every change goes through a PR
# that passes "Build & test", "Secret scan" and "Dependency audit".
# Usage (after the first push): scripts/protect-main.sh [owner/repo]
set -euo pipefail
REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
gh api -X PUT "repos/${REPO}/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Build & test", "Secret scan", "Dependency audit"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
echo "main is protected on ${REPO}: PRs only, CI must pass."
