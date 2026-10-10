import { useMutation } from '@tanstack/react-query'
import { DownloadIcon, FileWarningIcon, Trash2Icon, XIcon } from 'lucide-react'
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ApiError, mgmt } from '@/lib/api'
import { fmtNumber } from '@/lib/format'
import { useConfigWrite } from '@/lib/queries'
import type { LogsResponse } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Highlight, LiveStatus, LiveToggle, LogEmpty, LogPanel, LogSearch } from './log-panel'
import { LEVELS, LEVEL_STYLE, type Level, type LogLine, parseLine, saveText } from './log-utils'

const MAX_LINES = 5000
const MAX_RENDERED = 2000
const POLL_MS = 2000

/** Tails CPA's main.log with the cursor API. Pausing keeps the cursor, so resuming catches up. */
function useAppLog(paused: boolean) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [error, setError] = useState<Error | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const cursor = useRef<string | undefined>(undefined)
  const nextId = useRef(0)

  useEffect(() => {
    if (paused) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await mgmt<LogsResponse>('/observability/logs', {
          query: cursor.current ? { cursor: cursor.current, limit: MAX_LINES } : { limit: 500 },
        })
        if (cancelled) return
        const parsed = res.lines.map((l) => parseLine(l, nextId.current++))
        const replace = !cursor.current || res['cursor-reset']
        cursor.current = res['next-cursor'] || undefined
        setLines((prev) => {
          const next = replace ? parsed : parsed.length ? prev.concat(parsed) : prev
          return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next
        })
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
  }, [paused, epoch])

  const reset = useCallback(() => {
    cursor.current = undefined
    setLines([])
    setEpoch((e) => e + 1)
  }, [])

  return { lines, error, loaded, reset }
}

