import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { CircleAlertIcon, KeyRoundIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'
import { PageHeader } from '@/components/common'
import { AddCredentialDialog } from '@/components/credentials/add-credential-dialog'
import { CredentialsTable } from '@/components/credentials/credentials-table'
import { useAccountParam, validateAccountSearch } from '@/components/credentials/lib'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ApiError } from '@/lib/api'
import { queries } from '@/lib/queries'

/** `account` opens that credential's panel, so other pages can link to it. */
export const Route = createFileRoute('/_app/credentials')({
  validateSearch: validateAccountSearch,
  component: CredentialsPage,
})

function CredentialsPage() {
  const [adding, setAdding] = useState(false)
  const { account } = Route.useSearch()
  const { data, isLoading, error } = useQuery(queries.credentials())
  const files = data?.files ?? []
  const setAccount = useAccountParam(account, data?.files)
  const unavailable = error instanceof ApiError && error.status === 503

  return (
    <>
      <PageHeader
        title="Credentials"
        description="OAuth accounts CLIProxyAPI rotates through. Select a row for details and settings."
        actions={
          <Button onClick={() => setAdding(true)}>
            <PlusIcon />
            Add credential
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{unavailable ? 'CLIProxyAPI is not running' : 'Could not load credentials'}</AlertTitle>
          <AlertDescription>{unavailable ? 'Start it from the Overview page to manage credentials.' : error.message}</AlertDescription>
        </Alert>
      )}

      {!isLoading && !error && files.length === 0 ? (
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon />
            </EmptyMedia>
            <EmptyTitle>No credentials yet</EmptyTitle>
            <EmptyDescription>
              Sign in with a Claude or Codex account, or upload auth files you already have.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setAdding(true)}>
              <PlusIcon />
              Add credential
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        (isLoading || files.length > 0) && (
          <CredentialsTable
            files={files}
            loading={isLoading}
            account={account}
            onAccountChange={setAccount}
          />
        )
      )}

      <AddCredentialDialog open={adding} onOpenChange={setAdding} />
    </>
  )
}
