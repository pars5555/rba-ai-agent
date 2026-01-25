import { parentPort, workerData } from 'worker_threads';
import axios from 'axios';
import { config } from '../config.js';
import { emit, log, logError } from '../logger.js';
import RBAClient from './rba.js';
import LLMClient from './llm.js';

/**
 * Worker Thread for Agent Tasks
 * 
 * Runs agent loop in isolated thread
 * Sends events to main thread via parentPort
 * Receives messages from main thread (for interactive communication)
 */

// Global state for this worker
let agentConfig = null;
let interactiveMessage = null;

/**
 * Get and clear interactive message
 */
function getInteractiveMessage() {
  const msg = interactiveMessage;
  interactiveMessage = null;
  return msg;
}

// Listen for messages from main thread (interactive communication)
parentPort.on('message', (msg) => {
  if (msg.type === 'message') {
    interactiveMessage = msg.content;
    log(`📩 Received interactive message: ${msg.content}`);
  } else if (msg.type === 'stop') {
    log('⛔ Stop requested');
    process.exit(0);
  }
});

/**
 * Load agent config from PHP server
 */
async function loadConfig() {
  const version = config.agent?.version || 'v1';
  const url = `${config.rba.apiBaseUrl}/agent/prompt?version=${version}`;

  log(`📋 Loading config (${version})...`);

  try {
    const response = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${config.rba.apiKey}` },
      timeout: 10000
    });

    if (!response.data?.success || !response.data.prompt || !response.data.registry) {
      throw new Error(response.data?.message || 'Invalid config response');
    }

    agentConfig = {
      prompt: response.data.prompt,
      registry: response.data.registry
    };

    log(`✅ Config loaded: ${Object.keys(agentConfig.registry).length} commands`);
    return true;
  } catch (error) {
    logError(`Config load failed: ${error.message}`);
    return false;
  }
}

/**
 * Main Agent Loop
 */
async function runAgent() {
  const { sn, task, taskId, options } = workerData;

  emit('task_init', { sn, task, taskId, options });

  // Load config
  if (!await loadConfig()) {
    emit('fatal', { message: 'Failed to load config' });
    process.exit(1);
  }

  // Initialize clients
  const rba = new RBAClient(agentConfig.registry);
  const llm = new LLMClient(agentConfig, getInteractiveMessage);

  const maxSteps = options.maxSteps || config.agent?.maxSteps || 100;
  const maxDuration = (options.maxDurationSeconds || config.agent?.maxDurationSeconds || 300) * 1000;
  const speak = options.speak !== false;
  const hideKeyboard = options.hide_virtual_keyboard !== false; // enabled by default

  const startTime = Date.now();

  emit('task_start', { sn, task, taskId, maxSteps, maxDuration, speak, hideKeyboard });
  await rba.reportEvent({ uuid: sn, task_id: taskId, type: 'start', task });

  // Initial setup
  if (speak) {
    try {
      const snapshot = await rba.call(sn, 'get_device_snapshot', {});
      if (snapshot?.snapshot?.is_muted) {
        log('🔇 Unmuting device...');
        await rba.call(sn, 'volume_mute', { mute: false });
      }
    } catch (e) { /* ignore */ }
  }

  if (hideKeyboard) {
    log('⌨️ Enabling ADB keyboard...');
    await rba.call(sn, 'enable_adb_keyboard', {});
  }

  const history = [];
  let lastResult = null;
  let step = 0;
  let completed = false;
  let fatalError = null;
  let timedOut = false;

  while (step < maxSteps && !completed && !fatalError && !timedOut) {
    if (Date.now() - startTime > maxDuration) {
      timedOut = true;
      emit('timeout', { elapsed: Date.now() - startTime });
      break;
    }

    step++;
    emit('step_start', { step, maxSteps });

    // Get AI decision
    let action;
    try {
      action = await llm.getNextAction(task, history, lastResult);
    } catch (error) {
      fatalError = { type: 'llm_error', message: error.message };
      break;
    }

    emit('ai_decision', {
      step,
      action: action.action,
      params: action.params,
      reason: action.reason,
      details: action.details,
      complete: action.complete
    });

    // Log details for debugging (if provided)
    if (action.details) {
      log(`📋 Details: ${action.details}`);
    }

    // Speak reason (fire-and-forget)
    if (speak && action.reason) {
      log(`🔊 "${action.reason}"`);
      rba.call(sn, 'speak', { text: action.reason, speed: 1.0 }).catch(() => {});
    }

    if (action.complete) {
      completed = true;
      break;
    }

    // Execute action
    const result = await rba.call(sn, action.action, action.params || {});
    lastResult = { action: action.action, params: action.params, ...result };

    emit('step_result', {
      step,
      action: action.action,
      success: result.success,
      error: result.error
    });

    if (result._fatal) {
      fatalError = result._fatal;
      break;
    }

    history.push({ action: action.action, params: action.params, success: result.success });
    await rba.reportEvent({ uuid: sn, task_id: taskId, type: 'process', step, payload: { action, success: result.success } });
  }

  // Cleanup
  if (hideKeyboard) {
    log('⌨️ Disabling ADB keyboard...');
    await rba.call(sn, 'disable_adb_keyboard', {}).catch(() => {});
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const success = completed && !fatalError && !timedOut;
  const reason = fatalError ? 'fatal_error' : timedOut ? 'timeout' : completed ? 'completed' : 'max_steps';

  emit('task_complete', {
    success,
    steps: step,
    elapsed,
    reason,
    history
  });

  await rba.reportEvent({ uuid: sn, task_id: taskId, type: 'done', payload: { success, steps: step, elapsed, reason } });

  // Exit with appropriate code
  process.exit(success ? 0 : 1);
}

// Start agent
runAgent().catch(error => {
  emit('fatal', { message: error.message, stack: error.stack });
  process.exit(1);
});
