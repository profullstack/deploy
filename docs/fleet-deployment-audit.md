# Fleet deployment security and readiness audit

**Audit date:** 2026-10-31
**Implementation reviewed:** `profullstack/deploy` merge commit `d91e84f93230232410c231d48e47df122631fbf5` (PR #2), plus the hardening changes on branch `audit/fleet-deployment-readiness`.
**Verdict:** **NOT PRODUCTION READY.** The software path passed isolated end-to-end tests after fixes, but the production trust boundaries and infrastructure have not been provisioned or verified. Do not enable the PIT target or migrate another application yet.

## Executive summary

The design can remove permanent per-application SSH private keys: each runner creates an ephemeral Ed25519 key, obtains a short-lived OpenSSH user certificate through GitHub OIDC and OpenBao, and logs in as a repository-specific unprivileged account. The receiver enforces a forced deploy command, checks the repository and branch, rejects rollbacks, runs install behind a host-wide semaphore, and the runner checks HTTPS health.

The central implementation was **not merely syntax checked**. In a disposable environment, OpenBao 2.7.2 issued a certificate from a synthetic OIDC JWT; a local OpenSSH server authenticated it; the real client and receiver deployed an approved test commit as a non-root user; invalid principals, commands, branches, SHA values, and rollback attempts were rejected; and the test health endpoint passed. Separate tests covered role and policy revocation behavior, certificate expiry, gate concurrency and failure paths.

That is not production evidence. No production OpenBao, production CA, real GitHub-issued OIDC token, dev2 SSHD configuration, deploy account, known host key, or production deployment was available to verify. PIT remains disabled in the registry and still uses its old root/static-key workflow. The merged implementation authorized the mutable central `main` ref without binding `job_workflow_sha`. This audit branch fixes that path: callers must pin the central workflow to a commit, OpenBao roles bind both `job_workflow_ref` and `job_workflow_sha`, and the called workflow checks out its own helper code from `${{ job.workflow_sha }}`. Central `main` still lacks branch protection and should be protected before rollout.

## Architecture verification

### Verified in code and isolated tests

- The reusable workflow is declared with `workflow_call`, restricts its job to `push` on `main` or `master`, grants only `contents: read` and `id-token: write`, and groups deploy jobs by caller repository ID.
- The client resolves the host and health URL from `fleet/targets.json` by runner-provided `GITHUB_REPOSITORY_ID`; it verifies the owner/repo and ref too. Unknown, disabled, or mismatched targets fail closed.
- GitHub's OIDC request endpoint must be HTTPS. The token audience is `profullstack-deploy`; OpenBao login and sign API failures return nonzero without printing response bodies or tokens.
- A fresh Ed25519 key is generated in a mode-restricted temporary directory. The private key is used only by that run and removed in `finally`. SSH is invoked with `-F /dev/null`, strict host-key checking, the central known-hosts file, and no key-scan or insecure fallback.
- The enrollment helper creates one JWT role, one signer policy, and one SSH signer role per repository ID. The JWT role binds repository name, immutable repository ID, branch ref, push event, audience, exact reusable workflow ref, and exact reusable workflow SHA. The signer policy can sign only that repository's signer role; that role allows only `pfdeploy-REPO_ID`.
- GitHub documents `job.workflow_repository` and `job.workflow_sha` for checking out a reusable workflow's own source. The shared workflow now uses those fields so the helper checkout matches the exact workflow code. This context is documented for GitHub.com; it is not available on GitHub Enterprise Server.
- The receiver is configured as an SSH `ForceCommand`. A local disposable `sshd -T` check confirmed `TrustedUserCAKeys`, `AuthorizedPrincipalsFile`, `ForceCommand`, no TTY, and no TCP forwarding. The receiver rejected arbitrary shell commands and accepts only a full 40-character lowercase commit SHA.
- The receiver checks a root-owned non-symlink enrollment file, canonical checkout path, root-owned/non-writable parent chain, non-symlink `.git` metadata, checkout ownership, expected Git remote, enrolled branch ancestry, and forward-only progression before checking out the SHA. The local certificate principal was tied to the matching unprivileged Unix account. The app install command ran as UID 1000 in the fixture; no sudo was granted.
- The receiver clears inherited deploy-gate overrides, requires the root-provisioned shared gate, and fails closed if it is missing or unsafe. The hardened gate uses three cross-user root-owned lock files by default, refuses unsafe/symlinked files, waits for the configured memory floor, releases its slot on timeout, and has no timeout bypass.
- Health checks reject redirects, retry transient failures, and fail the deployment if the endpoint never returns success. A regression test now covers an HTTP 503 response.

### Concurrency and failure reporting

The reusable workflow's concurrency group is repository-specific and uses `cancel-in-progress: false`. GitHub allows one running and one pending run per group by default; a newer pending run replaces the older pending run, so this is not a FIFO deploy queue. The running run is not cancelled, and the newest surviving run deploys its own immutable `GITHUB_SHA`. The host-wide `deploy-gate` is a separate semaphore with a default of three slots shared by every migrated deployment that uses the same provisioned lock directory. Its timeout and memory failures return exit 75; SSH, install, and final health-check failures also leave the job failed. Existing deployments that bypass the gate are outside that limit.

### Not verified against real GitHub

GitHub's current OIDC documentation lists `repository`, `repository_id`, `ref`, `event_name`, `job_workflow_ref`, and `job_workflow_sha` among the relevant claims for reusable workflows. Its documentation also requires `id-token: write` in the calling workflow/job and permits public reusable workflows across organizations subject to each caller organization's Actions policy. The claim names and intended format were checked against the docs, and the isolated role matched synthetic claims. **No token from a real GitHub Actions run was exchanged with OpenBao.** Therefore the production issuer, audience, exact claim values, cross-organization policy, and organization-specific workflow access remain unverified.

Current official references:

- GitHub OIDC: https://docs.github.com/en/actions/reference/security/oidc
- Reusable workflows: https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- GitHub job context for reusable workflow source: https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context
- Workflow concurrency: https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency
- OpenBao JWT auth: https://openbao.org/docs/auth/jwt/
- OpenBao JWT API: https://openbao.org/docs/api/auth/jwt/
- OpenBao SSH signed certificates: https://openbao.org/docs/secrets/ssh/signed-ssh-certificates/
- OpenBao audit configuration: https://openbao.org/docs/configuration/audit/

## Findings

### High: central branch protection is absent; immutable role binding must be used

The merged implementation authorized `profullstack/deploy/.github/workflows/ssh-deploy.yml@refs/heads/main`, did not bind `job_workflow_sha`, and checked helper code out from mutable `main`. The central GitHub API check returned “branch not protected” for `main`. On this audit branch, callers pin a commit, the enrollment helper binds the exact `job_workflow_ref` and `job_workflow_sha`, and the called workflow checks out its own source using GitHub's `job.workflow_repository` and `job.workflow_sha` context. A changed central commit therefore fails OpenBao authentication until an operator reviews and updates the repo role. The branch protection gap remains a governance risk and must be closed before rollout.

**Fix before production:** protect central `main` with required review and checks; use the same reviewed commit SHA in each caller and OpenBao role; verify the OIDC `job_workflow_sha` from a real Actions run; and document how approved revisions are rolled out. Pin third-party actions to full commit SHAs as part of the same review.

### High: tests and security scans are caller-controlled

The shared workflow cannot inspect the caller's `needs` graph. A repository can call the deploy workflow without waiting for tests, builds, type checks, or ThreatCrush. The central CI workflow at the reviewed merge commit ran `npm test` only; its green run does not establish application gates. The shared example contains placeholder test/scan commands.

**Fix before each app migration:** preserve the app's real test/build/typecheck/security jobs, make the reusable deploy job depend on all required jobs, and configure required branch checks/rulesets. Audit each workflow individually; do not infer gates from the shared workflow.

### High: production identity, host and account provisioning is absent

`fleet/config.json` has an empty OpenBao URL, `ssh/known_hosts` has no pinned host key, PIT's registry target is disabled, and no production CA, OpenBao JWT role, SSHD CA trust, account, principal file, or receiver enrollment was verified. There was no production read or write to dev2 and no SSHD change was made. The implementation is deliberately unable to deploy until bootstrap completes.

**Fix:** provision and test the production control plane and a canary host using the runbook below, with operator-controlled backups and recovery. Keep PIT disabled until all prerequisites pass.

### High: PIT still requires a non-root deployment design

The existing PIT deployment runs as root. The new receiver correctly executes app installation as `pfdeploy-1423083790`; it does not grant sudo. PIT's installer needs dependencies, runtime/service setup, environment files, Nginx/TLS integration, and restart permissions. Those filesystem/service boundaries have not been migrated or tested. Granting blanket passwordless sudo would defeat the isolation.

**Fix:** define service ownership and secrets access for the dedicated account, pre-provision runtime and service units, and use only narrowly scoped root-owned helpers where necessary. Prove restart and rollback in a disposable PIT-like host before production.

### High: revoking a role alone leaves existing token signing access

In OpenBao 2.7.2 testing, deleting a JWT role prevented new logins, but a token already issued by that role could still call the signer while its policy remained. Deleting the repo signing policy then blocked that token. Disabling a fleet registry entry only blocks the central client; it does not invalidate a previously issued certificate or OpenBao token.

**Fix:** the runbook now requires disabling the target, deleting the JWT role and removing its signing policy; to block an already-issued certificate immediately, remove the user's authorized principal or disable the account on the host. Existing certs otherwise remain valid until their expiry.

### Medium: real OpenBao audit, CA recovery, and rotation are not commissioned

The disposable OpenBao test validated the JWT and SSH signing API formats and the enrollment helper. It did not validate production TLS, HA, unseal/recovery, durable audit delivery, backup restore, or rotation. OpenBao 2.7.2 rejected enabling an audit device through the API in the isolated instance; its audit device must be configured declaratively. No production audit configuration or restore test is available.

**Fix:** configure persistent audit devices declaratively on all HA nodes, test both login and signing events plus failure alerting, and run a restore and dual-trust CA rotation rehearsal before production enrollment.

### Medium: registry coverage is not established

`fleet/targets.json` contains exactly one entry: PIT, disabled. `fleet/properties.txt` is an unverified inventory and is not a mapping source. No domains were mapped to GitHub repository IDs, protected branches, hosts, health checks, or server accounts. Cross-organization claim behavior is documented but not tested with `profullstack` and `moshcoder` production org settings.

**Fix:** add a target only after independently verifying repository ID, branch, DNS/host ownership, health URL, server, service user, owner approval, and authorized principal. Unknown IDs must remain disabled; do not infer names from domains.

### Medium: runtime and checkout assumptions require per-host review

The receiver requires a dedicated checkout and runs its `bin/install.sh` under the per-repository account. It does not itself establish checkout ownership, service permissions, environment-file protection, per-app systemd policy, or that every other deploy path on the host shares the gate. The gate caps concurrency only for deploy paths that use it; legacy or operator scripts can still bypass it.

**Fix:** inventory all deployment entry points on each host, migrate them to the shared gate, validate account/group/file permissions, and test service start/stop under the real service manager. Keep app code and secrets isolated per account.

## Bugs fixed on the audit branch

- OpenBao's signed certificate response ended in newlines; the client appended another newline, creating an invalid extra line that caused `ssh-keygen -L` to warn. The client now trims and validates a single certificate line before writing it. Regression tests cover valid and malformed responses.
- `deploy-gate` now refuses unsafe lock directories, symlinked slot files, missing lock files, invalid bounds, and low-memory continuation. It releases the slot on low-memory timeout, ignores the old timeout bypass, and validates nested gate markers against the process ancestry.
- Added root-only `bin/setup-deploy-gate` to provision root-owned shared slot files and reboot-persistent tmpfiles configuration.
- The SSH receiver clears gate environment overrides and fails closed if the shared gate is unavailable; it no longer runs install ungated.
- The OpenSSH call ignores ambient client configuration with `-F /dev/null`.
- The receiver now rejects symlinked or traversal checkout paths, unsafe parent directories, symlinked Git metadata, and checkouts not owned by the dedicated deployment account.
- `bin/enroll-repo-openbao.sh` is now executable as its documented `./bin/...` command.
- OpenBao enrollment now requires a full workflow SHA and binds both `job_workflow_ref` and `job_workflow_sha`; the reusable workflow checks out its own tools at `job.workflow_sha`.
- Deploy scripts wired to `deploy-gate` now fail closed if the gate executable is missing.
- Documentation now states the caller-side CI requirement, host-gate provisioning, OpenBao revocation semantics, declarative audit setup, and a CA rotation/recovery procedure.

## Tests executed and results

### Repository and workflow checks

- Reviewed merge commit `d91e84f93230232410c231d48e47df122631fbf5`, PR #2, current workflow, registry, scripts, and tests.
- Merge CI run `41192340522` succeeded on that commit. Its only job ran `npm test`; it did not run security scanning, a real GitHub OIDC exchange, or deployment.
- `npm test` on the hardened audit branch: **31 tests pass** (local final run; hosted PR CI is still required).
- `node --check bin/oidc-ssh-deploy.mjs`: passed.
- `bash -n bin/enroll-repo-openbao.sh`, `bash -n bin/pfdeploy-ssh-receiver`, `bash -n bin/deploy-gate`, and `bash -n bin/setup-deploy-gate`: passed. The scripts are also covered by the repository test suite.
- ShellCheck: passed with no findings. The signal handler is called by a trap and is documented as such.
- `actionlint` was not installed in the audit environment. The GitHub workflow was reviewed manually and will be exercised by the PR's hosted check; no claim is made that it passed actionlint.

### Disposable OpenBao and SSH environment

- OpenBao 2.7.2 ran locally in dev mode with an in-memory disposable CA; a synthetic RSA JWT issuer and test-only claims were used. No production token, CA, or endpoint was used.
- The actual enrollment helper configured a repo role and policy bound to `job_workflow_ref` and `job_workflow_sha` for `d91e84f93230232410c231d48e47df122631fbf5`. A synthetic JWT with that exact pinned SHA logged in; changing only the workflow SHA was rejected with HTTP 400. JWT login returned a five-minute token; SSH signing returned a certificate for only `pfdeploy-1423083790` with the requested five-minute lifetime. OpenBao's `valid_after` was 30 seconds before issuance and `valid_before` five minutes after issuance.
- A disposable Debian/OpenSSH server trusted the test CA with `TrustedUserCAKeys`, used `AuthorizedPrincipalsFile` and `ForceCommand`, and authenticated the valid cert. The receiver deployed test commit `dae587c57da41454868ca6e977833d37e3506041`; the fixture's install process ran as UID 1000, and the health endpoint returned success.
- The fixture rejected arbitrary shell input, malformed SHA input, a principal for a different repo, a server enrollment with a mismatched Git remote, a symlink checkout, a traversal path, a feature-branch commit, and a rollback. A short-lived certificate authenticated before expiry and failed after expiry.
- Unauthorized repository and branch JWTs and a foreign principal signing request were rejected by OpenBao. Role deletion blocked a new login; policy deletion blocked an already-issued token from signing.
- An isolated declarative audit configuration wrote request and response records. Attempting to enable the audit device through the API returned HTTP 400 on OpenBao 2.7.2.
- The gate tests launch six jobs against three slots and assert the observed peak is exactly three. Tests also cover queued timeout, nested invocations, a daemon not retaining the lock, memory timeout/release, unsafe lock directories, symlink slots, and rejection of the old bypass flag.
- A disposable full client path used a local HTTPS OIDC fixture, test OpenBao, pinned test SSH host key, the actual client, the actual SSH receiver, and the health endpoint. It deployed the approved commit and reported `Health check passed` both before and after the path-safety changes. The real GitHub reusable-workflow context was not available in that fixture.

These tests validate the software behavior in isolation. They do **not** substitute for a GitHub-issued OIDC token, production OpenBao, dev2, or a production service health check.

## Explicit answers to the ten questions

1. **Functional or only syntactically valid?** More than syntax: the core issuance-to-SSH-to-deploy-to-health path worked in a disposable test. Production functionality remains unverified.
2. **OpenBao APIs and role options correct?** JWT login, signer role, policy, and SSH signing request/response formats worked against OpenBao 2.7.2. Production issuer discovery, token claims, HA, audit, and recovery remain unverified.
3. **Can one compromised repository deploy another app?** The tested role/policy/principal design denied a foreign repo/principal. Each repository has a separate signing policy and principal. The audit branch also requires a pinned central workflow SHA in both caller and OpenBao role, and checks out matching helper code; central branch protection and host account isolation remain required before production.
4. **Can a workflow trick the receiver into an unauthorized commit?** The receiver rejected feature-branch and rollback SHAs. The client deploys runner `GITHUB_SHA`, while the receiver verifies that SHA is on the enrolled branch and forward from current HEAD. It does not cryptographically bind the SSH certificate to a commit; branch protection, trusted shared workflow code, and the receiver's ancestry checks are required controls.
5. **Can app deploy scripts compromise root?** The new receiver itself runs app code under a dedicated non-root account and does not grant sudo. Root compromise is not demonstrated by the code path. Production safety depends on not adding broad sudo and on isolating service secrets and host processes.
6. **Does it support multiple GitHub organizations?** The stable repository ID and standard GitHub claims are organization-neutral, and a public reusable workflow can be called cross-org if the caller's Actions policy permits. Real org policy and OIDC were not tested. Only PIT is mapped.
7. **Will the server workflow work with existing app permissions?** Not established. PIT currently runs deployments as root; its runtime, service, Nginx/TLS, environment file, and checkout permissions need migration. No production account was tested.
8. **Does it remove permanent per-app SSH keys?** Yes, the new design requires no application SSH private key. During migration, existing keys must remain until the new path succeeds; PIT still uses `PIT_DEPLOY_KEY` in its legacy workflow.
9. **Can the CA rotate without breaking deploys?** OpenBao supports multiple issuers, and dual public-key trust can enable overlap. A production rotation was not performed. A staged, documented runbook was added; rehearse it before rollout.
10. **Can failures be diagnosed and recovered?** Test errors fail closed and include service status/receiver/gate errors; the new docs cover logs, revocation and forward-revert recovery. Production audit persistence, restore, alerting, access retention, and recovery were not tested.

## Original PIT SSH failure

GitHub run `41184952985` confirms the legacy workflow attempted `root@dev2.profullstack.com` with `deploy $SHA` and received `Permission denied (publickey)` (SSH exit 255). The reported command `grep -n 'pit-world-deploy' /root/.ssh/authorized_keys` found no matching comment/string. That establishes only that no matching line contained that string; it does not establish whether the configured key was absent, mismatched, revoked, sourced from another `AuthorizedKeysFile`/command, or whether another SSH authorization mechanism applied.

The audit credentials could not inspect PIT repository Actions secrets or the production host's SSH configuration/logs. Therefore the exact cause is **undetermined**. Do not remove or rotate the old key during migration; inspect the secret name/value metadata without exposing the value, effective SSHD config, root's `AuthorizedKeysFile`, key fingerprints, and server auth logs with the host operator.

## Unverified infrastructure assumptions and production blockers

- OpenBao production installation, TLS endpoint, HA/storage, init/unseal/recovery controls, backup restore, audit sink, GitHub OIDC trust, repo roles, signer mount, and central CA do not exist or were not verified.
- GitHub's actual OIDC claims for a reusable workflow were not captured. No production `id-token: write` execution has authenticated to OpenBao.
- No verified host keys exist in `ssh/known_hosts`; no target server certificate auth, user account, principal file, restricted SSHD block, or receiver install was checked on dev2.
- PIT's target is disabled. No real deployment, service restart, health failure, or rollback recovery has been tested.
- The fleet inventory is unverified and contains no authoritative mappings. Do not generate roles/accounts or enable targets from the properties list alone.
- Central `main` is unprotected, though the audit branch requires exact workflow SHA pinning; caller CI dependencies are not enforced by the central workflow.
- No production evidence confirms all existing deployment entry points use the host-wide gate. Only gated receiver deployments are bounded by this implementation.
- CA backup/restore, revocation, audit retention/alerting and rotation need operator-owned runbooks and rehearsal.

## Operational runbook

### Before enrolling any repository

1. Protect the central deployment branch and app deploy branches. Pin the reviewed reusable workflow to an approved immutable SHA; enroll that same SHA in OpenBao. Confirm the helper checkout uses the called workflow's own repository and SHA.
2. Provision OpenBao with supported persistent storage, TLS, separated unseal/recovery control, encrypted snapshots, restore testing, monitoring, and declarative durable audit sinks. Keep CA private material inside OpenBao.
3. Configure the GitHub OIDC issuer/audience and a repository-specific JWT role. Capture a real test-run claim set securely and verify exact `repository`, `repository_id`, `ref`, `event_name`, `job_workflow_ref`, `job_workflow_sha`, and `aud` before issuing any production signing token.
4. Verify the repository, branch protection, target host, DNS, health URL, app owner, service account, runtime, secrets, restart, and rollback plan. Create an explicit disabled target and review it. Never infer mappings from a domain name.
5. Provision the root-owned deploy gate with `bin/setup-deploy-gate` and every account on that host. Confirm every legacy and new deploy path shares it. Test simultaneous runs and low-memory behavior.
6. Provision one non-root per-repository account, root-owned enrollment and principal files, restricted `ForceCommand` configuration, checkout ownership, and only narrowly scoped service helpers. Preserve admin access and all current working authorization.
7. Pin and verify server host keys out-of-band. Never use `ssh-keyscan` in GitHub Actions or disable checking.
8. Test login, certificate principal, forced command, approved commit, wrong repo, wrong branch, rollback, arbitrary command, gate failure, install failure, health failure, and recovery using isolated credentials and hosts first.

### Revoke one repository

Set its central target to disabled; delete `auth/github-actions/role/repo-ID`; remove `fleet-deploy-repo-ID`'s signer policy (or its signer capability); then remove the host principal or disable the account if immediate cert rejection is required. Verify new login and signing fail, existing cert behavior is understood, and record the operator/action in durable audit logs. Do not assume the registry flag revokes already-issued authority.

### Rotate the CA

Create a new issuer; distribute and verify the new public CA alongside the old CA; validate SSHD config and test both issuers on a canary; switch signing to the new issuer; monitor; retain old trust for the maximum certificate lifetime and rollback window; then remove old trust and verify rejection. Keep an administrative session and tested old-signer rollback throughout. Do not rotate production credentials as part of ordinary tests.

### Recover a failed deploy

Use the failed GitHub job SHA and timestamp to correlate OpenBao audit, host auth, receiver, deploy-gate, app installer/service logs, and health result. Restore service with a reviewed forward revert commit that passes the same gates. If forward deployment is impossible, follow an explicitly authorized operator procedure, preserve audit evidence, and do not bypass the gate or grant the app user unrestricted sudo. Verify the health endpoint from a fresh external request after recovery.

## PIT migration plan

Keep the target disabled until each step is signed off by the operator:

1. Back up the current deployment configuration and verify administrative recovery access.
2. Provision production OpenBao securely, validate real GitHub OIDC claims, configure durable audit, and create a disposable test CA before production CA setup.
3. Create the central CA and distribute only its public key after fingerprint verification. Configure dev2 trust only with explicit operator authorization; retain existing root SSH authorization and keep an admin session open.
4. Provision PIT's restricted account and service ownership. Migrate the root-owned installer operations without broad sudo; test restart, secrets, logs, health, and rollback on an isolated host.
5. Pin verified dev2 host keys. Add the approved PIT mapping and OpenBao role only after repo ID, `main`, host, principal, health endpoint, central immutable workflow SHA, and app CI rules are reviewed.
6. Replace only PIT's legacy deploy job with the shared workflow; retain existing tests and ThreatCrush gates and require them on protected `main`.
7. Enable PIT after all checks. Deploy a reviewed commit, verify `https://pit.world/health` and the PIT Pro category/company metadata from a fresh external request, inspect service restart and logs, and execute the rollback/recovery rehearsal.
8. Revoke `PIT_DEPLOY_KEY` only after successful verification and operator sign-off. Keep a securely controlled recovery record until the migration is accepted.

## Staged fleet rollout

1. **Phase 1 — Isolated OIDC + OpenBao + SSH certificate tests:** use a disposable OpenBao, CA, GitHub test repository/workflow, SSH server and application; verify real GitHub claims, issue/expire/revoke certs, unauthorized repos/branches, failure cases, gate concurrency and health.
2. **Phase 2 — PIT pilot:** complete the migration steps above; use PIT as the single production canary and observe through a defined stability window.
3. **Phase 3 — Three low-risk applications:** select three properties only after owners, repository IDs, hosts, branch protections, service permissions and health endpoints are verified. Migrate and observe one at a time while preserving the shared per-host three-slot gate.
4. **Phase 4 — Controlled fleet batches:** build an authoritative repository-to-host registry. Roll out in small reviewed batches, stop on any failed check, verify each external health path, and reconcile inventory against GitHub and actual hosts. Do not assume all 88+ properties are mapped.
5. **Phase 5 — Remove obsolete per-app SSH keys:** after each app's new path is verified and recovery access tested, revoke its old static key. Track remaining legacy keys until none are in use, then remove obsolete secrets and document closure.

## Final production-readiness verdict

The hardened implementation is **ready for additional isolated testing**, not for fleet rollout. A successful central CI job or local OpenBao/SSH fixture is insufficient. Production readiness requires central branch protection and use of the immutable trust binding, required caller CI protections, a real GitHub OIDC exchange, production OpenBao audit/backup/recovery and CA rotation rehearsal, verified host trust and non-root service provisioning, unauthorized access tests, gate verification on the actual hosts, and a successful PIT pilot followed by fresh external health checks.
