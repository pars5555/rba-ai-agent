import express from 'express';
import axios from 'axios';
import Agent from './src/agent.js';
import RBAClient from './src/rba.js';
import { config } from './src/config.js';
import { getAgentConfig, setAgentConfig } from './src/agentConfig.js';

const app = express();
const PORT = config.server?.port || 3000;

/**
 * Load agent config (prompt + registry) from PHP server
 */
async function loadAgentConfig() {
  const version = config.agent?.version || 'v1';
  const url = `${config.rba.apiBaseUrl}/agent/prompt?version=${version}`;
  
  console.log(`📋 Loading config (${version}) from ${url}...`);
  
  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${config.rba.apiKey}`
      },
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
 * Run a task on device
 * Body: { sn, task, maxSteps?, speak?, hide_virtual_keyboard? }
 */
app.post('/run', async (req, res) => {
  try {
    const { sn, task, ...options } = req.body;

    if (!sn || !task) {
      return res.status(400).json({ success: false, error: 'Missing sn or task' });
    }

    const agentConfig = getAgentConfig();
    if (!agentConfig.prompt || !agentConfig.registry) {
      return res.status(503).json({ success: false, error: 'Agent config not loaded' });
    }

    const agent = new Agent(sn);
    const result = await agent.run(task, options);

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /execute
 * Execute a single action (no AI)
 * Body: { sn, action, params }
 */
app.post('/execute', async (req, res) => {
  try {
    const { sn, action, params = {} } = req.body;

    if (!sn || !action) {
      return res.status(400).json({ success: false, error: 'Missing sn or action' });
    }

    const rba = new RBAClient();
    const result = await rba.call(sn, action, params);

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
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
    rba: config.rba?.apiBaseUrl
  });
});

// Startup
async function start() {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🚀 RBA AI Agent`);
  console.log(`${'═'.repeat(50)}`);

  // Load config from PHP server
  const loaded = await loadAgentConfig();
  if (!loaded) {
    console.error('\n❌ Cannot start: Failed to load config from server');
    console.error(`   Make sure PHP server is running and ${config.rba.apiBaseUrl}/agent/prompt is accessible\n`);
    process.exit(1);
  }

  // Start server
  app.listen(PORT, () => {
    console.log(`\n   Server:  http://localhost:${PORT}`);
    console.log(`   LLM:     ${config.llm?.provider} (${config.llm?.[config.llm?.provider]?.model})`);
    console.log(`   RBA API: ${config.rba?.apiBaseUrl}`);
    console.log(`${'═'.repeat(50)}\n`);
    console.log('Endpoints:');
    console.log('  POST /run      - Run AI task: { sn, task }');
    console.log('  POST /execute  - Single action: { sn, action, params }');
    console.log('  POST /reload   - Reload config from server');
    console.log('  GET  /commands - List commands');
    console.log('  GET  /health   - Health check\n');
  });
}

start();
