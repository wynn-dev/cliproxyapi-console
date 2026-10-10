import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { KeyRoundIcon, PlusIcon, RefreshCwIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CopyButton, PageHeader, StatusDot } from '@/components/common'
import { ModelPicker, type ProxyModel } from '@/components/playground/model-picker'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { consoleApi } from '@/lib/api'
import { maskSecret } from '@/lib/format'
import { generateKey } from '@/lib/keys'
import { queries, useConfigWrite } from '@/lib/queries'
import type { ConsoleStatus } from '@/lib/types'

const TOOLS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'other', label: 'Other clients' },
] as const
type ToolId = (typeof TOOLS)[number]['id']

export const Route = createFileRoute('/_app/connect')({
  validateSearch: (s: Record<string, unknown>): { tool?: ToolId; key?: number } => ({
    tool: TOOLS.find((t) => t.id === s.tool)?.id,
    key: typeof s.key === 'number' && Number.isInteger(s.key) && s.key >= 0 ? s.key : undefined,
  }),
  component: Connect,
})

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]']
const NEW_KEY = 'new'
const PLAYGROUND_MODEL_KEY = 'cpa-console.playground.model'

type Shell = 'posix' | 'powershell'

function networkLabel(ip: string) {
  const [a, b] = ip.split('.').map(Number)
  if (a === 100 && b >= 64 && b <= 127) return 'Tailscale'
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'Local network'
  return 'Network'
}

/** Addresses clients can reach the proxy at, given the address it listens on. */
function proxyAddresses(status: ConsoleStatus | undefined) {
  const listen = status?.config?.host ?? ''
  const page = window.location.hostname
  if (LOCAL_HOSTS.includes(listen)) return { options: [{ host: 'localhost', hint: 'Same machine as the proxy' }], localOnly: true }
  if (listen && listen !== '0.0.0.0' && listen !== '::') return { options: [{ host: listen, hint: 'The only address the proxy listens on' }], localOnly: false }
  const hints = new Map<string, string[]>()
  const add = (host: string, hint: string) => hints.set(host, [...(hints.get(host) ?? []), hint])
  if (!LOCAL_HOSTS.includes(page)) add(page, "This page's address")
  for (const ip of status?.addresses ?? []) add(ip, networkLabel(ip))
  add('localhost', 'Same machine as the proxy')
  return { options: [...hints].map(([host, h]) => ({ host, hint: h.join(' · ') })), localOnly: false }
}

/** Setup for Claude Code, Codex and other clients, complete with the proxy's address and a client key. */
function Connect() {
  const { tool = 'claude-code', key: keyIndex = 0 } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { data: status } = useQuery(queries.status())
  const config = useQuery(queries.config())
  const keys: string[] = Array.isArray(config.data?.access?.['api-keys']) ? config.data.access['api-keys'] : []
  const write = useConfigWrite()
  const [shell, setShell] = useState<Shell>(() => (/windows/i.test(navigator.userAgent) ? 'powershell' : 'posix'))

  const { options, localOnly } = proxyAddresses(status)
  const page = window.location.hostname
  const preferred = LOCAL_HOSTS.includes(page) ? 'localhost' : page
  const [picked, setHost] = useState<string>()
  const host = [picked, preferred].find((h) => h && options.some((o) => o.host === h)) ?? options[0]?.host ?? 'localhost'
  const origin = `${status?.config?.tls ? 'https' : 'http'}://${host}:${status?.config?.port ?? 8317}`
  const key = keys[keyIndex] ?? keys[0]
  const shown = key ?? '<client-key>'

  const setSearch = (patch: { tool?: ToolId; key?: number }) => void navigate({ search: (s) => ({ ...s, ...patch }), replace: true })
  const createKey = async () => {
    const next = generateKey()
    await write.mutateAsync({ path: '/access/api-keys', value: [...keys, next] })
    setSearch({ key: keys.length })
    toast.success('Client key created', { description: 'It is filled in below.' })
  }

  return (
    <>
      <PageHeader title="Connect" description="Point Claude Code, Codex or any other client at the proxy. Every command is complete: copy it and run it." />

      <Card>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <div className="text-sm font-medium">Address</div>
              <Select value={host} onValueChange={setHost} disabled={!status}>
                <SelectTrigger className="w-full font-mono text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.host} value={o.host}>
                      <span className="font-mono text-[13px]">{o.host}</span>
                      <span className="font-sans text-xs text-muted-foreground">{o.hint}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {localOnly ? (
                  <>
                    The proxy only accepts connections from this machine. To use it from others, set its host to all interfaces in{' '}
                    <Link to="/settings" search={{ section: 'server' }} className="text-foreground underline underline-offset-4">
                      Settings
                    </Link>
                    .
                  </>
                ) : (
                  'Where the client runs: localhost for this machine, otherwise an address that machine can reach.'
                )}
              </p>
            </div>
            <div className="min-w-0 space-y-1.5">
              <div className="text-sm font-medium">Client key</div>
              {!config.data ? (
                <Skeleton className="h-8 w-full" />
              ) : keys.length ? (
                <Select
                  value={String(keys.indexOf(key))}
                  onValueChange={(v) => (v === NEW_KEY ? void createKey() : setSearch({ key: Number(v) }))}
                  disabled={write.isPending}
                >
                  <SelectTrigger className="w-full font-mono text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {keys.map((k, i) => (
                      <SelectItem key={k} value={String(i)}>
                        <span className="font-mono text-[13px]">{maskSecret(k)}</span>
                        <span className="font-sans text-xs text-muted-foreground">Key {i + 1}</span>
                      </SelectItem>
                    ))}
                    <SelectSeparator />
                    <SelectItem value={NEW_KEY}>
                      <PlusIcon />
                      Create a new key
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Button variant="outline" className="w-full" onClick={() => void createKey()} disabled={write.isPending}>
                  {write.isPending ? <Spinner /> : <KeyRoundIcon />}
                  Create a client key
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                Filled into every command below.{' '}
                <Link to="/keys" className="text-foreground underline underline-offset-4">
                  Manage keys
                </Link>
              </p>
            </div>
          </div>
          <Reachability origin={origin} host={host} clientKey={key} />
        </CardContent>
      </Card>

      <Tabs value={tool} onValueChange={(v) => setSearch({ tool: v as ToolId })} className="gap-4">
        <TabsList>
          {TOOLS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="px-3">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="claude-code">
          <Card>
            <CardContent>
              <ClaudeCode origin={origin} clientKey={shown} shell={shell} setShell={setShell} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="codex">
          <Card>
            <CardContent>
              <Codex origin={origin} clientKey={shown} shell={shell} setShell={setShell} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="other">
          <Card>
            <CardContent>
              <OtherClients origin={origin} clientKey={shown} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  )
}

