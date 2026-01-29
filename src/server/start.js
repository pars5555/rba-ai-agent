import express from 'express';
import http from 'http';
import https from 'https';
import { inspect } from 'util';
import { WebSocketServer } from 'ws';
import axios from 'axios';
import AgentManager from './agentManager.js';
import { buildUserPrompt, estimateTokens } from '../agent/util.js';

const formatTimestamp = () => new Date().toISOString();
const formatArgs = (args) =>
  args.map((a) => (typeof a === 'object' && a !== null ? inspect(a, { depth: 3, breakLength: 120 }) : String(a))).join(' ');

const _rawLog = console.log.bind(console);
const _rawError = console.error.bind(console);

// Create axios instance that ignores SSL certificate errors
const axiosInsecure = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

/**
 * RBA AI Agent Server v4.0 - Task Planner Architecture
 * 
 * Changes from v3.0:
 * - Two-phase execution: Planning → Execution
 * - Separate prompts for planning and execution
 * - No growing history - only plan context sent to LLM
 * 
 * Bootstrap Configuration (passed from PHP server via environment variables):
 *   RBA_API_URL  - PHP server API base URL
 *   RBA_API_KEY  - API key for authentication
 *   PORT         - Server port
 */

// Bootstrap params from environment variables
const BOOTSTRAP = {
  apiUrl: process.env.RBA_API_URL,
  apiKey: process.env.RBA_API_KEY,
  port: parseInt(process.env.PORT) || 3000
};

// Loaded configuration (from PHP server)
let serverConfig = null;  // From /agent/config
let configLoadedAt = null;

// Per-version agent context (prompts + registry), loaded on demand and cached
const agentContextCache = new Map();  // version -> { planningPrompt, executionPrompt, registry }

const app = express();

// Create HTTP server (SSL should be handled by reverse proxy like Apache/nginx)
const server = http.createServer(app);
console.log('🔓 Using HTTP/WS (use reverse proxy for SSL)');

// Agent Manager - orchestrates worker threads
let agentManager = null;

// WebSocket Server - for real-time event streaming
const wss = new WebSocketServer({ server });

// Track WebSocket clients
const wsClients = new Map();

// Server log ring buffer (stdout/stderr) for WS streaming; max 5000 lines
const SERVER_LOG_MAX = 5000;
const serverLogBuffer = [];

function broadcastServerLog(line, stream) {
  const msg = JSON.stringify({ method: 'server_log', line, stream });
  for (const [ws] of wsClients) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(msg);
    } catch (e) {
      _rawError('WebSocket server_log send error: ' + e.message);
    }
  }
}

function serverLogPush(line, stream) {
  serverLogBuffer.push({ line, stream });
  if (serverLogBuffer.length > SERVER_LOG_MAX) serverLogBuffer.splice(0, serverLogBuffer.length - SERVER_LOG_MAX);
  broadcastServerLog(line, stream);
}

function wrapConsole() {
  console.log = (...args) => {
    const line = '[' + formatTimestamp() + '] ' + formatArgs(args);
    _rawLog(line);
    serverLogPush(line, 'stdout');
  };
  console.info = (...args) => { console.log(...args); };
  console.warn = (...args) => {
    const line = '[' + formatTimestamp() + '] ' + formatArgs(args);
    _rawError(line);
    serverLogPush(line, 'stderr');
  };
  console.error = (...args) => {
    const line = '[' + formatTimestamp() + '] ' + formatArgs(args);
    _rawError(line);
    serverLogPush(line, 'stderr');
  };
}
wrapConsole();

/**
 * Load server config only from PHP server (no getContext at startup).
 * Agent context (prompts + registry) is loaded per-version on /run via loadAgentContext().
 */
async function loadAllConfig() {
  console.log(`📋 Loading config from ${BOOTSTRAP.apiUrl}...`);

  try {
    const configResponse = await axiosInsecure.get(`${BOOTSTRAP.apiUrl}/agent/config`, {
      headers: { 'Authorization': `Bearer ${BOOTSTRAP.apiKey}` },
      timeout: 10000
    });

    if (!configResponse.data?.success || !configResponse.data?.config) {
      throw new Error(configResponse.data?.message || 'Failed to load config');
    }

    serverConfig = configResponse.data.config;
    configLoadedAt = new Date().toISOString();
    console.log(`✅ Server config loaded`);
    console.log(`   LLM: ${serverConfig.llm?.provider} (${serverConfig.llm?.[serverConfig.llm?.provider]?.model})`);
    console.log(`   Default agent version: ${serverConfig.agent?.version ?? 'v3'}`);
    return true;
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error(`❌ Failed to load config: ${msg}`);
    return false;
  }
}

