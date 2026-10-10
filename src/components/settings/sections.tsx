import { useQuery } from '@tanstack/react-query'
import { AlertTriangleIcon, LayersIcon } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { queries } from '@/lib/queries'
import { SUBSCRIPTION_ROUTING, hasAccountPool, keepsCachesWarm } from '@/lib/routing'
import { NumberField, SectionCard, SelectField, SwitchField, TextField } from './form'
import { useReportDirty, useSectionForm, type FieldSpec } from './form-state'

export type DirtyReporter = (id: string, dirty: boolean) => void

export function FieldSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-5 border-t pt-5 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

export function Default({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground/80"> Default: {children}.</span>
}

// --- Routing ---------------------------------------------------------------------------------

const STRATEGIES = [
  {
    value: 'round-robin',
    label: 'Round robin',
    help: 'Rotates evenly through every eligible credential. Suits API keys; with several subscription accounts it moves conversations between accounts, and prompt caches do not follow.',
  },
  {
    value: 'weighted-round-robin',
    label: 'Weighted round robin',
    help: "Rotates in proportion to each credential's weight (default 1, max 1,000,000). Credentials with a weight of 0 or less are skipped.",
  },
  {
    value: 'fill-first',
    label: 'Fill first',
    help: 'Sends everything to the first eligible credential (highest priority, then file name) until it hits a limit or cooldown, then moves on to the next one. Keeps prompt caches warm on subscription accounts.',
  },
]

const routingSpecs: Record<string, FieldSpec> = {
  'routing.strategy': { kind: 'select', default: 'round-robin' },
  'routing.session-affinity': { kind: 'switch', default: false },
  'routing.session-affinity-ttl': {
    kind: 'text',
    default: '1h',
    validate: (v) => (/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(v) ? undefined : 'Use a duration like 30m, 1h or 1h30m'),
  },
  'routing.session-affinity-subagents': { kind: 'switch', default: true },
  'routing.force-model-prefix': { kind: 'switch', default: false },
}

export function RoutingSection({ onDirty }: { onDirty: DirtyReporter }) {
  const { data } = useQuery(queries.config())
  const form = useSectionForm(routingSpecs, data, 'Routing')
  useReportDirty('routing', form.dirty, onDirty)
  const strategy = STRATEGIES.find((s) => s.value === form.value('routing.strategy'))
  const affinity = form.value('routing.session-affinity') === true
  const affinityOff = affinity ? undefined : ' Only applies when session affinity is on.'
  const credentials = useQuery({ ...queries.credentials(), refetchInterval: false })
  const recommend = hasAccountPool(credentials.data?.files) && !keepsCachesWarm({ strategy: String(form.value('routing.strategy')), affinity })

  return (
    <SectionCard title="Routing" description="How CPA picks a credential when several can serve the same model." form={form}>
      {recommend && (
        <Alert>
          <LayersIcon />
          <AlertTitle>Several accounts share a provider</AlertTitle>
          <AlertDescription>
            Prompt caches belong to one account, so every switch between accounts re-sends the conversation uncached and uses limits faster.
            Fill first with session affinity stays on one account until it runs out and keeps each conversation where it started.
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                form.set('routing.strategy', SUBSCRIPTION_ROUTING.strategy)
                form.set('routing.session-affinity', SUBSCRIPTION_ROUTING.affinity)
              }}
            >
              Use these
            </Button>
          </AlertAction>
        </Alert>
      )}
      <SelectField
        form={form}
        path="routing.strategy"
        label="Strategy"
        options={STRATEGIES}
        description={
          <>
            {strategy?.help ?? 'Unknown strategy.'}
            <Default>round robin</Default>
          </>
        }
      />
      <SwitchField
        form={form}
        path="routing.session-affinity"
        label="Session affinity"
        description={
          <>
            Pins each client session (Claude Code, Codex, OpenCode session headers, prompt cache keys, conversation IDs) to one credential so
            upstream prompt caches stay warm. Fails over automatically when that credential becomes unavailable, and a bound session keeps its
            credential even if an earlier or higher-priority one recovers.
            <Default>off</Default>
          </>
        }
      />
      <TextField
        form={form}
        path="routing.session-affinity-ttl"
        label="Affinity TTL"
        mono
        className="@md/field-group:w-36!"
        disabled={!affinity}
        description={
          <>
            How long a session stays bound to its credential after its last request, as a duration (30m, 1h, 2h30m).{affinityOff}
            <Default>1h</Default>
          </>
        }
      />
      <SwitchField
        form={form}
        path="routing.session-affinity-subagents"
        label="Subagents share the parent's credential"
        disabled={!affinity}
        description={
          <>
            Subagents (child sessions that reference a parent) reuse the parent's credential to maximize prompt cache reuse. Turn off to spread
            them across the pool for more parallelism.{affinityOff}
            <Default>on</Default>
          </>
        }
      />
      <SwitchField
        form={form}
        path="routing.force-model-prefix"
        label="Force model prefix"
        description={
          <>
            Requests for an unprefixed model only use credentials without a prefix, so prefixed credentials are reachable only as{' '}
            <code className="font-mono text-xs">prefix/model</code>.
            <Default>off</Default>
          </>
        }
      />
    </SectionCard>
  )
}

