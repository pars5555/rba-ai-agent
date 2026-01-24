import RBAClient from './rba.js';
import LLMClient from './llm.js';
import { config } from './config.js';
import { randomUUID } from 'crypto';

/**
 * Simple Reactive Agent
 *
 * Just a bridge:
 * 1. Observe screen (get raw API response)
 * 2. Send to AI (AI analyzes everything)
 * 3. Execute AI's command
 * 4. Report/log
 * 5. Repeat
 *
 * NO task-related logic. AI decides everything.
 */
class Agent {
  constructor(deviceSerial) {
    this.sn = deviceSerial;
    this.rba = new RBAClient();
    this.llm = new LLMClient();
  }

  /**
   * Run a task
   */
  async run(task, options = {}) {
    const maxSteps = options.maxSteps || config.agent?.maxSteps || 25;
    const pauseMs = config.agent?.pauseBetweenSteps || 300;
    const taskId = options.taskId || randomUUID();

    const history = [];
    let step = 0;
    let completed = false;
    let fatalError = null;

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
      payload: { maxSteps, device: this.sn }
    });

    while (step < maxSteps && !completed && !fatalError) {
      step++;
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`📍 STEP ${step}/${maxSteps}`);

      // 1. OBSERVE - Get raw API response
      const state = await this.rba.call(this.sn, 'get_device_snapshot', {});

      // Only stop on fatal transport errors (device disconnected, auth failed)
      if (state._fatal) {
        fatalError = state._fatal;
        console.log(`❌ Fatal: ${fatalError.message}`);
        break;
      }

      console.log(`   📱 App: ${state.snapshot?.foreground_package || 'unknown'}`);

      // 2. DECIDE - AI analyzes raw state and decides next action
      let action;
      try {
        action = await this.llm.getNextAction(state, task, history);
        console.log(`   🤖 AI: ${action.action} - ${action.description || ''}`);
        if (action.reason) {
          console.log(`   💭 Reason: ${action.reason}`);
        }
      } catch (error) {
        console.error(`   ❌ LLM Error: ${error.message}`);
        fatalError = { type: 'llm_error', message: error.message };
        break;
      }

      // 3. CHECK COMPLETION (before executing)
      if (action.complete === true) {
        console.log(`\n✅ TASK COMPLETE: ${action.reason || 'AI marked as complete'}`);
        completed = true;
        history.push({ step, action, result: { success: true }, state: this.summarize(state) });
        break;
      }

      // 4. EXECUTE - Run AI's command
      const result = await this.rba.call(this.sn, action.action, action.params || {});

      // Only stop on fatal transport errors
      if (result._fatal) {
        fatalError = result._fatal;
        console.log(`   ❌ Fatal: ${fatalError.message}`);
        break;
      }

      // Log result
      const icon = result.success ? '✅' : '❌';
      console.log(`   ${icon} Result: ${result.success ? 'OK' : result.error || 'Failed'}`);

      // 5. RECORD
      history.push({
        step,
        action,
        result: { success: result.success, error: result.error },
        state: this.summarize(state)
      });

      // 6. REPORT
      await this.report({
        uuid: this.sn,
        task_id: taskId,
        type: 'process',
        task,
        step,
        payload: { action, result: { success: result.success, error: result.error } }
      });

      // Pause between steps
      if (pauseMs > 0) {
        await this.sleep(pauseMs);
      }
    }

    // Build final result
    const success = completed && !fatalError;
    const reason = fatalError ? 'fatal_error' :
                   completed ? 'completed' :
                   step >= maxSteps ? 'max_steps' : 'unknown';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🏁 AGENT ${success ? 'SUCCESS' : 'STOPPED'}`);
    console.log(`   Steps: ${step}`);
    console.log(`   Reason: ${reason}`);
    console.log(`${'═'.repeat(60)}\n`);

    const finalResult = { success, task, taskId, device: this.sn, steps: step, reason, history, fatalError };

    // Report done
    await this.report({
      uuid: this.sn,
      task_id: taskId,
      type: 'done',
      task,
      payload: finalResult
    });

    return finalResult;
  }

  async report(event) {
    try {
      await this.rba.reportEvent(event);
    } catch (e) {
      console.warn(`⚠️ Report failed: ${e.message}`);
    }
  }

  summarize(state) {
    return {
      app: state.snapshot?.foreground_package,
      success: state.success
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default Agent;