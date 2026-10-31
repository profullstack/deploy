import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { validateContext, resolveFleetTarget, normalizeSignedCertificate, verifyHealth, AUDIENCE } from '../bin/oidc-ssh-deploy.mjs'

const valid = {
  GITHUB_REPOSITORY_ID: '1423083790',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REPOSITORY: 'moshcoder/pit.world',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
  PFDEPLOY_HOST: 'dev2.profullstack.com',
  PFDEPLOY_PORT: '22',
  PFDEPLOY_OPENBAO_URL: 'https://openbao.example.net',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.net/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-temporary-secret',
}
describe('central fleet OIDC deployment context', () => {
  it('uses stable repo ID for short-lived certificate role and Unix principal', () => {
    const ctx = validateContext(valid)
    assert.equal(ctx.username, 'pfdeploy-1423083790')
    assert.equal(ctx.bao, 'https://openbao.example.net')
    assert.equal(AUDIENCE, 'profullstack-deploy')
  })
  it('supports the master branch', () => {
    assert.equal(validateContext({ ...valid, GITHUB_REF: 'refs/heads/master' }).ref, 'refs/heads/master')
  })
  for (const [name, change] of Object.entries({
    'reject pull requests': { GITHUB_EVENT_NAME: 'pull_request' },
    'reject feature branches': { GITHUB_REF: 'refs/heads/feature' },
    'reject abbreviated SHA': { GITHUB_SHA: 'a'.repeat(12) },
    'reject missing repo ID': { GITHUB_REPOSITORY_ID: '' },
    'reject host argument injection': { PFDEPLOY_HOST: 'host; rm -rf /' },
    'reject plaintext signing service': { PFDEPLOY_OPENBAO_URL: 'http://example.net' },
    'reject URL credentials': { PFDEPLOY_OPENBAO_URL: 'https://token@example.net' },
    'reject missing OIDC': { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' },
  })) {
    it(name, () => assert.throws(() => validateContext({ ...valid, ...change })))
  }
})

describe('OpenBao certificate response handling', () => {
  it('writes one complete certificate line even when OpenBao returns trailing newlines', () => {
    const line = 'ssh-ed25519-cert-v01@openssh.com AAAATEST'
    assert.equal(normalizeSignedCertificate(`${line}\n\n`), `${line}\n`)
  })
  it('rejects a multiline or non-certificate signing response', () => {
    assert.throws(() => normalizeSignedCertificate('ssh-ed25519-cert-v01@openssh.com AAAA\nssh-ed25519 AAAA'))
    assert.throws(() => normalizeSignedCertificate('ssh-ed25519 AAAA'))
  })
})

describe('central repository-to-deployment mapping', () => {
  const targets = { '1423083790': { repository: 'moshcoder/pit.world', ref: 'refs/heads/main', host: 'dev2.profullstack.com', port: 22, health_url: 'https://pit.world/health', enabled: true } }
  const fleet = { openbao_url: 'https://openbao.example.net' }
  it('resolves the target by immutable GitHub repository ID', () => {
    const result = resolveFleetTarget(valid, targets, fleet)
    assert.equal(result.env.PFDEPLOY_HOST, 'dev2.profullstack.com')
    assert.equal(result.env.PFDEPLOY_OPENBAO_URL, fleet.openbao_url)
    assert.equal(result.health_url, 'https://pit.world/health')
  })
  it('refuses unknown, disabled and wrong repository/branch mappings', () => {
    assert.throws(() => resolveFleetTarget(valid, {}, fleet))
    assert.throws(() => resolveFleetTarget(valid, { '1423083790': { ...targets['1423083790'], enabled: false } }, fleet))
    assert.throws(() => resolveFleetTarget({ ...valid, GITHUB_REPOSITORY: 'other/repo' }, targets, fleet))
    assert.throws(() => resolveFleetTarget({ ...valid, GITHUB_REF: 'refs/heads/master' }, targets, fleet))
  })
})

describe('post-deployment health checks', () => {
  it('fails the deployment when the health endpoint is not successful', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503).end('unhealthy')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    try {
      await assert.rejects(
        verifyHealth(`http://127.0.0.1:${address.port}/health`, { attempts: 1 }),
        /Deployment health check failed: HTTP 503/,
      )
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
