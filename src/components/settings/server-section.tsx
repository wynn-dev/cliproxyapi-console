import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, KeyRoundIcon, ShieldCheckIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { confirm } from '@/components/confirm'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { auth, consoleApi, mgmt } from '@/lib/api'
import { queries } from '@/lib/queries'
import { NumberField, SectionCard, SwitchField, TextField } from './form'
import { useReportDirty, useSectionForm, type FieldSpec } from './form-state'
import { Default, FieldSection, type DirtyReporter } from './sections'

const LOOPBACK_OK = ['', '0.0.0.0', '::', '[::]', '127.0.0.1', 'localhost']

const serverSpecs: Record<string, FieldSpec> = {
  'server.host': { kind: 'text', default: '', validate: (v) => (/\s/.test(v) ? 'Host cannot contain spaces' : undefined) },
  'server.port': { kind: 'number', default: 8317, min: 1, max: 65535 },
  'server.tls.enable': { kind: 'switch', default: false },
  'server.tls.cert': { kind: 'text', default: '' },
  'server.tls.key': { kind: 'text', default: '' },
  'server.commercial-mode': { kind: 'switch', default: false },
}

export function ServerSection({ onDirty }: { onDirty: DirtyReporter }) {
  const qc = useQueryClient()
  const { data } = useQuery(queries.config())
  const form = useSectionForm(serverSpecs, data, 'Server')
  useReportDirty('server', form.dirty, onDirty)
  const host = String(form.value('server.host')).trim()
  const port = String(form.value('server.port')) || '8317'
  const tls = form.value('server.tls.enable') === true
  const listenChanged = form.isDirty('server.host') || form.isDirty('server.port')

  const save = () =>
    confirm({
      title: 'Save and restart CLIProxyAPI?',
      description: (
        <>
          Listener settings only take effect after a restart, so CPA restarts right after saving. In-flight requests are interrupted for a
          moment.
          {listenChanged && (
            <>
              {' '}
              Clients will need to connect to{' '}
              <span className="font-mono text-foreground">
                {host || '0.0.0.0'}:{port}
              </span>
              .
            </>
          )}
        </>
      ),
      confirmLabel: 'Save & restart',
      onConfirm: async () => {
        if (!(await form.save())) return
        try {
          await consoleApi('/process/restart', { method: 'POST' })
          toast.success('CLIProxyAPI is restarting')
        } catch (err) {
          toast.error('Saved, but the restart failed', { description: (err as Error).message })
        } finally {
          void qc.invalidateQueries({ queryKey: ['console', 'status'] })
        }
      },
    })

  return (
    <SectionCard
      title="Server"
      description="Where CPA listens for client traffic."
      form={form}
      onSave={save}
      footerNote="Saving restarts CLIProxyAPI."
    >
      <FieldSection title="Listener">
        <TextField
          form={form}
          path="server.host"
          label="Host"
          mono
          placeholder="All interfaces"
          className="@md/field-group:w-48!"
          description="Interface to bind. Empty listens on all interfaces (IPv4 and IPv6); 127.0.0.1 keeps CPA reachable from this machine only."
        />
        {!LOOPBACK_OK.includes(host) && (
          <WarningAlert title="The console may lose its connection">
            The console talks to CPA at 127.0.0.1. Binding only to {host} can cut it off from management and usage collection.
          </WarningAlert>
        )}
        <NumberField
          form={form}
          path="server.port"
          label="Port"
          description="The port clients use for /v1 and the other proxy APIs. Changing it means updating every client's base URL."
        />
      </FieldSection>
      <FieldSection title="TLS">
        <SwitchField
          form={form}
          path="server.tls.enable"
          label="Serve HTTPS"
          description="Listen with TLS using the certificate and key below instead of plain HTTP."
        />
        {tls && form.isDirty('server.tls.enable') && (
          <WarningAlert title="This console connects to CPA over plain HTTP">
            With TLS on, the console can no longer reach CPA for management or usage collection. Prefer terminating TLS in a reverse proxy
            in front of CPA.
          </WarningAlert>
        )}
        <TextField
          form={form}
          path="server.tls.cert"
          label="Certificate file"
          mono
          placeholder="/path/to/cert.pem"
          disabled={!tls}
          description="Path to the PEM certificate (chain) on the server."
        />
        <TextField
          form={form}
          path="server.tls.key"
          label="Private key file"
          mono
          placeholder="/path/to/key.pem"
          disabled={!tls}
          description="Path to the PEM private key on the server."
        />
      </FieldSection>
      <FieldSection title="Performance">
        <SwitchField
          form={form}
          path="server.commercial-mode"
          label="Commercial mode"
          description={
            <>
              Turns off high-overhead request logging and HTTP middleware to cut per-request memory under heavy concurrency.
              <Default>off</Default>
            </>
          }
        />
      </FieldSection>
    </SectionCard>
  )
}

