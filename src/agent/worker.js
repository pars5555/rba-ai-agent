import { parentPort, workerData } from 'worker_threads';
import { emit, log, logError } from '../logger.js';
import RBAClient from './rba.js';
import LLMClient from './llm.js';

/**
 * Worker Thread with Task Planner Architecture
 * 
 * Two-phase execution:
 * 1. Planning Phase: Create structured plan from task
 * 2. Execution Phase: Execute steps, tracking progress
 * 
 * Benefits:
 * - No growing history sent to LLM
 * - Clear progress tracking
 * - Efficient token usage
 * - Better structured execution
 */

// Get everything from workerData
const { sn, task, taskId, options, config } = workerData;

// Interactive message state
let interactiveMessage = null;

function getInteractiveMessage() {
  const msg = interactiveMessage;
  interactiveMessage = null;
  return msg;
}

// Listen for messages from main thread
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
 * Main Agent Loop with Task Planner
 */
async function runAgent() {
  emit('task_init', { sn, task, taskId, options });

  // Validate config
  if (!config.planningPrompt || !config.executionPrompt || !config.registry) {
    emit('fatal', { message: 'Missing prompts or registry in config' });
    process.exit(1);
  }

  log(`📋 Config ready: ${Object.keys(config.registry).length} commands`);

  // Initialize clients
  const rba = new RBAClient(config, config.registry);
  const llm = new LLMClient(config, {
    planningPrompt: config.planningPrompt,
    executionPrompt: config.executionPrompt,
    registry: config.registry
  }, getInteractiveMessage);

  const maxSteps = options.maxSteps || config.agent?.maxSteps || 100;
  const maxDuration = (options.maxDurationSeconds || config.agent?.maxDurationSeconds || 300) * 1000;
  const maxRetries = options.maxRetries || 3;
  const speak = options.speak !== false;
  const hideKeyboard = options.hide_virtual_keyboard !== false;

  const startTime = Date.now();

  emit('task_start', { sn, task, taskId, maxSteps, maxDuration, speak, hideKeyboard });
  await rba.reportEvent({ uuid: sn, task_id: taskId, type: 'start', task });

  // Initial setup
  let initialSnapshot = null;
  try {
    initialSnapshot = await rba.call(sn, 'get_device_snapshot', {});
    
    if (speak && initialSnapshot?.snapshot?.is_muted) {
      log('🔇 Unmuting device...');
      await rba.call(sn, 'volume_mute', { mute: false });
    }
  } catch (e) { /* ignore */ }

  if (hideKeyboard) {
    log('⌨️ Enabling ADB keyboard...');
    await rba.call(sn, 'enable_adb_keyboard', {});
  }

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: PLANNING
  // ═══════════════════════════════════════════════════════════════
  
  emit('phase', { phase: 'planning', task });
  log('📋 Phase 1: Creating execution plan...');

  let plan;
  try {
    plan = await llm.createPlan(task, initialSnapshot?.snapshot);
    
    if (!plan.steps || plan.steps.length === 0) {
      // Task might be already complete or trivial
      if (plan.complete) {
        emit('task_complete', {
          success: true,
          steps: 0,
          elapsed: Math.round((Date.now() - startTime) / 1000),
          reason: 'completed_immediately',
          plan: null
        });
        
        if (speak && plan.reason) {
          await rba.call(sn, 'speak', { text: plan.reason, speed: 1.0 }).catch(() => {});
        }
        
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
    steps: plan.steps.map((s, i) => ({ index: i, description: s.description })),
    analysis: plan.analysis
  });

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: EXECUTION
  // ═══════════════════════════════════════════════════════════════
  
  emit('phase', { phase: 'execution', stepsCount: plan.steps.length });
  log('🚀 Phase 2: Executing plan...');

  let currentStepIndex = 0;
  let totalActions = 0;
  let lastResult = null;
  let completed = false;
  let fatalError = null;
  let timedOut = false;
  let stepRetries = 0;

  while (currentStepIndex < plan.steps.length && totalActions < maxSteps && !completed && !fatalError && !timedOut) {
    // Check timeout
    if (Date.now() - startTime > maxDuration) {
      timedOut = true;
      emit('timeout', { elapsed: Date.now() - startTime, atStep: currentStepIndex });
      break;
    }

    const currentStep = plan.steps[currentStepIndex];
    
    emit('step_start', {
      stepIndex: currentStepIndex,totalSteps: plan.steps.length,description: currentStep.description,
      actionNumber: totalActions + 1,maxActions: maxSteps});

    log(`\n── Step ${currentStepIndex + 1}/${plan.steps.length}: ${currentStep.description} ──`);

    // Get AI decision for this step
    let decision;
    try {
      decision = await llm.executeStep(task, plan, currentStepIndex, lastResult);
    } catch (error) {
      fatalError = { type: 'llm_error', message: error.message };
      break;
    }

    emit('ai_decision', {
      stepIndex: currentStepIndex,
      action: decision.action,
      params: decision.params,
      reason: decision.reason,
      details: decision.details,
      stepComplete: decision.stepComplete,
      complete: decision.complete
    });

    if (decision.details) {
      log(`📋 Details: ${decision.details}`);
    }

    // Speak reason (fire-and-forget)
    if (speak && decision.reason) {
      log(`🔊 "${decision.reason}"`);
      rba.call(sn, 'speak', { text: decision.reason, speed: 1.0 }).catch(() => {});
    }

    // Task fully complete
    if (decision.complete) {
      completed = true;
      break;
    }

    // Current step complete, move to next
    if (decision.stepComplete) {
      log(`✓ Step ${currentStepIndex + 1} complete`);
      emit('step_complete', {
        stepIndex: currentStepIndex,
        description: currentStep.description
      });
      
      currentStepIndex++;
      stepRetries = 0;
      lastResult = null;
      
      // Check if all steps done
      if (currentStepIndex >= plan.steps.length) {
        completed = true;
      }
      continue;
    }

    // Execute the action
    totalActions++;
    const result = await rba.call(sn, decision.action, decision.params || {});
    lastResult = { action: decision.action, params: decision.params, ...result };

    emit('action_result', {
      stepIndex: currentStepIndex,
      actionNumber: totalActions,
      action: decision.action,
      success: result.success,
      error: result.error
    });

    // Check for fatal errors
    if (result._fatal) {
      fatalError = result._fatal;
      break;
    }

    // Handle action failure
    if (!result.success) {
      stepRetries++;
      log(`⚠️ Action failed (retry ${stepRetries}/${maxRetries}): ${result.error}`);
    } else {
      // Reset retries on success
      stepRetries = 0;
    }

    // Report progress
    await rba.reportEvent({
      uuid: sn,
      task_id: taskId,
      type: 'process',
      step: currentStepIndex,
      action: totalActions,
      payload: { decision, success: result.success }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════

  if (hideKeyboard) {
    log('⌨️ Disabling ADB keyboard...');
    await rba.call(sn, 'disable_adb_keyboard', {}).catch(() => {});
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const success = completed && !fatalError && !timedOut;
  
  let reason;
  if (fatalError) reason = 'fatal_error';
  else if (timedOut) reason = 'timeout';
  else if (completed) reason = 'completed';
  else if (totalActions >= maxSteps) reason = 'max_actions';
  else reason = 'unknown';

  emit('task_complete', {
    success,
    completedSteps: currentStepIndex,
    totalSteps: plan.steps.length,
    totalActions,
    elapsed,
    reason,
    fatalError
  });

  await rba.reportEvent({
    uuid: sn,
    task_id: taskId,
    type: 'done',
    payload: {
      success,
      completedSteps: currentStepIndex,
      totalSteps: plan.steps.length,
      totalActions,
      elapsed,
      reason
    }
  });

  process.exit(success ? 0 : 1);
}

// Start
runAgent().catch(error => {
  emit('fatal', { message: error.message, stack: error.stack });
  process.exit(1);
});
