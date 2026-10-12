import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, EyeIcon, FileDiffIcon, RefreshCwIcon, SaveIcon, Undo2Icon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { auth, mgmt } from '@/lib/api'
import { cn } from '@/lib/utils'
import { diffLines, diffStats, type DiffHunk } from './diff'
import { UnsavedBadge } from './form'
import { changedSettings, type ManagedSetting } from './managed'
import { useReportDirty } from './form-state'
import type { DirtyReporter } from './sections'

const yamlQuery = {
  queryKey: ['mgmt', 'config.yaml'],
  queryFn: () => mgmt<string>('/config.yaml'),
  refetchOnWindowFocus: false,
}

/** Value of the (only) `secret-key:` entry, unquoted; undefined when absent. */
function secretKeyOf(text: string) {
  const m = /^\s*secret-key\s*:\s*(.*)$/m.exec(text)
  if (!m) return undefined
  const v = m[1].replace(/\s+#.*$/, '').trim()
  return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v
}

interface Problem {
  title: string
  message: string
  line?: number
  /** Syntax errors block saving; server rejections don't (the user may fix and retry). */
  blocking?: boolean
}

type Review = { server: string; changedAgain?: boolean; managed: ManagedSetting[] }

/** Settings the console depends on that saving `text` over `server` would change. */
async function managedChanges(server: string, text: string): Promise<ManagedSetting[]> {
  const { parse } = await import('yaml')
  try {
    return changedSettings(parse(server), parse(text))
  } catch {
    return [] // the syntax check reports it
  }
}

/** Local syntax check: CPA only answers "invalid_body" for unparsable YAML, without a position. */
async function syntaxProblem(text: string): Promise<Problem | undefined> {
  const { parseDocument } = await import('yaml')
  const err = parseDocument(text).errors[0]
  return err && { title: 'YAML syntax error', message: err.message, line: err.linePos?.[0].line, blocking: true }
}

export function YamlSection({ onDirty }: { onDirty: DirtyReporter }) {
  const qc = useQueryClient()
  const { data, error, isLoading } = useQuery(yamlQuery)
  const [base, setBase] = useState<string>()
  const [text, setText] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [problem, setProblem] = useState<Problem>()
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const dirty = base !== undefined && text !== base
  useReportDirty('yaml', dirty, onDirty)

  // Follow the server while there are no local edits.
  const [seen, setSeen] = useState<string>()
  if (data !== undefined && data !== seen) {
    setSeen(data)
    if (base === undefined || text === base) {
      setBase(data)
      setText(data)
    }
  }

  const serverMoved = dirty && data !== undefined && data !== base
  const fetchLatest = () => qc.fetchQuery({ ...yamlQuery, staleTime: 0 })

  const load = (fresh: string) => {
    setBase(fresh)
    setText(fresh)
    setProblem(undefined)
  }

  async function openReview() {
    setChecking(true)
    try {
      const [server, syntax] = await Promise.all([fetchLatest(), syntaxProblem(text)])
      setProblem(syntax)
      setReview({ server, managed: await managedChanges(server, text) })
    } catch (err) {
      toast.error('Could not load the current config', { description: (err as Error).message })
    } finally {
      setChecking(false)
    }
  }

  async function save() {
    if (!review) return
    setSaving(true)
    setProblem(undefined)
    try {
      const latest = await fetchLatest()
      if (latest !== review.server) {
        setReview({ server: latest, changedAgain: true, managed: await managedChanges(latest, text) })
        return
      }
      const nextKey = secretKeyOf(text)
      const keyChanged = nextKey !== secretKeyOf(latest)
      await mgmt('/config.yaml', { method: 'PUT', body: text })
      // A plaintext key in the YAML becomes the new management key; switch before the next request.
      if (keyChanged && nextKey && !nextKey.startsWith('$2')) auth.set(nextKey)
      const saved = await fetchLatest()
      load(saved)
      setReview(null)
      void qc.invalidateQueries({ queryKey: ['mgmt'] })
      void qc.invalidateQueries({ queryKey: ['console', 'status'] })
      toast.success('config.yaml saved', {
        description: saved === text ? 'CLIProxyAPI reloads it in about a second.' : 'CLIProxyAPI normalized the formatting while saving.',
      })
    } catch (err) {
      const message = (err as Error).message
      setProblem({ title: 'CPA rejected the file', message, line: Number(/line (\d+)/.exec(message)?.[1]) || undefined })
    } finally {
      setSaving(false)
    }
  }

  const discard = () =>
    confirm({
      title: 'Discard your edits?',
      description: 'The editor reloads the file as it is on the server now.',
      confirmLabel: 'Discard',
      destructive: true,
      onConfirm: async () => load(await fetchLatest()),
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="font-mono">config.yaml</span>
          {dirty && <UnsavedBadge />}
        </CardTitle>
        <CardDescription>The full configuration, for everything the forms don't cover. CPA validates it before saving.</CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={discard}>
            <Undo2Icon />
            Discard
          </Button>
          <Button size="sm" disabled={!dirty || checking} onClick={openReview}>
            {checking ? <Spinner /> : <FileDiffIcon />}
            Review changes
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Could not load config.yaml</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        {serverMoved && (
          <Alert className="border-warning/40 bg-warning/5">
            <AlertTriangleIcon className="text-warning" />
            <AlertTitle>The file changed on the server while you were editing</AlertTitle>
            <AlertDescription>Saving would overwrite those changes. Review the diff before saving, or reload to start over.</AlertDescription>
            <Button
              variant="outline"
              size="sm"
              className="col-start-2 mt-2 w-fit"
              onClick={() =>
                confirm({
                  title: 'Reload config.yaml?',
                  description: 'Your edits are discarded and the editor shows the current file.',
                  confirmLabel: 'Reload',
                  destructive: true,
                  onConfirm: () => data !== undefined && load(data),
                })
              }
            >
              <RefreshCwIcon />
              Reload
            </Button>
          </Alert>
        )}
        {isLoading ? (
          <Skeleton className="h-[min(70vh,44rem)] w-full" />
        ) : (
          <CodeEditor value={text} onChange={setText} errorLine={problem?.line} />
        )}
        {problem && !review && <ProblemAlert problem={problem} />}
      </CardContent>

      <ReviewDialog
        review={review}
        text={text}
        base={base}
        saving={saving}
        problem={problem}
        onClose={() => !saving && setReview(null)}
        onSave={save}
      />
    </Card>
  )
}

function ProblemAlert({ problem }: { problem: Problem }) {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>{problem.title}</AlertTitle>
      <AlertDescription className="font-mono text-xs break-words whitespace-pre-wrap">{problem.message}</AlertDescription>
    </Alert>
  )
}

function ReviewDialog({
  review,
  text,
  base,
  saving,
  problem,
  onClose,
  onSave,
}: {
  review: Review | null
  text: string
  base?: string
  saving: boolean
  problem?: Problem
  onClose: () => void
  onSave: () => void
}) {
  const hunks = useMemo(() => (review ? diffLines(review.server, text) : []), [review, text])
  const stats = diffStats(hunks)
  const keyBefore = review ? secretKeyOf(review.server) : undefined
  const keyAfter = secretKeyOf(text)
  const keyChanged = !!review && keyBefore !== keyAfter

  return (
    <Dialog open={!!review} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Review changes</DialogTitle>
          <DialogDescription>
            {hunks.length ? (
              <>
                <span className="text-success">+{stats.added}</span> <span className="text-critical">−{stats.removed}</span> lines compared with
                the file currently on the server.
              </>
            ) : (
              'Your text matches the file on the server.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {review && review.server !== base && (
            <Alert className="border-warning/40 bg-warning/5">
              <AlertTriangleIcon className="text-warning" />
              <AlertTitle>{review.changedAgain ? 'The file changed again while you were reviewing' : 'The file changed since you loaded it'}</AlertTitle>
              <AlertDescription>
                The diff is against the current file. Changes made elsewhere that aren't in your text show up as removals and will be undone.
              </AlertDescription>
            </Alert>
          )}
          {keyChanged && (
            <Alert className="border-warning/40 bg-warning/5">
              <AlertTriangleIcon className="text-warning" />
              <AlertTitle>This changes management.secret-key</AlertTitle>
              <AlertDescription>
                {!keyAfter
                  ? 'An empty key disables the management API entirely, and this console with it.'
                  : keyAfter.startsWith('$2')
                    ? "You set a bcrypt hash, so you'll need to sign in again with the matching key."
                    : 'The plaintext value becomes the new key (CPA hashes it on reload). This browser switches to it automatically.'}
              </AlertDescription>
            </Alert>
          )}
          {!!review?.managed.length && (
            <Alert className="border-warning/40 bg-warning/5">
              <AlertTriangleIcon className="text-warning" />
              <AlertTitle>This changes settings the console relies on</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-0.5 pl-4">
                  {review.managed.map((m) => (
                    <li key={m.path}>
                      <span className="font-medium text-foreground">{m.label}</span> (<code className="font-mono text-xs">{m.path.split('.').at(-1)}</code>). {m.reason}
                    </li>
                  ))}
                </ul>
                <p>You can restore them later under Settings → Logging & usage.</p>
              </AlertDescription>
            </Alert>
          )}
          {problem && <ProblemAlert problem={problem} />}
        </div>

        {hunks.length > 0 && <DiffView hunks={hunks} />}

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Back to editor
          </Button>
          <Button disabled={saving || hunks.length === 0 || problem?.blocking} onClick={onSave}>
            {saving ? <Spinner /> : <SaveIcon />}
            Save config.yaml
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DiffView({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/20 font-mono text-xs leading-5">
      <table className="w-full border-collapse">
        <tbody>
          {hunks.map((h, hi) => (
            <HunkRows key={hi} hunk={h} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HunkRows({ hunk }: { hunk: DiffHunk }) {
  return (
    <>
      <tr className="bg-muted/60 text-muted-foreground">
        <td colSpan={4} className="px-3 py-0.5 select-none">
          @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </td>
      </tr>
      {hunk.lines.map((l, i) => (
        <tr key={i} className={cn(l.type === 'insert' && 'bg-success/10', l.type === 'delete' && 'bg-critical/10')}>
          <td className="w-10 border-r px-2 text-right text-muted-foreground/70 select-none tabular">{l.type !== 'insert' ? l.oldNo : ''}</td>
          <td className="w-10 border-r px-2 text-right text-muted-foreground/70 select-none tabular">{l.type !== 'delete' ? l.newNo : ''}</td>
          <td
            className={cn(
              'w-5 pl-2 select-none',
              l.type === 'insert' && 'text-success',
              l.type === 'delete' && 'text-critical',
            )}
            aria-label={l.type === 'insert' ? 'added' : l.type === 'delete' ? 'removed' : undefined}
          >
            {l.type === 'insert' ? '+' : l.type === 'delete' ? '−' : ' '}
          </td>
          <td className="pr-3 whitespace-pre">{l.text}</td>
        </tr>
      ))}
    </>
  )
}

function CodeEditor({ value, onChange, errorLine }: { value: string; onChange: (v: string) => void; errorLine?: number }) {
  const gutter = useRef<HTMLDivElement>(null)
  const lineCount = useMemo(() => value.split('\n').length, [value])
  // Match the file's indentation (CPA writes 4 spaces); fall back to 2.
  const indent = useMemo(() => {
    const n = /^( +)\S/m.exec(value)?.[1].length ?? 2
    return ' '.repeat(Math.min(Math.max(n, 2), 4))
  }, [value])
  // The file holds client keys and provider secrets; keep it hidden until asked (screen sharing).
  const [revealed, setRevealed] = useState(false)

  return (
    <div className="relative flex h-[min(70vh,44rem)] min-h-80 overflow-hidden rounded-lg border bg-muted/20 font-mono text-[13px] leading-5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
      {!revealed && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background/40 font-sans">
          <p className="text-sm text-muted-foreground">config.yaml contains API keys and other secrets.</p>
          <Button variant="outline" size="sm" onClick={() => setRevealed(true)}>
            <EyeIcon />
            Show file
          </Button>
        </div>
      )}
      <div
        ref={gutter}
        aria-hidden
        className={cn('shrink-0 overflow-hidden border-r bg-muted/40 py-3 text-right text-muted-foreground/60 select-none', !revealed && 'blur-sm')}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className={cn('px-3 tabular', errorLine === i + 1 && 'bg-critical/15 font-medium text-critical')}>
            {i + 1}
          </div>
        ))}
        <div className="h-8" />
      </div>
      <textarea
        aria-label="config.yaml"
        className={cn('min-w-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-3 whitespace-pre outline-none', !revealed && 'blur-sm select-none')}
        readOnly={!revealed}
        tabIndex={revealed ? undefined : -1}
        wrap="off"
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.currentTarget.blur()
          if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
          e.preventDefault()
          // execCommand keeps the native undo stack intact.
          document.execCommand('insertText', false, indent)
        }}
      />
    </div>
  )
}
