// Node loader hook: resolve the three specifiers a Desktop plugin may import
// to inert stubs, so the pure helpers in desktop/plugin.js load under node.
import { register } from 'node:module'

const stub = `
const any = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : any), apply: () => any })
export const host = any
export const atom = v => { let value = v; return { get: () => value, set: n => { value = n } } }
export const jsx = () => null
export const jsxs = () => null
export const useMemo = f => f()
export const useState = v => [typeof v === 'function' ? v() : v, () => {}]
export const Button = any, Checkbox = any, Codicon = any, Dialog = any, DialogContent = any, DialogTitle = any, SearchField = any, SessionStatusDot = any, ToggleRow = any
export const PALETTE_AREA = 'palette', ROUTES_AREA = 'routes', SIDEBAR_NAV_AREA = 'sidebar.nav'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const TITLEBAR_AREAS = { left: 'titlebar.left', center: 'titlebar.center', right: 'titlebar.right' }
export const useQuery = () => ({}), useValue = () => null
export default any
`

const url = `data:text/javascript,${encodeURIComponent(stub)}`

register(
  `data:text/javascript,${encodeURIComponent(`
    const STUBBED = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
    export async function resolve(specifier, context, next) {
      return STUBBED.has(specifier) ? { url: ${JSON.stringify(url)}, shortCircuit: true } : next(specifier, context)
    }
  `)}`
)
