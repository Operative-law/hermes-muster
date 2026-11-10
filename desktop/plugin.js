/**
 * Muster — the morning stand-up for parallel agent work.
 *
 * 1. Recap: the threads you worked on last (yesterday, or Friday on a Monday)
 *    plus anything already moving today, each with its live status dot.
 * 2. Pick: yesterday's threads are ticked; search to add older ones.
 * 3. Lay out: Muster proposes a grid for that count (2, 3, 2×2, 3+2, 3×2 …
 *    up to 8) and, on approval, docks each thread into its own zone.
 *
 * Placement goes through `host.dockSession` (the sidebar-drag placement, as a
 * plugin verb). On a Desktop without it, Muster opens the threads as tabs and
 * says so — it never reaches past the SDK.
 *
 * Plain ESM, loaded uncompiled: jsx()/jsxs() calls only. Pure helpers are
 * exported for the node tests in ../tests.
 */

import {
  atom,
  Button,
  Checkbox,
  Codicon,
  Dialog,
  DialogContent,
  DialogTitle,
  host,
  PALETTE_AREA,
  ROUTES_AREA,
  SearchField,
  SessionStatusDot,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  ToggleRow,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PATH = '/muster'
export const MAX_ZONES = 8
const LOOKBACK_DAYS = 14
const LIST_LIMIT = 300
const DAY_MS = 86_400_000
// Sources that are not human threads (scheduled runs, delegated workers).
const SKIP_SOURCES = new Set(['cron', 'subagent', 'delegate', 'kanban'])

let store = null // ctx.storage, set in register()
const $lineup = atom(null) // { day, ids } — today's (or the last) muster
const $open = atom(false) // the Muster dialog
export const openMuster = () => $open.set(true)

// ── pure helpers (exported for tests) ───────────────────────────────────────

/** Backend timestamps are epoch seconds; tolerate milliseconds too. */
export const toMs = t => {
  const n = Number(t) || 0

  return n > 1e12 ? n : n * 1000
}

/** Local-midnight epoch ms of the day holding `ms`. */
export function startOfDay(ms) {
  const d = new Date(ms)

  d.setHours(0, 0, 0, 0)

  return d.getTime()
}

/** `YYYY-MM-DD` in local time — the key for "already mustered today". */
export function dayKey(ms) {
  const d = new Date(ms)

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A conversation a person had (not a cron run, worker, empty draft or hidden plumbing). */
export function isHumanThread(s) {
  return Boolean(
    s &&
      s.id &&
      !s.archived &&
      !s.hidden &&
      !s.is_internal_child &&
      (s.message_count || 0) > 0 &&
      !SKIP_SOURCES.has(String(s.source || '').toLowerCase())
  )
}

/** Folder name of the thread's repo (or cwd), '' when it has none. */
export function projectLabel(s) {
  const raw = String(s?.git_repo_root || s?.cwd || '').replace(/[\\/]+$/, '')
  const name = raw.split(/[\\/]/).pop() || ''

  return /^(Users|home|root|~)$/.test(name) ? '' : name
}

const durableId = s => s._lineage_root_id || s.id

/**
 * The recap window: the most recent day before today with any activity
 * (so a Monday shows Friday), plus whatever has already moved today.
 * Returns `{ previous, today, earlier, label }` — each list newest first,
 * one row per conversation (compression chains collapse to their tip).
 */
export function dayWindow(sessions, now = Date.now()) {
  const seen = new Set()
  const rows = []

  for (const s of [...(sessions || [])].sort((a, b) => toMs(b.last_active) - toMs(a.last_active))) {
    if (!isHumanThread(s) || seen.has(durableId(s))) {
      continue
    }

    seen.add(durableId(s))
    rows.push(s)
  }

  const today = startOfDay(now)
  const todays = rows.filter(s => toMs(s.last_active) >= today)
  const before = rows.filter(s => toMs(s.last_active) < today && toMs(s.last_active) >= today - LOOKBACK_DAYS * DAY_MS)
  const lastDay = before.length ? startOfDay(toMs(before[0].last_active)) : null
  const previous = lastDay === null ? [] : before.filter(s => startOfDay(toMs(s.last_active)) === lastDay)
  const shown = new Set([...todays, ...previous].map(s => s.id))

  return {
    today: todays,
    previous,
    earlier: rows.filter(s => !shown.has(s.id)),
    label: lastDay === null ? '' : dayLabel(lastDay, today)
  }
}

export function dayLabel(dayMs, todayMs) {
  if (todayMs - dayMs <= DAY_MS + 3_600_000) {
    return 'Yesterday'
  }

  return new Date(dayMs).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}

/**
 * Grid shape for `n` threads: one row up to three, then two rows with
 * ceil(n/2) columns — the first (n - cols) columns split top/bottom.
 * 4 → 2×2, 5 → 3+2, 6 → 3×2, 7 → 4+3, 8 → 4×2.
 */
export function gridShape(n) {
  const count = Math.max(0, Math.min(MAX_ZONES, Math.floor(n) || 0))

  if (count <= 3) {
    return { count, cols: count, split: 0 }
  }

  const cols = Math.ceil(count / 2)

  return { count, cols, split: count - cols }
}

/**
 * Docking plan for an ordered list of thread ids. `main` loads in the
 * workspace (top-left zone); each step docks `id` against `anchor` (a thread
 * id, or null = main) on `pos` at `share` of the anchor zone. Columns go
 * left→right taking (k-1)/k of what remains, so they come out even; split
 * columns then take the bottom half. Threads past MAX_ZONES are `extras`
 * (stacked as tabs in the main zone).
 */
export function planGrid(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))]
  const { cols, split } = gridShape(unique.length)
  const zoned = unique.slice(0, MAX_ZONES)
  const steps = []

  if (!zoned.length) {
    return { main: null, steps, extras: [], cols: 0, split: 0 }
  }

  for (let c = 1; c < cols; c++) {
    steps.push({ id: zoned[c], anchor: c === 1 ? null : zoned[c - 1], pos: 'right', share: (cols - c) / (cols - c + 1) })
  }

  for (let r = 0; r < split; r++) {
    steps.push({ id: zoned[cols + r], anchor: r === 0 ? null : zoned[r], pos: 'bottom', share: 0.5 })
  }

  return { main: zoned[0], steps, extras: unique.slice(MAX_ZONES), cols, split }
}

