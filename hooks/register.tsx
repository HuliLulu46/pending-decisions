import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Decision, DecisionKind, Resolution, ResolutionBy } from '../types'

const PLUGIN = 'pending-decisions'
const PANE = 'pending-decisions'
const MODEL = 'claude-haiku-5-5'
const AI_TEXT_LIMIT = 12_000
const USER_TEXT_LIMIT = 4_000
const REMOVED_KEPT = 10
const SESSIONS_KEPT = 20
const SESSIONS_KEY = 'sessions'
const SESSION_KEY_PREFIX = 'session:'

const BOARD_REF = { plugin: 'pending-decisions', key: 'board' } as const
const EMPTY: Board = { sessionId: '', items: [], removed: [], nextSeq: 1 }
const board = atom(BOARD_REF, EMPTY)
const showRemoved = atom({ plugin: 'pending-decisions', key: 'showRemoved' } as const, false)

const KIND_LABEL: Record<DecisionKind, string> = { decide: 'Decide', confirm: 'Confirm', info: 'Info' }
const KIND_COLOR: Record<DecisionKind, string> = { decide: 'warning', confirm: 'suggestion', info: 'subtle' }
const RESOLUTION_LABEL: Record<ResolutionBy, string> = {
  accepted: '✓ Accepted',
  answered: '✓ Answered',
  delegated: 'Left to AI',
  withdrawn: 'AI withdrew',
  manual: 'Removed by you',
}
const RESOLUTION_COLOR: Record<ResolutionBy, string> = {
  accepted: 'success',
  answered: 'success',
  delegated: 'suggestion',
  withdrawn: 'subtle',
  manual: 'subtle',
}

export type SidecarReply = {
  resolved: ({ id: string } & Resolution)[]
  added: { title: string; kind: DecisionKind; recommendation?: string }[]
  updated: { id: string; recommendation: string }[]
}

export const SYSTEM = `You track the decisions an AI coding assistant is waiting on from its user.
Reply with one JSON object and nothing else.`

export const buildPrompt = (items: readonly Decision[], userText: string, aiText: string) => `Open items:
${JSON.stringify(items.map(({ id, title }) => ({ id, title })))}

<user_message>
${userText.slice(-USER_TEXT_LIMIT)}
</user_message>

<assistant_messages>
${aiText.slice(-AI_TEXT_LIMIT)}
</assistant_messages>

1. "resolved": open items no longer pending, each {"id", "by", "answer"}. "by" says how:
   - "accepted": the user took the assistant's recommendation;
   - "answered": the user gave another answer, chose another option, rejected it, or supplied the asked-for fact; "answer" is what they chose, a short phrase in the conversation's language;
   - "delegated": the user handed it back ("you decide", "up to you");
   - "withdrawn": the assistant settled or withdrew it itself, without the user.
   Omit "answer" unless "by" is "answered".
2. "added": things the assistant's messages now wait on the user for, not already open. List each one separately; a single message often holds several. Count only:
   - "decide": the assistant asks the user to choose between options;
   - "confirm": the assistant asks for a yes/no, or proposes a concrete next step and waits for approval. This includes conditional offers that name the action, wherever they sit in the message: "需要的话我来做 X", "要我顺手把 Y 也改了吗", "I can also do Z if you want";
   - "info": the assistant asks the user to provide a fact it needs.
   Skip rhetorical questions and offers that name no action ("有问题随时告诉我", "let me know if you need anything").
   Each: {"title": a short noun phrase in the conversation's language (at most 20 Chinese characters or 8 words), "kind": "decide" | "confirm" | "info", "recommendation": the assistant's recommended answer, omitted when it gave none}.
3. "updated": open items the assistant asked again with a new recommendation: {"id", "recommendation"}.

Reply exactly as {"resolved": [], "added": [], "updated": []}.`

const isKind = (value: unknown): value is DecisionKind => value === 'decide' || value === 'confirm' || value === 'info'
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isResolutionBy = (value: unknown): value is ResolutionBy => typeof value === 'string' && value in RESOLUTION_LABEL

export const parseReply = (text: string): SidecarReply | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end < start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { resolved, added, updated } = raw as Record<string, unknown>
  const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : [])
  return {
    resolved: list(resolved)
      .filter(one => isText(one?.id))
      .map(one => {
        const by = isResolutionBy(one.by) && one.by !== 'manual' ? one.by : 'answered'
        return {
          id: one.id as string,
          by,
          ...(by === 'answered' && isText(one.answer) ? { answer: one.answer.trim() } : {}),
        }
      }),
    added: list(added)
      .filter(one => isText(one?.title) && isKind(one?.kind))
      .map(one => ({
        title: (one.title as string).trim(),
        kind: one.kind as DecisionKind,
        ...(isText(one.recommendation) ? { recommendation: one.recommendation.trim() } : {}),
      })),
    updated: list(updated)
      .filter(one => isText(one?.id) && isText(one?.recommendation))
      .map(one => ({ id: one.id as string, recommendation: (one.recommendation as string).trim() })),
  }
}

