#!/usr/bin/env node
// Slack mention watcher: a tiny stdio MCP server (Node >= 22, zero dependencies).
// Its single tool, `wait_for_mention`, blocks until someone mentions the target in a watched
// channel/thread and then returns the mention(s), so a cheap subagent can simply sleep on it.
// Events arrive over Slack Socket Mode; mentions that land while nobody is waiting are queued.
import dc from 'node:diagnostics_channel'
import { createInterface } from 'node:readline'

const env = process.env
const APP_TOKEN = env.SLACK_APP_TOKEN
const API = env.SLACK_API_URL || 'https://slack.com/api'
const DEFAULT_TIMEOUT_SEC = env.SLACK_WAIT_TIMEOUT_SEC ? Number(env.SLACK_WAIT_TIMEOUT_SEC) : 1200 // under Claude Code's 30 min stdio idle cut-off
const MENTION_IDS = list(env.SLACK_MENTION_IDS)
const WAKE_USERS = list(env.SLACK_WAKE_USERS) // authors whose every post counts, mention or not
const WATCH = list(env.SLACK_WATCH).map(parseTarget)
const QUEUE_MAX = 200
const STALE_MS = 120_000 // no ping from Slack for this long -> assume a dead socket

const log = (...a) => console.error('[slack-mention]', ...a)

function list(s) {
  return (s || '').split(',').map((x) => x.trim()).filter(Boolean)
}

// "C123", "C123:1712345678.000100", or a Slack permalink (channel, message or thread reply)
function parseTarget(s) {
  const link = s.match(/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/)
  if (link) {
    const root = s.match(/thread_ts=(\d+\.\d+)/)?.[1]
    return { channel: link[1], thread: root || (link[2] && `${link[2]}.${link[3]}`) }
  }
  const [channel, thread] = s.split(':')
  return { channel, thread }
}

// ---- Mentions ---------------------------------------------------------------

let botId = null // learned from event payloads (authorizations[0].user_id)
const seen = new Set() // channel+ts, dedupes app_mention vs message events and Slack retries
const queue = []
const waiters = new Set()

function isMention(ev) {
  const ids = MENTION_IDS.length ? MENTION_IDS : botId ? [botId] : []
  if (ev.user && (ev.user === botId || ids.includes(ev.user))) return false // our own posts
  if (ev.user && WAKE_USERS.includes(ev.user)) return true
  if (ev.type === 'app_mention' && !MENTION_IDS.length) return true
  const text = ev.text || ''
  return ids.some((id) => {
    const tag = id[0] === 'S' ? `<!subteam^${id}` : /^(here|channel|everyone)$/.test(id) ? `<!${id}` : `<@${id}`
    return text.includes(tag + '>') || text.includes(tag + '|')
  })
}

function onEvent(payload) {
  const ev = payload?.event
  if (!ev || (ev.type !== 'message' && ev.type !== 'app_mention')) return
  botId ||= payload.authorizations?.[0]?.user_id
  if (ev.hidden || (ev.subtype && ev.subtype !== 'thread_broadcast' && ev.subtype !== 'file_share')) return
  if (!isMention(ev)) return
  const key = ev.channel + ev.ts
  if (seen.has(key)) return
  seen.add(key)
  if (seen.size > 1000) seen.delete(seen.values().next().value)

  const m = { channel: ev.channel, user: ev.user, text: ev.text, ts: ev.ts, thread_ts: ev.thread_ts || ev.ts }
  for (const w of waiters) {
    if (inScope(m, w.scope)) return w.finish({ mentions: [m] })
  }
  queue.push(m)
  if (queue.length > QUEUE_MAX) queue.shift()
}

function inScope(m, scope) {
  return !scope.length || scope.some((t) => t.channel === m.channel && (!t.thread || t.thread === m.thread_ts))
}

function take(scope) {
  const out = []
  for (let i = 0; i < queue.length; ) {
    if (inScope(queue[i], scope)) out.push(...queue.splice(i, 1))
    else i++
  }
  return out
}

// ---- Socket Mode ------------------------------------------------------------

let live = null // the socket currently receiving events
let opening = null // in-flight open()
let retryTimer = null
let backoff = 1000
let lastPing = Date.now()
let pingsVisible = false // the watchdog only runs once Node has reported a ping

dc.subscribe('undici:websocket:ping', () => {
  lastPing = Date.now()
  pingsVisible = true
})

function connect() {
  opening ||= open().finally(() => (opening = null))
  return opening
}