/** Zone index → [column, row] for the preview (row 1 = bottom half). */
export function zoneCells(n) {
  const { cols, split, count } = gridShape(n)
  const cells = []

  for (let i = 0; i < count; i++) {
    cells.push(i < cols ? [i, 0] : [i - cols, 1])
  }

  return { cells, cols, split }
}

// ── data ────────────────────────────────────────────────────────────────────

async function loadSessions() {
  const profile = (host.state.profile.get() || '').trim() || 'default'
  const page = await host.listPersistedSessions(null, { profile, limit: LIST_LIMIT })

  return Array.isArray(page?.sessions) ? page.sessions : []
}

function threadTitle(s) {
  return (s.title || '').trim() || (s.preview || '').trim().slice(0, 80) || 'Untitled thread'
}

// ── layout ──────────────────────────────────────────────────────────────────

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))

/** Wait (bounded) until the layout has adopted `paneId`, so the next dock can anchor on it. */
async function settle(paneId) {
  const visible = typeof host.paneVisibility === 'function' ? host.paneVisibility(paneId) : null

  for (let i = 0; i < 30 && visible && !visible.get(); i++) {
    await nextFrame()
  }
}

export const canDock = () => typeof host.dockSession === 'function'

/** Lay `ids` out as a grid. Returns `{ placed, mode }`. */
async function layOut(ids) {
  const plan = planGrid(ids)

  if (!plan.main) {
    return { placed: 0, mode: 'none' }
  }

  if (!canDock()) {
    return openAsTabs(ids)
  }

  // Start from a clean workspace: close the chats docked from yesterday (or a
  // hand-made arrangement). Same path as a tab's Close, so ⌘⇧T brings any
  // back and a busy chat keeps running in the background.
  if (typeof host.dockedSessions === 'function' && typeof host.undockSession === 'function') {
    for (const id of host.dockedSessions()) {
      host.undockSession(id)
    }

    await nextFrame()
  }

  // Main first, and wait for it to bind: a thread that WAS in main must have
  // left it before it can be docked as a tile.
  try {
    await host.openSession(plan.main, { intent: 'main', awaitHydration: true, hydrationTimeoutMs: 8000 })
  } catch {
    // A slow transcript is not a reason to abandon the layout.
  }

  const paneOf = new Map([[plan.main, 'workspace']])
  let placed = 1

  for (const step of plan.steps) {
    const pane = host.dockSession(step.id, {
      pane: step.anchor ? (paneOf.get(step.anchor) ?? 'workspace') : 'workspace',
      pos: step.pos,
      share: step.share
    })

    if (pane) {
      paneOf.set(step.id, pane)
      placed++
      await settle(pane)
    }
  }

  for (const id of plan.extras) {
    if (host.dockSession(id, { pane: 'workspace', pos: 'center' })) {
      placed++
    }
  }

  return { placed, mode: 'grid' }
}

