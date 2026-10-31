#!/usr/bin/env node
/**
 * Zero static deployment credentials: GitHub OIDC -> OpenBao JWT role ->
 * short-lived SSH user certificate -> a per-repository, forced-command account.
 *
 * The server must already trust the OpenBao USER CA and have an enrollment for
 * this repository ID. This program never uses a shared private key, doesn't
 * create remote accounts, and fails closed if enrollment is incomplete.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AUDIENCE = 'profullstack-deploy'

export function validateContext(env) {
  const id = env.GITHUB_REPOSITORY_ID || ''
  const sha = env.GITHUB_SHA || ''
  const repository = env.GITHUB_REPOSITORY || ''
  const ref = env.GITHUB_REF || ''
  const event = env.GITHUB_EVENT_NAME || ''
  const host = env.PFDEPLOY_HOST || ''
  const port = String(env.PFDEPLOY_PORT || '22')
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error('Missing numeric GitHub repository ID')
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Deployment requires a full commit SHA')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid GitHub repository')
  if (ref !== 'refs/heads/main' && ref !== 'refs/heads/master') throw new Error('Only main/master are deployable')
  if (event !== 'push') throw new Error('Deployments must come from a push after CI, never a PR')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,251}$/.test(host)) throw new Error('Invalid deployment host')
  if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('Invalid SSH port')
  const address = env.PFDEPLOY_OPENBAO_URL || ''
  const bao = new URL(address)
  if (bao.protocol !== 'https:' || bao.username || bao.password || bao.search || bao.hash || bao.pathname !== '/') {
    throw new Error('OpenBao URL must be an HTTPS origin with no credentials or path')
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('GitHub Actions id-token: write permission is required')
  }
  return { id, sha, repository, ref, host, port, bao: bao.origin, username: 'pfdeploy-' + id }
}

async function jsonRequest(url, { bearer, body } = {}) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('Authentication service rejected request (HTTP ' + response.status + ')')
  return response.json()
}

async function githubOidc(env) {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL)
  if (url.protocol !== 'https:') throw new Error('OIDC endpoint must use HTTPS')
  url.searchParams.set('audience', AUDIENCE)
  const doc = await jsonRequest(url, { bearer: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN })
  if (typeof doc?.value !== 'string' || !doc.value) throw new Error('GitHub OIDC returned no token')
  return doc.value
}

export async function deploy(env = process.env) {
  const cfg = validateContext(env)
  const knownHosts = resolve(env.PFDEPLOY_KNOWN_HOSTS || '')
  const content = readFileSync(knownHosts, 'utf8')
  if (!content.trim() || !content.split(/\r?\n/).some(s => s && !s.startsWith('#'))) {
    throw new Error('No pinned server host keys or host CA in known_hosts; refusing insecure SSH')
  }
  const temp = mkdtempSync(join(tmpdir(), 'pfdeploy-'))
  try {
    const key = join(temp, 'identity')
    const certificate = join(temp, 'identity-cert.pub')
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-q', '-N', '', '-f', key])
    const publicKey = readFileSync(key + '.pub', 'utf8').trim()
    const token = await githubOidc(env)
    const login = await jsonRequest(cfg.bao + '/v1/auth/github-actions/login', {
      body: { role: 'repo-' + cfg.id, jwt: token },
    })
    const vaultToken = login?.auth?.client_token
    if (typeof vaultToken !== 'string' || !vaultToken) throw new Error('OpenBao JWT login did not yield a token')
    const signed = await jsonRequest(cfg.bao + '/v1/ssh-client-signer/sign/repo-' + cfg.id, {
      bearer: vaultToken,
      body: { public_key: publicKey, valid_principals: cfg.username, ttl: '5m' },
    })
    if (typeof signed?.data?.signed_key !== 'string' || !signed.data.signed_key.includes('-cert-v01@openssh.com')) {
      throw new Error('OpenBao did not return an SSH user certificate')
    }
    writeFileSync(certificate, signed.data.signed_key + '\n', { mode: 0o600 })
    console.log('Deploying', cfg.repository, cfg.sha.slice(0, 12), 'to', cfg.host, 'with a short-lived SSH certificate')
    execFileSync('ssh', [
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UserKnownHostsFile=' + knownHosts, '-o', 'CertificateFile=' + certificate,
      '-o', 'ConnectTimeout=15', '-p', cfg.port,
      '-i', key, cfg.username + '@' + cfg.host, 'deploy ' + cfg.sha,
    ], { stdio: 'inherit' })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deploy().catch(error => { console.error('pfdeploy:', error.message); process.exitCode = 1 })
}
