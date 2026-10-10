import type { QueryClient } from '@tanstack/react-query'
import { Outlet, createRootRouteWithContext, useRouter } from '@tanstack/react-router'
import { RotateCwIcon, UnplugIcon } from 'lucide-react'
import { AuthShell } from '@/components/auth-shell'
import { ConfirmHost } from '@/components/confirm'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <TooltipProvider delayDuration={300}>
      <Outlet />
      <Toaster position="bottom-right" />
      <ConfirmHost />
    </TooltipProvider>
  ),
  errorComponent: RootError,
})

function RootError({ error }: { error: unknown }) {
  const router = useRouter()
  return (
    <AuthShell title="Can't reach the console" description="The CPA Console server didn't respond. Check that it is running, then try again.">
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
          <UnplugIcon className="size-3.5" />
          {error instanceof Error ? error.message : String(error)}
        </div>
        <Button onClick={() => router.invalidate()}>
          <RotateCwIcon /> Try again
        </Button>
      </div>
    </AuthShell>
  )
}
