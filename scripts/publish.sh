#!/usr/bin/env bash
# Publish dsh-model-router to GitHub and npm.
#
# Requires, in the environment:
#   GITHUB_TOKEN  - GitHub PAT (classic, `repo` scope) for the account the
#                   repository will be created under.
#   GITHUB_USER   - GitHub username/org for the repository.
#   NPM_TOKEN     - npm automation token (optional; skip to publish GitHub only).
#
# Usage: GITHUB_TOKEN=... GITHUB_USER=... NPM_TOKEN=... ./scripts/publish.sh
set -euo pipefail

REPO_NAME="dsh-model-router"
REPO_DESC="DeepSeek Harness plugin: role-based model routing — planner on deepseek-v4-pro, executor subagents on deepseek-v4-flash."

cd "$(dirname "$0")/.."

if [[ -z "${GITHUB_TOKEN:-}" || -z "${GITHUB_USER:-}" ]]; then
  echo "error: GITHUB_TOKEN and GITHUB_USER are required" >&2
  exit 1
fi

echo "==> Creating GitHub repository $GITHUB_USER/$REPO_NAME"
CREATE_RESPONSE="$(curl -fsS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d "{\"name\":\"$REPO_NAME\",\"description\":\"$REPO_DESC\",\"has_issues\":true,\"has_wiki\":false}" \
  "https://api.github.com/user/repos")"
echo "$CREATE_RESPONSE" | grep -o '"html_url": *"[^"]*"' || true

echo "==> Pushing to origin"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${REPO_NAME}.git"
git push -u origin main
git remote set-url origin "https://github.com/${GITHUB_USER}/${REPO_NAME}.git"

echo "==> Creating a v0.1.0 release"
git tag v0.1.0
git push origin v0.1.0
curl -fsS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"tag_name":"v0.1.0","name":"v0.1.0","generate_release_notes":true}' \
  "https://api.github.com/repos/${GITHUB_USER}/${REPO_NAME}/releases" >/dev/null && echo "release created"

if [[ -n "${NPM_TOKEN:-}" ]]; then
  echo "==> Publishing to npm"
  npm publish --access public --registry https://registry.npmjs.org/
else
  echo "==> NPM_TOKEN not set; skipping npm publish"
fi

echo "==> Done. Install with: dsh plugin --profile web add $REPO_NAME"
