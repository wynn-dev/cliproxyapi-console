import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { CopyButton, PageHeader, SecretText } from '@/components/common'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { maskSecret } from '@/lib/format'
import { queries } from '@/lib/queries'

export const Route = createFileRoute('/_app/connect')({ component: Connect })

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]']

/** Ready-to-paste setup for Claude Code, and the plain endpoint for everything else. */
function Connect() {
  const { data: status } = useQuery(queries.status())
  const port = status?.config?.port ?? 8317
  const origin = `${window.location.protocol}//${window.location.hostname}:${port}`
  const key = status?.config?.clientKeys[0]
  // The proxy only listens on this machine, or the console was opened locally and may be used from elsewhere.
  const proxyLocalOnly = LOCAL_HOSTS.includes(status?.config?.host ?? '')
  const openedLocally = LOCAL_HOSTS.includes(window.location.hostname)

  return (
    <>
      <PageHeader title="Connect" description="Point Claude Code, or any OpenAI, Claude or Gemini compatible tool, at the proxy." />
      {!key && <NoKey />}
      <Card>
        <CardHeader>
          <CardTitle>Claude Code</CardTitle>
          <CardDescription>
            Three steps, with this proxy's address and your client key filled in. While they are set, Claude Code uses the accounts in this
            proxy, not the one you are signed in to.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ClaudeCode origin={origin} clientKey={key} />
          {(proxyLocalOnly || openedLocally) && (
            <p className="text-xs text-muted-foreground">
              {proxyLocalOnly
                ? 'The proxy only accepts connections from this machine.'
                : `Running Claude Code on another machine? Replace ${window.location.hostname} with this server's address.`}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Other clients</CardTitle>
          <CardDescription>Use this base URL and client key in any tool that speaks the OpenAI, Claude or Gemini API.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <OtherClients origin={origin} clientKey={key} />
        </CardContent>
      </Card>
    </>
  )
}

function NoKey() {
  return (
    <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
      There is no client key yet.{' '}
      <Link to="/keys" className="text-foreground underline underline-offset-4">
        Create one
      </Link>{' '}
      and the commands below fill in.
    </p>
  )
}

type Shell = 'posix' | 'powershell'
type Target = 'command' | 'file' | 'vscode'

function ClaudeCode({ origin, clientKey }: { origin: string; clientKey?: string }) {
  const [shell, setShell] = useState<Shell>(() => (/windows/i.test(navigator.userAgent) ? 'powershell' : 'posix'))
  const [choice, setChoice] = useState<Target>('command')
  // The command is a shell heredoc, so PowerShell falls back to editing the file.
  const target = choice === 'command' && shell !== 'posix' ? 'file' : choice
  const key = clientKey ?? '<client-key>'
  const env = { ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: key }

  const run =
    shell === 'posix'
      ? `export ANTHROPIC_BASE_URL=${origin}\nexport ANTHROPIC_AUTH_TOKEN=${key}\nclaude`
      : `$env:ANTHROPIC_BASE_URL = "${origin}"\n$env:ANTHROPIC_AUTH_TOKEN = "${key}"\nclaude`
  const settingsFile = shell === 'posix' ? '~/.claude/settings.json' : '%USERPROFILE%\\.claude\\settings.json'
  const keep = {
    command: {
      code: `node - <<'EOF'
const fs = require('fs'), file = require('os').homedir() + '/.claude/settings.json'
const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
settings.env = { ...settings.env, ANTHROPIC_BASE_URL: '${origin}', ANTHROPIC_AUTH_TOKEN: '${key}' }
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
      note: settingsFile,
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
      <Step n={1} title="Start Claude Code through the proxy" description="Run this in a terminal. It applies to that terminal until you close it.">
        <Snippet
          code={run}
          secret={clientKey}
          label={
            <Choice
              value={shell}
              onChange={setShell}
              options={[
                { value: 'posix', label: 'macOS / Linux' },
                { value: 'powershell', label: 'PowerShell' },
              ]}
            />
          }
        />
      </Step>
      <Step n={2} title="Keep it for every session" description={keep.description}>
        <Snippet
          code={keep.code}
          secret={clientKey}
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
            <span className="text-foreground">Auth token</span> should name <Code>ANTHROPIC_AUTH_TOKEN</Code>. Then send any message.
          </>
        }
      />
    </ol>
  )
}

function OtherClients({ origin, clientKey }: { origin: string; clientKey?: string }) {
  const baseUrl = `${origin}/v1`
  const curl = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${clientKey ?? '<client-key>'}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "<model>", "messages": [{"role": "user", "content": "Hello"}]}'`

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-xs text-muted-foreground">Base URL</div>
          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
            <code className="truncate font-mono text-[13px]">{baseUrl}</code>
            <CopyButton value={baseUrl} />
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            Client key
            <Link to="/keys" className="hover:text-foreground">
              Manage keys
            </Link>
          </div>
          <div className="flex items-center rounded-md border bg-muted/40 py-1 pr-1 pl-3">
            {clientKey ? <SecretText value={clientKey} className="w-full justify-between" /> : <span className="py-1 text-sm text-muted-foreground">No client keys</span>}
          </div>
        </div>
      </div>
      <Snippet code={curl} secret={clientKey} label="OpenAI-compatible request" />
    </>
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

/** A code block that shows the key masked and copies the real one. */
function Snippet({ code, secret, label }: { code: string; secret?: string; label: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b py-1 pr-1 pl-3 text-xs text-muted-foreground">
        <div className="min-w-0 truncate">{label}</div>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{secret ? code.replaceAll(secret, maskSecret(secret)) : code}</pre>
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
