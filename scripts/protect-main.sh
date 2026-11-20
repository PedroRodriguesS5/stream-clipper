#!/usr/bin/env bash
# Protects main: no direct pushes; every PR needs 1 approving review (from the maintainer)
# plus green "Build & test", "Secret scan" and "Dependency audit". Admins may merge their
# own PRs after CI (GitHub never lets an account approve its own PR).
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
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
echo "main is protected on ${REPO}: PRs only, 1 approval + CI required."
