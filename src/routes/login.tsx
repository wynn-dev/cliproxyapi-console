import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthShell } from '@/components/auth-shell'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { auth, consoleApi } from '@/lib/api'
import type { ConsoleState } from '@/lib/types'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const state = await consoleApi<ConsoleState>('/state')
    if (!state.configured) throw redirect({ to: '/setup' })
  },
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(undefined)
    try {
      await consoleApi('/status', { key })
      auth.set(key)
      await navigate({ to: '/' })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthShell title="CPA Console" description="Enter your management key to continue.">
      <Card>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="key">Management key</FieldLabel>
                <Input id="key" type="password" autoFocus autoComplete="current-password" value={key} onChange={(e) => setKey(e.target.value)} />
              </Field>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={!key || pending}>
                {pending && <Spinner />}
                Sign in
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  )
}
