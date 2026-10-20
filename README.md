# MCP Slack Mention Watcher

A tiny stdio MCP server that lets Slack messages wake a Claude Code main session.

A Haiku subagent calls `wait_for_mention` synchronously and stays blocked on that call. When a message arrives in the watched channel or thread, the call returns, the subagent finishes, and its completion notice wakes the main session.

## Why

A Claude Code main session has no way to notice on its own that someone replied on Slack. The usual workaround is a watcher that reads Slack every few minutes and sleeps in between. Every check costs tokens, and a reply is only noticed at the next check.

This server inverts that. The watcher does not go and read Slack; it waits inside a single tool call. Slack pushes events over Socket Mode, so the call returns the moment a message arrives. While it waits, neither the main session nor the Haiku subagent runs any inference, so waiting costs no tokens.

```
main session ──(runs in background)──▶ slack-watcher (Haiku)
                                         └─ wait_for_mention ⏸ blocks until a message arrives
                                              calls again on timeout
  message arrives ─▶ the watcher returns the message JSON as its final result and exits
                  ─▶ the completion notice wakes the main session → it handles the message → relaunches the watcher
```

- One file (`server.mjs`), no dependencies, Node.js 22 or later (it uses the global `WebSocket`).
- Events are pushed over Slack Socket Mode (WebSocket), so there is no polling. While waiting it holds a single socket and uses almost no CPU.
- One tool: `wait_for_mention`.

## How it works

1. The first `wait_for_mention` call connects to Socket Mode, and the connection then stays open.
2. When a matching message arrives, the pending call returns immediately. Against real Slack, the call returned within the same second the message was posted.
3. Messages that arrive while the agent is busy are queued (up to 200) and returned at once by the next call.
4. A message delivered both as `app_mention` and as `message`, or redelivered by Slack, is returned only once (keyed by `channel` + `ts`).
5. When Slack sends `disconnect`, or no ping arrives for two minutes, the server opens a new socket before closing the old one, so a reconnect leaves no gap.

A message wakes the watcher in either of two cases:

- **Mention**: it mentions one of `SLACK_MENTION_IDS` (by default, the bot itself).
- **Author**: it was posted by one of `SLACK_WAKE_USERS`, with or without a mention. Use this when the people or agents you work with in a thread reply without mentioning you.

## 1. Create the Slack app

1. Open <https://api.slack.com/apps>, choose **Create New App** → **From a manifest**, pick the workspace, paste the contents of `slack-app-manifest.json` into the **JSON** tab, and click **Create**.
2. Under **Basic Information → App-Level Tokens → Generate Token and Scopes**, create a token with the `connections:write` scope. This `xapp-...` token is your `SLACK_APP_TOKEN`.
3. Install the app to the workspace under **Install App**. The `xoxb-...` bot token shown there is not needed.
4. Invite the bot to every channel you want to watch: `/invite @mention-watcher`

If you only need bot mentions (`@mention-watcher`), the manifest can be reduced to the `app_mention` event and the `app_mentions:read` scope. Mentions of people or user groups, and `SLACK_WAKE_USERS`, need the `message.*` events, and the bot must be a member of the channel.

## 2. Provide the token

Claude Code passes its own environment to the stdio MCP servers it starts, so the simplest safe option is to keep the token in a user environment variable instead of a config file. Restart Claude Code afterwards (the whole desktop app, if that is what you use) so it picks up the variable.

Windows (PowerShell):

```powershell
[Environment]::SetEnvironmentVariable('SLACK_APP_TOKEN', 'xapp-...', 'User')
```

macOS / Linux: add `export SLACK_APP_TOKEN=xapp-...` to your shell profile (`~/.zshrc`, `~/.bashrc`, and so on).

## 3. Register the server with Claude Code

To use it in every project, register it in user scope:

```bash
claude mcp add -s user --env SLACK_MENTION_IDS=U0123456789 --env SLACK_WAKE_USERS=U0987654321 \
  --transport stdio slack-mention -- node /abs/path/to/MCP-Slack-Mention-Watcher/server.mjs
```

> If the server name directly follows an `--env` value, the CLI reads the name as another env entry. The `--transport` flag in between prevents that.

To store the token in the config instead of the environment, add `--env SLACK_APP_TOKEN=xapp-...`. The token is then saved in plain text in `~/.claude.json`.

You can also register it per project in `.mcp.json`:

```json
{
  "mcpServers": {
    "slack-mention": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/MCP-Slack-Mention-Watcher/server.mjs"],
      "env": { "SLACK_APP_TOKEN": "${SLACK_APP_TOKEN}", "SLACK_WATCH": "C0123456789" }
    }
  }
}
```

## 4. Install the watcher agent

