import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * AgentManager v3.0
 */
class AgentManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workers = new Map();
    this.workerPath = path.join(__dirname, '..', 'agent', 'worker.js');
    this.getWorkerConfig = options.getWorkerConfig;
    // How long to keep completed/failed tasks in the list (default: 60 seconds)
    this.taskRetentionMs = options.taskRetentionMs || 60000;
  }

  startTask(sn, task, options = {}) {
    const taskId = options.taskId || randomUUID();

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
      worker, sn, task, taskId,
      status: 'running',
      startedAt: Date.now(),
      currentStep: 0,
      totalSteps: 0,
      totalActions: 0
    };

    this.workers.set(taskId, workerInfo);

    worker.on('message', (event) => {
      if (event.type === 'plan_created') {
        workerInfo.totalSteps = event.stepsCount;
      } else if (event.type === 'step_complete' || event.type === 'step_failed') {
        workerInfo.currentStep = event.step + 1;
      } else if (event.type === 'action_result') {
        workerInfo.totalActions = event.actionNum;
      }

      this.logEvent(taskId, event);
      this.emit('event', { taskId, ...event });
    });

    worker.on('exit', (code) => {
      workerInfo.status = code === 0 ? 'completed' : 'failed';
      workerInfo.completedAt = Date.now();
      this.logEvent(taskId, { type: 'worker_exit', code });
      this.emit('event', { taskId, type: 'worker_exit', code });
      
      // Schedule task removal after retention period
      this.scheduleTaskRemoval(taskId);
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
    if (!info || info.status !== 'running') return { success: false, error: 'Not running' };
    info.worker.postMessage(message);
    return { success: true };
  }

  stopTask(taskId) {
    const info = this.workers.get(taskId);
    if (!info || info.status !== 'running') return { success: false, error: 'Not running' };
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
        totalActions: info.totalActions,
        startedAt: info.startedAt, completedAt: info.completedAt
      };
    }
    return Array.from(this.workers.values()).map(info => ({
      taskId: info.taskId, sn: info.sn, task: info.task, status: info.status,
      currentStep: info.currentStep, totalSteps: info.totalSteps, totalActions: info.totalActions
    }));
  }

  getRunningCount() {
    return Array.from(this.workers.values()).filter(w => w.status === 'running').length;
  }

  /**
   * Schedule removal of a completed/failed task after retention period
   */
  scheduleTaskRemoval(taskId) {
    setTimeout(() => {
      const info = this.workers.get(taskId);
      if (info && info.status !== 'running') {
        this.workers.delete(taskId);
        this.emit('event', { taskId, type: 'task_removed' });
        console.log(`[cleanup] Removed task ${taskId.slice(0, 8)} from memory`);
      }
    }, this.taskRetentionMs);
  }

  /**
   * Manually remove a specific task
   */
  removeTask(taskId) {
    const info = this.workers.get(taskId);
    if (!info) return { success: false, error: 'Task not found' };
    if (info.status === 'running') return { success: false, error: 'Cannot remove running task' };
    this.workers.delete(taskId);
    return { success: true };
  }

  /**
   * Remove all completed/failed tasks
   */
  clearCompletedTasks() {
    let removed = 0;
    for (const [taskId, info] of this.workers) {
      if (info.status !== 'running') {
        this.workers.delete(taskId);
        removed++;
      }
    }
    return { success: true, removed };
  }

  logEvent(taskId, event) {
    const ts = new Date().toISOString().slice(11, 23);
    const id = taskId.slice(0, 8);
    const source = event.source || 'agentManager.js';
    const prefix = `[${ts}] [${id}] [${source}]`;

    switch (event.type) {
      case 'log':
        // Show all logs from worker - this is where user prompts, AI responses, etc. come from
        console.log(`${prefix} ${event.message}`);
        break;
      case 'error':
        console.log(`${prefix} ❌ ${event.message}`);
        break;
      case 'task_init':
        console.log(`${prefix} 🤖 Task: "${event.task}"`);
        break;
      case 'task_start':
        console.log(`${prefix} 🚀 Starting (max ${event.maxActions} actions)`);
        break;
      case 'llm_request':
        console.log(`${prefix} llm_request: ${JSON.stringify(event)}`);
        break;
      case 'api_call':
        console.log(`${prefix} api_call: ${JSON.stringify(event)}`);
        break;
      case 'api_response':
        console.log(`${prefix} api_response: ${JSON.stringify(event)}`);
        break;
      case 'api_error':
        console.log(`${prefix} api_error: ${JSON.stringify(event)}`);
        break;
      case 'phase':
        console.log(`${prefix} ${event.phase === 'planning' ? '📋' : '🚀'} ${event.phase.toUpperCase()}`);
        break;
      case 'plan_created':
        console.log(`${prefix} 📋 Plan: ${event.stepsCount} steps`);
        event.steps?.forEach((s, i) => console.log(`${prefix}    ${i + 1}. ${s.description}`));
        break;
      case 'step_start':
        console.log(`${prefix} ── Step ${event.step + 1}/${event.total}: ${event.description} ──`);
        break;
      case 'step_complete':
        console.log(`${prefix} ✓ Step ${event.step + 1} complete (${event.actionsUsed} actions)`);
        break;
      case 'step_failed':
        console.log(`${prefix} ❌ Step ${event.step + 1} failed: ${event.error}`);
        break;
      case 'ai_decision':
        if (event.complete) {
          console.log(`${prefix} ✅ COMPLETE: ${event.reason}`);
        } else if (event.stepComplete) {
          console.log(`${prefix} ✓ Step done: ${event.reason}`);
        } else if (event.error) {
          console.log(`${prefix} ❌ Error: ${event.error}`);
        } else {
          console.log(`${prefix} 🤖 ${event.action}: ${event.reason}`);
          if (event.params && Object.keys(event.params).length > 0) {
            console.log(`${prefix}    Params: ${JSON.stringify(event.params)}`);
          }
        }
        break;
      case 'speak':
        console.log(`${prefix} 🔊 "${event.text}"`);
        break;
      case 'action_result':
        console.log(`${prefix} ${event.success ? '✔' : '✗'} [${event.actionNum}] ${event.action}`);
        break;
      case 'task_complete':
        console.log(`${prefix} 🏁 ${event.success ? 'SUCCESS' : 'FAILED'}: ${event.reason} (${event.totalActions} actions, ${event.elapsed}s)`);
        if (event.fatalError) {
          console.log(`${prefix}    ❌ Error: ${JSON.stringify(event.fatalError)}`);
        }
        break;
      case 'timeout':
        console.log(`${prefix} ⏱️ Timeout`);
        break;
      case 'fatal':
        console.log(`${prefix} 💀 ${event.message}`);
        break;
      case 'worker_exit':
        console.log(`${prefix} 👋 Exit ${event.code}`);
        break;
    }
  }
}

export default AgentManager;