import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * AgentManager - Orchestrates agent workers
 * 
 * Responsibilities:
 * - Spawn worker threads for agent tasks
 * - Track running workers by taskId
 * - Receive and broadcast events from workers
 * - Allow interactive communication with running agents
 */
class AgentManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workers = new Map(); // taskId -> { worker, sn, task, startedAt, status }
    // Worker is in ../agent/worker.js relative to this file
    this.workerPath = path.join(__dirname, '..', 'agent', 'worker.js');
    
    // Logging options
    this.verbose = options.verbose !== false; // true by default
    this.logApiBody = options.logApiBody || false; // false by default (can be large)
    this.maxBodyLogLength = options.maxBodyLogLength || 500; // truncate body logs
  }

  /**
   * Start a new agent task in a worker thread
   * @param {string} sn - Device serial number
   * @param {string} task - Task description
   * @param {object} options - Task options (maxSteps, speak, etc.)
   * @returns {object} - { taskId, success }
   */
  startTask(sn, task, options = {}) {
    const taskId = options.taskId || randomUUID();

    // Check if device already has a running task
    for (const [existingTaskId, info] of this.workers) {
      if (info.sn === sn && info.status === 'running') {
        return {
          success: false,
          error: `Device ${sn} already has a running task: ${existingTaskId}`,
          existingTaskId
        };
      }
    }

    const workerData = {
      sn,
      task,
      taskId,
      options
    };

    const worker = new Worker(this.workerPath, { workerData });

    const workerInfo = {
      worker,
      sn,
      task,
      taskId,
      startedAt: Date.now(),
      status: 'running',
      lastEvent: null
    };

    this.workers.set(taskId, workerInfo);

    // Handle worker messages (events from agent)
    worker.on('message', (event) => {
      workerInfo.lastEvent = event;
      this.emit('event', { taskId, sn, ...event });

      // Log to console
      this.logEvent(taskId, event);
    });

    // Handle worker exit
    worker.on('exit', (code) => {
      workerInfo.status = code === 0 ? 'completed' : 'failed';
      workerInfo.exitCode = code;
      workerInfo.completedAt = Date.now();

      this.emit('event', {
        taskId,
        sn,
        type: 'worker_exit',
        code,
        elapsed: workerInfo.completedAt - workerInfo.startedAt
      });

      // Clean up after 1 hour
      setTimeout(() => {
        this.workers.delete(taskId);
      }, 3600000);
    });

    // Handle worker errors
    worker.on('error', (error) => {
      workerInfo.status = 'error';
      workerInfo.error = error.message;

      this.emit('event', {
        taskId,
        sn,
        type: 'error',
        message: error.message
      });
    });

    this.emit('event', {
      taskId,
      sn,
      type: 'started',
      task
    });

    return { success: true, taskId, sn, task };
  }

  /**
   * Send a message to a running agent (for interactive communication)
   * @param {string} taskId - Task ID
   * @param {object} message - Message to send
   */
  sendMessage(taskId, message) {
    const info = this.workers.get(taskId);
    if (!info) {
      return { success: false, error: 'Task not found' };
    }
    if (info.status !== 'running') {
      return { success: false, error: `Task is ${info.status}` };
    }

    info.worker.postMessage(message);
    return { success: true };
  }

  /**
   * Stop a running task
   * @param {string} taskId - Task ID
   */
  stopTask(taskId) {
    const info = this.workers.get(taskId);
    if (!info) {
      return { success: false, error: 'Task not found' };
    }
    if (info.status !== 'running') {
      return { success: false, error: `Task is ${info.status}` };
    }

    info.worker.terminate();
    info.status = 'stopped';
    info.completedAt = Date.now();

    return { success: true };
  }

  /**
   * Get status of all tasks or a specific task
   * @param {string} taskId - Optional task ID
   */
  getStatus(taskId = null) {
    if (taskId) {
      const info = this.workers.get(taskId);
      if (!info) {
        return null;
      }
      return {
        taskId,
        sn: info.sn,
        task: info.task,
        status: info.status,
        startedAt: info.startedAt,
        completedAt: info.completedAt,
        elapsed: info.completedAt 
          ? info.completedAt - info.startedAt 
          : Date.now() - info.startedAt
      };
    }

    // Return all tasks
    const tasks = [];
    for (const [id, info] of this.workers) {
      tasks.push({
        taskId: id,
        sn: info.sn,
        task: info.task,
        status: info.status,
        startedAt: info.startedAt,
        completedAt: info.completedAt,
        elapsed: info.completedAt 
          ? info.completedAt - info.startedAt 
          : Date.now() - info.startedAt
      });
    }
    return tasks;
  }

  /**
   * Get running tasks count
   */
  getRunningCount() {
    let count = 0;
    for (const info of this.workers.values()) {
      if (info.status === 'running') count++;
    }
    return count;
  }

  /**
   * Log event to console with formatting
   * @param {boolean} verbose - If true, print full event data
   */
  logEvent(taskId, event, verbose = true) {
    const ts = new Date().toISOString().slice(11, 23);
    const shortId = taskId.slice(0, 8);

    switch (event.type) {
      case 'log':
        console.log(`[${ts}] [${shortId}] ${event.message}`);
        break;
      case 'step_start':
        console.log(`[${ts}] [${shortId}] ── Step ${event.step}/${event.maxSteps} ──`);
        break;
      case 'step_result':
        console.log(`[${ts}] [${shortId}]    ${event.success ? '✓' : '✗'} ${event.action}${event.error ? ': ' + event.error : ''}`);
        break;
      case 'ai_decision':
        console.log(`[${ts}] [${shortId}]    🤖 AI: ${event.action || 'complete'}${event.reason ? ' - ' + event.reason : ''}`);
        if (event.params && Object.keys(event.params).length > 0) {
          console.log(`[${ts}] [${shortId}]       Params: ${JSON.stringify(event.params)}`);
        }
        if (event.details) {
          console.log(`[${ts}] [${shortId}]       Details: ${event.details}`);
        }
        break;
      case 'api_call':
        console.log(`[${ts}] [${shortId}]    📤 ${event.action} → ${event.url}`);
        if (this.logApiBody && event.body) {
          const bodyDisplay = event.body.length > this.maxBodyLogLength 
            ? event.body.slice(0, this.maxBodyLogLength) + `... (${event.bodyLength} chars)`
            : event.body;
          console.log(`[${ts}] [${shortId}]       Body: ${bodyDisplay}`);
        }
        break;
      case 'api_response':
        console.log(`[${ts}] [${shortId}]    📥 ${event.action}: ${event.success ? '✓' : '✗'} (${event.status})`);
        break;
      case 'api_error':
        console.log(`[${ts}] [${shortId}]    ❌ API Error: ${event.error}`);
        break;
      case 'llm_call':
        console.log(`[${ts}] [${shortId}]    💭 LLM call (history: ${event.historyLength})`);
        break;
      case 'llm_response':
        console.log(`[${ts}] [${shortId}]    💭 LLM: ${event.action || 'complete'}${event.complete ? ' ✓DONE' : ''}`);
        break;
      case 'llm_error':
        console.log(`[${ts}] [${shortId}]    ❌ LLM Error: ${event.error}`);
        break;
      case 'task_init':
        console.log(`[${ts}] [${shortId}] 📋 Task: "${event.task}" on ${event.sn}`);
        break;
      case 'task_start':
        console.log(`[${ts}] [${shortId}] 🚀 Starting (max ${event.maxSteps} steps, ${event.maxDuration/1000}s)`);
        break;
      case 'task_complete':
        console.log(`[${ts}] [${shortId}] 🏁 ${event.success ? 'SUCCESS' : 'FAILED'}: ${event.reason} (${event.steps} steps, ${event.elapsed}s)`);
        break;
      case 'timeout':
        console.log(`[${ts}] [${shortId}] ⏱️ Timeout after ${event.elapsed}ms`);
        break;
      case 'fatal':
        console.log(`[${ts}] [${shortId}] 💀 Fatal: ${event.message}`);
        break;
      case 'worker_exit':
        console.log(`[${ts}] [${shortId}] 👋 Worker exit (code: ${event.code})`);
        break;
      case 'error':
        console.log(`[${ts}] [${shortId}] ❌ ${event.message}`);
        break;
      default:
        // For unknown events, print full data if verbose
        if (verbose) {
          console.log(`[${ts}] [${shortId}] ${event.type}:`, JSON.stringify(event, null, 2));
        } else {
          console.log(`[${ts}] [${shortId}] ${event.type}`);
        }
    }
  }
}

export default AgentManager;
