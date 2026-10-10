import os from 'node:os'
import { env } from './env.ts'

/** URLs the console is reachable at: localhost first, then LAN addresses when bound to all interfaces. */
export function consoleUrls(port: number) {
  if (env.host !== '0.0.0.0' && env.host !== '::') return [`http://${env.host}:${port}`]
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${port}`)
  return [`http://localhost:${port}`, ...lan]
}
