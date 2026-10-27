/** How long polls fail before that is taken as the restart, not a blip. */
export const DOWN_MS = 10_000

/**
 * Whether failing update polls are the console restarting: the last phase seen was installing or verifying (verifying
 * lasts under a second, so polls can miss it) and polls have failed for DOWN_MS since the last one that answered.
 */
export function pollsDown(phase: string | undefined, failing: boolean, failedAt: number, answeredAt: number) {
  return failing && (phase === 'installing' || phase === 'verifying') && failedAt - answeredAt >= DOWN_MS
}