async function openAsTabs(ids) {
  const list = [...new Set(ids)]
  let placed = 0

  for (const [i, id] of list.entries()) {
    try {
      await host.openSession(id, { intent: i === 0 ? 'main' : 'tab' })
      placed++
    } catch {
      // keep going; the summary says how many landed
    }
  }

  return { placed, mode: 'tabs' }
}

async function applyLineup(ids) {
  const result = await layOut(ids)
  const today = dayKey(Date.now())

  $lineup.set({ day: today, ids: [...ids] })
  store?.set('lineup', $lineup.get())
  store?.set('lastMusterDay', today)

  if (result.mode === 'grid') {
    host.notify({ kind: 'success', message: `Mustered ${result.placed} thread${result.placed === 1 ? '' : 's'}.` })
  } else if (result.mode === 'tabs') {
    host.notify({
      kind: 'info',
      title: 'Opened as tabs',
      message: `This Desktop can't place chats in a grid yet. ${result.placed} threads are open as tabs — drag them into zones, or update Hermes.`
    })
  }

  return result
}

// ── UI ──────────────────────────────────────────────────────────────────────

const muted = { color: 'var(--ui-text-tertiary)' }
const faint = { color: 'var(--ui-text-quaternary)' }
const hairline = '1px solid var(--ui-stroke-secondary)'

function SectionLabel({ children, right }) {
  return jsxs('div', {
    style: {
      alignItems: 'baseline',
      display: 'flex',
      fontSize: '0.6875rem',
      fontWeight: 600,
      justifyContent: 'space-between',
      letterSpacing: '0.04em',
      margin: '1.25rem 0 0.375rem',
      textTransform: 'uppercase',
      ...muted
    },
    children: [jsx('span', { children }), right ? jsx('span', { style: { fontWeight: 400 }, children: right }) : null]
  })
}