export function AppLog() {
  const [paused, setPaused] = useState(false)
  const [search, setSearch] = useState('')
  const [levels, setLevels] = useState<Level[]>([...LEVELS])
  const [hideMgmt, setHideMgmt] = useState(true)
  const [reqId, setReqId] = useState<string>()
  const { lines, error, loaded, reset } = useAppLog(paused)
  const query = useDeferredValue(search.trim())

  const visible = useMemo(() => {
    const q = query.toLowerCase()
    const allLevels = levels.length === LEVELS.length
    return lines.filter(
      (l) =>
        (!hideMgmt || !l.mgmt) &&
        (allLevels || !l.level || levels.includes(l.level)) &&
        (!reqId || l.reqId === reqId) &&
        (!q || l.lower.includes(q)),
    )
  }, [lines, query, levels, hideMgmt, reqId])
  const rendered = visible.length > MAX_RENDERED ? visible.slice(-MAX_RENDERED) : visible
  const filtered = visible.length !== lines.length

  const filterReq = useCallback((id: string) => setReqId((cur) => (cur === id ? undefined : id)), [])

  const clear = useMutation({
    mutationFn: () => mgmt('/observability/logs', { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Logs cleared')
      reset()
    },
    onError: (e) => toast.error('Could not clear logs', { description: e.message }),
  })

  if (error instanceof ApiError && error.status === 400 && /logging to file disabled/i.test(error.message)) {
    return <LoggingDisabled onEnabled={reset} />
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <LogSearch value={search} onChange={setSearch} />
        {reqId && (
          <Button variant="secondary" size="sm" className="font-mono" onClick={() => setReqId(undefined)}>
            req {reqId}
            <XIcon />
          </Button>
        )}
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          spacing={0}
          value={levels}
          onValueChange={(v) => v.length && setLevels(v as Level[])}
          aria-label="Levels"
        >
          {LEVELS.map((l) => (
            <ToggleGroupItem key={l} value={l} className="gap-1.5 data-[state=off]:text-muted-foreground">
              <span className={cn('size-1.5 rounded-full', levels.includes(l) ? LEVEL_STYLE[l].dot : 'bg-muted-foreground/40')} />
              {LEVEL_STYLE[l].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2 px-1">
          <Switch id="hide-mgmt" size="sm" checked={hideMgmt} onCheckedChange={setHideMgmt} />
          <Label htmlFor="hide-mgmt" className="text-sm font-normal whitespace-nowrap">
            Hide management API
          </Label>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <LiveStatus
            paused={paused}
            error={!!error}
            count={filtered ? `${fmtNumber(visible.length)} of ${fmtNumber(lines.length)} lines` : `${fmtNumber(lines.length)} lines`}
          />
          <LiveToggle paused={paused} onChange={setPaused} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Download visible lines"
                disabled={!visible.length}
                onClick={() => saveText(visible.map((l) => l.raw).join('\n') + '\n', 'cpa-main')}
              >
                <DownloadIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download visible lines</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Clear logs"
                onClick={() =>
                  confirm({
                    title: 'Clear application logs?',
                    description: 'Deletes rotated log files and truncates main.log on the server. This cannot be undone.',
                    confirmLabel: 'Clear logs',
                    destructive: true,
                    onConfirm: () => clear.mutateAsync(),
                  })
                }
              >
                {clear.isPending ? <Spinner /> : <Trash2Icon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear logs</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {error && lines.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Lost connection to the log stream</AlertTitle>
          <AlertDescription>{error.message} · retrying every few seconds</AlertDescription>
        </Alert>
      )}

      <LogPanel
        version={rendered.at(-1)?.id}
        notice={
          visible.length > MAX_RENDERED &&
          `Showing the latest ${fmtNumber(MAX_RENDERED)} of ${fmtNumber(visible.length)} matching lines. Download to get all of them.`
        }
      >
        {!loaded ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-3.5" style={{ width: `${40 + ((i * 37) % 55)}%` }} />
            ))}
          </div>
        ) : error && !lines.length ? (
          <LogEmpty>Could not load logs: {error.message}</LogEmpty>
        ) : !rendered.length ? (
          <LogEmpty>{lines.length ? 'No lines match your filters.' : 'No log lines yet. New lines appear here as they are written.'}</LogEmpty>
        ) : (
          rendered.map((l) => <LogRow key={l.id} line={l} query={query} activeReq={reqId} onReq={filterReq} />)
        )}
      </LogPanel>
    </div>
  )
}

const LogRow = memo(function LogRow({
  line,
  query,
  activeReq,
  onReq,
}: {
  line: LogLine
  query: string
  activeReq?: string
  onReq: (id: string) => void
}) {
  const style = line.level && LEVEL_STYLE[line.level]
  return (
    <div className={cn('flex gap-3 px-3 hover:bg-foreground/5', style?.row)}>
      <span className="w-15 shrink-0 text-muted-foreground tabular" title={line.date && `${line.date} ${line.time}`}>
        {line.time}
      </span>
      <span className="w-12 shrink-0">
        {style && (
          <span className={cn('inline-block w-full rounded-sm text-center text-[10px] leading-4 font-medium uppercase', style.badge)}>
            {line.level}
          </span>
        )}
      </span>
      <span className="w-16 shrink-0">
        {line.reqId && (
          <button
            type="button"
            className={cn(
              'rounded-sm text-muted-foreground/80 hover:text-foreground hover:underline',
              activeReq === line.reqId && 'text-foreground underline',
            )}
            title={activeReq === line.reqId ? 'Show all requests' : 'Show only this request'}
            onClick={() => onReq(line.reqId!)}
          >
            {line.reqId}
          </button>
        )}
      </span>
      <span className="hidden w-44 shrink-0 truncate text-muted-foreground/80 xl:block" title={line.source}>
        {line.source}
      </span>
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        <Highlight text={line.message} query={query} />
      </span>
    </div>
  )
})

function LoggingDisabled({ onEnabled }: { onEnabled: () => void }) {
  const write = useConfigWrite()
  return (
    <Alert>
      <FileWarningIcon />
      <AlertTitle>Logging to file is turned off</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>CLIProxyAPI only writes main.log when file logging is enabled. Turn it on to tail the application log here.</p>
        <Button
          size="sm"
          disabled={write.isPending}
          onClick={() =>
            write.mutate(
              { path: '/observability/logs/logging-to-file', value: true },
              {
                onSuccess: () => {
                  toast.success('File logging enabled')
                  // CPA hot-reloads the config asynchronously.
                  setTimeout(onEnabled, 1500)
                },
              },
            )
          }
        >
          {write.isPending && <Spinner />}
          Enable file logging
        </Button>
      </AlertDescription>
    </Alert>
  )
}
