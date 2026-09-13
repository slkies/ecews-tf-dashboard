import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from 'cn'

export type Tone = 'good' | 'warn' | 'bad'

const TONES: Record<Tone, { Icon: typeof CircleCheck; cls: string }> = {
  good: { Icon: CircleCheck, cls: 'bg-good-tint text-good' },
  warn: { Icon: TriangleAlert, cls: 'bg-warn-tint text-warn' },
  bad: { Icon: CircleAlert, cls: 'bg-bad-tint text-bad' },
}

/**
 * Status, carried by an icon and a word as well as colour.
 *
 * shadcn's Badge variants (default, secondary, destructive, outline) are
 * generic and none of them means "on track". Status is also kept apart from
 * the brand accent: brand green marks what a thing is, these mark how it is.
 */
export function StatusBadge({ tone, children, className }: {
  tone: Tone
  children: ReactNode
  className?: string
}) {
  const { Icon, cls } = TONES[tone]
  return (
    <span className={cn(
      'inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap [&_svg]:size-3',
      cls, className)}>
      <Icon aria-hidden />
      {children}
    </span>
  )
}