function ThreadRow({ session, index, checked, onToggle }) {
  const project = projectLabel(session)
  const at = new Date(toMs(session.last_active))
  const when =
    Date.now() - at.getTime() < 2 * DAY_MS
      ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

  return jsxs('label', {
    style: {
      alignItems: 'flex-start',
      borderTop: hairline,
      cursor: 'pointer',
      display: 'flex',
      gap: '0.625rem',
      padding: '0.5rem 0.25rem'
    },
    children: [
      jsx(Checkbox, { checked, onCheckedChange: () => onToggle(session.id), style: { marginTop: '0.125rem' } }),
      jsx('span', {
        style: { display: 'inline-flex', marginTop: '0.3rem' },
        children: jsx(SessionStatusDot, { session, storedSessionId: session.id })
      }),
      jsxs('span', {
        style: { display: 'flex', flex: 1, flexDirection: 'column', gap: '0.125rem', minWidth: 0 },
        children: [
          jsxs('span', {
            style: { alignItems: 'baseline', display: 'flex', gap: '0.5rem', minWidth: 0 },
            children: [
              jsx('span', {
                style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                children: threadTitle(session)
              }),
              index > 0 ? jsx('span', { style: { ...faint, fontSize: '0.6875rem' }, children: `#${index}` }) : null
            ]
          }),
          jsx('span', {
            style: { ...muted, fontSize: '0.75rem' },
            children: [project, `${session.message_count || 0} messages`, `last ${when}`].filter(Boolean).join(' · ')
          }),
          session.title && session.preview
            ? jsx('span', {
                style: { ...faint, fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                children: session.preview
              })
            : null
        ]
      })
    ]
  })
}

function GridPreview({ ids, byId }) {
  const { cells, cols } = zoneCells(ids.length)

  if (!cells.length) {
    return jsx('div', {
      style: { ...muted, border: hairline, borderRadius: 6, fontSize: '0.75rem', padding: '1.5rem', textAlign: 'center' },
      children: 'Pick threads to see today’s layout.'
    })
  }

  const columns = Array.from({ length: cols }, (_, c) => cells.map((cell, i) => [cell, i]).filter(([cell]) => cell[0] === c))

  return jsx('div', {
    style: { aspectRatio: '16 / 10', display: 'flex', gap: 4, width: '100%' },
    children: columns.map((zones, c) =>
      jsx(
        'div',
        {
          style: { display: 'flex', flex: 1, flexDirection: 'column', gap: 4, minWidth: 0 },
          children: zones.map(([, i]) =>
            jsxs(
              'div',
              {
                style: {
                  background: 'color-mix(in srgb, var(--ui-accent) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--ui-accent) 45%, transparent)',
                  borderRadius: 4,
                  display: 'flex',
                  flex: 1,
                  flexDirection: 'column',
                  fontSize: '0.6875rem',
                  gap: 2,
                  minHeight: 0,
                  overflow: 'hidden',
                  padding: '0.375rem 0.5rem'
                },
                children: [
                  jsx('span', { style: faint, children: i + 1 }),
                  jsx('span', {
                    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    children: byId.get(ids[i]) ? threadTitle(byId.get(ids[i])) : ''
                  })
                ]
              },
              ids[i]
            )
          )
        },
        c
      )
    )
  })
}

function MusterPage({ inDialog = false, onDone } = {}) {
  const profile = useValue(host.state.profile)
  const query = useQuery({ queryKey: ['plugin:muster', 'sessions', profile], queryFn: loadSessions, staleTime: 30_000 })
  const day = useMemo(() => dayWindow(query.data || []), [query.data])
  const byId = useMemo(() => new Map((query.data || []).map(s => [s.id, s])), [query.data])
  const [picked, setPicked] = useState(null)
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(40)
  const [busy, setBusy] = useState(false)

  // Default lineup: everything from today + the last working day, newest first.
  const defaults = useMemo(() => [...day.today, ...day.previous].map(s => s.id).slice(0, MAX_ZONES), [day])
  const ids = picked ?? defaults
  const toggle = id => setPicked(cur => ((cur ?? defaults).includes(id) ? (cur ?? defaults).filter(x => x !== id) : [...(cur ?? defaults), id]))

  const needle = search.trim().toLowerCase()

  const earlier = needle
    ? day.earlier.filter(s => `${threadTitle(s)} ${s.preview || ''} ${projectLabel(s)}`.toLowerCase().includes(needle))
    : day.earlier

  const go = async () => {
    setBusy(true)

    try {
      await applyLineup(ids)
      onDone?.()
    } finally {
      setBusy(false)
    }
  }

  const row = s => jsx(ThreadRow, { session: s, index: ids.indexOf(s.id) + 1, checked: ids.includes(s.id), onToggle: toggle }, s.id)
  const shape = gridShape(ids.length)

  const shapeLabel =
    ids.length === 0 ? '' : shape.split ? `${shape.cols} + ${shape.split}` : `${shape.cols} across`

  return jsx('div', {
    style: inDialog
      ? { height: 'min(46rem, 84vh)', overflowX: 'hidden', overflowY: 'auto', width: '100%' }
      : { height: '100%', overflowY: 'auto' },
    children: jsxs('div', {
      style: { display: 'flex', flexWrap: 'wrap', gap: '2rem', margin: '0 auto', maxWidth: 1100, padding: inDialog ? '0.25rem 0.5rem 1.5rem' : '1.75rem 1.5rem 3rem' },
      children: [
        jsxs('div', {
          style: { flex: '1 1 26rem', minWidth: 0 },
          children: [
            inDialog
              ? jsx(DialogTitle, { style: { fontSize: '1.25rem', fontWeight: 600 }, children: 'Muster' })
              : jsx('div', { style: { fontSize: '1.25rem', fontWeight: 600 }, children: 'Muster' }),
            jsx('div', {
              style: { ...muted, fontSize: '0.8125rem', marginTop: 2 },
              children: new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
            }),
            query.isLoading ? jsx('div', { style: { ...muted, marginTop: '1.5rem' }, children: 'Reading your threads…' }) : null,
            query.isError
              ? jsx('div', { style: { color: 'var(--ui-danger, var(--ui-text-secondary))', marginTop: '1.5rem' }, children: String(query.error?.message || query.error) })
              : null,
            day.today.length ? jsx(SectionLabel, { right: `${day.today.length}`, children: 'Already moving today' }) : null,
            ...day.today.map(row),
            day.previous.length ? jsx(SectionLabel, { right: `${day.previous.length}`, children: day.label }) : null,
            ...day.previous.map(row),
            !query.isLoading && !day.today.length && !day.previous.length
              ? jsx('div', { style: { ...muted, marginTop: '1.5rem' }, children: 'No threads in the last two weeks. Search below to add older ones.' })
              : null,
            jsx(SectionLabel, { right: day.earlier.length ? `${day.earlier.length}` : '', children: 'Older threads' }),
            jsx(SearchField, {
              'aria-label': 'Search older threads',
              placeholder: 'Search by title, first message or project',
              value: search,
              onChange: setSearch,
              onClear: () => setSearch('')
            }),
            ...earlier.slice(0, shown).map(row),
            earlier.length > shown
              ? jsx(Button, { variant: 'ghost', style: { marginTop: '0.5rem' }, onClick: () => setShown(n => n + 40), children: `Show ${Math.min(40, earlier.length - shown)} more (${earlier.length - shown} older)` })
              : null
          ]
        }),
        jsxs('div', {
          style: { alignSelf: 'flex-start', flex: '0 1 22rem', minWidth: '16rem', position: 'sticky', top: '1.75rem' },
          children: [
            jsx(SectionLabel, { right: shapeLabel, children: `Today · ${ids.length} thread${ids.length === 1 ? '' : 's'}` }),
            jsx(GridPreview, { ids, byId }),
            ids.length > MAX_ZONES
              ? jsx('div', { style: { ...muted, fontSize: '0.75rem', marginTop: '0.5rem' }, children: `${ids.length - MAX_ZONES} more open as tabs in zone 1.` })
              : null,
            jsxs('div', {
              style: { display: 'flex', gap: '0.5rem', marginTop: '1rem' },
              children: [
                jsxs(Button, {
                  disabled: busy || !ids.length,
                  onClick: go,
                  children: [jsx(Codicon, { name: 'layout' }), canDock() ? 'Lay out' : 'Open as tabs']
                }),
                picked
                  ? jsx(Button, { variant: 'ghost', onClick: () => setPicked(null), children: 'Reset picks' })
                  : null
              ]
            }),
            !canDock()
              ? jsx('div', {
                  style: { ...faint, fontSize: '0.75rem', marginTop: '0.75rem' },
                  children: 'Grid placement needs a newer Hermes Desktop. Until then Muster opens the threads as tabs.'
                })
              : null
          ]
        })
      ]
    })
  })
}

/** The dialog lives with the always-mounted status chip, so it opens above any layout. */
function MusterDialog() {
  const open = useValue($open)

  return jsx(Dialog, {
    open,
    onOpenChange: v => $open.set(v),
    children: open
      ? jsx(DialogContent, { fitContent: true, style: { maxWidth: '92vw', width: 'min(68rem, 92vw)' }, children: jsx(MusterPage, { inDialog: true, onDone: () => $open.set(false) }) })
      : null
  })
}

function StatusChip() {
  const lineup = useValue($lineup)
  const today = lineup && lineup.day === dayKey(Date.now())

  return jsxs('span', {
    style: { display: 'inline-flex' },
    children: [
      jsx(MusterDialog, {}),
      jsxs('button', {
        type: 'button',
        title: today ? 'Today’s muster' : 'Plan today’s threads',
        onClick: openMuster,
        style: { alignItems: 'center', background: 'none', border: 0, cursor: 'pointer', display: 'inline-flex', gap: 4, padding: '0 0.375rem', ...muted, fontSize: '0.6875rem' },
        children: [jsx(Codicon, { name: 'layout', size: '0.75rem' }), today ? `Muster · ${lineup.ids.length}` : 'Muster']
      })
    ]
  })
}

function SettingsPage() {
  const [offer, setOffer] = useState(() => store?.get('offerEachMorning', true) !== false)
  const [auto, setAuto] = useState(() => store?.get('openEachMorning', false) === true)

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
    children: [
      jsx(ToggleRow, {
        label: 'Offer Muster each morning',
        description: 'A one-line reminder on the first launch of the day.',
        checked: offer,
        onChange: v => {
          setOffer(v)
          store?.set('offerEachMorning', v)
        }
      }),
      jsx(ToggleRow, {
        label: 'Open Muster automatically each morning',
        description: 'Go straight to the Muster page on the first launch of the day.',
        checked: auto,
        onChange: v => {
          setAuto(v)
          store?.set('openEachMorning', v)
        }
      })
    ]
  })
}

