import { useQuery } from '@tanstack/react-query'
import { ChevronRightIcon, DownloadIcon } from 'lucide-react'
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { PROCESS_LABEL } from '@/components/app-sidebar'
import { StatusDot } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { consoleApi } from '@/lib/api'
import { fmtNumber } from '@/lib/format'
import { queries } from '@/lib/queries'
import type { OutputLine } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Highlight, LiveStatus, LiveToggle, LogEmpty, LogPanel, LogSearch } from './log-panel'
import { saveText } from './log-utils'

const MAX_LINES = 2000
const POLL_MS = 2000

function useProcessOutput(paused: boolean) {
  const [lines, setLines] = useState<OutputLine[]>([])
  const [error, setError] = useState<Error | null>(null)
  const [loaded, setLoaded] = useState(false)
  const after = useRef(0)

  useEffect(() => {
    if (paused) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        let res = await consoleApi<{ seq: number; lines: OutputLine[] }>('/process/output', { query: { after: after.current } })
        if (cancelled) return
        if (res.seq < after.current) {
          // The console server restarted and its sequence numbers started over.
          after.current = 0
          res = await consoleApi<{ seq: number; lines: OutputLine[] }>('/process/output')
          if (cancelled) return
          setLines([])
        }
        if (res.lines.length) {
          after.current = res.lines[res.lines.length - 1].seq
          setLines((prev) => prev.concat(res.lines).slice(-MAX_LINES))
        }
        setError(null)
      } catch (e) {
        if (cancelled) return
        setError(e as Error)
      }
      setLoaded(true)
      timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [paused])

  return { lines, error, loaded }
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export function ProcessOutput() {
  const [paused, setPaused] = useState(false)
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim())
  const { lines, error, loaded } = useProcessOutput(paused)
  const { data: status } = useQuery(queries.status())
  const state = status?.process.state

  const visible = useMemo(() => {
    const q = query.toLowerCase()
    return q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines
  }, [lines, query])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <LogSearch value={search} onChange={setSearch} />
        {state && (
          <Badge variant="outline" className="h-8 gap-1.5 rounded-lg px-2.5">
            <StatusDot tone={PROCESS_LABEL[state].tone} pulse={state === 'starting'} />
            {PROCESS_LABEL[state].label}
            {status.process.pid && state === 'running' && <span className="text-muted-foreground tabular">pid {status.process.pid}</span>}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <LiveStatus
            paused={paused}
            error={!!error}
            count={query ? `${fmtNumber(visible.length)} of ${fmtNumber(lines.length)} lines` : `${fmtNumber(lines.length)} lines`}
          />
          <LiveToggle paused={paused} onChange={setPaused} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Download visible lines"
                disabled={!visible.length}
                onClick={() =>
                  saveText(visible.map((l) => `${new Date(l.ts).toISOString()} [${l.stream}] ${l.text}`).join('\n') + '\n', 'cpa-output')
                }
              >
                <DownloadIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download visible lines</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <LogPanel version={visible.at(-1)?.seq}>
        {!loaded ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-3.5" style={{ width: `${35 + ((i * 41) % 55)}%` }} />
            ))}
          </div>
        ) : error && !lines.length ? (
          <LogEmpty>Could not load process output: {error.message}</LogEmpty>
        ) : !visible.length ? (
          <LogEmpty>{lines.length ? 'No lines match your search.' : 'No output yet. CLIProxyAPI stdout and stderr appear here.'}</LogEmpty>
        ) : (
          visible.map((l) => <OutputRow key={l.seq} line={l} query={query} />)
        )}
      </LogPanel>
    </div>
  )
}

const OutputRow = memo(function OutputRow({ line, query }: { line: OutputLine; query: string }) {
  const time = timeFmt.format(line.ts)
  if (line.stream === 'console') {
    return (
      <div className="flex gap-3 px-3 py-0.5 text-muted-foreground">
        <span className="w-15 shrink-0 tabular">{time}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 font-sans italic">
          <ChevronRightIcon className="size-3 shrink-0" />
          <Highlight text={line.text} query={query} />
        </span>
      </div>
    )
  }
  const err = line.stream === 'stderr'
  return (
    <div className={cn('flex gap-3 px-3 hover:bg-foreground/5', err && 'bg-critical/5')}>
      <span className="w-15 shrink-0 text-muted-foreground tabular">{time}</span>
      <span className={cn('w-8 shrink-0 text-[10px] leading-5 uppercase', err ? 'font-medium text-critical' : 'text-muted-foreground/60')}>
        {err ? 'err' : 'out'}
      </span>
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        <Highlight text={line.text} query={query} />
      </span>
    </div>
  )
})
