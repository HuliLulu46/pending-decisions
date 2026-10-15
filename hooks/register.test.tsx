import { test, expect, mock } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import { applyReply, clearAll, dismiss, parseReply, restore } from './register'
import type { Board } from '../types'

const SURFACES = ['terminal', 'desktop'] as const
const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PANE = { title: 'Pending decisions', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

// An in-memory store the test can read back ($.store is not on the test's engine).
const memoryStore = (on: On) => {
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  return store
}

const row = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })

test('parseReply reads a fenced reply and drops malformed entries', () => {
  const reply = parseReply(
    '```json\n{"resolved":[{"id":"d1","by":"accepted","answer":"ignored"},{"id":"d4","by":"answered","answer":" YAML "},{"id":"d5","by":"bogus"},{"by":"accepted"}],"added":[{"title":"Storage format","kind":"decide","recommendation":"JSON"},{"title":"x","kind":"bogus"}],"updated":[{"id":"d2","recommendation":"B"},{"id":"d3"}]}\n```',
  )
  expect(reply).toEqual({
    resolved: [
      { id: 'd1', by: 'accepted' },
      { id: 'd4', by: 'answered', answer: 'YAML' },
      { id: 'd5', by: 'answered' },
    ],
    added: [{ title: 'Storage format', kind: 'decide', recommendation: 'JSON' }],
    updated: [{ id: 'd2', recommendation: 'B' }],
  })
  expect(parseReply('no json here')).toBe(null)
  expect(parseReply('{not json}')).toBe(null)
})

test('applyReply resolves, updates and adds; restore puts an item back in raised order', () => {
  const start: Board = {
    sessionId: 's',
    items: [
      { id: 'd1', seq: 1, title: 'A', kind: 'decide' },
      { id: 'd2', seq: 2, title: 'B', kind: 'confirm', recommendation: 'yes' },
    ],
    removed: [],
    nextSeq: 3,
  }
  const after = applyReply(start, {
    resolved: [
      { id: 'd1', by: 'answered', answer: 'Use YAML' },
      { id: 'missing', by: 'accepted' },
    ],
    added: [{ title: 'C', kind: 'info' }],
    updated: [{ id: 'd2', recommendation: 'no' }],
  })
  expect(after.items.map(item => [item.id, item.recommendation])).toEqual([
    ['d2', 'no'],
    ['d3', undefined],
  ])
  expect(after.removed.map(item => [item.id, item.resolution])).toEqual([['d1', { by: 'answered', answer: 'Use YAML' }]])
  expect(after.nextSeq).toBe(4)

  const restored = restore(after, 'd1')
  expect(restored.items.map(item => item.id)).toEqual(['d1', 'd2', 'd3'])
  expect(restored.items[0]?.resolution).toBeUndefined()
  expect(restored.removed).toEqual([])

  expect(dismiss(restored, 'd2').removed.map(item => [item.id, item.resolution?.by])).toEqual([['d2', 'manual']])
  const cleared = clearAll(restored)
  expect(cleared.items).toEqual([])
  expect(cleared.removed.map(item => [item.id, item.resolution?.by])).toEqual([
    ['d1', 'manual'],
    ['d2', 'manual'],
    ['d3', 'manual'],
  ])
})

