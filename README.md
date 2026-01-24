# RBA AI Agent (Simplified)

Pure AI-driven Android device automation. No hardcoded logic — AI decides everything.

## Architecture

```
User Task → Agent Loop → Done
                ↓
         ┌─────────────────┐
         │  1. OBSERVE     │ → rba.call('get_device_snapshot')
         │  2. DECIDE      │ → llm.getNextAction(state, task, history)  
         │  3. EXECUTE     │ → rba.call(action, params)
         │  4. LOG         │ → history.push(...)
         │  5. REPEAT      │ → until complete or max steps
         └─────────────────┘
```

## Files

```
rba-ai-agent-simple/
├── config/
│   ├── config.json      # API keys, settings
│   └── registry.json    # All commands with endpoints
├── src/
│   ├── config.js        # Config loader (20 lines)
│   ├── rba.js           # Generic API client (80 lines)
│   ├── llm.js           # AI decision maker (200 lines)
│   └── agent.js         # The reactive loop (150 lines)
├── server.js            # Express server (80 lines)
├── test.js              # CLI test script
└── package.json
```

**Total: ~530 lines** (down from 2000+)

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

## API

### POST /run
Run a task with AI control.

```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"sn": "DEVICE_SERIAL", "task": "Open Chrome and search for cats"}'
```

### POST /execute
Execute a single action (no AI).

```bash
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -d '{"sn": "DEVICE_SERIAL", "action": "go_home", "params": {}}'
```

### GET /commands
List available commands.

```bash
curl http://localhost:3000/commands
```

## How It Works

1. **Observe**: Get device snapshot (foreground app, UI elements, text on screen)
2. **Decide**: AI analyzes screen and decides next action
3. **Execute**: Run the action via RBA API
4. **Repeat**: Loop until AI says complete or max steps reached

The AI has full access to:
- All safe commands from `registry.json`
- Screen coordinates from OCR and accessibility nodes
- History of previous actions and results

## Key Principles

- **No hardcoded logic**: AI handles popups, dialogs, navigation
- **No switch statements**: Generic `rba.call(action, params)` for all commands
- **One comprehensive prompt**: AI knows all commands upfront
- **Minimal code**: ~530 lines total

## Testing

```bash
# Direct test (no server)
node test.js "Open Settings and go to Wi-Fi" DEVICE_SERIAL

# Via API
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{"sn": "DEVICE_SERIAL", "task": "Take a screenshot"}'
```

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
