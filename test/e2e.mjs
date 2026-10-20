// End-to-end test against a mock Slack (apps.connections.open + Socket Mode WebSocket).
// Usage: npm i --no-save ws@8 && node test/e2e.mjs ./server.mjs

// Mock Slack (apps.connections.open + Socket Mode WS) and drive server.mjs over stdio.
import { WebSocketServer } from 'ws'
import http from 'node:http'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const wss = new WebSocketServer({ port: 0 })
const wsPort = wss.address().port
const sockets = [], acks = []
let opens = 0
wss.on('connection', (s) => {
  sockets.push(s)
  s.on('message', (d) => acks.push(JSON.parse(d).envelope_id))
  s.send(JSON.stringify({ type: 'hello', num_connections: 1 }))
})
const api = http.createServer((req, res) => {
  opens++
  const ok = req.headers.authorization === 'Bearer xapp-good'
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(ok ? { ok: true, url: `ws://127.0.0.1:${wsPort}/link?n=${opens}` } : { ok: false, error: 'invalid_auth' }))
}).listen(0)
await new Promise((r) => api.on('listening', r))

function startServer(token, extraEnv = {}) {
  const p = spawn('node', [process.argv[2]], { env: { ...process.env, SLACK_APP_TOKEN: token, SLACK_API_URL: `http://127.0.0.1:${api.address().port}`, ...extraEnv }, stdio: ['pipe', 'pipe', 'inherit'] })
  let buf = ''; const msgs = []; const listeners = []
  p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); msgs.push(m); listeners.forEach((f) => f(m)) } })
  let nextId = 1
  const rpc = (method, params) => { const id = nextId++; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return { id, done: new Promise((r) => listeners.push((m) => m.id === id && r(m))) } }
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  return { p, rpc, notify, msgs }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let env = 0
const live = () => sockets.filter((s) => s.readyState === 1).at(-1)
const emit = (event, sock = live()) => sock.send(JSON.stringify({ envelope_id: `e${++env}`, type: 'events_api', payload: { authorizations: [{ user_id: 'UBOT' }], event } }))
const parse = (m) => JSON.parse(m.result.content[0].text)

// --- bad token surfaces as tool error
{
  const s = startServer('xapp-bad')
  await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }).done
  const r = await s.rpc('tools/call', { name: 'wait_for_mention', arguments: {} }).done
  assert.equal(r.result.isError, true); assert.match(r.result.content[0].text, /invalid_auth/)
  s.p.kill(); console.log('ok bad token ->', r.result.content[0].text)
}

const s = startServer('xapp-good')
const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }).done
assert.equal(init.result.protocolVersion, '2025-06-18')
s.notify('notifications/initialized', {})
const tl = await s.rpc('tools/list', {}).done
assert.equal(tl.result.tools[0].name, 'wait_for_mention'); console.log('ok initialize + tools/list')

// --- blocking wait, out-of-scope + noise ignored, in-scope wakes instantly
let call = s.rpc('tools/call', { name: 'wait_for_mention', arguments: { channel: 'C1' } })
await sleep(300)
emit({ type: 'message', channel: 'C2', user: 'U1', text: 'hi <@UBOT>', ts: '1.1' })          // other channel -> queued
emit({ type: 'message', channel: 'C1', user: 'U1', text: 'no mention here', ts: '1.2' })     // not a mention
emit({ type: 'message', channel: 'C1', user: 'UBOT', text: 'self <@UBOT>', ts: '1.3' })      // own post
emit({ type: 'message', subtype: 'message_changed', channel: 'C1', hidden: true, ts: '1.4' }) // edit
await sleep(200)
assert.equal(s.msgs.some((m) => m.id === call.id), false); console.log('ok still blocked after noise')
const t0 = Date.now()
emit({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> deploy?', ts: '2.1' })
emit({ type: 'message', channel: 'C1', user: 'U1', text: '<@UBOT> deploy?', ts: '2.1' }) // duplicate of same msg
let r = parse(await call.done)
console.log('ok woke in', Date.now() - t0, 'ms ->', JSON.stringify(r))
assert.deepEqual(r, { mentions: [{ channel: 'C1', user: 'U1', text: '<@UBOT> deploy?', ts: '2.1', thread_ts: '2.1' }] })

// --- queued while busy -> returned immediately; dup was dropped
await sleep(100)
r = parse(await s.rpc('tools/call', { name: 'wait_for_mention', arguments: { channel: 'C2' } }).done)
assert.equal(r.mentions.length, 1); assert.equal(r.mentions[0].ts, '1.1'); console.log('ok queued C2 mention returned immediately')
r = parse(await s.rpc('tools/call', { name: 'wait_for_mention', arguments: { channel: 'C1', timeout_sec: 0.5 } }).done)
assert.deepEqual(r, { mentions: [], timeout: true }); console.log('ok duplicate dropped + timeout ->', JSON.stringify(r))

// --- thread scope via permalink
call = s.rpc('tools/call', { name: 'wait_for_mention', arguments: { channel: 'https://x.slack.com/archives/C3/p1700000000000100' } })
await sleep(100)
emit({ type: 'message', channel: 'C3', user: 'U2', text: '<@UBOT> top level', ts: '9.9' })
emit({ type: 'message', channel: 'C3', user: 'U2', text: 'reply <@UBOT|bot>', ts: '1700000005.000200', thread_ts: '1700000000.000100' })
r = parse(await call.done)
assert.equal(r.mentions[0].ts, '1700000005.000200'); console.log('ok thread scope via permalink')

// --- cancellation: no reply, waiter removed
call = s.rpc('tools/call', { name: 'wait_for_mention', arguments: { channel: 'C4' } })
await sleep(100)
s.notify('notifications/cancelled', { requestId: call.id })
await sleep(100)
emit({ type: 'message', channel: 'C4', user: 'U2', text: '<@UBOT> after cancel', ts: '5.1' })
await sleep(200)
assert.equal(s.msgs.some((m) => m.id === call.id), false)
r = parse(await s.rpc('tools/call', { name: 'wait_for_mention', arguments: { channel: 'C4' } }).done)
assert.equal(r.mentions[0].ts, '5.1'); console.log('ok cancel -> no reply, mention kept in queue')

// --- disconnect -> overlap reconnect, old socket closed, events keep flowing
const before = live()
before.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }))
await sleep(300)
assert.notEqual(live(), before); assert.equal(before.readyState >= 2, true); console.log('ok refresh: new socket, old closed, opens =', opens)
r = parse(await s.rpc('tools/call', { name: 'wait_for_mention', arguments: {} }).done)
assert.deepEqual(r.mentions.map((m) => m.ts), ['9.9']); console.log('ok unscoped call drains the leftover C3 top-level mention')
call = s.rpc('tools/call', { name: 'wait_for_mention', arguments: {} })
await sleep(100)
emit({ type: 'message', channel: 'C9', user: 'U3', text: 'yo <@UBOT>', ts: '7.1', thread_ts: '7.0' })
r = parse(await call.done)
assert.equal(r.mentions[0].thread_ts, '7.0'); console.log('ok events after refresh')

