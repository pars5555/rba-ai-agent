import RBAClient from './rba.js';
import LLMClient from './llm.js';
import { config } from './config.js';
import { randomUUID } from 'crypto';

/**
 * Simple Reactive Agent
 *
 * The entire logic:
 * 1. Observe screen (get_device_snapshot)
 * 2. Ask AI what to do next
 * 3. Execute AI's command
 * 4. Validate response
 * 5. Log result to server
 * 6. Repeat until complete or max steps
 *
 * NO hardcoded logic. AI decides everything.
 */
class Agent {
  constructor(deviceSerial) {
    this.sn = deviceSerial;
    this.rba = new RBAClient();
    this.llm = new LLMClient();
  }

  /**
   * Run a task
   * @param {string} task - User's task description
   * @param {object} options - { maxSteps, taskId }
   * @returns {Promise<object>} Execution result
   */
  async run(task, options = {}) {
    const maxSteps = options.maxSteps || config.agent?.maxSteps || 25;
    const pauseMs = config.agent?.pauseBetweenSteps || 300;
    const taskId = options.taskId || randomUUID();

    const history = [];
    let step = 0;
    let completed = false;
    let fatalError = null;
    let validationError = null;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🤖 AGENT START`);
    console.log(`   Task: "${task}"`);
    console.log(`   Device: ${this.sn}`);
    console.log(`   Task ID: ${taskId}`);
    console.log(`   Max steps: ${maxSteps}`);
    console.log(`${'═'.repeat(60)}\n`);

    // Report task start
    await this.report({
      uuid: this.sn,
      task_id: taskId,
      type: 'start',
      task,
      payload: {
        maxSteps,
        device: this.sn
      }
    });

    while (step < maxSteps && !completed && !fatalError && !validationError) {
      step++;
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`📍 STEP ${step}/${maxSteps}`);

      // 1. OBSERVE - Get current screen state
      const state = await this.observe();

      // Check for fatal errors
      if (state._fatal) {
        fatalError = state._fatal;
        console.log(`❌ Fatal: ${fatalError.message}`);
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { fatal: fatalError, state: this.summarizeState(state) }
        });
        break;
      }

      // Check for validation errors in observation
      if (state._validationError) {
        validationError = { type: 'observation_validation', message: state.error };
        console.log(`❌ Validation Error: ${state.error}`);
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { validationError, state: this.summarizeState(state) }
        });
        break;
      }

      console.log(`   📱 App: ${state.foreground_package || 'unknown'}`);
      console.log(`   📊 Screen: ${state.screen_width}x${state.screen_height}, Nodes: ${state.ui_nodes?.count || 0}, Text: ${state.screen_analysis?.textCount || 0}`);

      // 2. DECIDE - Ask AI for next action
      let action;
      try {
        action = await this.llm.getNextAction(state, task, history);
        console.log(`   🤖 AI: ${action.action} - ${action.description || ''}`);
        if (action.reason) {
          console.log(`   💭 Reason: ${action.reason}`);
        }
        if (action.params && Object.keys(action.params).length > 0) {
          console.log(`   📝 Params: ${JSON.stringify(action.params)}`);
        }
      } catch (error) {
        console.error(`   ❌ LLM Error: ${error.message}`);
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { llmError: error.message, state: this.summarizeState(state) }
        });
        break;
      }

      // 3. EXECUTE - Run the action (even if complete=true, execute the action first!)
      // Only skip if action is explicitly "none" or missing
      let result = { success: true, skipped: true };
      
      if (action.action && action.action !== 'none') {
        result = await this.rba.call(this.sn, action.action, action.params || {});
      }

      // Check for fatal errors
      if (result._fatal) {
        fatalError = result._fatal;
        console.log(`   ❌ Fatal: ${fatalError.message}`);
        history.push({ step, action, result, state: this.summarizeState(state) });
        
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { action, result, fatal: fatalError, state: this.summarizeState(state) }
        });
        break;
      }

      // Check for validation errors (missing params, etc.)
      if (result._validationError) {
        validationError = { 
          type: 'param_validation', 
          message: result.error,
          missingParams: result.missingParams 
        };
        console.log(`   ❌ Validation Error: ${result.error}`);
        history.push({ step, action, result, state: this.summarizeState(state) });
        
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { action, validationError, state: this.summarizeState(state) }
        });
        break;
      }

      // Check for response validation warnings
      if (result._responseValidation && !result._responseValidation.valid) {
        console.log(`   ⚠️ Response validation issues: ${result._responseValidation.errors.join(', ')}`);
      }

      // Log result
      if (!result.skipped) {
        const icon = result.success ? '✅' : '❌';
        console.log(`   ${icon} Result: ${result.success ? 'OK' : result.error || 'Failed'}`);
      }

      // 4. RECORD - Add to history
      history.push({
        step,
        action,
        result: { success: result.success, error: result.error },
        state: this.summarizeState(state)
      });

      // Report step to server
      await this.report({
        uuid: this.sn,
        task_id: taskId,
        type: 'process',
        task,
        step,
        payload: {
          action,
          result: { success: result.success, error: result.error },
          completed: action.complete === true,
          state: this.summarizeState(state)
        }
      });

      // 5. CHECK COMPLETION - After executing the action!
      if (action.complete === true) {
        console.log(`\n✅ TASK COMPLETE: ${action.reason || 'AI marked as complete'}`);
        completed = true;
        break;
      }

      // Pause between steps
      if (pauseMs > 0 && step < maxSteps) {
        await this.sleep(pauseMs);
      }
    }

    // Build final result
    const success = completed && !fatalError && !validationError;
    const reason = fatalError ? 'fatal_error' :
        validationError ? 'validation_error' :
        completed ? 'completed' :
        step >= maxSteps ? 'max_steps' : 'unknown';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🏁 AGENT ${success ? 'SUCCESS' : 'STOPPED'}`);
    console.log(`   Steps: ${step}`);
    console.log(`   Reason: ${reason}`);
    if (fatalError) console.log(`   Fatal: ${fatalError.message}`);
    if (validationError) console.log(`   Validation: ${validationError.message}`);
    console.log(`${'═'.repeat(60)}\n`);

