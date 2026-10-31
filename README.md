# @profullstack/deploy

Deploy in batches, **3 at a time**, so one box never builds everything at once.

On 2026-10-19 a change rolled out to 38 repos at once on our production box. Every repo installed, tested, type-checked and built together, then every merge's deploy built again; the box ran out of memory and the kernel killed the shared production Postgres. This package makes that impossible from both ends:

- **`deploy-gate`** (bash + `flock`, on the box): every deploy takes one of N slots before it builds. Merges can land all at once; builds queue and run three at a time.
- **`pfdeploy batch`** (and `batch()`, where the rollout is driven): run one command across many repos, three at a time, stopping at the first failure.

Zero dependencies. Linux (`flock`, `/proc/meminfo`); the batch runner works anywhere Node 18+ does.

## Fleet-wide deployments without per-site SSH keys

**One workflow, one centrally managed SSH certificate authority, zero permanent private deployment keys in app repositories.** On every merge to `main` or `master`, the repository's existing tests/typechecks/ThreatCrush scan run, then the same shared workflow deploys the actual commit. GitHub's signed OIDC assertion authenticates the repo to OpenBao, which returns a five-minute SSH certificate for that repo's restricted account. Target hosts and health endpoints live in `fleet/targets.json` keyed by stable GitHub repository ID; the single signing URL lives in `fleet/config.json`. `fleet/properties.txt` contains the currently supplied property inventory, pending verification of repo/host associations.

See **[Full SSH CA rollout and provisioning guide](docs/fleet-ssh-ca.md)**. The new workflow at `.github/workflows/ssh-deploy.yml` is disabled for an app until its central target entry is explicitly `enabled` and OpenBao + the host trust have been bootstrapped. The existing deployment gate remains in place. **No live app deployment is claimed by this code alone.**

## On the box: the gate

```sh
npx @profullstack/deploy install /usr/local/bin     # as root: one copy every user's deploys share
deploy-gate --name crawlproof -- ./deploy-app.sh "$SHA"
deploy-gate status
```

```
slot 0  busy  crawlproof pid 41233 since 2026-10-19T13:20:02Z
slot 1  busy  smshub pid 41290 since 2026-10-19T13:20:09Z
slot 2  free
2 of 3 busy, 31 GB available
```

How it decides:

1. Take one of `DEPLOY_SLOTS` (3) lock files in `/run/lock/profullstack-deploy` (shared by root and every user). All taken: wait, saying who holds them every 30 s.
2. Wait up to `DEPLOY_MEM_WAIT` (600 s) for `DEPLOY_MIN_FREE_GB` (8) of available memory, then go on.
3. Run the deploy with the lock descriptor closed, so a server it starts never keeps the slot. Signals are forwarded; the exit code is the deploy's.
4. Still no slot after `DEPLOY_WAIT` (3600 s): exit 75 (try again), or run anyway with `DEPLOY_GATE_ON_TIMEOUT=run`.

A deploy already inside the gate (`DEPLOY_GATED=1`) passes straight through, so a gated script that calls another gated script never waits on itself. Without `flock` the gate runs the deploy ungated rather than blocking it.

### Wiring a deploy script

Put this right after `set -euo pipefail`; if the gate is not installed the script runs exactly as before:

```sh
# Three deploys at a time on this box (@profullstack/deploy).
if [ -z "${DEPLOY_GATED:-}" ]; then
  for gate in /usr/local/bin/deploy-gate "$HOME/.local/bin/deploy-gate"; do
    [ -x "$gate" ] && exec "$gate" --name "<site>" -- "$0" "$@"
  done
fi
```

## Where the rollout runs: batches

```sh
# one change, many repos, three at a time; {} is the item, shell-quoted
pfdeploy batch -c 3 -- 'cd ~/src/profullstack/{} && bun test && gh pr merge --squash --auto' crawlproof smshub ugig.net
ls ~/www | pfdeploy batch -- '~/www/{}/deploy-app.sh origin/main'
pfdeploy batch -c 3 --keep-going --min-free-gb 12 -- 'make -C {} build' < repos.txt
```

Output lines are prefixed with the item. The first failure stops new starts (running ones finish); the summary names what failed and what never started. `--keep-going` runs everything.

```js
import { batch } from '@profullstack/deploy';

const results = await batch(repos, (repo) => rollOut(repo), { concurrency: 3, minFreeGb: 8 });
// [{ item, ok, value | error, skipped }]
```

## License

MIT