Copy `slack-watcher.agent.md` to `~/.claude/agents/slack-watcher.md` (for all projects) or to `<project>/.claude/agents/slack-watcher.md`.
It is a Haiku agent whose only tool is `mcp__slack-mention__wait_for_mention`. If you registered the server under a name other than `slack-mention`, change the middle part of the `tools:` line to match.

## Usage

From the main session, launch the watcher in the background and end the turn:

```
Agent(subagent_type: "slack-watcher", run_in_background: true, prompt: "Watch C0123456789:1712345678.000100.")
```

- Pass a channel (`C0123456789`), or a single thread as `channel:thread_ts` or as a permalink.
- When a message arrives, the watcher returns its JSON as the final result and exits, and that completion wakes the main session. After handling the message, launch the watcher again the same way. Each launch starts fresh, so the Haiku context never grows.
- Treat the watcher's report as a notice. Read the Slack thread from the main session before acting on it.
- The watcher never replies on Slack. It only hands the message JSON to the main session.
- The queue lives in the MCP server process that the session started, so messages that arrive after one watcher finishes and before the next one starts are kept and returned to the next watcher immediately.
- An MCP tool called inside a subagent is not moved to the background automatically, so the watcher stays blocked in that call until a message arrives.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SLACK_APP_TOKEN` | (required) | App-Level Token `xapp-...` with the `connections:write` scope |
| `SLACK_WATCH` | every channel the bot is in | Default watch scope. Comma-separated `C123`, `C123:1712345678.000100` (a thread), or Slack permalinks |
| `SLACK_MENTION_IDS` | the bot itself | Who counts as mentioned. Comma-separated users `U…`, user groups `S…`, or `here` / `channel` / `everyone` |
| `SLACK_WAKE_USERS` | (none) | Authors who wake the watcher without a mention. Comma-separated user IDs `U…`. Any message they post inside the watch scope is returned |
| `SLACK_WAIT_TIMEOUT_SEC` | `1200` | Maximum wait per call in seconds; `0` waits forever |
| `SLACK_API_URL` | `https://slack.com/api` | Override for tests |

When `SLACK_MENTION_IDS` is set, only the listed targets count as mentions; add the bot's own ID if bot mentions should still count.
Messages posted by a mention target or by the bot itself are ignored, so an agent replying from its own account does not wake itself. This rule is applied before `SLACK_WAKE_USERS`.
Messages from `SLACK_WAKE_USERS` wake the watcher without a mention. Edits and deletions are still ignored.

## Tool

`wait_for_mention({ channel?, thread_ts?, timeout_sec? })`

- `channel`: a channel ID, `"C…:THREAD_TS"`, or a permalink. Defaults to `SLACK_WATCH`.
- `thread_ts`: only messages in this thread.
- `timeout_sec`: the wait for this call.

It returns text content holding JSON:

```json
{"mentions":[{"channel":"C0123456789","user":"U0456","text":"<@U0BOT> what's the deploy status?","ts":"1712345699.000300","thread_ts":"1712345678.000100"}]}
```

Messages that matched through `SLACK_WAKE_USERS` come back in the same `mentions` array.
`thread_ts` is always the root of the thread the message belongs to (equal to `ts` for a top-level message); use it when replying.
On timeout the tool returns `{"mentions":[],"timeout":true}`. Just call it again.

## Testing

The end-to-end test starts a mock Slack (`apps.connections.open` plus a Socket Mode WebSocket) and drives the server over stdio. Only the test needs `ws`.

```bash
npm i --no-save ws@8
node test/e2e.mjs ./server.mjs
```

It covers a bad token, blocking waits, ignored noise, queueing, deduplication, thread scope, cancellation, reconnects, `SLACK_MENTION_IDS` and `SLACK_WAKE_USERS`, and prints `ALL PASS` at the end.

## Caveats

- **Claude Code drops a stdio MCP call after 30 minutes without a response or a progress notification** (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`). That is why the default wait is 20 minutes. If the client sends a `progressToken`, the server also sends a progress notification every 25 seconds. To wait longer, set `"timeout": 14400000` on the server entry in `.mcp.json`, or set `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`. If you have set `MCP_TOOL_TIMEOUT`, keep it above the wait time.
- **Watch from only one session per Slack app at a time.** When several Socket Mode connections are open, Slack delivers each event to just one of them. A session opens its connection on its first call and **keeps it open until the session ends**, so while any session that has launched a watcher is still running, watchers in other sessions will miss some messages. Sessions that have the server registered but never call it do not open a connection.
- Behind a proxy (for example in Claude Code cloud sessions) you may need `NODE_USE_ENV_PROXY=1` (Node 22.21 or later).
- Queued messages are lost when the server process restarts (for example when the session ends). After a restart, read the thread yourself from the last message you saw.

## License

[MIT](LICENSE)
