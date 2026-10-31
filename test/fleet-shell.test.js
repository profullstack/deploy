import { describe, it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

describe('shared fleet deployment scripts', () => {
  for (const name of ['bin/enroll-repo-openbao.sh', 'bin/pfdeploy-ssh-receiver']) {
    it('parses safely in bash: ' + name, () => {
      execFileSync('bash', ['-n', resolve(name)])
    })
  }
})
