# MCP Slack Mention Watcher

Claude Code의 메인 세션을 **Slack 메시지로 깨우기** 위한 초경량 stdio MCP 서버야.
Haiku 서브에이전트가 `wait_for_mention`을 **동기로** 호출한 채 멈춰 있다가, 감시 중인 채널이나 스레드에 메시지가 오면 그 자리에서 반환받고 종료해. 메인 세션은 그 서브에이전트의 완료 알림으로 깨어나.

## 왜 필요한가

Claude Code 메인 세션은 Slack에 답이 왔는지 스스로 알 방법이 없어. 그래서 보통은 몇 분마다 Slack을 읽고 잠드는 폴링 감시자를 돌리는데, 그러면 확인할 때마다 토큰이 들고, 답이 와도 다음 확인 때까지 늦게 알아채.

이 서버는 그 구조를 뒤집어. 감시자는 Slack을 읽으러 가지 않고 **도구 호출 하나에 블로킹된 채** 기다려. 메시지는 Slack Socket Mode로 푸시되니까 도착하는 순간 호출이 반환돼. 기다리는 동안은 메인 세션도 Haiku도 추론을 하지 않으니까 토큰을 쓰지 않아.

```
메인 세션 ──(백그라운드 실행)──▶ slack-watcher (Haiku)
                                    └─ wait_for_mention ⏸ 메시지가 올 때까지 블로킹
                                         타임아웃이면 다시 호출
  메시지 도착 ─▶ watcher가 메시지 JSON을 최종 결과로 내고 종료
             ─▶ 메인 세션이 완료 알림으로 깨어남 → 처리 → watcher 다시 실행
```

- 파일 하나(`server.mjs`), 의존성 0개, Node.js 22 이상(전역 `WebSocket` 사용)
- Slack **Socket Mode**(WebSocket)로 이벤트를 푸시받아서 폴링이 없어. 대기 중에는 소켓 하나만 열려 있고 CPU를 거의 안 써
- 도구는 `wait_for_mention` 하나뿐

## 동작 방식

1. 첫 `wait_for_mention` 호출 때 Socket Mode에 연결하고, 그 뒤로는 연결을 계속 유지해.
2. 대상 메시지가 오면 기다리던 호출이 바로 반환돼. 실제 Slack에서 측정했을 때 메시지가 올라온 시각과 같은 초에 반환됐어.
3. 에이전트가 처리하느라 바쁠 때 온 메시지는 큐(최대 200개)에 쌓였다가, 다음 호출에서 대기 없이 바로 반환돼.
4. `app_mention`과 `message` 이벤트가 같은 메시지로 중복해서 오거나 Slack이 재전송해도 `channel+ts` 기준으로 한 번만 반환해.
5. Slack이 `disconnect`를 보내거나 ping이 2분 넘게 끊기면 새 소켓을 먼저 열고 나서 옛 소켓을 닫아. 그래서 재연결하는 동안에도 공백이 없어.

깨어나는 조건은 두 가지야.

- **멘션**: `SLACK_MENTION_IDS`에 적은 대상(기본은 봇 자신)을 멘션한 메시지
- **작성자**: `SLACK_WAKE_USERS`에 적은 사람이 쓴 메시지(멘션이 없어도 돼). 스레드에서 함께 일하는 상대가 멘션 없이 답하는 경우에 써

## 1. Slack 앱 만들기

1. <https://api.slack.com/apps> → **Create New App** → **From a manifest** → 워크스페이스 선택 → **JSON** 탭에 `slack-app-manifest.json` 내용 붙여넣기 → **Create**
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**에서 `connections:write` 스코프로 토큰을 만들어. `xapp-...`로 시작하는 이게 `SLACK_APP_TOKEN`이야.
3. **Install App**으로 워크스페이스에 설치해. 이때 나오는 `xoxb-...` Bot Token은 필요 없어.
4. 감시할 채널에 봇을 초대해: `/invite @mention-watcher`

봇 멘션(`@mention-watcher`)만 감지할 거라면 manifest에서 `app_mention` 이벤트와 `app_mentions:read` 스코프만 남겨도 돼.
사람(예: 내 계정) 멘션이나 유저 그룹 멘션, `SLACK_WAKE_USERS`까지 쓰려면 `message.*` 이벤트가 필요하고, 봇이 그 채널에 들어가 있어야 해.