// --- Retries & cooldown ----------------------------------------------------------------------

const retrySpecs: Record<string, FieldSpec> = {
  'routing.retry.request-retry': { kind: 'number', default: 0, min: 0, max: 100 },
  'routing.retry.max-retry-credentials': { kind: 'number', default: 0, min: 0 },
  'routing.retry.max-retry-interval': { kind: 'number', default: 0, min: 0 },
  'routing.cooldown.disable-cooling': { kind: 'switch', default: false },
  'routing.cooldown.save-cooldown-status': { kind: 'switch', default: false },
  'routing.cooldown.transient-error-cooldown-seconds': { kind: 'number', default: 0, min: -1 },
}

export function RetriesSection({ onDirty }: { onDirty: DirtyReporter }) {
  const { data } = useQuery(queries.config())
  const form = useSectionForm(retrySpecs, data, 'Retries & cooldown')
  useReportDirty('retries', form.dirty, onDirty)

  return (
    <SectionCard
      title="Retries & cooldown"
      description="What happens when an upstream request fails, and how long failing credentials are rested."
      form={form}
    >
      <FieldSection title="Retries">
        <NumberField
          form={form}
          path="routing.retry.request-retry"
          label="Retry rounds"
          description={
            <>
              Extra rounds across credentials after every eligible credential has failed once. Applies to HTTP 403, 408, 429, 500, 502, 503
              and 504. Provider and credential overrides take precedence. 0 disables extra rounds.
              <Default>0 (the example config uses 3)</Default>
            </>
          }
        />
        <NumberField
          form={form}
          path="routing.retry.max-retry-credentials"
          label="Credentials per round"
          description={
            <>
              Maximum number of different credentials tried in each round. 0 tries every available credential.
              <Default>0</Default>
            </>
          }
        />
        <NumberField
          form={form}
          path="routing.retry.max-retry-interval"
          label="Max wait between rounds"
          unit="s"
          description={
            <>
              Longest time to wait for a credential to leave cooldown before the next round. 0 never waits for cooldowns.
              <Default>0 (the example config uses 30)</Default>
            </>
          }
        />
      </FieldSection>
      <FieldSection title="Cooldown">
        <SwitchField
          form={form}
          path="routing.cooldown.disable-cooling"
          label="Disable cooldowns"
          description={
            <>
              Never rest credentials or models after quota or error responses, so they stay in rotation. Provider and credential settings
              override this.
              <Default>off</Default>
            </>
          }
        />
        <SwitchField
          form={form}
          path="routing.cooldown.save-cooldown-status"
          label="Persist cooldown state"
          description={
            <>
              Save each credential's cooldown as a <code className="font-mono text-xs">.cds</code> file next to its auth file so it survives
              restarts. When off, cooldowns live in memory only.
              <Default>off</Default>
            </>
          }
        />
        <NumberField
          form={form}
          path="routing.cooldown.transient-error-cooldown-seconds"
          label="Transient error cooldown"
          unit="s"
          description={
            <>
              How long a credential rests after a transient upstream error (408, 500, 502–504, 520–526). 0 keeps the legacy 60 seconds; −1
              disables these cooldowns.
              <Default>0 (60 seconds)</Default>
            </>
          }
        />
      </FieldSection>
    </SectionCard>
  )
}

// --- Network & requests ----------------------------------------------------------------------

function validateProxyUrl(v: string) {
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return 'Enter a full URL, e.g. socks5://user:pass@host:1080'
  }
  if (!['socks5:', 'socks5h:', 'http:', 'https:'].includes(url.protocol)) return 'Use a socks5://, http:// or https:// URL'
  if (!url.hostname) return 'The URL needs a host'
  return undefined
}

const networkSpecs: Record<string, FieldSpec> = {
  'requests.proxy-url': { kind: 'text', default: '', validate: validateProxyUrl },
  'requests.passthrough-headers': { kind: 'switch', default: false },
  'requests.nonstream-keepalive-interval': { kind: 'number', default: 0, min: 0 },
  'requests.streaming.keepalive-seconds': { kind: 'number', default: 0, min: 0 },
  'requests.streaming.bootstrap-retries': { kind: 'number', default: 0, min: 0, max: 10 },
}