// --- unexpected close -> reconnect
live().terminate()
await sleep(1500)
call = s.rpc('tools/call', { name: 'wait_for_mention', arguments: {} })
await sleep(100)
emit({ type: 'message', channel: 'C9', user: 'U3', text: 'again <@UBOT>', ts: '8.1' })
r = parse(await call.done)
assert.equal(r.mentions[0].ts, '8.1'); console.log('ok reconnect after drop, opens =', opens)

assert.equal(acks.length, env); console.log('ok every envelope acked:', acks.length)
s.p.kill()

// --- SLACK_MENTION_IDS (user + usergroup) and SLACK_WATCH default scope
const u = startServer('xapp-good', { SLACK_MENTION_IDS: 'UME,S123', SLACK_WATCH: 'C7' })
await u.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }).done
call = u.rpc('tools/call', { name: 'wait_for_mention', arguments: {} })
await sleep(200)
emit({ type: 'app_mention', channel: 'C7', user: 'U1', text: '<@UBOT> bot only', ts: '3.1' }) // bot mention no longer counts
emit({ type: 'message', channel: 'C8', user: 'U1', text: '<@UME> wrong channel', ts: '3.2' })
emit({ type: 'message', channel: 'C7', user: 'UME', text: '<@UME> myself', ts: '3.3' })
emit({ type: 'message', channel: 'C7', user: 'U1', text: 'hey <!subteam^S123|@devs>', ts: '3.4' })
r = parse(await call.done)
assert.equal(r.mentions[0].ts, '3.4'); console.log('ok SLACK_MENTION_IDS + SLACK_WATCH')
u.p.kill()

// --- SLACK_WAKE_USERS: any post by a listed author wakes without a mention; scope and own-post rules still apply
const w = startServer('xapp-good', { SLACK_MENTION_IDS: 'UME', SLACK_WAKE_USERS: 'UDOT,UME' })
await w.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }).done
call = w.rpc('tools/call', { name: 'wait_for_mention', arguments: { channel: 'C5:10.0' } })
await sleep(200)
emit({ type: 'message', channel: 'C5', user: 'U1', text: 'plain chatter', ts: '10.1', thread_ts: '10.0' })        // not a wake user
emit({ type: 'message', channel: 'C6', user: 'UDOT', text: 'other channel', ts: '10.2' })                         // out of scope -> queued
emit({ type: 'message', subtype: 'message_changed', hidden: true, channel: 'C5', user: 'UDOT', ts: '10.3', thread_ts: '10.0' }) // edit by a wake user
emit({ type: 'message', channel: 'C5', user: 'UME', text: '<@UME> my own post', ts: '10.4', thread_ts: '10.0' })  // own post, even though UME is also a wake user
await sleep(200)
assert.equal(w.msgs.some((m) => m.id === call.id), false)
emit({ type: 'message', channel: 'C5', user: 'UDOT', text: 'pushed 314f4fa', ts: '10.5', thread_ts: '10.0' })
r = parse(await call.done)
assert.deepEqual(r.mentions.map((m) => m.ts), ['10.5'])
r = parse(await w.rpc('tools/call', { name: 'wait_for_mention', arguments: { channel: 'C6' } }).done)
assert.deepEqual(r.mentions.map((m) => m.ts), ['10.2']); console.log('ok SLACK_WAKE_USERS')
w.p.kill()
console.log('ALL PASS'); process.exit(0)