## 2. 토큰 넣기

Claude Code는 stdio MCP 서버를 띄울 때 자기 환경변수를 그대로 물려줘. 그래서 토큰은 설정 파일에 평문으로 적지 말고 사용자 환경변수에 넣는 걸 추천해. 넣은 다음에는 Claude Code(데스크톱 앱이면 앱 전체)를 다시 시작해야 반영돼.

Windows (PowerShell):

```powershell
[Environment]::SetEnvironmentVariable('SLACK_APP_TOKEN', 'xapp-...', 'User')
```

macOS / Linux: 셸 프로필(`~/.zshrc`, `~/.bashrc` 등)에 `export SLACK_APP_TOKEN=xapp-...`

## 3. Claude Code에 등록

모든 프로젝트에서 쓰려면 user 스코프로 등록해.

```bash
claude mcp add -s user --env SLACK_MENTION_IDS=U0123456789 --env SLACK_WAKE_USERS=U0987654321 \
  --transport stdio slack-mention -- node /abs/path/to/MCP-Slack-Mention-Watcher/server.mjs
```

> `--env` 바로 뒤에 서버 이름이 오면 CLI가 그 이름까지 env 값으로 읽어버려. 그래서 사이에 `--transport`를 끼워둔 거야.

토큰을 환경변수 대신 설정에 직접 넣고 싶으면 `--env SLACK_APP_TOKEN=xapp-...`를 추가하면 돼. 이 경우 토큰이 `~/.claude.json`에 평문으로 저장돼.

프로젝트 단위로 `.mcp.json`에 등록할 수도 있어.

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

## 4. 워처 에이전트 설치

`slack-watcher.agent.md`를 `~/.claude/agents/slack-watcher.md`(모든 프로젝트) 또는 `<프로젝트>/.claude/agents/slack-watcher.md`로 복사해.
Haiku 모델에 도구는 `mcp__slack-mention__wait_for_mention` 하나뿐인 에이전트야. 서버를 `slack-mention`이 아닌 다른 이름으로 등록했다면 `tools:` 줄의 가운데 이름도 바꿔줘.

## 사용법

메인 세션에서 워처를 백그라운드로 띄우고 턴을 끝내면 돼.

```
Agent(subagent_type: "slack-watcher", run_in_background: true, prompt: "Watch C0123456789:1712345678.000100.")
```

- 채널만 줘도 되고(`C0123456789`), 특정 스레드만 보려면 `채널:스레드_ts`나 퍼머링크를 줘.
- 메시지가 오면 워처가 그 JSON을 최종 결과로 내고 끝나. 그 완료 알림이 메인 세션을 깨워. 처리한 다음에는 같은 방식으로 다시 띄워줘. 매번 새로 띄우니까 Haiku 컨텍스트가 쌓이지 않아.
- 워처의 보고는 알림일 뿐이야. 행동하기 전에 메인 세션이 Slack 스레드를 직접 읽는 걸 추천해.
- 워처는 Slack에 답장하지 않아. 메시지 JSON을 그대로 메인에 넘기는 역할만 해.
- 큐는 세션이 띄운 MCP 서버 프로세스에 있어. 그래서 워처가 끝나고 다시 뜨기 전 사이에 온 메시지도 사라지지 않고, 다음 워처가 바로 받아가.
- 서브에이전트 안에서 호출한 MCP 도구는 자동으로 백그라운드로 넘어가지 않아. 그래서 워처는 메시지가 올 때까지 그 호출에서 계속 멈춰 있어.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `SLACK_APP_TOKEN` | (필수) | App-Level Token `xapp-...` (`connections:write`) |
| `SLACK_WATCH` | 봇이 들어간 모든 채널 | 기본 감시 대상. 쉼표로 구분하고 `C123`, `C123:1712345678.000100`(스레드), Slack 퍼머링크를 쓸 수 있어 |
| `SLACK_MENTION_IDS` | 봇 자신 | 멘션으로 칠 대상. 쉼표로 구분하고 유저 `U…`, 유저 그룹 `S…`, `here`/`channel`/`everyone`을 쓸 수 있어 |
| `SLACK_WAKE_USERS` | (없음) | 멘션이 없어도 깨어날 작성자. 쉼표로 구분한 유저 ID `U…`. 감시 범위 안에서 이 사람이 쓴 메시지면 멘션이 없어도 반환해 |
| `SLACK_WAIT_TIMEOUT_SEC` | `1200` | 호출당 최대 대기 시간(초), `0`이면 무한 대기 |
| `SLACK_API_URL` | `https://slack.com/api` | 테스트용 오버라이드 |