export function NetworkSection({ onDirty }: { onDirty: DirtyReporter }) {
  const { data } = useQuery(queries.config())
  const form = useSectionForm(networkSpecs, data, 'Network & requests')
  useReportDirty('network', form.dirty, onDirty)

  return (
    <SectionCard title="Network & requests" description="Outbound proxy and connection keep-alive behavior for upstream requests." form={form}>
      <FieldSection title="Upstream">
        <TextField
          form={form}
          path="requests.proxy-url"
          label="Proxy URL"
          mono
          placeholder="socks5://user:pass@host:1080"
          description={
            <>
              Send all upstream traffic through this proxy (socks5, http or https; credentials optional). Individual credentials and API keys
              can override it. Leave empty to connect directly.
            </>
          }
        />
        <SwitchField
          form={form}
          path="requests.passthrough-headers"
          label="Pass through upstream headers"
          description={
            <>
              Forward filtered upstream response headers to clients.
              <Default>off</Default>
            </>
          }
        />
        <NumberField
          form={form}
          path="requests.nonstream-keepalive-interval"
          label="Non-streaming keep-alive"
          unit="s"
          description={
            <>
              Emit a blank line every N seconds while a non-streaming response is pending, so clients and load balancers with idle timeouts
              don't drop long requests. 0 disables.
              <Default>0</Default>
            </>
          }
        />
      </FieldSection>
      <FieldSection title="Streaming">
        <NumberField
          form={form}
          path="requests.streaming.keepalive-seconds"
          label="SSE keep-alive"
          unit="s"
          description={
            <>
              Send an SSE keep-alive comment every N seconds during streaming responses. 0 disables.
              <Default>0</Default>
            </>
          }
        />
        <NumberField
          form={form}
          path="requests.streaming.bootstrap-retries"
          label="Bootstrap retries"
          description={
            <>
              Retry a streaming request that fails before its first byte reaches the client. Safe, since nothing has been sent yet. 0
              disables.
              <Default>0</Default>
            </>
          }
        />
      </FieldSection>
    </SectionCard>
  )
}

// --- Logging & usage -------------------------------------------------------------------------

const loggingSpecs: Record<string, FieldSpec> = {
  'observability.logs.debug': { kind: 'switch', default: false },
  'observability.logs.logging-to-file': { kind: 'switch', default: false },
  'observability.logs.request-log': { kind: 'switch', default: false },
  'observability.logs.logs-max-total-size-mb': { kind: 'number', default: 0, min: 0 },
  'observability.logs.error-logs-max-files': { kind: 'number', default: 10, min: 0 },
  'observability.usage.usage-statistics-enabled': { kind: 'switch', default: false },
  'observability.usage.redis-usage-queue-retention-seconds': { kind: 'number', default: 60, min: 1, max: 3600 },
}

export function LoggingSection({ onDirty }: { onDirty: DirtyReporter }) {
  const { data } = useQuery(queries.config())
  const form = useSectionForm(loggingSpecs, data, 'Logging & usage')
  useReportDirty('logging', form.dirty, onDirty)
  const usageOff = form.loaded && form.value('observability.usage.usage-statistics-enabled') !== true
  const fileLogsOff = form.loaded && form.value('observability.logs.logging-to-file') !== true

  return (
    <SectionCard title="Logging & usage" description="Application logs, request logs and the usage statistics this console reads." form={form}>
      <FieldSection title="Logs">
        <SwitchField
          form={form}
          path="observability.logs.debug"
          label="Debug logging"
          description={
            <>
              Verbose debug-level application logs. Helpful when troubleshooting, noisy otherwise.
              <Default>off</Default>
            </>
          }
        />
        <SwitchField
          form={form}
          path="observability.logs.logging-to-file"
          label="Log to file"
          description={
            <>
              Write application logs to rotating files instead of stdout. The console's Logs page reads these files.
              <Default>off</Default>
            </>
          }
        >
          {fileLogsOff && <p className="mt-1 text-xs text-warning">The Logs page stays empty while this is off.</p>}
        </SwitchField>
        <SwitchField
          form={form}
          path="observability.logs.request-log"
          label="Request logs"
          description={
            <>
              Record full request and response bodies for proxy traffic (management calls excluded). Files contain prompts and outputs and
              grow quickly.
              <Default>off</Default>
            </>
          }
        />
        <NumberField
          form={form}
          path="observability.logs.logs-max-total-size-mb"
          label="Log directory size limit"
          unit="MB"
          description={
            <>
              Delete the oldest log files once the logs directory exceeds this size. 0 means no limit.
              <Default>0</Default>
            </>
          }
        />
        <NumberField
          form={form}
          path="observability.logs.error-logs-max-files"
          label="Error log files kept"
          description={
            <>
              With request logs off, CPA still saves a log file for each failed request. Keeps the newest N; 0 disables cleanup.
              <Default>10</Default>
            </>
          }
        />
      </FieldSection>
      <FieldSection title="Usage statistics">
        <SwitchField
          form={form}
          path="observability.usage.usage-statistics-enabled"
          label="Collect usage statistics"
          description={
            <>
              Aggregate per-request token and latency data in memory. This console collects it into its own history.
              <Default>off</Default>
            </>
          }
        />
        {usageOff && (
          <Alert className="border-warning/40 bg-warning/5">
            <AlertTriangleIcon className="text-warning" />
            <AlertTitle>The Usage page needs this on</AlertTitle>
            <AlertDescription>Without usage statistics the console records no new requests, tokens or latency.</AlertDescription>
          </Alert>
        )}
        <NumberField
          form={form}
          path="observability.usage.redis-usage-queue-retention-seconds"
          label="Usage queue retention"
          unit="s"
          description={
            <>
              How long usage records wait in memory for a collector. The console collects every 5 seconds, so 60 or more is plenty. Max 3600.
              <Default>60</Default>
            </>
          }
        />
      </FieldSection>
    </SectionCard>
  )
}