test('a turn feeds Haiku, the band and pane show the result, buttons quote, accept, dismiss and restore', async ($, on) => {
  const store = memoryStore(on)
  const clock = mock.clock(on)
  const rows: SessionMessage[] = [row('user', 'earlier'), row('assistant', 'earlier reply')]
  const prompts: string[] = []
  const filled: string[] = []
  let replyText = ''

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.messages', () => ({ value: rows }))
  on('command.register', () => ({ value: {} as never }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true as const, text: replyText, usage: USAGE } }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'Help me design the storage layer', turnId: 't1' })
  rows.push(row('user', 'Help me design the storage layer'), row('assistant', 'Let me look at the code first.'), row('assistant', 'SQLite or JSON for storage? I recommend JSON. Shall I commit it?'))
  replyText = JSON.stringify({
    resolved: [],
    added: [
      { title: 'Storage format', kind: 'decide', recommendation: 'JSON' },
      { title: 'Commit it', kind: 'confirm' },
    ],
    updated: [],
  })
  await $.turn.complete({ answer: 'SQLite or JSON for storage?', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()

  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Let me look at the code first.')
  expect(prompts[0]).toContain('Help me design the storage layer')
  expect(prompts[0]).not.toContain('earlier reply')
  expect(store.get('session:session-1')).toMatchObject({ nextSeq: 3 })
  expect(store.get('sessions')).toEqual(['session-1'])

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'pending-decisions', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /2 pending decisions/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /①Storage format ②Commit it/ })).toBeDefined()
    await band.unmount()
  }

  for (const surface of SURFACES) {
    const drawn = await $.ui.mount({ plugin: 'pending-decisions', surface, component: 'Pane', requestId: 'pending-decisions', props: PANE })
    expect(await drawn.find({ type: 'Text', text: /\[Decide\].*Storage format/ })).toBeDefined()
    expect(await drawn.find({ type: 'Text', text: /Recommended: JSON/ })).toBeDefined()
    await drawn.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'pending-decisions', surface: 'terminal', component: 'Pane', requestId: 'pending-decisions', props: PANE })
  expect(await pane.find({ key: 'accept:d1' })).toBeDefined()
  expect(await pane.find({ key: 'accept:d2' })).toBeUndefined()
  await pane.press({ key: 'quote:d2' })
  await pane.press({ key: 'accept:d1' })
  expect(filled).toEqual(['Re "Commit it": ', 'Re "Storage format": going with your recommendation (JSON)'])

  await pane.press({ key: 'dismiss:d1' })
  await pane.press({ key: 'toggle-removed' })
  expect(await pane.find({ key: 'restore:d1' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Removed by you' })).toBeDefined()
  await pane.press({ key: 'restore:d1' })
  expect(await pane.find({ key: 'dismiss:d1' })).toBeDefined()

  // The next turn answers one item; Haiku marks it resolved.
  await $.turn.start({ text: 'Re "Storage format": going with your recommendation (JSON)', turnId: 't2' })
  rows.push(row('user', 'Re "Storage format": going with your recommendation (JSON)'), row('assistant', 'OK, JSON it is.'))
  replyText = '{"resolved":[{"id":"d1","by":"accepted"},{"id":"d2","by":"answered","answer":"Not yet"}],"added":[],"updated":[]}'
  await $.turn.complete({ answer: 'OK, JSON it is.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()

  expect(prompts[1]).toContain('"id":"d1"')
  expect(await pane.find({ key: 'dismiss:d1' })).toBeUndefined()
  expect(await pane.find({ key: 'dismiss:d2' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '✓ Accepted' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '✓ Answered' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /↳ Not yet/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Removed by you' })).toBeUndefined()
  await pane.unmount()
})

test('a subagent turn and a failed Haiku call leave the board alone', async ($, on) => {
  const store = memoryStore(on)
  const clock = mock.clock(on)
  let calls = 0
  on('session.id', () => ({ value: 'session-2' }))
  on('session.messages', () => ({ value: [row('assistant', 'Which approach should I use?')] }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
  })
  on('ui.log', () => ({ value: undefined }))

  await $.turn.complete({ answer: 'Which approach should I use?', durationMs: 1, isAborted: false, turnId: 's1', reason: 'answer', agentId: 'agent-1' })
  await clock.settle()
  expect(calls).toBe(0)

  await $.turn.complete({ answer: 'Which approach should I use?', durationMs: 1, isAborted: false, turnId: 'm1', reason: 'answer' })
  await clock.settle()
  expect(calls).toBe(1)
  expect(store.has('session:session-2')).toBe(false)
})

test('a resumed session loads its own board; /clear empties and forgets it', async ($, on) => {
  const store = memoryStore(on)
  let sessionId = 'old'
  store.set('session:old', { sessionId: 'old', items: [{ id: 'd1', seq: 1, title: 'Old item', kind: 'decide' }], removed: [], nextSeq: 2 })
  on('session.id', () => ({ value: sessionId }))
  on('session.messages', () => ({ value: [] }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const bandText = async () => {
    const band = await $.ui.mount({ plugin: 'pending-decisions', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const found = await band.find({ type: 'Text', text: /pending decisions/ })
    await band.unmount()
    return found
  }

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await bandText()).toBeDefined()

  await $.session.end({ reason: 'clear', sessionId: 'old', resume: {} as never })
  sessionId = 'new'
  expect(await bandText()).toBeUndefined()
  expect(store.has('session:old')).toBe(false)

  await $.turn.start({ text: 'hi', turnId: 't2' })
  expect(await bandText()).toBeUndefined()
})
