import { useEffect, useState } from 'react'
import { api } from '../core/api'
import type { BuildInfo } from '../core/types'

/**
 * Which build is on screen.
 *
 * Asked for by name when something looks wrong, so it has to be readable off
 * the page rather than curled from the API. Quiet enough to ignore the rest of
 * the time. A build made from a modified working tree says so - the only
 * honest thing to do, since it is not a release anyone can check out.
 */
export default function BuildLine() {
  const [info, setInfo] = useState<BuildInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    // Unauthenticated and cheap; a failure here is not worth surfacing, the
    // line simply does not appear.
    api<BuildInfo>('/version')
      .then((v) => { if (!cancelled) setInfo(v) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (!info) return null
  const commit = info.commit && info.commit !== 'unknown' ? ` · ${info.commit}` : ''
  return (
    <div className={`rail-ver${info.dirty ? ' dirty' : ''}`}
         title={info.dirty
           ? 'Built from a modified working tree - not a tagged release'
           : `Release ${info.label}`}>
      {info.label}{commit}
    </div>
  )
}
