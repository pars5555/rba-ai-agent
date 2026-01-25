import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import axios from 'axios';
import { config } from './src/config.js';
import { getAgentConfig, setAgentConfig } from './src/agentConfig.js';
import AgentManager from './src/server/agentManager.js';

const app = express();
const server = http.createServer(app);
const PORT = config.server?.port || 3000;
const WS_PORT = config.server?.wsPort || PORT; // Same port by default

// Agent Manager - orchestrates worker threads
const agentManager = new AgentManager({
  verbose: config.logging?.verbose !== false,
  logApiBody: config.logging?.logApiBody || false,
  maxBodyLogLength: config.logging?.maxBodyLogLength || 500
});

// WebSocket Server - for real-time event streaming
const wss = new WebSocketServer({ server });

// Track WebSocket clients and their subscriptions
const wsClients = new Map(); // ws -> { subscriptions: Set<taskId | '*'> }

/**
 * Broadcast event to WebSocket clients
 */
function broadcastEvent(event) {
  const message = JSON.stringify(event);
  
  for (const [ws, client] of wsClients) {
    if (ws.readyState !== ws.OPEN) continue;
    
    // Check if client subscribed to this task or all tasks
    if (client.subscriptions.has('*') || client.subscriptions.has(event.taskId)) {
      try {
        ws.send(message);
      } catch (e) {
        console.error('WebSocket send error:', e.message);
      }
    }
  }
}

// Forward all agent events to WebSocket clients
agentManager.on('event', broadcastEvent);

/**
 * WebSocket connection handler
 */
wss.on('connection', (ws, req) => {
  const clientId = req.socket.remoteAddress + ':' + req.socket.remotePort;
  console.log(`🔌 WebSocket client connected: ${clientId}`);
  
  // Initialize client state
  wsClients.set(ws, {
    subscriptions: new Set(['*']), // Subscribe to all by default
    connectedAt: Date.now()
  });
  
  // Send current status on connect
  ws.send(JSON.stringify({
    type: 'connected',
    tasks: agentManager.getStatus(),
    runningCount: agentManager.getRunningCount()
  }));
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWsMessage(ws, msg);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
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
 * Handle WebSocket messages from clients
 */
function handleWsMessage(ws, msg) {
  const client = wsClients.get(ws);
  
  switch (msg.type) {
    case 'subscribe':
      // Subscribe to specific task or all
      if (msg.taskId) {
        client.subscriptions.add(msg.taskId);
        ws.send(JSON.stringify({ type: 'subscribed', taskId: msg.taskId }));
      }
      break;
      
    case 'unsubscribe':
      // Unsubscribe from task
      if (msg.taskId) {
        client.subscriptions.delete(msg.taskId);
        ws.send(JSON.stringify({ type: 'unsubscribed', taskId: msg.taskId }));
      }
      break;
      
    case 'subscribe_all':
      client.subscriptions.add('*');
      ws.send(JSON.stringify({ type: 'subscribed', taskId: '*' }));
      break;
      
    case 'unsubscribe_all':
      client.subscriptions.delete('*');
      ws.send(JSON.stringify({ type: 'unsubscribed', taskId: '*' }));
      break;
      
    case 'start_task':
      // Start a new task
      const result = agentManager.startTask(msg.sn, msg.task, msg.options || {});
      ws.send(JSON.stringify({ type: 'task_started', ...result }));
      if (result.success) {
        client.subscriptions.add(result.taskId);
      }
      break;
      
    case 'stop_task':
      // Stop a running task
      const stopResult = agentManager.stopTask(msg.taskId);
      ws.send(JSON.stringify({ type: 'task_stopped', ...stopResult }));
      break;
      
    case 'send_message':
      // Send interactive message to running task
      const sendResult = agentManager.sendMessage(msg.taskId, {
        type: 'message',
        content: msg.content
      });
      ws.send(JSON.stringify({ type: 'message_sent', ...sendResult }));
      break;
      
    case 'get_status':
      // Get task status
      ws.send(JSON.stringify({
        type: 'status',
        tasks: agentManager.getStatus(msg.taskId),
        runningCount: agentManager.getRunningCount()
      }));
      break;
      
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
      
    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

/**
 * Load agent config (prompt + registry) from PHP server
 */
async function loadAgentConfig() {
  const version = config.agent?.version || 'v1';
  const url = `${config.rba.apiBaseUrl}/agent/prompt?version=${version}`;
  
  console.log(`📋 Loading config (${version}) from ${url}...`);
  
  try {
    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${config.rba.apiKey}` },
      timeout: 10000
    });

    if (!response.data?.success) {
      throw new Error(response.data?.message || 'Server returned error');
    }

    if (!response.data.prompt || !response.data.registry) {
      throw new Error('Missing prompt or registry in response');
    }

    setAgentConfig(response.data.prompt, response.data.registry);
    const agentConfig = getAgentConfig();

    console.log(`✅ Config loaded (${version}): ${Object.keys(agentConfig.registry).length} commands, ${agentConfig.prompt.length} chars prompt`);
    return true;
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error(`❌ Failed to load config: ${msg}`);
    return false;
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
 * POST /run
 * Start a task in a worker thread
 * Body: { sn, task, maxSteps?, speak?, hide_virtual_keyboard? }
 */
app.post('/run', (req, res) => {
  const { sn, task, ...options } = req.body;

  if (!sn || !task) {
    return res.status(400).json({ success: false, error: 'Missing sn or task' });
  }

  const agentConfig = getAgentConfig();
  if (!agentConfig.prompt || !agentConfig.registry) {
    return res.status(503).json({ success: false, error: 'Agent config not loaded' });
  }

  const result = agentManager.startTask(sn, task, options);
  
  if (result.success) {
    res.json({
      success: true,
      taskId: result.taskId,
      sn: result.sn,
      task: result.task,
      wsUrl: `ws://localhost:${PORT}`,
      message: 'Task started. Connect via WebSocket to receive real-time events.'
    });
  } else {
    res.status(409).json(result);
  }
});

/**
 * POST /stop
 * Stop a running task
 * Body: { taskId }
 */
app.post('/stop', (req, res) => {
  const { taskId } = req.body;

  if (!taskId) {
    return res.status(400).json({ success: false, error: 'Missing taskId' });
  }

  const result = agentManager.stopTask(taskId);
  res.json(result);
});

/**
 * POST /message
 * Send interactive message to running task
 * Body: { taskId, content }
 */
app.post('/message', (req, res) => {
  const { taskId, content } = req.body;

  if (!taskId || !content) {
    return res.status(400).json({ success: false, error: 'Missing taskId or content' });
  }

  const result = agentManager.sendMessage(taskId, { type: 'message', content });
  res.json(result);
});

/**
 * GET /tasks
 * Get status of all tasks
 */
app.get('/tasks', (req, res) => {
  res.json({
    success: true,
    tasks: agentManager.getStatus(),
    runningCount: agentManager.getRunningCount()
  });
});

/**
 * GET /tasks/:taskId
 * Get status of specific task
 */
app.get('/tasks/:taskId', (req, res) => {
  const status = agentManager.getStatus(req.params.taskId);
  
  if (!status) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }
  
  res.json({ success: true, ...status });
});

