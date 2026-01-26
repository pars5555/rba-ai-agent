import { parentPort, workerData } from 'worker_threads';
import { emit, log } from '../logger.js';
import RBAClient from './rba.js';
import LLMClient from './llm.js';

/**
 * Worker Thread - Task Planner (Minimal)
 * 
 * Simple flow:
 * 1. Create plan
 * 2. Execute steps in loop
 * 3. AI decides everything (actions, step completion, task completion, stopping on error)
 */

const { sn, task, taskId, options, config } = workerData;

// Interactive message
let interactiveMessage = null;
function getInteractiveMessage() {
  const msg = interactiveMessage;
  interactiveMessage = null;
  return msg;
}

parentPort.on('message', (msg) => {
  if (msg.type === 'message') {
    interactiveMessage = msg.content;
    log(`📩 Message: ${msg.content}`);
  } else if (msg.type === 'stop') {
    log('⛔ Stop requested');
    process.exit(0);
  }
});

/**
 * Main Agent Loop
 */
async function runAgent() {
  emit('task_init', { sn, task, taskId, options });

  // Validate config
  if (!config.planningPrompt || !config.executionPrompt || !config.registry) {
    emit('fatal', { message: 'Missing prompts or registry' });
    process.exit(1);
  }

  log(`📋 Config: ${Object.keys(config.registry).length} commands`);

  // Initialize
  const rba = new RBAClient(config, config.registry);
  const llm = new LLMClient(config, {
    planningPrompt: config.planningPrompt,
    executionPrompt: config.executionPrompt,
    registry: config.registry
  }, getInteractiveMessage);

  const maxSteps = options.maxSteps || config.agent?.maxSteps || 100;
  const maxDuration = (options.maxDurationSeconds || config.agent?.maxDurationSeconds || 300) * 1000;
  const speak = options.speak !== false;
  const hideKeyboard = options.hide_virtual_keyboard !== false;

  const startTime = Date.now();
  emit('task_start', { sn, task, taskId, maxSteps, maxDuration, speak });
  await rba.reportEvent({ uuid: sn, task_id: taskId, type: 'start', task });

  // Setup
  if (speak) {
    try {
      const snapshot = await rba.call(sn, 'get_device_snapshot', {});
      if (snapshot?.snapshot?.is_muted) {
        log('🔇 Unmuting...');
        await rba.call(sn, 'volume_mute', { mute: false });
      }
    } catch (e) { /* ignore */ }
  }

  if (hideKeyboard) {
    log('⌨️ Enabling ADB keyboard...');
    await rba.call(sn, 'enable_adb_keyboard', {});
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: PLANNING
  // ═══════════════════════════════════════════════════════════════
  
  emit('phase', { phase: 'planning' });

  let plan;
  try {
    plan = await llm.createPlan(task);
    
    if (!plan.steps || plan.steps.length === 0) {
      if (plan.complete) {
        log(`✓ Task complete immediately: ${plan.reason}`);
        await cleanup();
        emit('task_complete', { success: true, steps: 0, elapsed: elapsed(), reason: 'completed' });
        process.exit(0);
      }
      throw new Error('Plan has no steps');
    }
  } catch (error) {
    emit('fatal', { message: `Planning failed: ${error.message}` });
    process.exit(1);
  }

  emit('plan_created', {
    stepsCount: plan.steps.length,
    steps: plan.steps.map((s, i) => ({ index: i, description: s.description }))
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: EXECUTION
  // ═══════════════════════════════════════════════════════════════
  
  emit('phase', { phase: 'execution' });

  let currentStep = 0;
  let totalActions = 0;
  let lastResult = null;
  let completed = false;
  let fatalError = null;

  while (currentStep < plan.steps.length && totalActions < maxSteps && !completed && !fatalError) {
    // Timeout check
    if (Date.now() - startTime > maxDuration) {
      emit('timeout', { elapsed: elapsed() });
      break;
    }

    emit('step_start', { step: currentStep, total: plan.steps.length, description: plan.steps[currentStep].description });

    // Get AI decision
    let decision;
    try {
      decision = await llm.executeStep(task, plan, currentStep, lastResult);
    } catch (error) {
      fatalError = { type: 'llm_error', message: error.message };
      break;
    }

    emit('ai_decision', {
      step: currentStep,
      action: decision.action,
      params: decision.params,
      reason: decision.reason,
      stepComplete: decision.stepComplete,
      complete: decision.complete
    });

    // Speak
    if (speak && decision.reason) {
      log(`🔊 "${decision.reason}"`);
      rba.call(sn, 'speak', { text: decision.reason, speed: 1.0 }).catch(() => {});
    }

    // Task complete
    if (decision.complete) {
      completed = true;
      break;
    }

    // Step complete
    if (decision.stepComplete) {
      log(`✓ Step ${currentStep + 1} complete`);
      emit('step_complete', { step: currentStep });
      currentStep++;
      lastResult = null;
      if (currentStep >= plan.steps.length) completed = true;
      continue;
    }

    // Execute action
    totalActions++;
    const result = await rba.call(sn, decision.action, decision.params || {});
    lastResult = { action: decision.action, ...result };

    emit('action_result', { step: currentStep, action: decision.action, success: result.success, error: result.error });

    if (result._fatal) {
      fatalError = result._fatal;
      break;
    }

    await rba.reportEvent({ uuid: sn, task_id: taskId, type: 'process', step: currentStep, payload: { action: decision.action, success: result.success } });
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════
  
  await cleanup();

  const success = completed && !fatalError;
  const reason = fatalError ? 'fatal_error' : completed ? 'completed' : 'max_steps';

  emit('task_complete', { success, steps: currentStep, totalActions, elapsed: elapsed(), reason });
  await rba.reportEvent({ uuid: sn, task_id: taskId, type: 'done', payload: { success, steps: currentStep, totalActions, reason } });

  process.exit(success ? 0 : 1);

  // Helpers
  function elapsed() { return Math.round((Date.now() - startTime) / 1000); }
  
  async function cleanup() {
    if (hideKeyboard) {
      log('⌨️ Disabling ADB keyboard...');
      await rba.call(sn, 'disable_adb_keyboard', {}).catch(() => {});
    }
  }
}

runAgent().catch(error => {
  emit('fatal', { message: error.message });
  process.exit(1);
});