type Check = { ok: true; models: number } | { ok: false; reason: string }

/** Checks from this browser that the chosen address answers and accepts the key. CLIProxyAPI allows cross-origin requests. */
function Reachability({ origin, host, clientKey }: { origin: string; host: string; clientKey?: string }) {
  const remotePage = !LOCAL_HOSTS.includes(window.location.hostname)
  const skip = !clientKey
    ? 'Create a client key to check the connection.'
    : host === 'localhost' && remotePage
      ? "localhost means the machine each client runs on, so it can't be checked from this browser."
      : undefined
  const check = useQuery({
    queryKey: ['connect', 'check', origin, clientKey],
    enabled: !skip,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<Check> => {
      try {
        const res = await fetch(`${origin}/v1/models`, { headers: { Authorization: `Bearer ${clientKey}` }, signal: AbortSignal.timeout(6000) })
        if (res.status === 401 || res.status === 403) return { ok: false, reason: 'The proxy answered but rejected this key.' }
        if (!res.ok) return { ok: false, reason: `The proxy answered with HTTP ${res.status}.` }
        const body = (await res.json()) as { data?: unknown[] }
        return { ok: true, models: body.data?.length ?? 0 }
      } catch {
        const blocked = window.location.protocol === 'https:' && origin.startsWith('http:')
        return {
          ok: false,
          reason: blocked
            ? 'This page is served over HTTPS, so the browser blocks checks against a plain-HTTP proxy.'
            : `Nothing answered at ${origin} from this browser.`,
        }
      }
    },
  })

  let tone: 'good' | 'bad' | 'idle' = 'idle'
  let text: React.ReactNode = skip
  if (!skip && check.isFetching) text = 'Checking from this browser…'
  else if (!skip && check.data?.ok) {
    tone = 'good'
    text = `Reachable from this browser and the key works · ${check.data.models} models available`
  } else if (!skip && check.data && !check.data.ok) {
    tone = 'bad'
    text = check.data.reason
  }

  return (
    <div className="flex min-h-8 items-center gap-2 rounded-md border bg-muted/30 py-1 pr-1 pl-3 text-sm">
      {!skip && check.isFetching ? <Spinner className="size-3.5" /> : <StatusDot tone={tone} />}
      <span className="min-w-0 flex-1 text-muted-foreground">{text}</span>
      {!skip && (
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Check again" disabled={check.isFetching} onClick={() => void check.refetch()}>
          <RefreshCwIcon />
        </Button>
      )}
    </div>
  )
}

