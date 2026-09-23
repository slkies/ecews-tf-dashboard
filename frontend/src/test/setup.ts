import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'

// With eleven page suites rendering in parallel, a page's first render can
// outrun the default 1 s wait for findBy/waitFor, and a different test failed
// on each run (23 Sep 2026). A longer ceiling only costs time when a test is
// already failing.
configure({ asyncUtilTimeout: 5000 })

// Base UI positions popups and tracks element sizes with browser APIs that
// jsdom does not implement. Minimal stand-ins, so components mount in tests.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList
}

// Base UI's checkbox re-dispatches a click as a PointerEvent, which jsdom lacks.
globalThis.PointerEvent ??= class PointerEventStub extends MouseEvent {
  pointerType: string
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerType = init.pointerType ?? 'mouse'
  }
} as unknown as typeof PointerEvent

Element.prototype.scrollIntoView ??= function scrollIntoView() {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