/**
 * POST /reload
 * Reload agent config from PHP server
 */
app.post('/reload', async (req, res) => {
  try {
    const success = await loadAgentConfig();
    const agentConfig = getAgentConfig();
    if (success) {
      res.json({ 
        success: true, 
        message: 'Config reloaded',
        commands: Object.keys(agentConfig.registry).length,
        promptLength: agentConfig.prompt.length,
        loadedAt: agentConfig.loadedAt
      });
    } else {
      res.status(500).json({ success: false, error: 'Failed to reload config' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /commands
 * List available commands
 */
app.get('/commands', (req, res) => {
  const agentConfig = getAgentConfig();
  if (!agentConfig.registry) {
    return res.status(503).json({ success: false, error: 'Registry not loaded' });
  }

  const commands = Object.entries(agentConfig.registry)
    .map(([name, cmd]) => ({
      name,
      description: cmd.description,
      parameters: cmd.parameters || {}
    }));

  res.json({ success: true, commands });
});

/**
 * GET /health
 * Health check
 */
app.get('/health', (req, res) => {
  const agentConfig = getAgentConfig();
  res.json({ 
    status: agentConfig.prompt ? 'ok' : 'not_ready',
    configLoaded: !!agentConfig.prompt,
    loadedAt: agentConfig.loadedAt,
    commands: agentConfig.registry ? Object.keys(agentConfig.registry).length : 0,
    llm: config.llm?.provider,
    rba: config.rba?.apiBaseUrl,
    wsClients: wsClients.size,
    runningTasks: agentManager.getRunningCount()
  });
});

// Startup
async function start() {
  console.log(`\n${'═'.repeat(54)}`);
  console.log(`🚀 RBA AI Agent v3.0 - Worker Architecture`);
  console.log(`${'═'.repeat(54)}`);

  // Load config from PHP server
  const loaded = await loadAgentConfig();
  if (!loaded) {
    console.error('\n❌ Cannot start: Failed to load config from server');
    console.error(`   Make sure PHP server is running and ${config.rba.apiBaseUrl}/agent/prompt is accessible\n`);
    process.exit(1);
  }

  // Start HTTP + WebSocket server
  server.listen(PORT, () => {
    console.log(`\n   HTTP Server:  http://localhost:${PORT}`);
    console.log(`   WebSocket:    ws://localhost:${PORT}`);
    console.log(`   LLM:          ${config.llm?.provider} (${config.llm?.[config.llm?.provider]?.model})`);
    console.log(`   RBA API:      ${config.rba?.apiBaseUrl}`);
    console.log(`${'═'.repeat(54)}\n`);
    console.log('HTTP Endpoints:');
    console.log('  POST /run         - Start task: { sn, task, options? }');
    console.log('  POST /stop        - Stop task: { taskId }');
    console.log('  POST /message     - Send message: { taskId, content }');
    console.log('  GET  /tasks       - List all tasks');
    console.log('  GET  /tasks/:id   - Get task status');
    console.log('  POST /reload      - Reload config');
    console.log('  GET  /commands    - List commands');
    console.log('  GET  /health      - Health check\n');
    console.log('WebSocket Protocol:');
    console.log('  → { type: "subscribe", taskId }');
    console.log('  → { type: "start_task", sn, task, options? }');
    console.log('  → { type: "stop_task", taskId }');
    console.log('  → { type: "send_message", taskId, content }');
    console.log('  → { type: "get_status", taskId? }');
    console.log('  ← Events: task_*, step_*, ai_*, api_*, log, error\n');
  });
}

start();
