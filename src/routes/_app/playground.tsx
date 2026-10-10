import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowUpIcon, BoxesIcon, ChevronRightIcon, MessageSquareIcon, SquareIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PageHeader } from '@/components/common'
import { AssistantMessage, type Turn, UserMessage } from '@/components/playground/message'
import { ModelPicker, type ProxyModel } from '@/components/playground/model-picker'
import { type ChatMessage, streamChat } from '@/components/playground/stream'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useStickToBottom } from '@/hooks/use-stick-to-bottom'
import { consoleApi } from '@/lib/api'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/playground')({ component: Playground })

const MODEL_KEY = 'cpa-console.playground.model'
const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent)

function Playground() {
  const models = useQuery({
    queryKey: ['console', 'v1', 'models'],
    queryFn: () => consoleApi<{ data?: ProxyModel[] }>('/v1/models'),
    select: (d) => (d.data ?? []).sort((a, b) => a.id.localeCompare(b.id)),
    staleTime: 30_000,
  })
  const list = models.data ?? []
  const [saved, setSaved] = useState(() => localStorage.getItem(MODEL_KEY) ?? undefined)
  const model = saved && list.some((m) => m.id === saved) ? saved : list[0]?.id
  const pickModel = (id: string) => {
    setSaved(id)
    localStorage.setItem(MODEL_KEY, id)
  }

  const [turns, setTurns] = useState<Turn[]>([])
  const [system, setSystem] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const [input, setInput] = useState('')
  const abort = useRef<AbortController | null>(null)
  const nextId = useRef(0)
  const streaming = !!turns.at(-1)?.pending

  useEffect(() => () => abort.current?.abort(), [])

  const last = turns.at(-1)
  const { ref, onScroll } = useStickToBottom(`${turns.length}:${last?.content.length}:${last?.reasoning?.length}:${last?.pending}`)

  const send = async () => {
    const text = input.trim()
    if (!text || !model || streaming) return
    const messages: ChatMessage[] = [
      ...(system.trim() ? [{ role: 'system' as const, content: system.trim() }] : []),
      // Failed or empty replies are left out so the conversation stays valid.
      ...turns.filter((t) => t.role === 'user' || (t.content && !t.result?.error)).map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: text },
    ]
    const aid = nextId.current + 1
    nextId.current += 2
    setTurns((ts) => [...ts, { id: aid - 1, role: 'user', content: text }, { id: aid, role: 'assistant', content: '', pending: true, model }])
    setInput('')

    const ctrl = new AbortController()
    abort.current = ctrl
    const update = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === aid ? fn(t) : t)))
    const result = await streamChat({ model, messages }, ctrl.signal, {
      onContent: (s) => update((t) => ({ ...t, content: t.content + s })),
      onReasoning: (s) => update((t) => ({ ...t, reasoning: (t.reasoning ?? '') + s })),
    })
    update((t) => ({ ...t, pending: false, result }))
    if (abort.current === ctrl) abort.current = null
  }

  const clear = () => {
    abort.current?.abort()
    abort.current = null
    setTurns([])
  }

  const noModels = models.isSuccess && list.length === 0

  return (
    <>
      <PageHeader
        title="Playground"
        description="Chat with a model through the proxy to check that it and its credentials work end to end."
        actions={
          !noModels && (
            <>
              {models.isLoading ? (
                <Skeleton className="h-8 w-72" />
              ) : (
                <ModelPicker models={list} value={model} onChange={pickModel} disabled={!list.length} />
              )}
              <Button variant="outline" onClick={clear} disabled={!turns.length}>
                <Trash2Icon />
                Clear
              </Button>
            </>
          )
        }
      />

      {models.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load models</AlertTitle>
          <AlertDescription>{models.error.message}</AlertDescription>
        </Alert>
      ) : noModels ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BoxesIcon />
            </EmptyMedia>
            <EmptyTitle>No models available</EmptyTitle>
            <EmptyDescription>
              Models appear here once you add an OAuth credential or an API provider. The playground then sends requests through
              the proxy just like your clients do.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button size="sm" asChild>
              <Link to="/credentials">Add credentials</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link to="/providers">Add an API provider</Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Card className="h-[calc(100svh-14.5rem)] min-h-96 gap-0 overflow-hidden py-0">
          <div className="border-b px-3 py-2">
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground hover:text-foreground"
              aria-expanded={showSystem}
              onClick={() => setShowSystem(!showSystem)}
            >
              <ChevronRightIcon className={cn('size-4 shrink-0 transition-transform', showSystem && 'rotate-90')} />
              <span className="shrink-0 font-medium">System prompt</span>
              {!showSystem && (
                <span className="truncate text-xs">{system.trim() ? `· ${system.trim()}` : '· none'}</span>
              )}
            </button>
            {showSystem && (
              <Textarea
                value={system}
                onChange={(e) => setSystem(e.target.value)}
                placeholder="You are a helpful assistant."
                className="mt-2 max-h-40 min-h-16"
                autoFocus
              />
            )}
          </div>

          <div ref={ref} onScroll={onScroll} className="flex-1 overflow-y-auto">
            {turns.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
                <MessageSquareIcon className="size-5" />
                {model ? (
                  <p>
                    Send a message to test <span className="font-mono text-foreground">{model}</span>.
                  </p>
                ) : (
                  <Skeleton className="h-4 w-48" />
                )}
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
                {turns.map((t) => (t.role === 'user' ? <UserMessage key={t.id} turn={t} /> : <AssistantMessage key={t.id} turn={t} />))}
              </div>
            )}
          </div>

          <form
            className="border-t p-3"
            onSubmit={(e) => {
              e.preventDefault()
              void send()
            }}
          >
            <InputGroup className="mx-auto max-w-3xl">
              <InputGroupTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void send()
                  }
                }}
                placeholder="Send a message"
                aria-label="Message"
                className="max-h-48 min-h-12"
              />
              <InputGroupAddon align="block-end" className="justify-between">
                <span className="flex items-center gap-1.5 text-xs font-normal">
                  <KbdGroup>
                    <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
                    <Kbd>↵</Kbd>
                  </KbdGroup>
                  to send
                </span>
                {streaming ? (
                  <InputGroupButton variant="outline" size="sm" onClick={() => abort.current?.abort()}>
                    <SquareIcon className="fill-current" />
                    Stop
                  </InputGroupButton>
                ) : (
                  <InputGroupButton type="submit" variant="default" size="sm" disabled={!input.trim() || !model}>
                    <ArrowUpIcon />
                    Send
                  </InputGroupButton>
                )}
              </InputGroupAddon>
            </InputGroup>
          </form>
        </Card>
      )}
    </>
  )
}