interface ToolProps {
  origin: string
  clientKey: string
  shell: Shell
  setShell: (s: Shell) => void
}

const SHELLS: { value: Shell; label: string }[] = [
  { value: 'posix', label: 'macOS / Linux' },
  { value: 'powershell', label: 'PowerShell' },
]

function ClaudeCode({ origin, clientKey, shell, setShell }: ToolProps) {
  const [choice, setChoice] = useState<'command' | 'file' | 'vscode'>('command')
  // The command is a Node heredoc, so PowerShell falls back to editing the file.
  const target = choice === 'command' && shell !== 'posix' ? 'file' : choice
  const env = { ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: clientKey }

  const run =
    shell === 'posix'
      ? `export ANTHROPIC_BASE_URL=${origin}\nexport ANTHROPIC_AUTH_TOKEN=${clientKey}\nclaude`
      : `$env:ANTHROPIC_BASE_URL = "${origin}"\n$env:ANTHROPIC_AUTH_TOKEN = "${clientKey}"\nclaude`
  const keep = {
    command: {
      code: `node - <<'EOF'
const fs = require('fs'), file = require('os').homedir() + '/.claude/settings.json'
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
settings.env = { ...settings.env, ANTHROPIC_BASE_URL: '${origin}', ANTHROPIC_AUTH_TOKEN: '${clientKey}' }
fs.mkdirSync(require('path').dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\\n')
EOF`,
      note: 'Needs Node.js',
      description: (
        <>
          Run this once. It adds the two values to <Code>~/.claude/settings.json</Code> and leaves your other settings as they are.
        </>
      ),
    },
    file: {
      code: JSON.stringify({ env }, null, 2),
      note: shell === 'posix' ? '~/.claude/settings.json' : '%USERPROFILE%\\.claude\\settings.json',
      description: (
        <>
          Add this to your Claude Code user settings. If the file already has an <Code>env</Code> block, add the two lines to it.
        </>
      ),
    },
    vscode: {
      code: JSON.stringify({ 'claudeCode.environmentVariables': Object.entries(env).map(([name, value]) => ({ name, value })) }, null, 2),
      note: 'User settings (JSON)',
      description: (
        <>
          The VS Code extension reads its environment from VS Code. Open <Code>Preferences: Open User Settings (JSON)</Code> and add this.
        </>
      ),
    },
  }[target]

  return (
    <ol className="space-y-6">
      <Step n={1} title="Try it in a terminal" description="Starts Claude Code through the proxy. The setting lasts until you close that terminal.">
        <Snippet code={run} label={<Choice value={shell} onChange={setShell} options={SHELLS} />} />
      </Step>
      <Step n={2} title="Use it every time" description={keep.description}>
        <Snippet
          code={keep.code}
          label={
            <span className="flex min-w-0 items-center gap-3">
              <Choice
                value={target}
                onChange={setChoice}
                options={[
                  ...(shell === 'posix' ? [{ value: 'command' as const, label: 'Command' }] : []),
                  { value: 'file', label: 'Settings file' },
                  { value: 'vscode', label: 'VS Code' },
                ]}
              />
              <span className="truncate font-mono">{keep.note}</span>
            </span>
          }
        />
      </Step>
      <Step
        n={3}
        title="Check the connection"
        description={
          <>
            In Claude Code, run <Code>/status</Code>. <span className="text-foreground">Anthropic base URL</span> should read <Code>{origin}</Code> and{' '}
            <span className="text-foreground">Auth token</span> should name <Code>ANTHROPIC_AUTH_TOKEN</Code>. If Claude Code warns that two credentials are
            set, run <Code>/logout</Code> so only the proxy key is used. A notice that auto mode isn't eligible for a billing change is expected with
            any gateway.
          </>
        }
      />
    </ol>
  )
}

