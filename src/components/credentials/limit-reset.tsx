import { RotateCcwIcon } from 'lucide-react'
import { confirm } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { fmtWhen } from '@/lib/format'
import { limitWindows, type LimitReading } from '@/lib/limits'
import { useLimitReset } from '@/lib/queries'
import type { Credential, LimitResetKind, LimitReset as Reset } from '@/lib/types'
import { accountName } from './lib'

/** The limit each kind of reset clears, by its window's id. */
const WINDOW: Record<LimitResetKind, string> = { '5h': '5h', fable: '7d_oi' }

/**
 * A Claude account's limit reset, or its Fable reset: what the provider last said about it, and the
 * button that uses it. Off while there is nothing to reset or the reset is used, and the line beside
 * it says which. `older` is the reading before, for a Fable limit the newer one lacks, as the meters
 * show it.
 */
export function LimitReset({
  kind = '5h',
  account: c,
  reading,
  older,
  reset,
  now,
}: {
  kind?: LimitResetKind
  account: Credential
  reading?: LimitReading
  older?: LimitReading
  reset?: Reset
  now: number
}) {
  const use = useLimitReset()
  const fable = kind === 'fable'
  const limit = fable ? 'Fable limit' : '5-hour limit'
  const reached = [reading, older].flatMap((r) => limitWindows(c.provider, r, now)).find((w) => w.id === WINDOW[kind])?.level === 'exhausted'
  // Once the time it gave has passed, a used reset is no longer known to be used, nor a Fable reset to be left.
  const passed = reset?.state === 'used' ? reset.nextAvailableAt : reset?.state === 'available' ? reset.endsAt : undefined
  const known = passed && passed <= now ? undefined : reset
  // Fable resets are counted, and the provider is asked again at the click: what it last said only shows.
  const used = !fable && known?.state === 'used' && !!known.nextAvailableAt
  const said = fable ? fableSaid(known) : limitSaid(known)
  const why = used
    ? undefined
    : !reached
      ? `It can be used once the ${limit} is reached.`
      : fable
        ? 'It resets the Fable limit now and gives what Fable used this week back to the weekly limit.'
        : 'It resets the 5-hour limit now, once a week.'

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">{fable ? 'Fable reset' : 'Limit reset'}</div>
        <div className="text-xs text-muted-foreground">{[said, why].filter(Boolean).join(' ')}</div>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={used || !reached || use.isPending}
        onClick={() =>
          confirm({
            title: fable ? `Use a Fable reset on ${accountName(c)}?` : `Use the limit reset on ${accountName(c)}?`,
            description: fable
              ? "This resets the account's Fable limit now and gives what Fable used this week back to its weekly limit, which still resets on the same day. It uses up one of the account's Fable resets."
              : "This resets the account's 5-hour limit now. A reset can be used once a week, and what the account uses afterwards still counts toward its weekly limit.",
            confirmLabel: 'Use reset',
            // The outcome is told either way, so the dialog closes on a failure too.
            onConfirm: () => use.mutateAsync({ name: c.name, kind }).catch(() => {}),
          })
        }
      >
        {use.isPending ? <Spinner /> : <RotateCcwIcon />}
        Use reset
      </Button>
    </div>
  )
}

function limitSaid(known: Reset | undefined) {
  if (known?.state === 'available') return 'A reset is available.'
  if (known?.state === 'used') return known.nextAvailableAt ? `Reset used, available again ${fmtWhen(known.nextAvailableAt)}.` : 'Reset used.'
  if (known?.state === 'not-offered') return 'The provider did not offer this account a reset when last asked.'
  return 'The provider has not said whether a reset is left.'
}

function fableSaid(known: Reset | undefined) {
  if (known?.state === 'available') {
    const left = known.left ?? 1
    return `${left} Fable reset${left === 1 ? '' : 's'} left${known.endsAt ? `, to use by ${fmtWhen(known.endsAt)}` : ''}.`
  }
  if (known?.state === 'used') return 'No Fable reset is left.'
  if (known?.state === 'not-offered') return 'The provider did not offer this account a Fable reset when last asked.'
  return 'The provider has not said whether a Fable reset is left.'
}
