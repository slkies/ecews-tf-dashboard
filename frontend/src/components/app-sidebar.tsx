import {
  BookOpen, ChartLine, ClipboardList, FileText, GitCompareArrows, LayoutDashboard,
  ListChecks, ListFilter, Microscope, Settings2, ShieldCheck, Stethoscope, Timer,
} from 'lucide-react'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { useSession } from '@/core/session'
import BuildLine from '@/shell/BuildLine'
import { GROUPS, NAV } from '@/shell/nav'

const ICONS: Record<string, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  cascade: ListFilter,
  deep: Microscope,
  dtc: Stethoscope,
  time: Timer,
  compare: GitCompareArrows,
  worklists: ListChecks,
  plans: ClipboardList,
  adv: ChartLine,
  dq: ShieldCheck,
  guide: BookOpen,
  method: FileText,
  admin: Settings2,
}

/**
 * The frame's navigation.
 *
 * Grouped as the programme thinks about the work - Programme, Action,
 * Reference - with the active page marked by a tinted pill rather than a bar,
 * and the line-list provenance in the footer where it is always one glance
 * away. Collapses to icons; each icon keeps its name as a tooltip.
 */
export function AppSidebar({ view, onNavigate, asof, episodes, clients }: {
  view: string
  onNavigate: (id: string) => void
  asof: string
  episodes: string
  clients: string
}) {
  const { me } = useSession()
  const items = NAV.filter((n) => !n.adminOnly || me?.role === 'admin')

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-16 justify-center border-b border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={() => onNavigate('overview')}
                               className="hover:bg-transparent active:bg-transparent">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                EC
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-semibold text-foreground">TF Monitor</span>
                <span className="truncate text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                  ECEWS · SPEED
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-0 py-2">
        {GROUPS.map((g) => {
          const inGroup = items.filter((n) => n.group === g)
          if (!inGroup.length) return null
          return (
            <SidebarGroup key={g} className="py-1.5">
              <SidebarGroupLabel className="text-[11px] font-medium tracking-[0.08em] uppercase">
                {g}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {inGroup.map((n) => {
                    const Icon = ICONS[n.id] ?? LayoutDashboard
                    return (
                      <SidebarMenuItem key={n.id}>
                        <SidebarMenuButton isActive={view === n.id} tooltip={n.label}
                                           onClick={() => onNavigate(n.id)} className="h-9">
                          <Icon />
                          <span>{n.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )
        })}
      </SidebarContent>

      <SidebarFooter>
        {/* Provenance: what the numbers on screen were built from. */}
        <div className="rounded-lg border bg-card px-3 py-2.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          <div className="font-medium text-foreground">Line list · {asof}</div>
          <div className="tabular-nums">{episodes} episodes · {clients} clients</div>
          <BuildLine />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
