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
    this.workerPath = path.join(__dirname, '..', 'agent', 'worker.js');
    
    // Logging options
    this.verbose = options.verbose !== false;
    this.logApiBody = options.logApiBody || false;
    this.maxBodyLogLength = options.maxBodyLogLength || 500;
    
    // Function to get worker config (passed from server.js)
    this.getWorkerConfig = options.getWorkerConfig;
  }

  /**
   * Start a new agent task in a worker thread
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

    // Get full config to pass to worker
    const config = this.getWorkerConfig();
    
    const workerData = {
      sn,
      task,
      taskId,
      options,
      config  // Contains: rba, llm, agent, prompt, registry
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

    // Handle worker messages
    worker.on('message', (event) => {
      workerInfo.lastEvent = event;
      this.emit('event', { taskId, sn, ...event });
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
   * Send a message to a running agent
   */
  sendMessage(taskId, message) {
    const info = this.workers.get(taskId);
    if (!info) return { success: false, error: 'Task not found' };
    if (info.status !== 'running') return { success: false, error: `Task is ${info.status}` };
    info.worker.postMessage(message);
    return { success: true };
  }

  /**
   * Stop a running task
   */
  stopTask(taskId) {
    const info = this.workers.get(taskId);
    if (!info) return { success: false, error: 'Task not found' };
    if (info.status !== 'running') return { success: false, error: `Task is ${info.status}` };
    info.worker.terminate();
    info.status = 'stopped';
    info.completedAt = Date.now();
    return { success: true };
  }

  /**
   * Get status of all tasks or a specific task
   */
  getStatus(taskId = null) {
    if (taskId) {
      const info = this.workers.get(taskId);
      if (!info) return null;
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
   * Log event to console
   */
  logEvent(taskId, event) {
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
        if (this.verbose) {
          console.log(`[${ts}] [${shortId}] ${event.type}:`, JSON.stringify(event, null, 2));
        } else {
          console.log(`[${ts}] [${shortId}] ${event.type}`);
        }
    }
  }
}

export default AgentManager;