/**
 * Load agent context (prompts + registry) for a version. Uses cache; fetches if missing.
 * @param {string} version - e.g. 'v1', 'v2', 'v3'
 * @returns {Promise<{ planningPrompt: string, executionPrompt: string, registry: object }>}
 */
async function loadAgentContext(version) {
  const v = version || serverConfig?.agent?.version || 'v3';
  if (agentContextCache.has(v)) {
    return agentContextCache.get(v);
  }
  const response = await axiosInsecure.get(`${BOOTSTRAP.apiUrl}/agent/getContext?version=${v}`, {
    headers: { 'Authorization': `Bearer ${BOOTSTRAP.apiKey}` },
    timeout: 10000
  });
  if (!response.data?.success || !response.data?.registry) {
    throw new Error(response.data?.message || `Failed to load agent context for version ${v}`);
  }
  const data = response.data;
  if (!data.planningPrompt || !data.executionPrompt) {
    throw new Error(`Invalid prompt format for version ${v} - missing planning/execution prompts`);
  }
  const ctx = {
    planningPrompt: data.planningPrompt,
    executionPrompt: data.executionPrompt,
    registry: data.registry
  };
  agentContextCache.set(v, ctx);
  console.log(`   Cached agent context ${v} (${Object.keys(ctx.registry).length} commands)`);
  return ctx;
}

/**
 * Build full worker config from run options. Loads agent context for version if needed.
 * Merges per-request overrides: version, llmProvider, llmModel, temperature.
 * @param {object} options - from POST /run body (version, llmProvider, llmModel, temperature, maxActions, maxDurationSeconds, ...)
 */
async function buildWorkerConfig(options = {}) {
  const version = options.version ?? serverConfig?.agent?.version ?? 'v3';
  const ctx = await loadAgentContext(version);

  const provider = options.llmProvider ?? serverConfig?.llm?.provider ?? 'openai';
  const modelOverride = (options.llmModel && options.llmModel.trim()) ? options.llmModel.trim() : null;
  const openaiDef = serverConfig?.llm?.openai ?? {};
  const openaiModels = openaiDef.models;
  const openaiDefault = openaiDef.model ?? (Array.isArray(openaiModels) && openaiModels[0])
    ?? (openaiModels && typeof openaiModels === 'object' && Object.keys(openaiModels)[0]);
  const openaiModel = provider === 'openai' && modelOverride ? modelOverride : openaiDefault ?? null;
  const anthropicDef = serverConfig?.llm?.anthropic ?? {};
  const anthropicModels = anthropicDef.models;
  const anthropicDefault = anthropicDef.model ?? (Array.isArray(anthropicModels) && anthropicModels[0])
    ?? (anthropicModels && typeof anthropicModels === 'object' && Object.keys(anthropicModels)[0]);
  const anthropicModel = provider === 'anthropic' && modelOverride ? modelOverride : anthropicDefault ?? null;
  const openai = {
    ...openaiDef,
    model: openaiModel
  };
  const anthropic = {
    ...anthropicDef,
    model: anthropicModel
  };

  let temperature = undefined;
  if (options.temperature !== undefined && options.temperature !== null && options.temperature !== '') {
    const t = Number(options.temperature);
    if (Number.isFinite(t)) temperature = t;
  }

  return {
    rba: {
      apiBaseUrl: BOOTSTRAP.apiUrl,
      apiKey: BOOTSTRAP.apiKey
    },
    llm: { provider, openai, anthropic, temperature },
    agent: { version },
    logging: serverConfig?.logging,
    planningPrompt: ctx.planningPrompt,
    executionPrompt: ctx.executionPrompt,
    registry: ctx.registry
  };
}

/**
 * Broadcast event to WebSocket clients
 */
function broadcastEvent(event) {
  const message = JSON.stringify(event);
  
  for (const [ws, client] of wsClients) {
    if (ws.readyState !== ws.OPEN) continue;
    
    if (client.subscriptions.has('*') || client.subscriptions.has(event.taskId)) {
      try {
        ws.send(message);
      } catch (e) {
        console.error('WebSocket send error:', e.message);
      }
    }
  }
}

/**
 * WebSocket connection handler
 */
