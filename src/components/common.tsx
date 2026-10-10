import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { maskSecret } from '@/lib/format'
import { cn } from '@/lib/utils'

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn('text-muted-foreground', className)}
          aria-label={label}
          onClick={async (e) => {
            e.stopPropagation()
            await navigator.clipboard.writeText(value)
            setCopied(true)
            toast.success('Copied to clipboard')
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function SecretText({ value, className }: { value: string; className?: string }) {
  const [shown, setShown] = useState(false)
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-0.5', className)}>
      <code className="truncate font-mono text-[13px]">{shown ? value : maskSecret(value)}</code>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={shown ? 'Hide' : 'Reveal'} onClick={() => setShown(!shown)}>
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
      <CopyButton value={value} />
    </span>
  )
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  loading,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  loading?: boolean
}) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="space-y-1.5 px-4">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          {label}
          {Icon && <Icon className="size-4" />}
        </div>
        {loading ? <Skeleton className="h-8 w-24" /> : <div className="text-2xl font-semibold tracking-tight">{value}</div>}
        {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}

/** Status dot with a label; color is never the only signal. */
export function StatusDot({ tone, pulse, className }: { tone: 'good' | 'warn' | 'bad' | 'idle'; pulse?: boolean; className?: string }) {
  const color = { good: 'bg-success', warn: 'bg-warning', bad: 'bg-critical', idle: 'bg-muted-foreground/50' }[tone]
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)}>
      {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', color)} />}
      <span className={cn('relative inline-flex size-2 rounded-full', color)} />
    </span>
  )
}

/** Tiny bar sparkline for CPA's 20 × 10-minute recent request buckets. */
export function RequestSparkline({ buckets, className }: { buckets: { success: number; failed: number; time: string }[]; className?: string }) {
  const max = Math.max(1, ...buckets.map((b) => b.success + b.failed))
  return (
    <div className={cn('flex h-6 items-end gap-px', className)}>
      {buckets.map((b, i) => {
        const total = b.success + b.failed
        return (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <div className="flex h-full w-1.5 flex-col justify-end">
                {total === 0 ? (
                  <div className="h-px w-full bg-border" />
                ) : (
                  <>
                    {b.failed > 0 && <div className="w-full rounded-t-[1px] bg-critical" style={{ height: `${(b.failed / max) * 100}%` }} />}
                    {b.success > 0 && (
                      <div className={cn('w-full bg-chart-1', b.failed === 0 && 'rounded-t-[1px]')} style={{ height: `${(b.success / max) * 100}%` }} />
                    )}
                  </>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <div className="font-medium">{b.time}</div>
              <div>
                {b.success} ok · {b.failed} failed
              </div>
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
