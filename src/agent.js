import RBAClient from './rba.js';
import LLMClient from './llm.js';
import { config } from './config.js';
import { randomUUID } from 'crypto';

/**
 * Get current timestamp string HH:MM:SS.mmm
 */
function ts() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * Pure Bridge Agent with TTS feedback
 *
 * Loop: Ask AI -> Speak reason -> Execute command -> Repeat
 *
 * AI controls ALL speech via the "reason" field.
 * AI provides debugging info via the "details" field.
 */
class Agent {
  constructor(deviceSerial) {
    this.sn = deviceSerial;
    this.rba = new RBAClient();
    this.llm = new LLMClient();
    this.isMuted = false;
  }

  log(msg) {
    console.log(`[${ts()}] ${msg}`);
  }

  logError(msg) {
    console.error(`[${ts()}] ${msg}`);
  }

  async run(task, options = {}) {
    const maxSteps = options.maxSteps || config.agent?.maxSteps || 100;
    const maxDurationSeconds = options.maxDurationSeconds || config.agent?.maxDurationSeconds || 300;
    const maxDurationMs = maxDurationSeconds * 1000;
    const taskId = options.taskId || randomUUID();
    const startTime = Date.now();

    // TTS options
    const speak = options.speak !== false; // enabled by default

    console.log(`\n${'═'.repeat(60)}`);
    this.log(`🤖 AGENT: "${task}"`);
    this.log(`   Device: ${this.sn} | Max: ${maxSteps} steps, ${maxDurationMs/1000}s`);
    this.log(`   TTS: ${speak ? 'ON' : 'OFF'}`);
    console.log(`${'═'.repeat(60)}`);

    await this.report({ uuid: this.sn, task_id: taskId, type: 'start', task });

    // Check initial mute status and unmute if TTS is enabled
    if (speak) {
      try {
        const snapshot = await this.rba.call(this.sn, 'get_device_snapshot', {});
        this.isMuted = snapshot?.snapshot?.is_muted || false;

        if (this.isMuted) {
          this.log(`   🔇 Device is muted, unmuting...`);
          await this.rba.call(this.sn, 'volume_mute', { mute: false });
          this.isMuted = false;
          this.log(`   🔊 Device unmuted`);
        }
      } catch (e) {
        this.isMuted = false;
      }
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
        this.log(`   ⏱️ Timeout: ${maxDurationMs/1000}s exceeded`);
        break;
      }
      step++;
      this.log(`\n── Step ${step} ──`);

      // Ask AI what to do
      let action;
      try {
        action = await this.llm.getNextAction(task, history, lastResult);

        // Log AI decision
        this.log(`   AI: ${action.action || 'complete'}${action.reason ? ' - ' + action.reason : ''}`);

        // Log details for debugging (if provided)
        if (action.details) {
          this.log(`   📋 Details: ${action.details}`);
        }
      } catch (error) {
        this.logError(`   ❌ LLM: ${error.message}`);
        fatalError = { type: 'llm_error', message: error.message };
        break;
      }

      // Speak AI's reason (fire-and-forget)
      if (speak && action.reason) {
        this.speak(action.reason);
      }

      // Check completion
      if (action.complete) {
        completed = true;
        break;
      }

      // Execute command
      const result = await this.rba.call(this.sn, action.action, action.params || {});
      lastResult = { action: action.action, params: action.params, ...result };

      if (result._fatal) {
        fatalError = result._fatal;
        this.log(`   ❌ Fatal: ${fatalError.message}`);
        break;
      }

      this.log(`   ${result.success ? '✓' : '✗'} ${result.success ? 'OK' : result.error || 'Failed'}`);

      history.push({ action: action.action, params: action.params, success: result.success });
      await this.report({ uuid: this.sn, task_id: taskId, type: 'process', step, payload: { action, success: result.success } });
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const success = completed && !fatalError && !timedOut;
    const reason = fatalError ? 'fatal_error' : timedOut ? 'timeout' : completed ? 'completed' : 'max_steps';

    console.log(`\n${'═'.repeat(60)}`);
    this.log(`🏁 ${success ? 'SUCCESS' : 'STOPPED'} (${step} steps, ${elapsed}s) - ${reason}`);
    console.log(`${'═'.repeat(60)}\n`);

    await this.report({ uuid: this.sn, task_id: taskId, type: 'done', payload: { success, steps: step, elapsed, reason } });
    return { success, task, taskId, steps: step, elapsed, reason, history, fatalError };
  }

  /**
   * Speak text on device via TTS (fire-and-forget)
   * @param {string} text - Text to speak
   * @param {number} speed - Speech rate (0.5-2.0), default 1.0
   */
  speak(text, speed = 1.0) {
    (async () => {
      try {
        if (this.isMuted) {
          await this.rba.call(this.sn, 'volume_mute', { mute: false });
          this.isMuted = false;
        }
        this.log(`   🔊 "${text}"`);
        await this.rba.call(this.sn, 'speak', { text, speed });
      } catch (e) {
        this.log(`   🔇 TTS failed: ${e.message}`);
      }
    })();
  }

  async report(event) {
    try { await this.rba.reportEvent(event); } catch (e) { }
  }
}

export default Agent;