wss.on('connection', (ws, req) => {
  const clientId = req.socket.remoteAddress + ':' + req.socket.remotePort;
  console.log(`🔌 WebSocket client connected: ${clientId}`);
  
  wsClients.set(ws, {
    subscriptions: new Set(['*']),
    connectedAt: Date.now()
  });
  
  ws.send(JSON.stringify({
    method: 'connected',
    configLoaded: !!serverConfig,
    cachedVersions: [...agentContextCache.keys()],
    tasks: agentManager ? agentManager.getStatus() : [],
    runningCount: agentManager ? agentManager.getRunningCount() : 0
  }));
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWsMessage(ws, msg);
    } catch (e) {
      ws.send(JSON.stringify({ method: 'error', message: 'Invalid JSON' }));
    }
  });
  
  ws.on('close', () => {
    console.log(`🔌 WebSocket client disconnected: ${clientId}`);
    wsClients.delete(ws);
  });
  
  ws.on('error', (error) => {
    console.error(`WebSocket error (${clientId}):`, error.message);
    wsClients.delete(ws);
  });
});

/**
 * Handle WebSocket messages
 */
function handleWsMessage(ws, msg) {
  const client = wsClients.get(ws);
  
  switch (msg.method) {
    case 'subscribe':
      if (msg.taskId) {
        client.subscriptions.add(msg.taskId);
        ws.send(JSON.stringify({ method: 'subscribed', taskId: msg.taskId }));
      }
      break;
      
    case 'unsubscribe':
      if (msg.taskId) {
        client.subscriptions.delete(msg.taskId);
        ws.send(JSON.stringify({ method: 'unsubscribed', taskId: msg.taskId }));
      }
      break;
      
    case 'subscribe_all':
      client.subscriptions.add('*');
      ws.send(JSON.stringify({ method: 'subscribed', taskId: '*' }));
      break;

    case 'get_recent_logs': {
      const n = Math.min(Math.max(parseInt(msg.lines, 10) || 500, 1), SERVER_LOG_MAX);
      const lines = serverLogBuffer.slice(-n);
      ws.send(JSON.stringify({ method: 'recent_logs', lines }));
      break;
    }
      
    case 'unsubscribe_all':
      client.subscriptions.delete('*');
      ws.send(JSON.stringify({ method: 'unsubscribed', taskId: '*' }));
      break;

    case 'stop_task':
      if (!agentManager) {
        ws.send(JSON.stringify({ method: 'error', message: 'Agent not ready' }));
        break;
      }
      const stopResult = agentManager.stopTask(msg.taskId);
      ws.send(JSON.stringify({ method: 'task_stopped', ...stopResult }));
      break;
      
    case 'send_message':
      if (!agentManager) {
        ws.send(JSON.stringify({ method: 'error', message: 'Agent not ready' }));
        break;
      }
      const sendResult = agentManager.sendMessage(msg.taskId, { type: 'message', content: msg.content });
      ws.send(JSON.stringify({ method: 'message_sent', ...sendResult }));
      break;
      
    case 'get_status':
      ws.send(JSON.stringify({
        method: 'status',
        configLoaded: !!serverConfig,
        cachedVersions: [...agentContextCache.keys()],
        tasks: agentManager ? agentManager.getStatus(msg.taskId) : [],
        runningCount: agentManager ? agentManager.getRunningCount() : 0
      }));
      break;
      
    case 'ping':
      ws.send(JSON.stringify({ method: 'pong', timestamp: Date.now() }));
      break;
    
    case 'clear_tasks':
      if (!agentManager) {
        ws.send(JSON.stringify({ method: 'error', message: 'Agent not ready' }));
        break;
      }
      const clearResult = agentManager.clearCompletedTasks();
      ws.send(JSON.stringify({ method: 'tasks_cleared', ...clearResult }));
      // Send updated task list
      ws.send(JSON.stringify({
        method: 'status',
        configLoaded: !!serverConfig,
        cachedVersions: [...agentContextCache.keys()],
        tasks: agentManager.getStatus(),
        runningCount: agentManager.getRunningCount()
      }));
      break;
      
    default:
      ws.send(JSON.stringify({ method: 'error', message: `Unknown method: ${msg.method}` }));
  }
}

// Middleware
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/**
 * POST /run - Start a task
 * Accepts per-request overrides: version, llmProvider, llmModel, temperature,
 * plus maxActions/maxSteps, maxDurationSeconds, speak, hide_virtual_keyboard, etc.
 */