function Codex({ origin, clientKey, shell, setShell }: ToolProps) {
  const [choice, setChoice] = useState<'command' | 'file'>('command')
  const profile = `model_provider = "cliproxy"

[model_providers.cliproxy]
name = "CLIProxyAPI"
base_url = "${origin}/v1"
wire_api = "responses"
http_headers = { Authorization = "Bearer ${clientKey}" }
`
  const write =
    shell === 'posix'
      ? `mkdir -p ~/.codex && cat > ~/.codex/cliproxy.config.toml <<'EOF'\n${profile}EOF`
      : `New-Item -ItemType Directory -Force "$HOME\\.codex" | Out-Null\n[IO.File]::WriteAllText("$HOME\\.codex\\cliproxy.config.toml", @'\n${profile}'@)`
  const file = shell === 'posix' ? '~/.codex/cliproxy.config.toml' : '%USERPROFILE%\\.codex\\cliproxy.config.toml'

  return (
    <ol className="space-y-6">
      <Step
        n={1}
        title="Add the proxy to Codex"
        description={
          <>
            Creates a Codex profile named <Code>cliproxy</Code>. Your other Codex settings and your ChatGPT sign-in stay as they are.
          </>
        }
      >
        <Snippet
          code={choice === 'command' ? write : profile}
          label={
            <span className="flex min-w-0 items-center gap-3">
              <Choice
                value={choice}
                onChange={setChoice}
                options={[
                  { value: 'command', label: 'Command' },
                  { value: 'file', label: 'Profile file' },
                ]}
              />
              {choice === 'command' ? <Choice value={shell} onChange={setShell} options={SHELLS} /> : <span className="truncate font-mono">{file}</span>}
            </span>
          }
        />
      </Step>
      <Step
        n={2}
        title="Start Codex with it"
        description={
          shell === 'posix' ? (
            <>
              Plain <Code>codex</Code> keeps using your own account. To make the proxy the default, add <Code>alias codex='codex --profile cliproxy'</Code>{' '}
              to <Code>~/.zshrc</Code> or <Code>~/.bashrc</Code>.
            </>
          ) : (
            <>
              Plain <Code>codex</Code> keeps using your own account.
            </>
          )
        }
      >
        <Snippet code="codex --profile cliproxy" label="Terminal" />
      </Step>
      <Step
        n={3}
        title="Check the connection"
        description={
          <>
            Send any message. It shows up on the{' '}
            <Link to="/usage" className="text-foreground underline underline-offset-4">
              Usage
            </Link>{' '}
            page within a few seconds. Codex uses its default model; switch with <Code>/model</Code>.
          </>
        }
      />
    </ol>
  )
}

function OtherClients({ origin, clientKey }: { origin: string; clientKey: string }) {
  const [format, setFormat] = useState<'openai' | 'anthropic'>('openai')
  const models = useQuery({
    queryKey: ['console', 'v1', 'models'],
    queryFn: () => consoleApi<{ data?: ProxyModel[] }>('/v1/models'),
    select: (d) => d.data ?? [],
  })
  const [picked, setModel] = useState<string>()
  const list = models.data ?? []
  const has = (id?: string | null) => !!id && list.some((m) => m.id === id)
  // The model last used in the playground, else the newest Claude Sonnet.
  const sonnet = list
    .map((m) => m.id)
    .filter((id) => id.startsWith('claude-sonnet-'))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0]
  const fallback = [localStorage.getItem(PLAYGROUND_MODEL_KEY), sonnet, list[0]?.id].find(has)
  const model = (has(picked) ? picked : fallback) ?? '<model>'

  const curl =
    format === 'openai'
      ? `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${clientKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}'`
      : `curl ${origin}/v1/messages \\
  -H "x-api-key: ${clientKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}'`

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="OpenAI-compatible base URL" value={`${origin}/v1`} />
        <Field label="Anthropic-compatible base URL" value={origin} />
        <Field label="API key" value={clientKey} />
      </div>
      <p className="text-sm text-muted-foreground">
        Send the key as <Code>Authorization: Bearer</Code>, <Code>x-api-key</Code> or <Code>x-goog-api-key</Code>, whichever your client uses.
      </p>
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">Try a request</div>
          <ModelPicker models={list} value={fallback || picked ? model : undefined} onChange={setModel} disabled={!list.length} className="h-8 w-64" />
        </div>
        <Snippet
          code={curl}
          label={
            <Choice
              value={format}
              onChange={setFormat}
              options={[
                { value: 'openai', label: 'OpenAI format' },
                { value: 'anthropic', label: 'Anthropic format' },
              ]}
            />
          }
        />
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
        <code className="truncate font-mono text-[13px]">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  )
}

function Step({ n, title, description, children }: { n: number; title: string; description: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3">
      <span className="flex size-6 items-center justify-center rounded-full border text-xs font-medium tabular">{n}</span>
      <div className="min-w-0 space-y-2.5">
        <div className="space-y-1">
          <div className="text-sm leading-6 font-medium">{title}</div>
          <p className="text-sm text-pretty text-muted-foreground">{description}</p>
        </div>
        {children}
      </div>
    </li>
  )
}

const Code = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>

function Snippet({ code, label }: { code: string; label: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b py-1 pr-1 pl-3 text-xs text-muted-foreground">
        <div className="min-w-0 overflow-x-auto whitespace-nowrap [scrollbar-width:none]">{label}</div>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{code}</pre>
    </div>
  )
}

function Choice<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <span role="radiogroup" className="flex shrink-0 items-center gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className="rounded-md px-2 py-1 font-medium transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-xs"
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}
