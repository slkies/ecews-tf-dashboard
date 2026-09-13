/**
 * Whether the filter bar stays in view while the page scrolls.
 *
 * A pinned bar is a help on a tall screen and a cost on a laptop, where it
 * can take a quarter of the height. So it is the reader's choice, remembered
 * per browser. Until they choose, it follows the screen: pinned when the
 * window is at least 900px tall, scrolling away below that.
 */
import { useCallback, useSyncExternalStore } from 'react'

const KEY = 'ecews.filters.pinned'
const EVENT = 'ecews:filters-pinned'
const TALL = 900

function read(): boolean {
  try {
    const v = localStorage.getItem(KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch { /* storage blocked: fall back to the screen */ }
  return typeof window !== 'undefined' && window.innerHeight >= TALL
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange)
  window.addEventListener('storage', onChange)    // another tab changed it
  window.addEventListener('resize', onChange)     // the default follows the screen
  return () => {
    window.removeEventListener(EVENT, onChange)
    window.removeEventListener('storage', onChange)
    window.removeEventListener('resize', onChange)
  }
}

export function usePinnedFilters(): [boolean, (pinned: boolean) => void] {
  const pinned = useSyncExternalStore(subscribe, read, () => false)
  const set = useCallback((value: boolean) => {
    try { localStorage.setItem(KEY, value ? '1' : '0') } catch { /* not fatal */ }
    window.dispatchEvent(new Event(EVENT))
  }, [])
  return [pinned, set]
}
