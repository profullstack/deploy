# Profullstack fleet deployment: one OIDC trust, one SSH CA, one shared workflow

This design covers **all properties** across `profullstack`, `moshcoder` and additional approved organizations. Do **not** create or copy `PIT_DEPLOY_KEY` or a different SSH private key for each app. Enroll deployments from centrally maintained repo IDs and target records. The inventory in `fleet/properties.txt` is user-supplied and incomplete: it is **not** permission to assume every domain has the same-named GitHub repository or the same deployment host.

## What lives where

- `profullstack/deploy/.github/workflows/ssh-deploy.yml`: one reusable GitHub Actions job. Caller must run its own tests and threat scan first.
- `fleet/targets.json`: central mapping from immutable GitHub `repository_id` to an **explicitly reviewed** owner/repository, main or master branch, host, SSH port and public HTTPS health URL. `enabled=false` blocks a deploy, including the PIT pilot until it is provisioned.
- `fleet/config.json`: the ONE public HTTPS OpenBao URL for the fleet, set once during setup. No secrets are stored here.
- `ssh/known_hosts`: verified SSH host key or a separate SSH **host** CA public key, pinned centrally. It starts deliberately empty.
- `bin/oidc-ssh-deploy.mjs`: creates a fresh Ed25519 key, requests GitHub OIDC proof, exchanges it with OpenBao, gets a five-minute certificate restricted to the repository's login principal, deploys only the GitHub push SHA and checks health.
- `bin/pfdeploy-ssh-receiver`: root-owned SSHD ForceCommand for dedicated unprivileged `pfdeploy-REPO_ID` users. The server verifies the Git remote and that the SHA belongs to the enrolled branch before checking it out and running the app's existing `bin/install.sh` through the existing `deploy-gate`.

**One CA private key** stays in OpenBao; each GitHub job generates a throwaway, independently signed SSH key, not a shared reusable credential. Revocation is via disabling its JWT role or repo registry entry (certificates already issued expire in five minutes). One central SSH CA means rotation requires dual-trusting the old and new public CA briefly on servers; OpenBao supports CA issuers for rotation.

## 1. One-time OpenBao control plane (operator only)

Use a dedicated HTTPS OpenBao deployment (self-hosted, monitored, backed up, audit logs on, tightly firewalled). Never run OpenBao in dev mode in production. Run the following as an authenticated OpenBao administrator (do NOT put the admin token in GitHub):

```bash
bao auth enable -path=github-actions jwt
bao write auth/github-actions/config \
  oidc_discovery_url="https://token.actions.githubusercontent.com" \
  bound_issuer="https://token.actions.githubusercontent.com"
bao secrets enable -path=ssh-client-signer ssh
bao write ssh-client-signer/config/ca generate_signing_key=true
bao read -field=public_key ssh-client-signer/config/ca > profullstack-user-ca.pub
```

The `auth/github-actions/role/repo-ID` and `ssh-client-signer/roles/repo-ID` records must be created **only by an operator** using `bin/enroll-repo-openbao.sh OWNER/REPO REPO_ID main|master`. The script generates roles and policies from identity facts; nobody must hand-manage credentials. An authenticated OpenBao operator may later automate the script from an approved registry sync. Every role binds GitHub `repository`, immutable `repository_id`, exact `ref`, `event_name=push`, audience `profullstack-deploy` and exact central `job_workflow_ref`. Each policy can sign **only** its own SSH role, and each SSH role only its account principal.

**Do not** configure a single wildcard JWT policy that can sign arbitrary SSH principals. That would turn one compromised repo into access to the entire fleet.

Set `fleet/config.json`'s `openbao_url` to this single TLS origin after commissioning it. This is public configuration, **not a secret**.

## 2. Each target host, one CA and generated per-repo isolation

On each target server, install the **public** `profullstack-user-ca.pub` and the root-owned receiver. Verify CA fingerprint through your trusted management channel first. Example PIT repo ID `1423083790`:

```bash
sudo install -d -m 755 /etc/profullstack/deploy /etc/ssh/auth_principals
sudo install -m 644 -o root -g root profullstack-user-ca.pub /etc/ssh/profullstack-user-ca.pub
sudo install -m 755 -o root -g root bin/pfdeploy-ssh-receiver /usr/local/bin/pfdeploy-ssh-receiver
sudo useradd --create-home --shell /bin/bash pfdeploy-1423083790
printf '%s\n' 'pfdeploy-1423083790' | sudo tee /etc/ssh/auth_principals/pfdeploy-1423083790 >/dev/null
printf 'REPOSITORY=moshcoder/pit.world\nBRANCH=main\nCHECKOUT=/opt/pit.world\n' |
  sudo tee /etc/profullstack/deploy/pfdeploy-1423083790.conf >/dev/null
sudo chown root:root /etc/ssh/auth_principals/pfdeploy-1423083790 /etc/profullstack/deploy/pfdeploy-1423083790.conf
sudo chmod 644 /etc/ssh/auth_principals/pfdeploy-1423083790 /etc/profullstack/deploy/pfdeploy-1423083790.conf
```

