import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const data = path.resolve(process.env.CPA_CONSOLE_DATA ?? path.join(os.homedir(), '.cpa-console'))

export const paths = {
  root,
  data,
  dist: path.join(root, 'dist'),
  bin: path.join(data, 'bin'),
  config: path.join(data, 'config.yaml'),
  auths: path.join(data, 'auths'),
  state: path.join(data, 'console.json'),
  usageDb: path.join(data, 'usage.db'),
}

export const env = {
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 8320),
  usageRetentionDays: Number(process.env.USAGE_RETENTION_DAYS ?? 90),
  /** Behind a reverse proxy: rate-limit by the X-Forwarded-For client address instead of the socket. */
  trustProxy: ['1', 'true'].includes(process.env.TRUST_PROXY ?? ''),
  githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
  dev: process.env.NODE_ENV === 'development',
}

export const CPA_REPO = 'router-for-me/CLIProxyAPI'