app.post('/run', async (req, res) => {
  const { sn, task, ...options } = req.body;

  console.log('[/run] Request body:', JSON.stringify(req.body));
  console.log('[/run] Options extracted:', JSON.stringify(options));

  if (!sn || !task) {
    return res.status(400).json({ success: false, error: 'Missing sn or task' });
  }

  if (!agentManager || !serverConfig) {
    return res.status(503).json({ success: false, error: 'Agent not ready' });
  }

  const hasMaxActions = options.maxActions !== undefined || options.maxSteps !== undefined;
  const hasMaxDuration = options.maxDurationSeconds !== undefined;

  if (!hasMaxActions && !hasMaxDuration) {
    return res.status(400).json({
      success: false,
      error: 'Missing limits: provide maxActions or maxDurationSeconds (or both).'
    });
  }

  if (hasMaxActions) {
    const maxActions = options.maxActions ?? options.maxSteps;
    if (!Number.isFinite(maxActions) || maxActions <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid maxActions: must be a positive number.'
      });
    }
  }

  if (hasMaxDuration) {
    const maxDurationSeconds = options.maxDurationSeconds;
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid maxDurationSeconds: must be a positive number.'
      });
    }
  }

  let config;
  try {
    config = await buildWorkerConfig(options);
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    return res.status(502).json({ success: false, error: `Failed to load agent context: ${msg}` });
  }

  const result = agentManager.startTask(sn, task, options, config);

  if (result.success) {
    res.json({
      success: true,
      taskId: result.taskId,
      sn: result.sn,
      task: result.task,
      wsUrl: `ws://localhost:${BOOTSTRAP.port}`,
      message: 'Task started with Task Planner architecture. Connect via WebSocket for real-time events.'
    });
  } else {
    res.status(409).json(result);
  }
});

/**
 * POST /stop - Stop a task
 */
app.post('/stop', (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ success: false, error: 'Missing taskId' });
  if (!agentManager) return res.status(503).json({ success: false, error: 'Agent not ready' });
  res.json(agentManager.stopTask(taskId));
});

/**
 * POST /message - Send message to running task
 */
app.post('/message', (req, res) => {
  const { taskId, content } = req.body;
  if (!taskId || !content) return res.status(400).json({ success: false, error: 'Missing taskId or content' });
  if (!agentManager) return res.status(503).json({ success: false, error: 'Agent not ready' });
  res.json(agentManager.sendMessage(taskId, { type: 'message', content }));
});

/**
 * GET /tasks - List all tasks
 */
app.get('/tasks', (req, res) => {
  res.json({
    success: true,
    tasks: agentManager ? agentManager.getStatus() : [],
    runningCount: agentManager ? agentManager.getRunningCount() : 0
  });
});

/**
 * GET /tasks/:taskId - Get task status
 */
app.get('/tasks/:taskId', (req, res) => {
  if (!agentManager) return res.status(503).json({ success: false, error: 'Agent not ready' });
  const status = agentManager.getStatus(req.params.taskId);
  if (!status) return res.status(404).json({ success: false, error: 'Task not found' });
  res.json({ success: true, ...status });
});

/**
 * DELETE /tasks/:taskId - Remove a completed/failed task
 */