    const finalResult = {
      success,
      task,
      taskId,
      device: this.sn,
      steps: step,
      reason,
      history,
      fatalError,
      validationError
    };

    // Report task completion
    await this.report({
      uuid: this.sn,
      task_id: taskId,
      type: 'done',
      task,
      payload: finalResult,
      output: this.buildOutput(finalResult, history)
    });

    return finalResult;
  }

  /**
   * Report event to server
   */
  async report(event) {
    try {
      await this.rba.reportEvent(event);
    } catch (e) {
      // Don't fail main flow if reporting fails
      console.warn(`⚠️ Report failed: ${e.message}`);
    }
  }

  /**
   * Build human-readable output for done event
   */
  buildOutput(result, history) {
    const lines = [];
    lines.push(`Task: ${result.task}`);
    lines.push(`Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    lines.push(`Steps: ${result.steps}`);
    lines.push(`Reason: ${result.reason}`);
    
    if (result.fatalError) {
      lines.push(`Error: ${result.fatalError.message}`);
    }
    if (result.validationError) {
      lines.push(`Validation: ${result.validationError.message}`);
    }
    
    return lines.join('\n');
  }

  /**
   * Observe current screen state - returns raw API response, AI knows the format
   */
  async observe() {
    return await this.rba.call(this.sn, 'get_device_snapshot', {});
  }

  /**
   * Create a brief state summary for history (for logging only)
   */
  summarizeState(state) {
    return {
      app: state.foreground_package,
      nodes: state.ui_nodes?.count || 0,
      texts: state.screen_analysis?.textCount || 0
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default Agent;