function morningCheck() {
  const today = dayKey(Date.now())

  if (!store || store.get('lastMusterDay', '') === today || store.get('lastOfferDay', '') === today) {
    return
  }

  store.set('lastOfferDay', today)

  if (store.get('openEachMorning', false) === true) {
    openMuster()

    return
  }

  if (store.get('offerEachMorning', true) !== false) {
    host.notify({
      kind: 'info',
      icon: 'layout',
      title: 'Good morning',
      message: 'Pick today’s threads and lay them out.',
      action: { label: 'Muster', onClick: openMuster }
    })
  }
}

export default {
  id: 'muster',
  name: 'Muster',

  register(ctx) {
    store = ctx.storage
    $lineup.set(store.get('lineup', null))
    ctx.onDispose(() => {
      store = null
    })

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: PATH }, render: () => jsx(MusterPage, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: PATH, label: 'Muster', codicon: 'layout' } },
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 125, render: () => jsx(StatusChip, {}) },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: { id: 'muster.open', label: 'Muster: plan today', keywords: ['muster', 'layout', 'grid', 'morning', 'threads'], run: openMuster }
      },
      {
        id: 'restore',
        area: PALETTE_AREA,
        data: {
          id: 'muster.restore',
          label: 'Muster: restore today’s layout',
          keywords: ['muster', 'layout', 'restore', 'grid'],
          run: () => {
            const lineup = $lineup.get()

            if (lineup?.ids?.length) {
              void applyLineup(lineup.ids)
            } else {
              openMuster()
            }
          }
        }
      }
    ])

    ctx.registerSettingsPage?.({ id: 'settings', title: 'Muster', render: () => jsx(SettingsPage, {}) })

    // After the app settles, so the offer never races the launch restore.
    ctx.setTimeout(morningCheck, 4000)
  }
}
