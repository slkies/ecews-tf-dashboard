/** The rail's contents. One list, so nav and routing cannot disagree. */

export interface NavItem {
  id: string
  label: string
  group: 'Programme' | 'Action' | 'Reference'
  adminOnly?: boolean
}

export const NAV: NavItem[] = [
  { id: 'overview', label: 'Overview',           group: 'Programme' },
  { id: 'cascade',  label: 'Cascade',            group: 'Programme' },
  { id: 'deep',     label: 'Deep dive',          group: 'Programme' },
  { id: 'dtc',      label: 'DTC review',         group: 'Programme' },
  { id: 'time',     label: 'Time metrics',       group: 'Programme' },
  { id: 'compare',  label: 'Line list changes',  group: 'Programme' },
  { id: 'plans',    label: 'Treatment plans',    group: 'Action' },
  { id: 'adv',      label: 'Advanced analytics', group: 'Action' },
  { id: 'dq',       label: 'Data quality',       group: 'Reference' },
  { id: 'guide',    label: 'Guidelines',         group: 'Reference' },
  { id: 'method',   label: 'Methodology',        group: 'Reference' },
  { id: 'admin',    label: 'Admin',              group: 'Reference', adminOnly: true },
]

export const GROUPS = ['Programme', 'Action', 'Reference'] as const
