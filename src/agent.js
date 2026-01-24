import RBAClient from './rba.js';
import LLMClient from './llm.js';
import { config } from './config.js';
import { randomUUID } from 'crypto';

/**
 * Pure Bridge Agent with TTS feedback
 *
 * Loop: Ask AI -> Speak description -> Execute command -> Repeat
 */
class Agent {
  constructor(deviceSerial) {
    this.sn = deviceSerial;
    this.rba = new RBAClient();
    this.llm = new LLMClient();
  }

  async run(task, options = {}) {
    const maxSteps = options.maxSteps || config.agent?.maxSteps || 100;
    const maxDurationSeconds = options.maxDurationSeconds || config.agent?.maxDurationSeconds || 300;
    const maxDurationMs = maxDurationSeconds * 1000;
    const taskId = options.taskId || randomUUID();
    const startTime = Date.now();

    // TTS options
    const speak = options.speak !== false; // enabled by default
    const speakLang = options.speakLang || 'en';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🤖 AGENT: "${task}"`);
    console.log(`   Device: ${this.sn} | Max: ${maxSteps} steps, ${maxDurationMs/1000}s`);
    console.log(`   TTS: ${speak ? 'ON' : 'OFF'}${speak ? ` (${speakLang})` : ''}`);
    console.log(`${'═'.repeat(60)}`);

    await this.report({ uuid: this.sn, task_id: taskId, type: 'start', task });

    // Announce task start
    if (speak) {
      await this.speak(`Starting task: ${task}`);
    }

    const history = [];
    let lastResult = null;
    let step = 0;
    let completed = false;
    let fatalError = null;
    let timedOut = false;

    while (step < maxSteps && !completed && !fatalError && !timedOut) {
      // Check timeout
      if (Date.now() - startTime > maxDurationMs) {
        timedOut = true;
        console.log(`   ⏱️ Timeout: ${maxDurationMs/1000}s exceeded`);
        if (speak) await this.speak('Task timed out');
        break;
      }
      step++;
      console.log(`\n── Step ${step} ──`);

      // Ask AI what to do
      let action;
      try {
        action = await this.llm.getNextAction(task, history, lastResult);
        console.log(`   AI: ${action.action || 'complete'} ${action.reason ? '- ' + action.reason : ''}`);
      } catch (error) {
        console.error(`   ❌ LLM: ${error.message}`);
        fatalError = { type: 'llm_error', message: error.message };
        if (speak) await this.speak('AI error occurred');
        break;
      }

      // Check completion
      if (action.complete) {
        completed = true;
        if (speak && action.reason) {
          await this.speak(action.reason);
        }
        break;
      }

      // Speak the description/reason before executing
      if (speak && action.reason) {
        await this.speak(action.reason);
      }

      // Execute command
      const result = await this.rba.call(this.sn, action.action, action.params || {});
      lastResult = { action: action.action, params: action.params, ...result };

      if (result._fatal) {
        fatalError = result._fatal;
        console.log(`   ❌ Fatal: ${fatalError.message}`);
        if (speak) await this.speak('Fatal error: ' + fatalError.message);
        break;
      }

      console.log(`   ${result.success ? '✓' : '✗'} ${result.success ? 'OK' : result.error || 'Failed'}`);

      // Speak failure if action failed
      if (!result.success && speak) {
        await this.speak(`Failed: ${result.error || 'unknown error'}`);
      }

      history.push({ action: action.action, params: action.params, success: result.success });
      await this.report({ uuid: this.sn, task_id: taskId, type: 'process', step, payload: { action, success: result.success } });
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const success = completed && !fatalError && !timedOut;
    const reason = fatalError ? 'fatal_error' : timedOut ? 'timeout' : completed ? 'completed' : 'max_steps';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🏁 ${success ? 'SUCCESS' : 'STOPPED'} (${step} steps, ${elapsed}s) - ${reason}`);
    console.log(`${'═'.repeat(60)}\n`);

    // Announce completion
    if (speak) {
      const msg = success ? 'Task completed successfully' : `Task stopped: ${reason}`;
      await this.speak(msg);
    }

    await this.report({ uuid: this.sn, task_id: taskId, type: 'done', payload: { success, steps: step, elapsed, reason } });
    return { success, task, taskId, steps: step, elapsed, reason, history, fatalError };
  }

  /**
   * Speak text on device via TTS
   */
  async speak(text) {
    try {
      console.log(`   🔊 "${text}"`);
      await this.rba.call(this.sn, 'speak', { text });
    } catch (e) {
      // Silent fail - don't break main flow
      console.log(`   🔇 TTS failed: ${e.message}`);
    }
  }

  async report(event) {
    try { await this.rba.reportEvent(event); } catch (e) { }
  }
}

export default Agent;