Configure OpenSSH, keeping these global directives **outside** of any Match section, and the Match block last in `sshd_config`. Preserve your existing admin SSH access, do not disable it during migration:

```sshconfig
TrustedUserCAKeys /etc/ssh/profullstack-user-ca.pub
AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u

Match User pfdeploy-*
    AuthenticationMethods publickey
    ForceCommand /usr/local/bin/pfdeploy-ssh-receiver
    PermitTTY no
    AllowTcpForwarding no
    AllowAgentForwarding no
    PermitTunnel no
    X11Forwarding no
    PermitUserRC no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
```

Before reload, verify `sudo sshd -t` and `sudo sshd -T -C user=pfdeploy-1423083790,host=dev2.profullstack.com,addr=127.0.0.1`. **Do not** overwrite an existing SSHD configuration blindly. Keep an administrative shell open during the transition. Provision the checkout for the unprivileged deploy account and audit `bin/install.sh` and any necessary **narrow sudo permissions**; the current PIT installation runs as root, so **migration of its filesystem/service permissions is required** before enabling this pilot. Do not grant general passwordless root or a shell to deploy accounts.

Each SSH certificate principal is `pfdeploy-REPO_ID`, and only the matching Unix account accepts it. After authentication, the `ForceCommand` ignores arbitrary commands and accepts only `deploy FULL_40_CHARACTER_SHA`. It checks the Git remote and that the target commit is on the approved `origin/main` or `origin/master`. This keeps repo permissions separate without separate private keys.

## 3. Host-key trust is separate from user CA

SSH **user certificates** authenticate GitHub to your server. SSH **host keys** authenticate the server to GitHub. Do not confuse them. Pin the servers' verified host keys centrally in `ssh/known_hosts`, or deploy a separate SSH host CA and trust it there with an `@cert-authority` entry. Verify host CA fingerprints out-of-band. Never disable SSH host-key checking or run unauthenticated `ssh-keyscan` inside CI.

## 4. Every application has the same tiny workflow call

Your app workflow retains its existing project-specific test and security jobs, and gates the shared deploy on them:

```yaml
name: CI and release
on:
  pull_request:
  push:
    branches: [main, master]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "Run this project's real test/build/typecheck here"
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "Run the existing ThreatCrush scan here"
  deploy:
    if: github.event_name == 'push'
    needs: [test, security]
    uses: profullstack/deploy/.github/workflows/ssh-deploy.yml@main
    permissions:
      contents: read
      id-token: write
```

The `echo` commands in the **example above are placeholders**. Do not replace any real CI with those placeholders. Keep your existing tests, build, type checks, and ThreatCrush scan. In production pin the reusable workflow to a reviewed release commit/tag and protect it from unreviewed changes. If deploying across organizations, grant access to the public shared workflow; its OpenBao OIDC policy independently approves the actual calling repository and workflow.

There are **no repository secrets**, no PEM files in CI, and no target host settings in the individual application's workflow. Only `needs` and the reusable workflow reference. GitHub issues OIDC credentials that expire and OpenBao signs the generated public SSH key.

## 5. Migrating PIT and then the fleet

1. Confirm a backed-up, TLS-protected OpenBao and GitHub OIDC verification work.
2. Bind `moshcoder/pit.world` repo ID `1423083790` with `bin/enroll-repo-openbao.sh moshcoder/pit.world 1423083790 main`.
3. Install the one public SSH user CA on dev2, provision the dedicated PIT account, repository checkout ownership and any minimal service permissions. Check SSHD and audit logs.
4. Pin the host key in `ssh/known_hosts` and set `fleet/config.json`'s OpenBao URL.
5. Change PIT's central `fleet/targets.json` entry to `enabled=true` only **after** all checks pass. Change only PIT's deploy job to the reusable workflow; tests and ThreatCrush continue to gate the deployment.
6. Merge and verify `https://pit.world/health` and `https://pit.world/pros/industrial`. Revoke old `PIT_DEPLOY_KEY` only after new authentication works.
7. Map the other properties to **verified GitHub repository IDs and actual hosts**. Add those mappings to `fleet/targets.json`, generate OpenBao roles and server accounts from the registry (batch provisioning), migrate their existing GitHub workflows in reviewable waves (3 at a time), retain the shared `deploy-gate`, and observe failures before expanding.

**Current repository changes are a staged implementation, not a provisioned CA or deployed fleet.** Do not flip `enabled` without real infrastructure. This is intentional fail-closed behavior.

Reference docs:
- https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows
- https://openbao.org/docs/auth/jwt/
- https://openbao.org/docs/secrets/ssh/signed-ssh-certificates/
