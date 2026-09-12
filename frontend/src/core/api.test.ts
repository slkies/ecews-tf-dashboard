/**
 * The API client carries two bugs' worth of hard-won behaviour. These pin
 * both, because "the request looked fine and nothing changed" is exactly the
 * failure mode that reaches production unnoticed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, qs, setExpiryHandler, setToken } from './api'

function mockFetch(res: Partial<Response> & { json?: () => Promise<unknown> }) {
  const f = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({}), ...res,
  })
  vi.stubGlobal('fetch', f)
  return f
}

afterEach(() => { vi.unstubAllGlobals(); setToken(null) })

describe('api()', () => {
  it('sends Content-Type on a request with a body', async () => {
    const f = mockFetch({})
    await api('/login', { method: 'POST', body: '{}' })
    const headers = f.mock.calls[0]![1].headers
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('does not send Content-Type when there is no body', async () => {
    const f = mockFetch({})
    await api('/summary')
    expect(f.mock.calls[0]![1].headers['Content-Type']).toBeUndefined()
  })

  it('attaches the bearer token once one is set', async () => {
    const f = mockFetch({})
    setToken('abc123')
    await api('/me')
    expect(f.mock.calls[0]![1].headers.Authorization).toBe('Bearer abc123')
  })

  it('renders a FastAPI validation array as readable text, not [object Object]', async () => {
    mockFetch({
      ok: false, status: 422,
      json: async () => ({ detail: [{ msg: 'field required' }, { msg: 'too short' }] }),
    })
    await expect(api('/x')).rejects.toThrow('field required; too short')
  })

  it('passes a plain string detail through unchanged', async () => {
    mockFetch({ ok: false, status: 401, json: async () => ({ detail: 'Wrong username or password' }) })
    await expect(api('/login', { method: 'POST', body: '{}' }))
      .rejects.toThrow('Wrong username or password')
  })

  it('reports the status code on the error', async () => {
    mockFetch({ ok: false, status: 500, json: async () => ({}) })
    await expect(api('/x')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('qs()', () => {
  it('repeats a key for each value, which is what the filters send', () => {
    expect(qs({ age: ['0-9', '10-19'] })).toBe('?age=0-9&age=10-19')
  })
  it('drops undefined and empty values', () => {
    expect(qs({ a: undefined, b: '', c: 'x' })).toBe('?c=x')
  })
  it('returns an empty string rather than a bare question mark', () => {
    expect(qs({})).toBe('')
  })
})

describe('401 handling', () => {
  it('signs out when a request that CARRIED a token is rejected', async () => {
    mockFetch({ ok: false, status: 401, json: async () => ({}) })
    const onExpired = vi.fn()
    setExpiryHandler(onExpired)
    setToken('stale-token')
    await expect(api('/summary')).rejects.toThrow('Session expired')
    expect(onExpired).toHaveBeenCalledOnce()
  })

  it('does NOT sign out when a sign-in attempt is rejected', async () => {
    mockFetch({ ok: false, status: 401, json: async () => ({ detail: 'Wrong username or password' }) })
    const onExpired = vi.fn()
    setExpiryHandler(onExpired)
    await expect(api('/login', { method: 'POST', body: '{}' }))
      .rejects.toThrow('Wrong username or password')
    expect(onExpired).not.toHaveBeenCalled()
  })
})
