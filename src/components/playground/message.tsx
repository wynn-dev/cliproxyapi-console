import { BrainIcon, ChevronRightIcon, CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { CopyButton } from '@/components/common'
import { Spinner } from '@/components/ui/spinner'
import { fmtMs, fmtNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { StreamResult } from './stream'

export interface Turn {
  id: number
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  pending?: boolean
  model?: string
  result?: StreamResult
}

export function UserMessage({ turn }: { turn: Turn }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm break-words whitespace-pre-wrap text-primary-foreground">
        {turn.content}
      </div>
    </div>
  )
}

export function AssistantMessage({ turn }: { turn: Turn }) {
  const r = turn.result
  const waiting = turn.pending && !turn.content && !turn.reasoning
  return (
    <div className="flex max-w-[85%] flex-col items-start gap-1.5">
      {turn.reasoning && <Reasoning text={turn.reasoning} thinking={!!turn.pending && !turn.content} />}
      {(turn.content || waiting) && (
        <div className="rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm break-words whitespace-pre-wrap">
          {waiting ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> Waiting for the first token…
            </span>
          ) : (
            <>
              {turn.content}
              {turn.pending && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-[1px] bg-foreground/60 align-text-bottom" />}
            </>
          )}
        </div>
      )}
      {r?.error && (
        <div className="flex gap-2.5 rounded-2xl rounded-bl-md border border-critical/30 bg-critical/5 px-3.5 py-2.5 text-sm">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-critical" />
          <div className="min-w-0 space-y-0.5">
            <div className="font-medium">Request failed{r.status ? ` · HTTP ${r.status}` : ''}</div>
            <div className="font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">{r.error}</div>
          </div>
        </div>
      )}
      {r && !r.error && !turn.content && !turn.reasoning && !r.stopped && (
        <div className="rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm text-muted-foreground italic">Empty response</div>
      )}
      {r && <Meta turn={turn} result={r} />}
    </div>
  )
}

function Reasoning({ text, thinking }: { text: string; thinking: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="max-w-full text-xs text-muted-foreground">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md py-0.5 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        <BrainIcon className="size-3.5" />
        {thinking ? 'Thinking…' : 'Reasoning'}
        {thinking && <Spinner className="size-3" />}
      </button>
      {open && <div className="mt-1 ml-1.5 border-l-2 pl-3 leading-relaxed break-words whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

function Meta({ turn, result: r }: { turn: Turn; result: StreamResult }) {
  const u = r.usage
  const hasTokens = u && (u.prompt_tokens != null || u.completion_tokens != null)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-xs text-muted-foreground tabular">
      {turn.model && <span className="font-mono">{turn.model}</span>}
      {r.stopped && <span className="text-foreground">Stopped</span>}
      {r.ttftMs != null && <span>First token {fmtMs(r.ttftMs)}</span>}
      <span>Total {fmtMs(r.totalMs)}</span>
      {hasTokens && (
        <span>
          {fmtNumber(u.prompt_tokens ?? 0)} in · {fmtNumber(u.completion_tokens ?? 0)} out tokens
        </span>
      )}
      {r.requestId && (
        <span className="-my-1 flex items-center" title={r.requestId}>
          Request <span className="ml-1 font-mono">{r.requestId.slice(-8)}</span>
          <CopyButton value={r.requestId} label="Copy request ID" className="size-6" />
        </span>
      )}
    </div>
  )
}