const withRemoved = (current: Board, resolutionOf: (item: Decision) => Resolution | undefined): Board => {
  const gone = current.items.flatMap(item => {
    const resolution = resolutionOf(item)
    return resolution === undefined ? [] : [{ ...item, resolution }]
  })
  const goneIds = new Set(gone.map(item => item.id))
  return {
    ...current,
    items: current.items.filter(item => !goneIds.has(item.id)),
    removed: [...gone, ...current.removed].slice(0, REMOVED_KEPT),
  }
}

export const applyReply = (current: Board, reply: SidecarReply): Board => {
  const resolutions = new Map(reply.resolved.map(({ id, ...resolution }) => [id, resolution]))
  const next = withRemoved(current, item => resolutions.get(item.id))
  const recommendations = new Map(reply.updated.map(one => [one.id, one.recommendation]))
  const items = next.items.map(item => {
    const recommendation = recommendations.get(item.id)
    return recommendation === undefined ? item : { ...item, recommendation }
  })
  let nextSeq = next.nextSeq
  for (const one of reply.added) {
    items.push({ id: `d${nextSeq}`, seq: nextSeq, ...one })
    nextSeq += 1
  }
  return { ...next, items, nextSeq }
}

const MANUAL: Resolution = { by: 'manual' }

export const dismiss = (current: Board, id: string): Board =>
  withRemoved(current, item => (item.id === id ? MANUAL : undefined))

export const clearAll = (current: Board): Board => withRemoved(current, () => MANUAL)

export const restore = (current: Board, id: string): Board => {
  const gone = current.removed.find(item => item.id === id)
  if (gone === undefined) return current
  const { resolution: _, ...back } = gone
  return {
    ...current,
    items: [...current.items, back].sort((a, b) => a.seq - b.seq),
    removed: current.removed.filter(item => item !== gone),
  }
}

export const quoteText = (item: Decision) => `Re "${item.title}": `
export const acceptText = (item: Decision) => `Re "${item.title}": going with your recommendation (${item.recommendation ?? ''})`

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const ordinal = (index: number) => CIRCLED[index] ?? `(${index + 1})`

export const summary = (items: readonly Decision[]) => items.map((item, i) => `${ordinal(i)}${item.title}`).join(' ')

const isBoard = (value: unknown): value is Board =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as Board).items) &&
  Array.isArray((value as Board).removed) &&
  typeof (value as Board).nextSeq === 'number'

// Loads the current session's board when the state holds another's (a fresh
// process, a resume, a /clear), so every path goes through one check.
const sync = async ($: EngineInterface) => {
  const id = await $.session.id()
  if ((await read($, board)).sessionId === id) return
  const stored = await $.store.get(SESSION_KEY_PREFIX + id)
  await $.state.set(BOARD_REF, isBoard(stored) ? { ...stored, sessionId: id } : { ...EMPTY, sessionId: id })
}

const save = async ($: EngineInterface, value: Board) => {
  const id = value.sessionId
  await $.store.set(SESSION_KEY_PREFIX + id, value)
  const held = await $.store.get(SESSIONS_KEY)
  const ids = Array.isArray(held) ? (held as string[]) : []
  if (ids.includes(id)) return
  ids.push(id)
  for (const old of ids.splice(0, Math.max(0, ids.length - SESSIONS_KEPT))) {
    await $.store.delete(SESSION_KEY_PREFIX + old)
  }
  await $.store.set(SESSIONS_KEY, ids)
}

const change = async ($: EngineInterface, fn: (current: Board) => Board) => {
  await sync($)
  await save($, await update($, board, fn))
}

