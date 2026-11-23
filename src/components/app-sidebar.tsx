import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { Fragment, useState } from 'react'
import {
  BarChart3Icon,
  BlocksIcon,
  GiftIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LightbulbIcon,
  LogOutIcon,
  MenuIcon,
  PlugIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { Logo } from '@/components/auth-shell'
import { StatusDot } from '@/components/common'
import { ConsoleVersion } from '@/components/console-update'
import { ThemeToggle } from '@/components/theme'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { auth } from '@/lib/api'
import { queries } from '@/lib/queries'
import type { ProcessState } from '@/lib/types'

const NAV = [
  {
    label: 'Monitor',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboardIcon },
      { to: '/usage', label: 'Usage', icon: BarChart3Icon },
      { to: '/insights', label: 'Insights', icon: LightbulbIcon },
      { to: '/wrapped', label: 'Wrapped', icon: GiftIcon },
      { to: '/logs', label: 'Logs', icon: ScrollTextIcon },
    ],
  },
  {
    label: 'Manage',
    items: [
      { to: '/credentials', label: 'Credentials', icon: ShieldCheckIcon },
      { to: '/providers', label: 'Providers', icon: BlocksIcon },
      { to: '/keys', label: 'Client keys', icon: KeyRoundIcon },
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
  {
    label: 'Tools',
    items: [
      { to: '/connect', label: 'Connect', icon: PlugIcon },
    ],
  },
] as const

export const PROCESS_LABEL: Record<ProcessState, { label: string; tone: 'good' | 'warn' | 'bad' | 'idle' }> = {
  running: { label: 'Running', tone: 'good' },
  starting: { label: 'Starting', tone: 'warn' },
  stopping: { label: 'Stopping', tone: 'warn' },
  stopped: { label: 'Stopped', tone: 'idle' },
  crashed: { label: 'Crashed', tone: 'bad' },
}

const isActive = (to: string, pathname: string) => (to === '/' ? pathname === '/' : pathname.startsWith(to))

/** The console's navigation: one bar across the top; on phones a menu. */
export function AppNav() {
  const { data: status } = useQuery(queries.status())
  const qc = useQueryClient()
  const navigate = useNavigate()
  const pathname = useLocation({ select: (l) => l.pathname })
  const [open, setOpen] = useState(false)
  const state = status?.process.state
  const p = state ? PROCESS_LABEL[state] : undefined
  const current = NAV.flatMap((g): readonly { to: string; label: string }[] => g.items).find((i) => isActive(i.to, pathname))
  const signOut = () => {
    auth.clear()
    qc.clear()
    void navigate({ to: '/login' })
  }

  return (
    <header className="sticky top-0 z-20 border-b bg-background">
      <div className="mx-auto flex h-11 max-w-[90rem] items-center gap-1 px-3 md:px-5">
        <Link to="/" className="mr-3 flex shrink-0 items-center gap-2 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <Logo className="size-[18px]" />
          <span className="text-[13px] font-semibold tracking-tight max-md:hidden">CPA Console</span>
          <span className="text-[13px] font-medium md:hidden">{current?.label}</span>
        </Link>
        <nav aria-label="Main" className="flex min-w-0 items-center gap-0.5 overflow-x-auto max-md:hidden">
          {NAV.map((group, gi) => (
            <Fragment key={group.label}>
              {gi > 0 && <span aria-hidden className="mx-1.5 h-3.5 w-px shrink-0 bg-border" />}
              {group.items.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  data-active={isActive(item.to, pathname) || undefined}
                  className="shrink-0 rounded-[5px] px-2 py-1 text-[13px] whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-active:bg-foreground/[0.06] data-active:text-foreground"
                >
                  {item.label}
                </Link>
              ))}
            </Fragment>
          ))}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {p && (
            <span className="mr-1 flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground" title={`CLIProxyAPI ${p.label.toLowerCase()}`}>
              <StatusDot tone={p.tone} pulse={state === 'starting'} />
              {status?.cpa.version ?? p.label}
            </span>
          )}
          <ThemeToggle />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Sign out" className="text-muted-foreground max-md:hidden" onClick={signOut}>
                <LogOutIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sign out</TooltipContent>
          </Tooltip>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Menu" className="md:hidden">
                <MenuIcon />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-64 gap-0 p-3">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <nav aria-label="Main" className="mt-8 space-y-4">
                {NAV.map((group) => (
                  <div key={group.label} className="space-y-0.5">
                    <div className="px-2 pb-1 text-[11.5px] text-muted-foreground">{group.label}</div>
                    {group.items.map((item) => (
                      <Link
                        key={item.to}
                        to={item.to}
                        onClick={() => setOpen(false)}
                        data-active={isActive(item.to, pathname) || undefined}
                        className="flex h-8 items-center gap-2.5 rounded-[5px] px-2 text-[13px] text-muted-foreground data-active:bg-foreground/[0.06] data-active:text-foreground [&_svg]:size-4"
                      >
                        <item.icon />
                        {item.label}
                      </Link>
                    ))}
                  </div>
                ))}
              </nav>
              <div className="mt-auto space-y-1 border-t pt-3">
                <ConsoleVersion version={status?.consoleVersion} />
                <button type="button" onClick={signOut} className="flex h-8 w-full items-center gap-2.5 rounded-[5px] px-2 text-[13px] text-muted-foreground">
                  <LogOutIcon className="size-4" /> Sign out
                </button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
