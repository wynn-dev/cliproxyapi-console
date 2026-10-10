import os from 'node:os'
import { env } from './env.ts'

/** This machine's IPv4 addresses other clients can reach it at (LAN, VPN, tailnet). */
export function networkAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address)
}

/** URLs the console is reachable at: localhost first, then LAN addresses when bound to all interfaces. */
export function consoleUrls(port: number) {
  if (env.host !== '0.0.0.0' && env.host !== '::') return [`http://${env.host}:${port}`]
  return [`http://localhost:${port}`, ...networkAddresses().map((a) => `http://${a}:${port}`)]
}
