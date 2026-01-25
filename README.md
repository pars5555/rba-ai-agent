# RBA AI Agent v3.0

AI-powered Android device automation with WebSocket support and worker threads.

## Architecture

```
PHP Server (Control)
 └── Starts Node.js agent with env vars (RBA_API_URL, RBA_API_KEY, PORT)

Node.js Server (Main Thread)
 ├── Loads config from PHP: /agent/config + /agent/prompt
 ├── HTTP Server (Express)
 ├── WebSocket Server (ws)
 └── Agent Manager → Spawns workers with full config

Worker Thread (per task)
 ├── Receives all config via workerData (no HTTP calls needed)
 ├── Agent loop (observe → decide → execute)
 ├── LLM calls (OpenAI/Anthropic)
 └── RBA API calls
```

## Files

```
rba-ai-agent/
├── src/
│   ├── server/
│   │   ├── start.js         # Server entry point
│   │   └── agentManager.js  # Worker orchestration
│   ├── agent/
│   │   ├── worker.js        # Worker entry point
│   │   ├── rba.js           # RBA API client
│   │   └── llm.js           # LLM client
│   └── logger.js            # Centralized logging
├── package.json
└── README.md
```

## Configuration

All configuration is loaded from the PHP server at startup. No local config files.

**Bootstrap** (passed from PHP via environment variables):
- `RBA_API_URL` - PHP server API base URL
- `RBA_API_KEY` - API key for authentication
- `PORT` - Server port

**Server Config** (from `/api/v1/agent/config`):
- LLM settings (provider, API keys, model)
- Agent settings (version, maxSteps, maxDuration)
- Logging settings

**Agent Config** (from `/api/v1/agent/prompt`):
- System prompt
- Command registry

## Starting the Agent

The agent is started by the PHP server which passes the required environment variables:

```bash
# Via PHP control panel (recommended)
# Or manually:
RBA_API_URL=https://rba.checkout.am/api/v1 RBA_API_KEY=xxx PORT=3000 npm start
```

## HTTP API

### POST /run
Start a task.
```json
{ "sn": "DEVICE_SERIAL", "task": "Open Chrome and search for cats" }
```

### POST /stop
Stop a task.
```json
{ "taskId": "abc123..." }
```

### POST /message
Send message to running task.
```json
{ "taskId": "abc123...", "content": "Try clicking the button" }
```

### GET /tasks
List all tasks.

### POST /reload
Reload all config from PHP server.

### GET /health
Health check.

## WebSocket Protocol

Connect to `ws://localhost:3000` for real-time events.

### Client → Server
```json
{ "type": "start_task", "sn": "DEVICE_SERIAL", "task": "Open Settings" }
{ "type": "stop_task", "taskId": "abc123..." }
{ "type": "send_message", "taskId": "abc123...", "content": "..." }
{ "type": "subscribe", "taskId": "abc123..." }
{ "type": "get_status" }
```

### Server → Client
```json
{ "type": "task_start", "taskId": "...", "maxSteps": 100 }
{ "type": "ai_decision", "taskId": "...", "action": "input_tap", "reason": "..." }
{ "type": "step_result", "taskId": "...", "action": "input_tap", "success": true }
{ "type": "task_complete", "taskId": "...", "success": true, "steps": 5 }
```

## Key Features

- **No Local Config**: All config loaded from PHP server
- **Worker Threads**: Each task runs in isolated thread
- **WebSocket Events**: Real-time streaming
- **Hot Reload**: Reload config without restart via POST /reload
