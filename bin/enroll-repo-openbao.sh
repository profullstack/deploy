#!/usr/bin/env bash
# Central operator enrollment. One OpenBao role and one policy per GitHub repo,
# automatically generated; NEVER one long-lived SSH key per repo.
# Run only from an authenticated OpenBao administrator workstation.
# Usage: ./bin/enroll-repo-openbao.sh OWNER/REPO GITHUB_REPO_ID main|master WORKFLOW_SHA
set -euo pipefail

repo="${1:-}"
id="${2:-}"
branch="${3:-}"
workflow_sha="${4:-}"
[[ "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || { echo "invalid owner/repo" >&2; exit 2; }
[[ "$id" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "GitHub repo ID must be numeric" >&2; exit 2; }
[[ "$branch" = main || "$branch" = master ]] || { echo "branch must be main or master" >&2; exit 2; }
[[ "$workflow_sha" =~ ^[a-f0-9]{40}$ ]] || { echo "workflow SHA must be a full lowercase commit SHA" >&2; exit 2; }
command -v bao >/dev/null || { echo "Install the OpenBao CLI first" >&2; exit 2; }

policy="fleet-deploy-repo-$id"
workflow_ref="profullstack/deploy/.github/workflows/ssh-deploy.yml@$workflow_sha"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<EOF
path "ssh-client-signer/sign/repo-$id" {
  capabilities = ["update"]
}
EOF
bao policy write "$policy" "$tmp"

# Bound to THIS repo identity, this protected branch, GitHub push event,
# and only the reviewed immutable central reusable workflow commit.
bao write "auth/github-actions/role/repo-$id" - <<EOF
{
  "role_type": "jwt",
  "user_claim": "repository_id",
  "bound_audiences": ["profullstack-deploy"],
  "bound_claims_type": "string",
  "bound_claims": {
    "repository": ["$repo"],
    "repository_id": ["$id"],
    "ref": ["refs/heads/$branch"],
    "event_name": ["push"],
    "job_workflow_ref": ["$workflow_ref"],
    "job_workflow_sha": ["$workflow_sha"]
  },
  "token_policies": ["$policy"],
  "token_no_default_policy": true,
  "token_ttl": "5m",
  "token_max_ttl": "5m"
}
EOF

# The signer is not allowed to choose another repository's login principal.
bao write "ssh-client-signer/roles/repo-$id" - <<EOF
{
  "key_type": "ca",
  "allow_user_certificates": true,
  "allowed_users": "pfdeploy-$id",
  "default_user": "pfdeploy-$id",
  "ttl": "5m",
  "max_ttl": "5m",
  "allow_user_key_ids": false,
  "allowed_extensions": "",
  "allowed_critical_options": ""
}
EOF
echo "Enrolled $repo@$branch with workflow $workflow_sha: OpenBao roles repo-$id, principal pfdeploy-$id"
echo "Next: enroll pfdeploy-$id on its target host and trust the central USER CA public key."