// Opens a fresh socket and swaps it in once Slack says hello; the old one is closed only then,
// so refreshes never leave a gap (duplicates from the overlap are dropped by `seen`).
async function open() {
  const res = await fetch(`${API}/apps.connections.open`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${APP_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(`apps.connections.open: ${body.error}`)

  const ws = new WebSocket(body.url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => ws.close(), 10_000)
    ws.onmessage = (e) => {
      const msg = onFrame(ws, e.data)
      if (msg?.type === 'hello') {
        clearTimeout(timer)
        resolve()
      }
    }
    ws.onclose = () => {
      clearTimeout(timer)
      reject(new Error('Socket Mode connection closed before hello'))
    }
  })
  ws.onclose = () => {
    if (live !== ws) return
    live = null
    retryLater()
  }
  const old = live
  live = ws
  backoff = 1000
  lastPing = Date.now()
  old?.close()
}

function onFrame(ws, raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }))
  if (msg.type === 'events_api') onEvent(msg.payload)
  else if (msg.type === 'disconnect' && ws === live) refresh()
  return msg
}

function refresh() {
  connect().catch((e) => {
    log(e.message)
    retryLater()
  })
}

function retryLater() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    refresh()
  }, backoff)
  backoff = Math.min(backoff * 2, 30_000)
}

setInterval(() => {
  if (live && pingsVisible && Date.now() - lastPing > STALE_MS) {
    log('no ping from Slack, reconnecting')
    lastPing = Date.now()
    refresh()
  }
}, 30_000).unref()

// ---- MCP (newline-delimited JSON-RPC over stdio) ----------------------------

const TOOL = {
  name: 'wait_for_mention',
  description:
    'Blocks until someone mentions the watched target (or a SLACK_WAKE_USERS author posts) in a watched Slack channel or thread, then returns ' +
    'JSON {"mentions":[{"channel","user","text","ts","thread_ts"}]} (thread_ts = root of the thread it belongs to). ' +
    'Mentions that arrive while you are busy are queued and returned instantly by the next call. ' +
    'On timeout it returns {"mentions":[],"timeout":true}: just call it again.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description:
          'Channel ID (C...), "C...:THREAD_TS", or a Slack permalink. Omit to use the server default (SLACK_WATCH, or every channel the bot is in).',
      },
      thread_ts: { type: 'string', description: 'Only mentions inside this thread (ts of its root message).' },
      timeout_sec: {
        type: 'number',
        description: `Return empty-handed after this many seconds (default ${DEFAULT_TIMEOUT_SEC}, 0 = wait forever).`,
      },
    },
  },
  annotations: { readOnlyHint: true },
}

const INSTRUCTIONS =
  'Call wait_for_mention and stay blocked on it until it returns mentions. ' +
  'A timeout result is not an error; call it again.'

let started = false
const cancels = new Map() // request id -> cancel()

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')

async function waitForMention(args, id, progressToken) {
  if (!APP_TOKEN) throw new Error('SLACK_APP_TOKEN (xapp-...) is not set')
  if (typeof WebSocket === 'undefined') throw new Error('Node.js >= 22 is required (global WebSocket)')
  if (!started) {
    await connect() // first call surfaces a bad token right away; later drops reconnect quietly
    started = true
  }
  let scope = WATCH
  if (args.channel) {
    const t = parseTarget(String(args.channel))
    if (args.thread_ts) t.thread = String(args.thread_ts)
    scope = [t]
  }
  const ready = take(scope)
  if (ready.length) return { mentions: ready }

  const sec = args.timeout_sec != null ? Number(args.timeout_sec) : DEFAULT_TIMEOUT_SEC
  return new Promise((resolve) => {
    let beats = 0
    const w = { scope, finish }
    const timer = sec > 0 && setTimeout(() => finish({ mentions: [], timeout: true }), Math.min(sec * 1000, 2 ** 31 - 1))
    // Progress notifications let clients that honour them keep extending their request timeout.
    const keepalive =
      progressToken != null &&
      setInterval(() => {
        send({ method: 'notifications/progress', params: { progressToken, progress: ++beats, message: 'waiting for a Slack mention' } })
      }, 25_000)
    function finish(result) {
      waiters.delete(w)
      cancels.delete(id)
      clearTimeout(timer)
      clearInterval(keepalive)
      resolve(result)
    }
    waiters.add(w)
    cancels.set(id, () => finish(null))
  })
}

async function callTool(id, params) {
  if (params.name !== TOOL.name) return send({ id, error: { code: -32602, message: `Unknown tool: ${params.name}` } })
  try {
    const out = await waitForMention(params.arguments || {}, id, params._meta?.progressToken)
    if (out) send({ id, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } }) // null = cancelled, no reply
  } catch (e) {
    send({ id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } })
  }
}

function handle({ id, method, params = {} }) {
  switch (method) {
    case 'initialize':
      return send({
        id,
        result: {
          protocolVersion: params.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'slack-mention', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        },
      })
    case 'ping':
      return send({ id, result: {} })
    case 'tools/list':
      return send({ id, result: { tools: [TOOL] } })
    case 'tools/call':
      return callTool(id, params)
    case 'notifications/cancelled':
      return cancels.get(params.requestId)?.()
    default:
      if (id != null) send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } })
    }
    handle(msg)
  })
  .on('close', () => process.exit(0))
