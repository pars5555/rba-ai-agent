import express from 'express';
import Agent from './src/agent.js';
import RBAClient from './src/rba.js';
import { config, registry } from './src/config.js';

const app = express();
const PORT = config.server?.port || 3000;

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
 * Body: { sn, task, maxSteps? }
 */
app.post('/run', async (req, res) => {
  try {
    const { sn, task, maxSteps } = req.body;

    if (!sn || !task) {
      return res.status(400).json({ success: false, error: 'Missing sn or task' });
    }

    const agent = new Agent(sn);
    const result = await agent.run(task, { maxSteps });

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
 * GET /commands
 * List available commands
 */
app.get('/commands', (req, res) => {
  const commands = Object.entries(registry)
    .filter(([_, cmd]) => cmd.safe === true)
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
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    llm: config.llm?.provider,
    rba: config.rba?.apiBaseUrl
  });
});

// Start
app.listen(PORT, () => {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🚀 RBA AI Agent (Simplified)`);
  console.log(`${'═'.repeat(50)}`);
  console.log(`   Server:  http://localhost:${PORT}`);
  console.log(`   LLM:     ${config.llm?.provider} (${config.llm?.[config.llm?.provider]?.model})`);
  console.log(`   RBA API: ${config.rba?.apiBaseUrl}`);
  console.log(`${'═'.repeat(50)}\n`);
  console.log('Endpoints:');
  console.log('  POST /run      - Run AI task: { sn, task }');
  console.log('  POST /execute  - Single action: { sn, action, params }');
  console.log('  GET  /commands - List commands');
  console.log('  GET  /health   - Health check\n');
});
