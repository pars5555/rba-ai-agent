import express from 'express';
import http from 'http';
import https from 'https';
import { WebSocketServer } from 'ws';
import axios from 'axios';
import AgentManager from './agentManager.js';

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
let agentConfig = null;   // Contains: planningPrompt, executionPrompt, registry
let configLoadedAt = null;

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

/**
 * Load all config from PHP server
 */
async function loadAllConfig() {
  console.log(`📋 Loading config from ${BOOTSTRAP.apiUrl}...`);
  
  try {
    // Step 1: Load main config from /agent/config
    const configResponse = await axiosInsecure.get(`${BOOTSTRAP.apiUrl}/agent/config`, {
      headers: { 'Authorization': `Bearer ${BOOTSTRAP.apiKey}` },
      timeout: 10000
    });

    if (!configResponse.data?.success || !configResponse.data?.config) {
      throw new Error(configResponse.data?.message || 'Failed to load config');
    }
    
    serverConfig = configResponse.data.config;
    console.log(`✅ Server config loaded`);
    console.log(`   LLM: ${serverConfig.llm?.provider} (${serverConfig.llm?.[serverConfig.llm?.provider]?.model})`);
    console.log(`   Agent version: ${serverConfig.agent?.version}`);

    // Step 2: Load agent config (prompts + registry) from /agent/prompt
    // The endpoint now returns both planning and execution prompts
    const version = serverConfig.agent?.version;
    const promptResponse = await axiosInsecure.get(`${BOOTSTRAP.apiUrl}/agent/getContext?version=${version}`, {
      headers: { 'Authorization': `Bearer ${BOOTSTRAP.apiKey}` },
      timeout: 10000
    });

    if (!promptResponse.data?.success || !promptResponse.data?.registry) {
      throw new Error(promptResponse.data?.message || 'Failed to load agent prompts/registry');
    }

    // Support both old format (single prompt) and new format (planning + execution)
    const responseData = promptResponse.data;
    
    if (responseData.planningPrompt && responseData.executionPrompt) {
      // New format with separate prompts
      agentConfig = {
        planningPrompt: responseData.planningPrompt,
        executionPrompt: responseData.executionPrompt,
        registry: responseData.registry
      };
      console.log(`✅ Agent config loaded (Task Planner mode)`);
    } else {
      throw new Error('Invalid prompt format - missing planning/execution prompts');
    }
    
    configLoadedAt = new Date().toISOString();
    console.log(`   Commands: ${Object.keys(agentConfig.registry).length}`);
    console.log(`   Planning prompt: ${agentConfig.planningPrompt.length} chars`);
    console.log(`   Execution prompt: ${agentConfig.executionPrompt.length} chars`);
    
    return true;
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    console.error(`❌ Failed to load config: ${msg}`);
    return false;
  }
}

/**
 * Get full config to pass to workers
 */
function getWorkerConfig() {
  return {
    rba: {
      apiBaseUrl: BOOTSTRAP.apiUrl,
      apiKey: BOOTSTRAP.apiKey
    },
    llm: serverConfig?.llm,
    agent: serverConfig?.agent,
    // Task Planner prompts
    planningPrompt: agentConfig?.planningPrompt,
    executionPrompt: agentConfig?.executionPrompt,
    registry: agentConfig?.registry
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
    configLoaded: !!agentConfig,
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
        configLoaded: !!agentConfig,
        tasks: agentManager ? agentManager.getStatus(msg.taskId) : [],
        runningCount: agentManager ? agentManager.getRunningCount() : 0
      }));
      break;
      
    case 'ping':
      ws.send(JSON.stringify({ method: 'pong', timestamp: Date.now() }));
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
 */
app.post('/run', (req, res) => {
  const { sn, task, ...options } = req.body;

  if (!sn || !task) {
    return res.status(400).json({ success: false, error: 'Missing sn or task' });
  }

  if (!agentManager || !agentConfig) {
    return res.status(503).json({ success: false, error: 'Agent not ready' });
  }

  const result = agentManager.startTask(sn, task, options);
  
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
    commands: agentConfig?.registry ? Object.keys(agentConfig.registry).length : 0,
    planningPromptLength: agentConfig?.planningPrompt?.length || 0,
    executionPromptLength: agentConfig?.executionPrompt?.length || 0
  });
});

/**
 * GET /commands - List available commands
 */
app.get('/commands', (req, res) => {
  if (!agentConfig?.registry) {
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
 * GET /health - Health check
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: agentConfig ? 'ok' : 'not_ready',
    configLoaded: !!agentConfig,
    configLoadedAt,
    commands: agentConfig?.registry ? Object.keys(agentConfig.registry).length : 0,
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

  // Initialize agent manager with getWorkerConfig function
  agentManager = new AgentManager({
    verbose: serverConfig?.logging?.verbose !== false,
    logApiBody: serverConfig?.logging?.logApiBody || false,
    maxBodyLogLength: serverConfig?.logging?.maxBodyLogLength || 500,
    getWorkerConfig
  });
  agentManager.on('event', broadcastEvent);
  console.log('✅ Agent manager initialized (Task Planner mode)');

  // Start HTTP + WebSocket server
  server.listen(BOOTSTRAP.port, () => {
    console.log(`\n   HTTP Server:  http://localhost:${BOOTSTRAP.port}`);
    console.log(`   WebSocket:    ws://localhost:${BOOTSTRAP.port}`);
    console.log(`${'═'.repeat(54)}\n`);
    console.log('Endpoints:');
    console.log('  POST /run     - Start task: { sn, task }');
    console.log('  POST /stop    - Stop task: { taskId }');
    console.log('  POST /message - Send message: { taskId, content }');
    console.log('  GET  /tasks   - List tasks');
    console.log('  GET  /health  - Health check\n');
    console.log('Task Planner Flow:');
    console.log('  1. 📋 Planning Phase - Create execution plan');
    console.log('  2. 🚀 Execution Phase - Execute steps with progress tracking\n');
  });
}

start();
