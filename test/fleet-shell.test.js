import { describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

describe('shared fleet deployment scripts', () => {
  for (const name of ['bin/enroll-repo-openbao.sh', 'bin/pfdeploy-ssh-receiver', 'bin/setup-deploy-gate', 'bin/deploy-gate']) {
    it('parses safely in bash: ' + name, () => {
      execFileSync('bash', ['-n', resolve(name)])
    })
  }

  it('binds OpenBao enrollment to the pinned workflow SHA and rejects malformed SHAs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pfdeploy-enroll-test-'))
    const bao = join(dir, 'bao')
    const log = join(dir, 'bao.log')
    const workflowSha = '0123456789abcdef0123456789abcdef01234567'
    writeFileSync(bao, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$BAO_TEST_LOG"
if [[ "$1" == write && "$2" == "auth/github-actions/role/repo-1423083790" ]]; then cat >> "$BAO_TEST_LOG"; fi
`, { mode: 0o755 })
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, BAO_TEST_LOG: log }
    try {
      execFileSync('bash', [resolve('bin/enroll-repo-openbao.sh'), 'moshcoder/pit.world', '1423083790', 'main', workflowSha], { env })
      const output = readFileSync(log, 'utf8')
      assert.ok(output.includes(`"job_workflow_ref": ["profullstack/deploy/.github/workflows/ssh-deploy.yml@${workflowSha}"]`))
      assert.ok(output.includes(`"job_workflow_sha": ["${workflowSha}"]`))
      rmSync(log)
      assert.throws(() => execFileSync('bash', [resolve('bin/enroll-repo-openbao.sh'), 'moshcoder/pit.world', '1423083790', 'main', 'main'], { env, stdio: 'ignore' }))
      assert.throws(() => readFileSync(log, 'utf8'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
