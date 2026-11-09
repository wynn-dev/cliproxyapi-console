import { RotateCcwIcon } from 'lucide-react'
import { confirm } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { fmtWhen } from '@/lib/format'
import { limitWindows, type LimitReading } from '@/lib/limits'
import { useLimitReset } from '@/lib/queries'
import type { Credential, LimitReset as Reset } from '@/lib/types'
import { accountName } from './lib'

/**
 * A Claude account's limit reset: what the provider last said about it, and the button that uses
 * it. Off while there is nothing to reset or the reset is used, and the line beside it says which.
 */
export function LimitReset({ account: c, reading, reset, now }: { account: Credential; reading?: LimitReading; reset?: Reset; now: number }) {
  const use = useLimitReset()
  const reached = limitWindows(c.provider, reading, now).find((w) => w.id === '5h')?.level === 'exhausted'
  // Once the time it gave has passed, a used reset is no longer known to be used.
  const known = reset?.state === 'used' && reset.nextAvailableAt && reset.nextAvailableAt <= now ? undefined : reset
  const used = known?.state === 'used' && !!known.nextAvailableAt
  const said =
    known?.state === 'available'
      ? 'A reset is available.'
      : known?.state === 'used'
        ? known.nextAvailableAt
          ? `Reset used, available again ${fmtWhen(known.nextAvailableAt)}.`
          : 'Reset used.'
        : known?.state === 'not-offered'
          ? 'The provider did not offer this account a reset when last asked.'
          : 'The provider has not said whether a reset is left.'
  const why = used ? undefined : reached ? 'It resets the 5-hour limit now, once a week.' : 'It can be used once the 5-hour limit is reached.'

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">Limit reset</div>
        <div className="text-xs text-muted-foreground">{[said, why].filter(Boolean).join(' ')}</div>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={used || !reached || use.isPending}
        onClick={() =>
          confirm({
            title: `Use the limit reset on ${accountName(c)}?`,
            description:
              "This resets the account's 5-hour limit now. A reset can be used once a week, and what the account uses afterwards still counts toward its weekly limit.",
            confirmLabel: 'Use reset',
            // The outcome is told either way, so the dialog closes on a failure too.
            onConfirm: () => use.mutateAsync(c.name).catch(() => {}),
          })
        }
      >
        {use.isPending ? <Spinner /> : <RotateCcwIcon />}
        Use reset
      </Button>
    </div>
  )
}
