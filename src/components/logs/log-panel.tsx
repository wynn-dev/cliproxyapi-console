import { ArrowDownIcon, PauseIcon, PlayIcon, SearchIcon, XIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { StatusDot } from '@/components/common'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { useStickToBottom } from '@/hooks/use-stick-to-bottom'
import { cn } from '@/lib/utils'
import { isTypingTarget } from './log-utils'

/** Terminal-like scroll panel that sticks to the bottom as lines arrive. */
export function LogPanel({
  version,
  children,
  notice,
  className,
}: {
  version: unknown
  children: React.ReactNode
  notice?: React.ReactNode
  className?: string
}) {
  const { ref, onScroll, pinned, unseen, scrollToBottom } = useStickToBottom(version)
  return (
    <div
      className={cn(
        'relative h-[calc(100svh-19.5rem)] min-h-80 overflow-hidden rounded-xl border bg-muted/40 dark:bg-black/40',
        className,
      )}
    >
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto py-1.5 font-mono text-xs leading-5">
        {notice && <div className="px-3 pb-1.5 text-muted-foreground italic">{notice}</div>}
        {children}
      </div>
      {!pinned && unseen && (
        <Button
          size="xs"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          onClick={scrollToBottom}
        >
          <ArrowDownIcon />
          Jump to latest
        </Button>
      )}
    </div>
  )
}

export function LogEmpty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 font-sans text-sm text-muted-foreground">{children}</div>
}

/** Case-insensitive substring highlighting. */
export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, from)) {
    if (i > from) parts.push(text.slice(from, i))
    parts.push(
      <mark key={i} className="rounded-[2px] bg-warning/40 text-inherit">
        {text.slice(i, i + q.length)}
      </mark>,
    )
    from = i + q.length
  }
  if (from === 0) return text
  parts.push(text.slice(from))
  return parts
}

/** Search box; `/` anywhere on the page focuses it, Escape clears it. */
export function LogSearch({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      e.preventDefault()
      input.current?.focus()
      input.current?.select()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <InputGroup className={cn('w-full sm:w-64', className)}>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        ref={input}
        value={value}
        placeholder="Search logs"
        aria-label="Search logs"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('')
            e.currentTarget.blur()
          }
        }}
      />
      <InputGroupAddon align="inline-end">
        {value ? (
          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => onChange('')}>
            <XIcon />
          </InputGroupButton>
        ) : (
          <Kbd>/</Kbd>
        )}
      </InputGroupAddon>
    </InputGroup>
  )
}

export function LiveToggle({ paused, onChange }: { paused: boolean; onChange: (paused: boolean) => void }) {
  return (
    <Button variant="outline" size="sm" onClick={() => onChange(!paused)} aria-pressed={paused}>
      {paused ? <PlayIcon /> : <PauseIcon />}
      {paused ? 'Resume' : 'Pause'}
    </Button>
  )
}

export function LiveStatus({ paused, count, error }: { paused: boolean; count: React.ReactNode; error?: boolean }) {
  return (
    <span className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground tabular">
      <StatusDot tone={error ? 'bad' : paused ? 'idle' : 'good'} pulse={!paused && !error} />
      {error ? 'Disconnected' : paused ? 'Paused' : 'Live'}
      <span className="text-border">·</span>
      {count}
    </span>
  )
}
