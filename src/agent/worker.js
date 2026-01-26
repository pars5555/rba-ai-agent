import { parentPort, workerData } from 'worker_threads';
import { emit, log } from '../logger.js';
import RBAClient from './rba.js';
import LLMClient from './llm.js';

/**
 * Worker Thread v3.0 - Simple with Step Action Tracking
 *
 * Changes from v2.0:
 * - Track actions per step and send to AI
 * - NO loop detection in JS - AI decides when stuck
 * - Simpler flow
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
    log(`📩 User message: ${msg.content}`);
  } else if (msg.type === 'stop') {
    log('⛔ Stop requested');
    process.exit(0);
  }
});

/**
 * Main Agent Loop
 */
async function runAgent() {
  const startTime = Date.now();
  const elapsed = () => Math.round((Date.now() - startTime) / 1000);

  emit('task_init', { sn, task, taskId });

  // Validate config
  if (!config.planningPrompt || !config.executionPrompt || !config.registry) {
    emit('fatal', { message: 'Missing prompts or registry' });
    process.exit(1);
  }

  log(`\n${'═'.repeat(60)}`);
  log(`🤖 AI AGENT v3.0`);
  log(`${'═'.repeat(60)}`);
  log(`📋 Task: "${task}"`);
  log(`📱 Device: ${sn}`);
  log(`⚙️ Commands: ${Object.keys(config.registry).length}`);

  // Initialize clients
  const rba = new RBAClient(config, config.registry);
  const llm = new LLMClient(config, {
    planningPrompt: config.planningPrompt,
    executionPrompt: config.executionPrompt,
    registry: config.registry
  }, getInteractiveMessage);

  const maxActions = options.maxSteps || config.agent?.maxSteps || 100;
  const maxDuration = (options.maxDurationSeconds || config.agent?.maxDurationSeconds || 300) * 1000;
  const speak = options.speak !== false;
  const hideKeyboard = options.hide_virtual_keyboard !== false;

  emit('task_start', { sn, task, taskId, maxActions, maxDurationMs: maxDuration });
  await rba.reportEvent({ uuid: sn, task_id: taskId, type: 'start', task });

  // Initial setup
  if (speak) {
    try {
      const snap = await rba.call(sn, 'get_device_snapshot', {});
      if (snap?.snapshot?.is_muted) {
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
        log(`✅ Task complete immediately: ${plan.reason}`);
        if (speak && plan.reason) {
          await rba.call(sn, 'speak', { text: plan.reason, speed: 1.0 }).catch(() => {});
        }
        await cleanup();
        emit('task_complete', { success: true, steps: 0, totalActions: 0, elapsed: elapsed(), reason: 'completed' });
        process.exit(0);
      }
      throw new Error('Plan has no steps');
    }
  } catch (error) {
    log(`❌ Planning failed: ${error.message}`);
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
  log(`\n${'═'.repeat(60)}`);
  log(`🚀 EXECUTION - ${plan.steps.length} steps`);
  log(`${'═'.repeat(60)}`);

  let currentStep = 0;
  let totalActions = 0;
  let lastResult = null;
  let completed = false;
  let fatalError = null;

  // Track actions for CURRENT step only
  let stepActions = [];

  while (currentStep < plan.steps.length && totalActions < maxActions && !completed && !fatalError) {
    // Timeout check
    if (Date.now() - startTime > maxDuration) {
      log(`⏱️ Timeout after ${elapsed()}s`);
      emit('timeout', { elapsed: elapsed(), atStep: currentStep });
      break;
    }

    emit('step_start', {
      step: currentStep,
      total: plan.steps.length,
      description: plan.steps[currentStep].description,
      actionsInStep: stepActions.length
    });

    // Get AI decision - pass step action history
    let decision;
    try {
      decision = await llm.executeStep(task, plan, currentStep, stepActions, lastResult);
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
      complete: decision.complete,
      error: decision.error
    });

    // Speak reason
    if (speak && decision.reason) {
      rba.call(sn, 'speak', { text: decision.reason, speed: 1.0 }).catch(() => {});
    }

    // Task complete
    if (decision.complete) {
      log(`\n✅ TASK COMPLETE: ${decision.reason}`);
      completed = true;
      break;
    }

    // AI says step can't be done
    if (decision.error) {
      log(`❌ Step ${currentStep + 1} failed: ${decision.error}`);
      emit('step_failed', { step: currentStep, error: decision.error, actionsUsed: stepActions.length });

      // Move to next step
      currentStep++;
      stepActions = []; // Reset for new step
      lastResult = null;
      continue;
    }

    // Step complete - move to next
    if (decision.stepComplete) {
      log(`✓ Step ${currentStep + 1} complete (${stepActions.length} actions): ${decision.reason || ''}`);
      emit('step_complete', { step: currentStep, reason: decision.reason, actionsUsed: stepActions.length });

      currentStep++;
      stepActions = []; // Reset for new step
      lastResult = null;

      if (currentStep >= plan.steps.length) {
        completed = true;
      }
      continue;
    }

    // Execute action
    totalActions++;
    log(`⚡ [${totalActions}] ${decision.action}${decision.params ? ' ' + JSON.stringify(decision.params) : ''}`);

    const result = await rba.call(sn, decision.action, decision.params || {});

    // Track this action in step history
    stepActions.push({
      action: decision.action,
      params: decision.params || {},
      success: result.success
    });

    // Keep full result for next LLM call (contains snapshot data)
    lastResult = { action: decision.action, params: decision.params, ...result };

    emit('action_result', {
      step: currentStep,
      actionNum: totalActions,
      stepActionNum: stepActions.length,
      action: decision.action,
      success: result.success,
      error: result.error
    });

    if (!result.success) {
      log(`⚠️ Action failed: ${result.error || 'unknown'}`);
    }

    if (result._fatal) {
      fatalError = result._fatal;
      break;
    }

    // Report progress
    await rba.reportEvent({
      uuid: sn,
      task_id: taskId,
      type: 'process',
      step: currentStep,
      action: totalActions,
      payload: { action: decision.action, success: result.success }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════

  await cleanup();

  const success = completed && !fatalError;
  const reason = fatalError ? 'fatal_error' : completed ? 'completed' : totalActions >= maxActions ? 'max_actions' : 'timeout';

  log(`\n${'═'.repeat(60)}`);
  log(`🏁 ${success ? 'SUCCESS' : 'FAILED'} - ${reason}`);
  log(`   Steps: ${currentStep}/${plan.steps.length}`);
  log(`   Actions: ${totalActions}`);
  log(`   Time: ${elapsed()}s`);
  log(`${'═'.repeat(60)}\n`);

  emit('task_complete', {
    success,
    completedSteps: currentStep,
    totalSteps: plan.steps.length,
    totalActions,
    elapsed: elapsed(),
    reason,
    fatalError
  });

  await rba.reportEvent({
    uuid: sn,
    task_id: taskId,
    type: 'done',
    payload: { success, steps: currentStep, totalActions, reason }
  });

  process.exit(success ? 0 : 1);

  async function cleanup() {
    if (hideKeyboard) {
      log('⌨️ Disabling ADB keyboard...');
      await rba.call(sn, 'disable_adb_keyboard', {}).catch(() => {});
    }
  }
}

runAgent().catch(error => {
  log(`💀 Fatal: ${error.message}`);
  emit('fatal', { message: error.message });
  process.exit(1);
});