const fill = async ($: EngineInterface, text: string) => {
  const box = await $.prompt.read()
  const separator = box.text === '' || box.text.endsWith('\n') ? '' : '\n'
  const filled = await $.prompt.fill({ text: separator + text, mode: 'append' })
  if (!filled.isFilled) $.ui.toast('Can\'t fill the prompt right now; close the dialog holding the keyboard first')
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Pending decisions' })

type Turn = { userText: string; start: number }

const track = async ($: EngineInterface, turn: Turn | undefined, answer: string) => {
  const rows = await $.session.messages()
  const aiText =
    turn !== undefined && turn.start <= rows.length
      ? rows
          .slice(turn.start)
          .filter(row => row.role === 'assistant' && row.text !== '')
          .map(row => row.text)
          .join('\n\n')
      : answer
  await sync($)
  const current = await read($, board)
  if (aiText.trim() === '' && current.items.length === 0) return

  const reply = await $.model.complete({
    model: MODEL,
    system: SYSTEM,
    prompt: buildPrompt(current.items, turn?.userText ?? '', aiText),
    maxTokens: 1024,
    timeoutMs: 20_000,
  })
  if (!reply.isAnswered) {
    $.ui.log(`sidecar failed: ${reply.reason}`, { to: 'debug' })
    return
  }
  const parsed = parseReply(reply.text)
  if (parsed === null) {
    $.ui.log(`sidecar replied without valid JSON: ${reply.text.slice(0, 200)}`, { to: 'debug' })
    return
  }
  await change($, latest => applyReply(latest, parsed))
}

export const register: Register = on => {
  const turns = new Map<string, Turn>()
  // One sidecar at a time, so each sees the board the previous one left.
  let queue: Promise<void> = Promise.resolve()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'decisions', description: 'Open or close the pending decisions pane' })
    await sync($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await $.state.set(BOARD_REF, EMPTY)
      if (e.reason === 'clear') await $.store.delete(SESSION_KEY_PREFIX + e.sessionId)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await sync($)
    turns.set(e.turnId, { userText: e.text, start: (await $.session.messages()).length })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const turn = turns.get(e.turnId)
    turns.delete(e.turnId)
    if (e.agentId !== undefined || e.reason !== 'answer') return result
    // Off the turn's own dispatch, so the prompt is free while Haiku reads.
    $.clock.after(0, () => {
      queue = queue
        .then(() => track($, turn, e.answer))
        .catch(error => $.ui.log(`sidecar error: ${String(error)}`, { to: 'debug' }))
    })
    return result
  })

  on('command.run', { command: 'decisions' }, async $ => {
    const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
    if (isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'Closed the pending decisions pane.' }
    }
    await openPane($)
    return { text: 'Opened the pending decisions pane.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { items } = await read($, board)
    if (e.props.hasSurvey || e.props.view.agentId !== undefined || items.length === 0) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // The engine refuses its own node under a Box with a width, so the width sits on the decisions row alone
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} width={e.props.bodyColumns}>
          <Text color="warning" bold>
            ⚖ {items.length} pending decisions
          </Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {summary(items)}
            </Text>
          </Box>
          <Button key="open" label="Open" onPress={() => void openPane($)} />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { items, removed } = await read($, board)
    const isRemovedShown = await read($, showRemoved)
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{items.length === 0 ? 'No pending decisions' : `${items.length} pending decisions`}</Text>
          {items.length > 0 && (
            <Button key="clear" label="Clear all" dimColor onPress={() => change($, clearAll)} />
          )}
        </Box>
        {items.map((item, i) => (
          <Box key={`item:${item.id}`} flexDirection="column" marginTop={1}>
            <Text>
              {ordinal(i)} <Text color={KIND_COLOR[item.kind]}>[{KIND_LABEL[item.kind]}]</Text> {item.title}
            </Text>
            {item.recommendation !== undefined && <Text dimColor>{`   Recommended: ${item.recommendation}`}</Text>}
            <Box flexDirection="row" gap={1} paddingLeft={3}>
              <Button key={`quote:${item.id}`} label="Quote" onPress={() => fill($, quoteText(item))} />
              {item.recommendation !== undefined && (
                <Button
                  key={`accept:${item.id}`}
                  label="Accept"
                  variant="primary"
                  onPress={() => fill($, acceptText(item))}
                />
              )}
              <Button
                key={`dismiss:${item.id}`}
                label="Done"
                dimColor
                onPress={() => change($, current => dismiss(current, item.id))}
              />
            </Box>
          </Box>
        ))}
        {removed.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Button
              key="toggle-removed"
              plain
              dimColor
              label={`${isRemovedShown ? '▾' : '▸'} Recently removed (${removed.length})`}
              onPress={() => update($, showRemoved, shown => !shown)}
            />
            {isRemovedShown &&
              removed.map(item => {
                const by = item.resolution?.by
                return (
                  <Box key={`removed:${item.id}`} flexDirection="column" paddingLeft={2}>
                    <Box flexDirection="row" gap={1}>
                      <Box flexGrow={1} flexShrink={1}>
                        <Text dimColor wrap="truncate-end">
                          {item.title}
                        </Text>
                      </Box>
                      {by !== undefined && <Text color={RESOLUTION_COLOR[by]}>{RESOLUTION_LABEL[by]}</Text>}
                      <Button
                        key={`restore:${item.id}`}
                        label="Restore"
                        dimColor
                        onPress={() => change($, current => restore(current, item.id))}
                      />
                    </Box>
                    {item.resolution?.answer !== undefined && (
                      <Text dimColor wrap="truncate-end">{`  ↳ ${item.resolution.answer}`}</Text>
                    )}
                  </Box>
                )
              })}
          </Box>
        )}
      </Box>
    )
  })
}