function WarningAlert({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Alert className="border-warning/40 bg-warning/5">
      <AlertTriangleIcon className="text-warning" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

const MIN_KEY = 12

export function ManagementSection() {
  const qc = useQueryClient()
  const { data } = useQuery(queries.config())
  const [key, setKey] = useState('')
  const [again, setAgain] = useState('')
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const allowRemote = data?.management?.['allow-remote'] === true

  const keyError = key && key.length < MIN_KEY ? `Use at least ${MIN_KEY} characters` : /\s/.test(key) ? 'Keys cannot contain spaces' : undefined
  const matchError = touched && again && again !== key ? "Keys don't match" : undefined
  const ready = key.length >= MIN_KEY && !keyError && again === key

  const change = () =>
    confirm({
      title: 'Change the management key?',
      description:
        'This browser switches to the new key automatically. Anything else that uses the old key, including other signed-in browsers, will need the new one.',
      confirmLabel: 'Change key',
      onConfirm: async () => {
        setSaving(true)
        try {
          // CPA stores the plaintext and replaces it with a bcrypt hash on reload.
          await mgmt('/config/management/secret-key', {
            method: 'PUT',
            body: JSON.stringify(key),
            headers: { 'Content-Type': 'application/json' },
          })
          // Switch keys before anything else hits the API with the old one.
          auth.set(key)
          setKey('')
          setAgain('')
          setTouched(false)
          toast.success('Management key changed', { description: 'Use the new key next time you sign in.' })
          void qc.invalidateQueries({ queryKey: ['mgmt'] })
        } catch (err) {
          toast.error('Could not change the key', { description: (err as Error).message })
        } finally {
          setSaving(false)
        }
      },
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Management access</CardTitle>
        <CardDescription>The key that protects this console and CPA's management API.</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="responsive">
            <FieldContent>
              <FieldLabel>Remote management</FieldLabel>
              <FieldDescription>
                The console reaches CPA over localhost, so CPA's own remote management should stay off; manage remotely through this console
                instead.
              </FieldDescription>
            </FieldContent>
            {data ? (
              <Badge variant="outline" className="gap-1.5">
                {allowRemote ? <AlertTriangleIcon className="text-warning" /> : <ShieldCheckIcon className="text-success" />}
                {allowRemote ? 'On' : 'Off'}
              </Badge>
            ) : null}
          </Field>
          {allowRemote && (
            <WarningAlert title="Remote management is on">
              CPA's management API accepts non-localhost connections. Turn off <code className="font-mono text-xs">management.allow-remote</code>{' '}
              in the config file unless you need it.
            </WarningAlert>
          )}
          <div className="flex flex-col gap-5 border-t pt-5">
            <h3 className="text-sm font-medium text-muted-foreground">Change management key</h3>
            <Field data-invalid={!!keyError || undefined}>
              <FieldLabel htmlFor="new-management-key">New key</FieldLabel>
              <Input
                id="new-management-key"
                type="password"
                autoComplete="new-password"
                className="font-mono md:max-w-sm"
                value={key}
                aria-invalid={!!keyError}
                onChange={(e) => setKey(e.target.value)}
              />
              <FieldDescription>At least {MIN_KEY} characters. A long random string works best.</FieldDescription>
              <FieldError>{keyError}</FieldError>
            </Field>
            <Field data-invalid={!!matchError || undefined}>
              <FieldLabel htmlFor="confirm-management-key">Confirm new key</FieldLabel>
              <Input
                id="confirm-management-key"
                type="password"
                autoComplete="new-password"
                className="font-mono md:max-w-sm"
                value={again}
                aria-invalid={!!matchError}
                onChange={(e) => setAgain(e.target.value)}
                onBlur={() => setTouched(true)}
              />
              <FieldError>{matchError}</FieldError>
            </Field>
          </div>
        </FieldGroup>
      </CardContent>
      <CardFooter className="justify-end">
        <Button size="sm" disabled={!ready || saving} onClick={change}>
          {saving ? <Spinner /> : <KeyRoundIcon />}
          Change key
        </Button>
      </CardFooter>
    </Card>
  )
}
