import { spawn } from 'node:child_process'
// End-to-end check against a real session and real Haiku: two headless turns,
// printing the stored board after each. Run: node scripts/e2e.mjs
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const STORE_DIR = `${homedir()}/.claude/plugins/store`
const turns = [
  'I want to add config file support to a Node CLI. Don\'t write code or call any tools yet; just list in text 3 decisions you need me to make, each with your recommendation.',
  'Go with your recommendation on the first one. I\'m still thinking about the others.',
]
const work = mkdtempSync(join(tmpdir(), 'pending-decisions-e2e-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const board = () => {
  const file = readdirSync(STORE_DIR).find(f => f.startsWith('pending-decisions'))
  if (!file) return '(no store file yet)'
  const store = JSON.parse(readFileSync(`${STORE_DIR}/${file}`, 'utf8'))
  const key = Object.keys(store).find(k => k === `session:${sessionId}`)
  return key ? JSON.stringify(store[key], null, 1) : `(no key for ${sessionId}; keys: ${Object.keys(store).join(', ')})`
}

let sessionId = ''
const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--model', 'claude-haiku-5-5', '--debug-file', join(work, 'debug.log')], { cwd: work, stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
let resolveResult
child.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.session_id) sessionId = msg.session_id
    if (msg.type === 'result') resolveResult?.(msg)
  }
})
const send = text => new Promise(res => {
  resolveResult = res
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n')
})

for (const [n, text] of turns.entries()) {
  const result = await send(text)
  console.log(`\n===== turn ${n + 1} reply =====\n${result.result}`)
  await sleep(20000)
  console.log(`\n===== board after turn ${n + 1} =====\n${board()}`)
}
child.stdin.end()
console.log(`\ndebug log: ${join(work, 'debug.log')}`)