app.delete('/tasks/:taskId', (req, res) => {
  if (!agentManager) return res.status(503).json({ success: false, error: 'Agent not ready' });
  const result = agentManager.removeTask(req.params.taskId);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

/**
 * POST /tasks/clear - Remove all completed/failed tasks
 */
app.post('/tasks/clear', (req, res) => {
  if (!agentManager) return res.status(503).json({ success: false, error: 'Agent not ready' });
  const result = agentManager.clearCompletedTasks();
  res.json(result);
});

/**
 * GET /config - Get current config (without sensitive data)
 */
app.get('/config', (req, res) => {
  if (!serverConfig) {
    return res.status(503).json({ success: false, error: 'Config not loaded' });
  }

  res.json({
    success: true,
    loadedAt: configLoadedAt,
    llm: {
      provider: serverConfig.llm?.provider,
      model: serverConfig.llm?.[serverConfig.llm?.provider]?.model
    },
    agent: serverConfig.agent,
    logging: serverConfig.logging,
    cachedVersions: [...agentContextCache.keys()],
    note: 'Prompts/registry are loaded per-run by version; use GET /commands?version=v3 to list commands for a version.'
  });
});

/**
 * GET /commands - List available commands for a version
 * Query: ?version=v3 (default from serverConfig.agent.version or 'v3')
 */
app.get('/commands', async (req, res) => {
  if (!serverConfig) {
    return res.status(503).json({ success: false, error: 'Config not loaded' });
  }
  const version = req.query.version || serverConfig.agent?.version || 'v3';
  let ctx;
  try {
    ctx = await loadAgentContext(version);
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    return res.status(502).json({ success: false, error: msg });
  }
  const commands = Object.entries(ctx.registry)
    .map(([name, cmd]) => ({
      name,
      description: cmd.description,
      parameters: cmd.parameters || {}
    }));
  res.json({ success: true, version, commands });
});

/**
 * GET /builtPrompt - Built execution & planning prompts (system + user) using real buildUserPrompt
 * Query: ?version=v3 (default from serverConfig.agent.version or 'v3')
 * Returns full prompts with fake task/plan so UI shows exactly what is sent to the LLM.
 */
app.get('/builtPrompt', async (req, res) => {
  const version = req.query.version || serverConfig?.agent?.version || 'v3';
  let ctx;
  try {
    ctx = await loadAgentContext(version);
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    return res.status(502).json({ success: false, message: msg });
  }

  const task = 'Open Settings and turn on Wi-Fi';
  const plan = {
    steps: [
      { description: '[Step 1 from planner]', verifyBy: '[criteria]' },
      { description: '[Step 2 from planner]', verifyBy: '[criteria]' }
    ]
  };
  const currentStepIndex = 0;
  const stepActions = [];
  const lastResult = {"action": "volume_mute","am.checkout.rbamaster": "14.1","success": true,"code": 200};

  const interactiveMessage = "User Interactive message...";

  // Use exported buildUserPrompt from util.js (same as execution phase in llm.js)
  const executionUser = buildUserPrompt({ task, plan, currentStepIndex, stepActions, lastResult, interactiveMessage });
  const planningUser = `TASK: ${task}\n\nCreate a step-by-step plan. Respond with JSON only.`;

  const fullExecutionPrompt = ctx.executionPrompt + '\n\n--- USER MESSAGE ---\n\n' + executionUser;
  const fullPlanningPrompt = ctx.planningPrompt + '\n\n--- USER MESSAGE ---\n\n' + planningUser;

  res.json({
    success: true,
    version,
    fullExecutionPrompt,
    fullPlanningPrompt,
    executionTokens: estimateTokens(fullExecutionPrompt),
    planningTokens: estimateTokens(fullPlanningPrompt)
  });
});

/**
 * GET /health - Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: serverConfig ? 'ok' : 'not_ready',
    configLoaded: !!serverConfig,
    configLoadedAt,
    cachedVersions: [...agentContextCache.keys()],
    llm: serverConfig?.llm?.provider,
    wsClients: wsClients.size,
    runningTasks: agentManager ? agentManager.getRunningCount() : 0
  });
});

// Startup
async function start() {
  console.log(`\n${'═'.repeat(54)}`);
  console.log(`🚀 RBA AI Agent - Task Planner Architecture`);
  console.log(`${'═'.repeat(54)}`);
  
  // Validate bootstrap params
  if (!BOOTSTRAP.apiUrl || !BOOTSTRAP.apiKey) {
    console.error('\n❌ Missing environment variables:');
    console.error('   RBA_API_URL and RBA_API_KEY are required\n');
    process.exit(1);
  }

  console.log(`\n📡 Bootstrap:`);
  console.log(`   API URL: ${BOOTSTRAP.apiUrl}`);
  console.log(`   Port:    ${BOOTSTRAP.port}`);

  // Load all config from PHP server
  console.log('\n');
  const configLoaded = await loadAllConfig();
  if (!configLoaded) {
    console.error('\n❌ Cannot start: Failed to load config from PHP server\n');
    process.exit(1);
  }

  // Initialize agent manager. Worker config is built per-run via buildWorkerConfig(options) and passed to startTask().
  agentManager = new AgentManager({
    verbose: serverConfig?.logging?.verbose !== false,
    logApiBody: serverConfig?.logging?.logApiBody || false,
    maxBodyLogLength: serverConfig?.logging?.maxBodyLogLength || 500
  });
  agentManager.on('event', broadcastEvent);
  console.log('✅ Agent manager initialized (Task Planner mode)');

  // Start HTTP + WebSocket server
  server.listen(BOOTSTRAP.port, () => {
    console.log(`\n   HTTP Server:  http://localhost:${BOOTSTRAP.port}`);
    console.log(`   WebSocket:    ws://localhost:${BOOTSTRAP.port}`);
    console.log(`${'═'.repeat(54)}\n`);
    console.log('Endpoints:');
    console.log('  POST /run        - Start task: { sn, task, version?, llmProvider?, llmModel?, temperature?, maxActions?, maxDurationSeconds?, ... }');
    console.log('  POST /stop       - Stop task: { taskId }');
    console.log('  POST /message    - Send message: { taskId, content }');
    console.log('  GET  /tasks      - List tasks');
    console.log('  GET  /builtPrompt - Built prompts (system+user) for UI: ?version=v3');
    console.log('  GET  /health     - Health check\n');
    console.log('Task Planner Flow:');
    console.log('  1. 📋 Planning Phase - Create execution plan');
    console.log('  2. 🚀 Execution Phase - Execute steps with progress tracking\n');
  });
}

start();
