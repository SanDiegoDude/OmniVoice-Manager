// Runtime base-path support so the UI works whether it is served at the domain
// root (e.g. a direct port-forward) or under a sub-path by a reverse proxy that
// strips the prefix before it reaches the backend (e.g. weby, which serves apps
// at https://<cluster>.weby.lumalabs.link/<app>/).
//
// OmniVoice Manager is a single-page app with no client-side URL routing, so the
// document is always loaded at its mount root. We derive that mount prefix once
// from document.baseURI and then:
//   1. expose resolveUrl() to prefix root-relative ("/...") URLs — used for the
//      handful of places that assign a server URL straight to an element's `src`
//      (which bypasses fetch), and
//   2. install a fetch() wrapper so the many existing fetch('/api/...') call
//      sites keep working unchanged behind a sub-path.
//
// At the domain root the derived prefix is "" and every function here is a no-op.

function computePrefix(): string {
  try {
    // Directory portion of the current document URL: "/omnivoice/" behind a
    // proxy, "/" at the domain root.
    const dir = new URL('.', document.baseURI).pathname
    return dir.replace(/\/+$/, '') // "" at root, "/omnivoice" behind a proxy
  } catch {
    return ''
  }
}

export const API_PREFIX: string = computePrefix()

/**
 * Prefix a root-relative ("/...") URL with the app's mount path. Absolute URLs
 * (scheme://, //host), blob:, and data: URLs are returned unchanged, so this is
 * always safe to wrap around a value that might already be an object URL.
 */
export function resolveUrl<T extends string | null | undefined>(url: T): T {
  if (!url) return url
  const s = url as string
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return url // scheme:, blob:, data:, //host
  if (!s.startsWith('/')) return url // already relative
  if (API_PREFIX && s.startsWith(API_PREFIX + '/')) return url // already prefixed
  return (API_PREFIX + s) as T
}

let installed = false

/**
 * Route every root-relative fetch() request through resolveUrl() so existing
 * fetch('/api/...') call sites work behind a sub-path proxy without edits.
 * No-op when served at the domain root.
 */
export function installBasePath(): void {
  if (installed || !API_PREFIX) return
  installed = true
  const orig = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      if (typeof input === 'string') {
        return orig(resolveUrl(input), init)
      }
      if (input instanceof URL) {
        if (input.origin === window.location.origin) {
          return orig(resolveUrl(input.pathname + input.search + input.hash), init)
        }
        return orig(input, init)
      }
      if (input instanceof Request) {
        const u = new URL(input.url)
        if (u.origin === window.location.origin) {
          return orig(new Request(resolveUrl(u.pathname + u.search + u.hash), input), init)
        }
      }
    } catch {
      /* fall through to the original fetch */
    }
    return orig(input as RequestInfo, init)
  }
}
