# RBA AI Agent v3.0

AI-powered Android device automation with WebSocket support and worker threads.

## Architecture

```
Main Thread (Orchestrator)
 ├── HTTP Server (Express)
 ├── WebSocket Server (ws)
 ├── Agent Manager
 │    ├── Spawns worker threads
 │    ├── Tracks running tasks
 │    └── Broadcasts events
 └── Config loader

Worker Thread (per task)
 ├── Agent loop (observe → decide → execute)
 ├── LLM calls (OpenAI/Anthropic)
 ├── RBA API calls
 └── Events → Main thread → WebSocket clients
```

## Files

```
rba-ai-agent/
├── config/
│   ├── config.json        # Default settings
│   └── local_config.json  # API keys (gitignored)
├── src/
│   ├── server/
│   │   └── agentManager.js  # Worker orchestration (main thread)
│   ├── agent/
│   │   ├── worker.js        # Worker entry point
│   │   ├── rba.js           # RBA API client
│   │   └── llm.js           # LLM client
│   ├── config.js            # Config loader
│   ├── agentConfig.js       # Shared config store
│   └── logger.js            # Centralized logging
├── server.js                # Main HTTP/WebSocket server
└── package.json
```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure API keys in `config/local_config.json`:
```json
{
  "rba": {
    "apiKey": "your-rba-api-key"
  },
  "llm": {
    "provider": "openai",
    "openai": {
      "apiKey": "sk-your-openai-key"
    }
  }
}
```

3. Start server:
```bash
npm start
```

## HTTP API

### POST /run
Start a task in a worker thread.

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"sn": "DEVICE_SERIAL", "task": "Open Chrome and search for cats"}'
```

Response:
```json
{
  "success": true,
  "taskId": "abc123...",
  "wsUrl": "ws://localhost:3000",
  "message": "Task started. Connect via WebSocket to receive real-time events."
}
```

### POST /stop
Stop a running task.

```bash
curl -X POST http://localhost:3000/stop \
  -H "Content-Type: application/json" \
  -d '{"taskId": "abc123..."}'
```

### POST /message
Send an interactive message to a running task (for future interactive mode).

```bash
curl -X POST http://localhost:3000/message \
  -H "Content-Type: application/json" \
  -d '{"taskId": "abc123...", "content": "Try a different approach"}'
```

### GET /tasks
List all tasks.

```bash
curl http://localhost:3000/tasks
```

### GET /tasks/:taskId
Get status of a specific task.

```bash
curl http://localhost:3000/tasks/abc123
```

### GET /commands
List available commands.

```bash
curl http://localhost:3000/commands
```

### GET /health
Health check.

```bash
curl http://localhost:3000/health
```

## WebSocket Protocol

Connect to `ws://localhost:3000` to receive real-time events.

### Client → Server Messages

```json
// Subscribe to a specific task
{ "type": "subscribe", "taskId": "abc123..." }

// Subscribe to all tasks
{ "type": "subscribe_all" }

// Start a new task
{ "type": "start_task", "sn": "DEVICE_SERIAL", "task": "Open Settings" }

// Stop a task
{ "type": "stop_task", "taskId": "abc123..." }

// Send interactive message to running task
{ "type": "send_message", "taskId": "abc123...", "content": "Try clicking the button" }

// Get status
{ "type": "get_status", "taskId": "abc123..." }  // optional taskId

// Ping
{ "type": "ping" }
```

### Server → Client Events

```json
// Connection established
{ "type": "connected", "tasks": [...], "runningCount": 1 }

// Task lifecycle
{ "type": "task_init", "taskId": "...", "sn": "...", "task": "..." }
{ "type": "task_start", "taskId": "...", "maxSteps": 100, "speak": true }
{ "type": "task_complete", "taskId": "...", "success": true, "steps": 5, "elapsed": 30, "reason": "completed" }

// Step events
{ "type": "step_start", "taskId": "...", "step": 1, "maxSteps": 100 }
{ "type": "step_result", "taskId": "...", "step": 1, "action": "input_tap", "success": true }

// AI events
{ "type": "ai_decision", "taskId": "...", "action": "input_tap", "reason": "Tapping search button" }
{ "type": "llm_call", "taskId": "...", "historyLength": 5 }
{ "type": "llm_response", "taskId": "...", "action": "input_tap", "complete": false }

// API events
{ "type": "api_call", "taskId": "...", "action": "input_tap", "url": "..." }
{ "type": "api_response", "taskId": "...", "action": "input_tap", "success": true }

// Log events
{ "type": "log", "taskId": "...", "message": "..." }
{ "type": "error", "taskId": "...", "message": "..." }

// Worker events
{ "type": "worker_exit", "taskId": "...", "code": 0, "elapsed": 30000 }
```

## JavaScript WebSocket Client Example

```javascript
const ws = new WebSocket('ws://localhost:3000');

ws.onopen = () => {
  // Start a task
  ws.send(JSON.stringify({
    type: 'start_task',
    sn: 'DEVICE_SERIAL',
    task: 'Open Chrome and search for cats'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`[${data.type}]`, data);
  
  // Handle different event types
  switch (data.type) {
    case 'ai_decision':
      console.log(`AI: ${data.action} - ${data.reason}`);
      break;
    case 'task_complete':
      console.log(`Done! Success: ${data.success}, Steps: ${data.steps}`);
      break;
  }
};
```

## Interactive Communication (Future)

The architecture supports sending messages to running agents:

```javascript
// While task is running, send guidance
ws.send(JSON.stringify({
  type: 'send_message',
  taskId: 'abc123...',
  content: 'The button is in the top right corner'
}));
```

The agent will include this message in the next LLM prompt, allowing real-time interaction.

## Key Features

- **Worker Threads**: Each task runs in isolated worker thread
- **WebSocket Events**: Real-time streaming of all agent events
- **Multiple Tasks**: Run tasks on multiple devices simultaneously
- **Interactive**: Send messages to running agents (future)
- **Centralized Config**: Prompt and registry loaded from PHP server

## Switching LLM Providers

Edit `config/local_config.json`:

```json
{
  "llm": {
    "provider": "anthropic",
    "anthropic": {
      "apiKey": "sk-ant-xxx",
      "model": "claude-sonnet-4-20250514"
    }
  }
}
```

Supported: `openai`, `anthropic`
