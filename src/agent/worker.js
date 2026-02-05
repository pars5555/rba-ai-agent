import { parentPort, workerData } from 'worker_threads';
import { emit, getHumanErrorMessage, updateInstalledAppsFromSnapshot, validateRunAppPackage, createLogger, setLoggingConfig } from './util.js';
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

// Per-task logging: log_level (verbose|debug|info|warning|error|fatal), maxBodyLogLength
setLoggingConfig(config.logging || { log_level: 'info', maxBodyLogLength: 500 });
const { log } = createLogger('worker.js');

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

  const hasMaxActions = options.maxActions !== undefined || options.maxSteps !== undefined;
  const hasMaxDuration = options.maxDurationSeconds !== undefined;

  const maxActions = hasMaxActions ? (options.maxActions ?? options.maxSteps) : Infinity;
  const maxDurationSeconds = hasMaxDuration ? options.maxDurationSeconds : null;
  const maxDuration = hasMaxDuration ? maxDurationSeconds * 1000 : Infinity;
  const speak = options.speak !== false;
  const hideKeyboard = options.hide_virtual_keyboard !== false;
  const disableStatusBar = options.disable_status_bar === true; // disabled by default

  emit('task_start', { sn, task, taskId, maxActions, maxDurationMs: maxDuration });
  await rba.reportEvent({ uuid: sn, task_id: taskId, type: 'start', task });

  log(`⚙️ Options: speak=${speak}, hideKeyboard=${hideKeyboard}, disableStatusBar=${disableStatusBar}, maxActions=${maxActions}, maxDurationSeconds=${maxDurationSeconds ?? 'none'}`);

  let initialSnapshotResult = null;
  try {
    initialSnapshotResult = await rba.call(sn, 'get_device_snapshot');
  } catch (e) {
    initialSnapshotResult = { success: false, error: e.message };
  }

  if (!initialSnapshotResult?.success || !initialSnapshotResult?.snapshot) {
    const missingParams = initialSnapshotResult?._requestValidationError?.missingParameters || [];
    const unexpectedParams = initialSnapshotResult?._requestValidationError?.unexpectedParameters || [];
    const paramDetails = [
      missingParams.length ? `missing: ${missingParams.join(', ')}` : '',
      unexpectedParams.length ? `unexpected: ${unexpectedParams.join(', ')}` : ''
    ].filter(Boolean).join(' | ');
    const errorDetail = initialSnapshotResult?.error || 'Unknown error';
    log(`💀 Failed to load initial device snapshot: ${errorDetail}${paramDetails ? ` (${paramDetails})` : ''}`);
    emit('fatal', {
      message: 'Failed to load initial device snapshot',
      error: errorDetail,
      missingParameters: missingParams,
      unexpectedParameters: unexpectedParams
    });
    process.exit(1);
  }

  // Initial setup
  if (speak && initialSnapshotResult.snapshot.is_muted) {
    log('🔇 Unmuting...');
    await rba.call(sn, 'volume_mute', { mute: false });
  }

  if (hideKeyboard) {
    log('⌨️ Enabling ADB keyboard...');
    await rba.call(sn, 'enable_adb_keyboard', {});
  }

  if (disableStatusBar) {
    log('📵 Disabling status bar...');
    await rba.call(sn, 'disable_status_bar', {});
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
        speak && plan.reason && rba.call(sn, 'speak', { text: plan.reason, speed: 1.0 }).catch(() => {});
        await cleanup();
        emit('task_complete', { success: true, steps: 0, totalActions: 0, elapsed: elapsed(), reason: 'completed' });
        process.exit(0);
      }
      throw new Error('Plan has no steps');
    }
  } catch (error) {
    log(`❌ Planning failed: ${error.message}`);
    if (speak) {
      const speechMsg = `I could not create a plan for this task. ${error.message}`;
      log(`🔊 Speaking error: "${speechMsg}"`);
      rba.call(sn, 'speak', { text: speechMsg, speed: 1.0 }).catch(() => {});
    }
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

  let planCurrentStep = 0;
  let totalActions = 0;
  let lastApiResult = null;
  let completed = false;
  let fatalError = null;
  const installedAppsState = { installedApps: null };

  updateInstalledAppsFromSnapshot(initialSnapshotResult.snapshot, installedAppsState);
  lastApiResult = { action: 'get_device_snapshot', params: { }, ...initialSnapshotResult };

  // Track actions for CURRENT step only
  let stepActions = [];

  while (planCurrentStep < plan.steps.length && totalActions < maxActions && !completed && !fatalError) {
    // Timeout check
    if (Date.now() - startTime > maxDuration) {
      log(`⏱️ Timeout after ${elapsed()}s`);
      emit('timeout', { elapsed: elapsed(), atStep: planCurrentStep });
      // Note: speech will happen in the cleanup section
      break;
    }

    emit('step_start', {
      step: planCurrentStep,
      total: plan.steps.length,
      description: plan.steps[planCurrentStep].description,
      actionsInStep: stepActions.length
    });

    // Get AI decision - pass step action history
    let decision;
    try {
      decision = await llm.executeStep(task, plan, planCurrentStep, stepActions, lastApiResult);
    } catch (error) {
      log(`💀 LLM Error: ${error.message}`);
      log(`   Stack: ${error.stack}`);
      fatalError = { type: 'llm_error', message: error.message, stack: error.stack };
      // Note: speech will happen in the cleanup section
      break;
    }

    emit('ai_decision', {
      step: planCurrentStep,
      action: decision.action,
      params: decision.params,
      reason: decision.reason,
      stepComplete: decision.stepComplete,
      complete: decision.complete,
      error: decision.error
    });

    // Speak reason
    if (speak && decision.reason) {
      log(`🔊 Speaking: "${decision.reason}"`);
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
      log(`❌ Step ${planCurrentStep + 1} failed: ${decision.error}`);
      emit('step_failed', { step: planCurrentStep, error: decision.error, actionsUsed: stepActions.length });

      // Speak step failure
      if (speak) {
        const speechMsg = `Step ${planCurrentStep + 1} failed: ${decision.error}`;
        log(`🔊 Speaking step error: "${speechMsg}"`);
        rba.call(sn, 'speak', { text: speechMsg, speed: 1.0 }).catch(() => {});
      }

      fatalError = {
        type: 'ai_error',
        message: decision.error
      };
      break;
    }

    // Step complete - move to next
    if (decision.stepComplete) {
      log(`✓ Step ${planCurrentStep + 1} complete (${stepActions.length} actions): ${decision.reason || ''}`);
      emit('step_complete', { step: planCurrentStep, reason: decision.reason, actionsUsed: stepActions.length });

      planCurrentStep++;
      stepActions = []; // Reset for new step
      lastApiResult = null;

      if (planCurrentStep >= plan.steps.length) {
        completed = true;
      }
      continue;
    }

    // Validate run_app packages against snapshot
    if (decision.action === 'run_app') {
      const validation = validateRunAppPackage(decision.params, installedAppsState.installedApps);
      if (!validation.ok) {
        log(`❌ run_app blocked: ${validation.error.message}`);
        speak && rba.call(sn, 'speak', { text: validation.error.message, speed: 1.0 }).catch(() => {});
        fatalError = validation.error;
        break;
      }
    }

    // Handle send_screenshot - virtual command that sends screenshot to user via websocket
    if (decision.action === 'send_screenshot') {
      totalActions++;
      log(`📸 [${totalActions}] send_screenshot - capturing and sending to user...`);
      try {
        const screenshotResult = await rba.call(sn, 'get_screenshot', { quality: decision.params?.quality || 80 });
        if (screenshotResult.success && screenshotResult.data) {
          emit('screenshot', {
            step: planCurrentStep,
            actionNum: totalActions,
            reason: decision.reason || 'Screenshot requested',
            data: screenshotResult.data,
            width: screenshotResult.width,
            height: screenshotResult.height
          });
          log(`📸 Screenshot sent to user (${screenshotResult.width}x${screenshotResult.height})`);
        }
        lastApiResult = { action: 'send_screenshot', success: true, sent: !!screenshotResult.data };
        stepActions.push({ action: 'send_screenshot', params: decision.params || {}, success: true });
      } catch (e) {
        log(`📸 Screenshot failed: ${e.message}`);
        lastApiResult = { action: 'send_screenshot', success: false, error: e.message };
        stepActions.push({ action: 'send_screenshot', params: decision.params || {}, success: false });
      }
      continue;
    }

    // Execute action
    totalActions++;
    log(`⚡ [${totalActions}] ${decision.action}${decision.params ? ' ' + JSON.stringify(decision.params) : ''}`);

    const result = await rba.call(sn, decision.action, decision.params || {});
    log(`⚡ api result [${totalActions}] ${JSON.stringify(result)}`);

    // Track this action in step history
    stepActions.push({
      action: decision.action,
      params: decision.params || {},
      success: result.success
    });

    // Keep full result for next LLM call (contains snapshot data)
    lastApiResult = { action: decision.action, params: decision.params, ...result };

    emit('action_result', {
      step: planCurrentStep,
      actionNum: totalActions,
      stepActionNum: stepActions.length,
      action: decision.action,
      success: result.success,
      error: result.error
    });

    if (!result.success) {
      log(`⚠️ Action failed: ${result.error || 'unknown'}`);
    }

    // Check for response validation errors (missing properties from registry schema)
    if (result._responseValidationError) {
      const err = result._responseValidationError;
      log(`⚠️ Response validation error: ${err.message}`);
      emit('response_validation_error', {
        action: err.action,
        missingProperties: err.missingProperties
      });
      // This is a fatal error - device response doesn't match expected schema
      fatalError = { 
        type: 'response_validation_error', 
        message: err.message,
        missingProperties: err.missingProperties
      };
      break;
    }

    if (decision.action === 'get_device_snapshot' && result.success && result.snapshot) {
      updateInstalledAppsFromSnapshot(result.snapshot, installedAppsState);
    }

    if (result._fatal) {
      fatalError = result._fatal;
      log(`💀 Fatal error from RBA: ${JSON.stringify(result._fatal)}`);
      break;
    }

    // Report progress
    await rba.reportEvent({
      uuid: sn,
      task_id: taskId,
      type: 'process',
      step: planCurrentStep,
      action: totalActions,
      payload: { action: decision.action, success: result.success }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP & SPEAK RESULT
  // ═══════════════════════════════════════════════════════════════

  const success = completed && !fatalError;
  const reason = fatalError ? 'fatal_error' : completed ? 'completed' : totalActions >= maxActions ? 'max_actions' : 'timeout';

  // Speak error/result BEFORE cleanup (while device is still responsive)
  if (speak && !success) {
    const speechMsg = getHumanErrorMessage(fatalError, reason, planCurrentStep, plan.steps.length);
    log(`🔊 Speaking result: "${speechMsg}"`);
    rba.call(sn, 'speak', { text: speechMsg, speed: 1.0 }).catch(() => {});
    // Wait a bit for speech to complete
    await new Promise(r => setTimeout(r, 2000));
  }

  await cleanup();

  log(`\n${'═'.repeat(60)}`);
  log(`🏁 ${success ? 'SUCCESS' : 'FAILED'} - ${reason}`);
  log(`   Steps: ${planCurrentStep}/${plan.steps.length}`);
  log(`   Actions: ${totalActions}`);
  log(`   Time: ${elapsed()}s`);
  if (fatalError) {
    log(`   ❌ Fatal Error: ${JSON.stringify(fatalError)}`);
  }
  log(`${'═'.repeat(60)}\n`);

  emit('task_complete', {
    success,
    completedSteps: planCurrentStep,
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
    payload: { success, steps: planCurrentStep, totalActions, reason }
  });

  process.exit(success ? 0 : 1);

  async function cleanup() {
    if (hideKeyboard) {
      log('⌨️ Disabling ADB keyboard...');
      await rba.call(sn, 'disable_adb_keyboard', {}).catch(() => {});
    }
    if (disableStatusBar) {
      log('📵 Re-enabling status bar...');
      await rba.call(sn, 'enable_status_bar', {}).catch(() => {});
    }
  }
}

runAgent().catch(error => {
  log(`💀 Fatal: ${error.message}`);
  emit('fatal', { message: error.message });
  process.exit(1);
});