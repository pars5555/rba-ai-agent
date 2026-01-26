# RBA AI Agent - Task Planner

Minimal AI agent for Android device automation.

## Architecture

```
Simple Flow:
1. Create Plan (AI decides steps)
2. Execute Steps (loop until done or error)
   - AI decides: action, step complete, task complete, or stop on error
```

## Key Principle

**No logic in code - AI handles everything via prompts:**
- Loop detection → Prompt tells AI to stop if repeating
- Error handling → Prompt tells AI to stop and report why
- Step completion → AI decides when step is done
- Task completion → AI decides when task is done

## Files

```
src/
├── server/
│   ├── start.js         # HTTP + WebSocket server
│   └── agentManager.js  # Worker management
├── agent/
│   ├── worker.js        # Simple plan → execute loop
│   ├── llm.js           # LLM calls (createPlan, executeStep)
│   └── rba.js           # RBA API client
└── logger.js            # Centralized logging
```

## Configuration

All prompts are on PHP server: `data/agent/v3/`
- `planning_prompt.txt` - How to create plans
- `execution_prompt.txt` - How to execute steps (includes rules for loops, errors)
- `registry.json` - Available commands

## API

```
POST /run     - Start task: { sn, task }
POST /stop    - Stop task: { taskId }
POST /message - Send message: { taskId, content }
GET  /tasks   - List tasks
GET  /health  - Health check
```

## WebSocket

Connect to `ws://localhost:3000` for real-time events:
- `plan_created` - Plan with steps
- `step_start` / `step_complete` - Step progress
- `ai_decision` - AI action/decision
- `action_result` - Action success/failure
- `task_complete` - Final result
