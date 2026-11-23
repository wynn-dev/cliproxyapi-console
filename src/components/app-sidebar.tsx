import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  BarChart3Icon,
  BlocksIcon,
  GiftIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LightbulbIcon,
  LogOutIcon,
  PlugIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
} from 'lucide-react'
import { Logo } from '@/components/auth-shell'
import { StatusDot } from '@/components/common'
import { ConsoleVersion } from '@/components/console-update'
import { ThemeToggle } from '@/components/theme'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
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
      { to: '/providers', label: 'API providers', icon: BlocksIcon },
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

export function AppSidebar() {
  const { data: status } = useQuery(queries.status())
  const qc = useQueryClient()
  const navigate = useNavigate()
  const pathname = useLocation({ select: (l) => l.pathname })
  // On phones the sidebar is a sheet over the page; close it once a page is picked.
  const { setOpenMobile } = useSidebar()
  const close = () => setOpenMobile(false)
  const state = status?.process.state
  const p = state ? PROCESS_LABEL[state] : undefined

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex h-10 items-center gap-2.5 px-2">
              <Link to="/" onClick={close} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
                <Logo className="size-5 shrink-0" />
                <span className="truncate text-[0.9rem] font-semibold tracking-tight text-foreground">CPA Console</span>
              </Link>
              {p && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`CLIProxyAPI ${p.label.toLowerCase()} · ${status?.cpa.version ?? 'not installed'}`}>
                  <StatusDot tone={p.tone} pulse={state === 'starting'} />
                  <span className="tabular">{status?.cpa.version ?? p.label}</span>
                </span>
              )}
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      tooltip={item.label}
                      isActive={item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)}
                    >
                      <Link to={item.to} onClick={close}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign out"
              onClick={() => {
                auth.clear()
                qc.clear()
                void navigate({ to: '/login' })
              }}
            >
              <LogOutIcon />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem className="flex items-center justify-between">
            <ConsoleVersion version={status?.consoleVersion} />
            <ThemeToggle />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
