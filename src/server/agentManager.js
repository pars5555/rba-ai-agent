import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * AgentManager - Orchestrates worker threads (Minimal)
 */
class AgentManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workers = new Map();
    this.workerPath = path.join(__dirname, '..', 'agent', 'worker.js');
    this.getWorkerConfig = options.getWorkerConfig;
  }

  startTask(sn, task, options = {}) {
    const taskId = options.taskId || randomUUID();

    // Check if device busy
    for (const [id, info] of this.workers) {
      if (info.sn === sn && info.status === 'running') {
        return { success: false, error: 'Device busy', existingTaskId: id };
      }
    }

    const config = this.getWorkerConfig();
    const worker = new Worker(this.workerPath, {
      workerData: { sn, task, taskId, options, config }
    });

    const workerInfo = {
      worker,
      sn,
      task,
      taskId,
      status: 'running',
      startedAt: Date.now(),
      currentStep: 0,
      totalSteps: 0
    };

    this.workers.set(taskId, workerInfo);

    // Handle messages
    worker.on('message', (event) => {
      if (event.type === 'plan_created') {
        workerInfo.totalSteps = event.stepsCount;
        workerInfo.plan = event.steps;
      } else if (event.type === 'step_complete') {
        workerInfo.currentStep = event.step + 1;
      }
      
      this.logEvent(taskId, event);
      this.emit('event', { taskId, ...event });
    });

    worker.on('exit', (code) => {
      workerInfo.status = code === 0 ? 'completed' : 'failed';
      workerInfo.completedAt = Date.now();
      
      this.logEvent(taskId, { type: 'worker_exit', code });
      this.emit('event', { taskId, type: 'worker_exit', code });
    });

    worker.on('error', (error) => {
      workerInfo.status = 'error';
      this.logEvent(taskId, { type: 'worker_error', message: error.message });
      this.emit('event', { taskId, type: 'worker_error', message: error.message });
    });

    return { success: true, taskId, sn, task };
  }

  sendMessage(taskId, message) {
    const info = this.workers.get(taskId);
    if (!info || info.status !== 'running') return { success: false, error: 'Task not running' };
    info.worker.postMessage(message);
    return { success: true };
  }

  stopTask(taskId) {
    const info = this.workers.get(taskId);
    if (!info || info.status !== 'running') return { success: false, error: 'Task not running' };
    info.worker.postMessage({ type: 'stop' });
    return { success: true };
  }

  getStatus(taskId = null) {
    if (taskId) {
      const info = this.workers.get(taskId);
      if (!info) return null;
      return {
        taskId, sn: info.sn, task: info.task, status: info.status,
        currentStep: info.currentStep, totalSteps: info.totalSteps,
        startedAt: info.startedAt, completedAt: info.completedAt
      };
    }
    return Array.from(this.workers.values()).map(info => ({
      taskId: info.taskId, sn: info.sn, task: info.task, status: info.status,
      currentStep: info.currentStep, totalSteps: info.totalSteps
    }));
  }

  getRunningCount() {
    return Array.from(this.workers.values()).filter(w => w.status === 'running').length;
  }

  /**
   * Log event to console
   */
  logEvent(taskId, event) {
    const ts = new Date().toISOString().slice(11, 23);
    const id = taskId.slice(0, 8);

    switch (event.type) {
      case 'task_init':
        console.log(`[${ts}] [${id}] 📋 Task: "${event.task}" on ${event.sn}`);
        break;

      case 'task_start':
        console.log(`[${ts}] [${id}] 🚀 Starting (max ${event.maxSteps} actions, ${event.maxDuration/1000}s)`);
        break;

      case 'phase':
        console.log(`[${ts}] [${id}] ${event.phase === 'planning' ? '📋' : '🚀'} Phase: ${event.phase.toUpperCase()}`);
        break;

      case 'plan_created':
        console.log(`[${ts}] [${id}] 📋 Plan: ${event.stepsCount} steps`);
        event.steps?.forEach((s, i) => console.log(`[${ts}] [${id}]    ${i + 1}. ${s.description}`));
        break;

      case 'step_start':
        console.log(`[${ts}] [${id}] ── Step ${event.step + 1}/${event.total}: ${event.description} ──`);
        break;

      case 'step_complete':
        console.log(`[${ts}] [${id}] ✓ Step ${event.step + 1} complete`);
        break;

      case 'ai_decision':
        if (event.complete) {
          console.log(`[${ts}] [${id}]    🤖 COMPLETE: ${event.reason || ''}`);
        } else if (event.stepComplete) {
          console.log(`[${ts}] [${id}]    🤖 Step done: ${event.reason || ''}`);
        } else {
          console.log(`[${ts}] [${id}]    🤖 ${event.action}: ${event.reason || ''}`);
          if (event.params && Object.keys(event.params).length > 0) {
            console.log(`[${ts}] [${id}]       ${JSON.stringify(event.params)}`);
          }
        }
        break;

      case 'action_result':
        console.log(`[${ts}] [${id}]    ${event.success ? '✔' : '✗'} ${event.action}${event.error ? ': ' + event.error : ''}`);
        break;

      case 'api_call':
        console.log(`[${ts}] [${id}]    📤 ${event.action}`);
        break;

      case 'api_response':
        console.log(`[${ts}] [${id}]    📥 ${event.action}: ${event.success ? '✔' : '✗'}`);
        break;

      case 'log':
        console.log(`[${ts}] [${id}] ${event.message}`);
        break;

      case 'task_complete':
        console.log(`[${ts}] [${id}] 🏁 ${event.success ? 'SUCCESS' : 'FAILED'}: ${event.reason} (${event.steps} steps, ${event.totalActions} actions, ${event.elapsed}s)`);
        break;

      case 'timeout':
        console.log(`[${ts}] [${id}] ⏱️ Timeout after ${event.elapsed}s`);
        break;

      case 'fatal':
        console.log(`[${ts}] [${id}] ❌ Fatal: ${event.message}`);
        break;

      case 'worker_exit':
        console.log(`[${ts}] [${id}] 👋 Exit (code ${event.code})`);
        break;

      case 'worker_error':
        console.log(`[${ts}] [${id}] ❌ Worker error: ${event.message}`);
        break;
    }
  }
}

export default AgentManager;
