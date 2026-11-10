import assert from 'node:assert/strict'
import { test } from 'node:test'

const { dayKey, dayWindow, gridShape, isHumanThread, MAX_ZONES, planGrid, projectLabel, toMs, zoneCells } = await import(
  '../desktop/plugin.js'
)

const ids = n => Array.from({ length: n }, (_, i) => `t${i + 1}`)

test('grid shapes: one row to three, then two rows of ceil(n/2) columns', () => {
  const shapes = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, gridShape(n)]))

  assert.deepEqual(shapes[1], { count: 1, cols: 1, split: 0 })
  assert.deepEqual(shapes[3], { count: 3, cols: 3, split: 0 })
  assert.deepEqual(shapes[4], { count: 4, cols: 2, split: 2 })
  assert.deepEqual(shapes[5], { count: 5, cols: 3, split: 2 })
  assert.deepEqual(shapes[6], { count: 6, cols: 3, split: 3 })
  assert.deepEqual(shapes[7], { count: 7, cols: 4, split: 3 })
  assert.deepEqual(shapes[8], { count: 8, cols: 4, split: 4 })
  assert.deepEqual(gridShape(12), { count: MAX_ZONES, cols: 4, split: 4 })
  assert.deepEqual(gridShape(0), { count: 0, cols: 0, split: 0 })
})

test('columns dock left to right at (k-1)/k of what remains, so they come out even', () => {
  const plan = planGrid(ids(4))

  assert.equal(plan.main, 't1')
  // 4 threads → 2×2: one column dock, then two bottom docks.
  assert.deepEqual(plan.steps, [
    { id: 't2', anchor: null, pos: 'right', share: 1 / 2 },
    { id: 't3', anchor: null, pos: 'bottom', share: 0.5 },
    { id: 't4', anchor: 't2', pos: 'bottom', share: 0.5 }
  ])

  const three = planGrid(ids(3)).steps

  assert.deepEqual(
    three.map(s => [s.id, s.anchor, s.pos, Number(s.share.toFixed(4))]),
    [
      ['t2', null, 'right', 0.6667],
      ['t3', 't2', 'right', 0.5]
    ]
  )

  // Even columns: walking the shares reproduces 1/cols for every column.
  for (const n of [2, 3, 6, 8]) {
    const plan = planGrid(ids(n))
    const cols = plan.cols
    let remaining = 1
    const widths = []

    for (const step of plan.steps.filter(s => s.pos === 'right')) {
      widths.push(remaining * (1 - step.share))
      remaining *= step.share
    }

    widths.push(remaining)
    assert.equal(widths.length, cols)
    widths.forEach(w => assert.ok(Math.abs(w - 1 / cols) < 1e-9, `n=${n} width ${w}`))
  }
})

test('every zoned thread is placed exactly once; overflow becomes tabs', () => {
  for (let n = 1; n <= 11; n++) {
    const plan = planGrid(ids(n))
    const placed = [plan.main, ...plan.steps.map(s => s.id)]

    assert.equal(new Set(placed).size, Math.min(n, MAX_ZONES), `n=${n}`)
    assert.deepEqual(plan.extras, ids(n).slice(MAX_ZONES))

    // An anchor is always main or a thread docked earlier.
    const seen = new Set([plan.main])

    for (const step of plan.steps) {
      assert.ok(step.anchor === null || seen.has(step.anchor), `n=${n} ${step.id} anchors on ${step.anchor}`)
      seen.add(step.id)
    }
  }

  assert.deepEqual(planGrid(['a', 'a', '', 'b']).steps.map(s => s.id), ['b'])
  assert.equal(planGrid([]).main, null)
})

test('zone cells match the preview layout', () => {
  assert.deepEqual(zoneCells(5).cells, [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1]
  ])
})

test('human threads only', () => {
  const ok = { id: 'a', message_count: 3, source: 'desktop' }

  assert.equal(isHumanThread(ok), true)
  assert.equal(isHumanThread({ ...ok, source: 'cron' }), false)
  assert.equal(isHumanThread({ ...ok, message_count: 0 }), false)
  assert.equal(isHumanThread({ ...ok, hidden: true }), false)
  assert.equal(isHumanThread({ ...ok, is_internal_child: true }), false)
  assert.equal(isHumanThread({ ...ok, archived: true }), false)
})

test('project label from repo root or cwd, never a bare home folder', () => {
  assert.equal(projectLabel({ git_repo_root: '/home/sam/code/acme-app/' }), 'acme-app')
  assert.equal(projectLabel({ cwd: 'C:\\work\\billing' }), 'billing')
  assert.equal(projectLabel({ cwd: '/Users' }), '')
  assert.equal(projectLabel({}), '')
})

test('day window: last working day plus today, newest first, chains collapsed', () => {
  // Monday 9 Nov 2026, 08:00 local. Last activity before today: Friday 6 Nov.
  const now = new Date(2026, 10, 9, 8, 0).getTime()
  const at = (d, h) => new Date(2026, 10, d, h, 0).getTime() / 1000

  const sessions = [
    { id: 'fri-1', message_count: 4, last_active: at(6, 16) },
    { id: 'fri-2', message_count: 9, last_active: at(6, 18) },
    { id: 'mon-1', message_count: 2, last_active: at(9, 7) },
    { id: 'thu-1', message_count: 5, last_active: at(5, 11) },
    { id: 'cron-1', message_count: 5, last_active: at(6, 12), source: 'cron' },
    // A compressed conversation: the tip and its root share a lineage.
    { id: 'fri-3-tip', _lineage_root_id: 'fri-3', message_count: 30, last_active: at(6, 15) },
    { id: 'fri-3', _lineage_root_id: 'fri-3', message_count: 20, last_active: at(6, 10) }
  ]

  const day = dayWindow(sessions, now)

  assert.deepEqual(day.today.map(s => s.id), ['mon-1'])
  assert.deepEqual(day.previous.map(s => s.id), ['fri-2', 'fri-1', 'fri-3-tip'])
  assert.deepEqual(day.earlier.map(s => s.id), ['thu-1'])
  assert.notEqual(day.label, 'Yesterday')

  const tue = dayWindow(sessions, new Date(2026, 10, 7, 9, 0).getTime())

  assert.equal(tue.label, 'Yesterday')
})

test('timestamps and day keys', () => {
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000)
  assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05')
})