`SLACK_MENTION_IDS`를 지정하면 그 목록에 있는 대상만 멘션으로 쳐(봇 멘션도 넣고 싶으면 봇 ID를 같이 적어줘).
멘션 대상 본인이나 이 봇이 직접 쓴 메시지는 무시해. 그래서 에이전트가 자기 계정으로 답장해도 다시 깨어나지 않아. 이 규칙은 `SLACK_WAKE_USERS`보다 먼저 적용돼.
`SLACK_WAKE_USERS`에 적은 사람의 글은 멘션이 없어도 깨우고, 수정·삭제 이벤트는 여전히 무시해.

## 도구

`wait_for_mention({ channel?, thread_ts?, timeout_sec? })`

- `channel`: 채널 ID, `"C…:THREAD_TS"`, 또는 퍼머링크. 생략하면 `SLACK_WATCH`
- `thread_ts`: 이 스레드 안의 메시지만
- `timeout_sec`: 이번 호출의 대기 시간

반환 (text content, JSON):

```json
{"mentions":[{"channel":"C0123456789","user":"U0456","text":"<@U0BOT> 배포 상태 알려줘","ts":"1712345699.000300","thread_ts":"1712345678.000100"}]}
```

`SLACK_WAKE_USERS`로 깨어난 메시지도 같은 `mentions` 배열에 들어와.
`thread_ts`는 항상 그 메시지가 속한 스레드 루트야(최상위 메시지면 `ts`와 같아). 답장할 때 이걸 쓰면 돼.
타임아웃되면 `{"mentions":[],"timeout":true}`를 반환하니까 그냥 다시 호출하면 돼.

## 테스트

mock Slack(`apps.connections.open` + Socket Mode WebSocket)을 띄워서 stdio로 서버를 조종하는 e2e 테스트가 있어. 테스트에만 `ws`가 필요해.

```bash
npm i --no-save ws@8
node test/e2e.mjs ./server.mjs
```

잘못된 토큰, 블로킹 대기, 잡음 무시, 큐잉, 중복 제거, 스레드 범위, 취소, 재연결, `SLACK_MENTION_IDS`, `SLACK_WAKE_USERS`까지 확인하고 마지막에 `ALL PASS`를 출력해.

## 주의할 점

- **Claude Code의 stdio MCP 호출은 응답도 progress 알림도 없이 30분이 지나면 끊겨**(`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`). 그래서 기본 대기 시간을 20분으로 잡았어. 클라이언트가 `progressToken`을 주면 서버가 25초마다 progress 알림도 보내. 그보다 길게 기다리고 싶으면 `.mcp.json` 서버 항목에 `"timeout": 14400000`을 넣거나 `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`으로 설정해줘. `MCP_TOOL_TIMEOUT`을 따로 설정해 뒀다면 대기 시간보다 길게 잡아줘.
- **한 Slack 앱으로는 한 번에 한 세션만 감시해줘.** Socket Mode는 연결이 여러 개면 이벤트를 그중 한 곳에만 보내. 연결은 첫 호출 때 열리고, **그 세션이 끝날 때까지 열린 채로 남아.** 그래서 한 번이라도 워처를 띄운 세션이 살아 있으면, 다른 세션의 워처는 일부 메시지를 놓쳐. 등록만 해두고 호출하지 않은 세션은 연결을 열지 않아.
- 프록시 환경(예: Claude Code 클라우드 세션)에서는 `NODE_USE_ENV_PROXY=1`이 필요할 수 있어(Node 22.21 이상).
- 서버 프로세스가 재시작되면(세션 종료 등) 큐에 쌓여 있던 메시지는 사라져. 재시작한 뒤에는 마지막으로 읽은 지점부터 스레드를 직접 읽어줘.
