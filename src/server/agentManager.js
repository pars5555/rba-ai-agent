import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * AgentManager - Orchestrates agent workers (Task Planner Architecture)
 * 
 * Responsibilities:
 * - Spawn worker threads for agent tasks
 * - Track running workers by taskId
 * - Receive and broadcast events from workers (including plan events)
 * - Allow interactive communication with running agents
 */
class AgentManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workers = new Map(); // taskId -> { worker, sn, task, startedAt, status, plan, currentStep }
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
      config  // Contains: rba, llm, agent, planningPrompt, executionPrompt, registry
    };

    const worker = new Worker(this.workerPath, { workerData });

    const workerInfo = {
      worker,
      sn,
      task,
      taskId,
      startedAt: Date.now(),
      status: 'running',
      phase: 'initializing',
      plan: null,
      currentStep: 0,
      totalSteps: 0,
      lastEvent: null
    };

    this.workers.set(taskId, workerInfo);

    // Handle worker messages
    worker.on('message', (event) => {
      workerInfo.lastEvent = event;
      
      // Track plan and progress
      if (event.type === 'plan_created') {
        workerInfo.plan = event.steps;
        workerInfo.totalSteps = event.stepsCount;
        workerInfo.phase = 'executing';
      } else if (event.type === 'phase') {
        workerInfo.phase = event.phase;
      } else if (event.type === 'step_complete') {
        workerInfo.currentStep = event.stepIndex + 1;
      }
      
      this.emit('event', { taskId, sn, ...event });
      this.logEvent(taskId, event);
    });

    // Handle worker exit
    worker.on('exit', (code) => {
      workerInfo.status = code === 0 ? 'completed' : 'failed';
      workerInfo.exitCode = code;
      workerInfo.completedAt = Date.now();
      workerInfo.phase = 'finished';

      this.emit('event', {
        taskId,
        sn,
        type: 'worker_exit',
        code,
        elapsed: workerInfo.completedAt - workerInfo.startedAt,
        completedSteps: workerInfo.currentStep,
        totalSteps: workerInfo.totalSteps
      });

      // Clean up after 1 hour
      setTimeout(() => {
        //todo dont clean all workers, we should clean the workers that stuck only
        //this.workers.delete(taskId);
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
        phase: info.phase,
        currentStep: info.currentStep,
        totalSteps: info.totalSteps,
        plan: info.plan,
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
        phase: info.phase,
        currentStep: info.currentStep,
        totalSteps: info.totalSteps,
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

      // Task Planner specific events
      case 'phase':
        const phaseEmoji = event.phase === 'planning' ? '📋' : '🚀';
        console.log(`[${ts}] [${shortId}] ${phaseEmoji} Phase: ${event.phase.toUpperCase()}`);
        break;

      case 'plan_created':
        console.log(`[${ts}] [${shortId}] 📋 Plan created with ${event.stepsCount} steps:`);
        event.steps?.forEach((step, i) => {
          console.log(`[${ts}] [${shortId}]    ${i + 1}. ${step.description}`);
        });
        break;

      case 'step_start':
        console.log(`[${ts}] [${shortId}] ── Step ${event.stepIndex + 1}/${event.totalSteps}: ${event.description} ──`);
        if (event.actionNumber) {
          console.log(`[${ts}] [${shortId}]    (Action ${event.actionNumber}/${event.maxActions})`);
        }
        break;

      case 'step_complete':
        console.log(`[${ts}] [${shortId}] ✓ Step ${event.stepIndex + 1} complete: ${event.description}`);
        break;

      case 'action_result':
        console.log(`[${ts}] [${shortId}]    ${event.success ? '✔' : '✗'} ${event.action}${event.error ? ': ' + event.error : ''}`);
        break;

      case 'ai_decision':
        if (event.complete) {
          console.log(`[${ts}] [${shortId}]    🤖 AI: TASK COMPLETE${event.reason ? ' - ' + event.reason : ''}`);
        } else if (event.stepComplete) {
          console.log(`[${ts}] [${shortId}]    🤖 AI: Step complete${event.reason ? ' - ' + event.reason : ''}`);
        } else {
          console.log(`[${ts}] [${shortId}]    🤖 AI: ${event.action}${event.reason ? ' - ' + event.reason : ''}`);
          if (event.params && Object.keys(event.params).length > 0) {
            console.log(`[${ts}] [${shortId}]       Params: ${JSON.stringify(event.params)}`);
          }
        }
        if (event.details) {
          console.log(`[${ts}] [${shortId}]       Details: ${event.details}`);
        }
        break;

      // Original events (backward compatible)
      case 'step_result':
        console.log(`[${ts}] [${shortId}]    ${event.success ? '✔' : '✗'} ${event.action}${event.error ? ': ' + event.error : ''}`);
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
        console.log(`[${ts}] [${shortId}]    📥 ${event.action}: ${event.success ? '✔' : '✗'} (${event.status})`);
        break;

      case 'api_error':
        console.log(`[${ts}] [${shortId}]    ❌ API Error: ${event.error}`);
        break;

      case 'llm_call':
        console.log(`[${ts}] [${shortId}]    💭 LLM call (step: ${event.historyLength})`);
        break;

      case 'llm_response':
        console.log(`[${ts}] [${shortId}]    💭 LLM: ${event.action || 'complete'}${event.complete ? ' ✔DONE' : ''}`);
        break;

      case 'llm_error':
        console.log(`[${ts}] [${shortId}]    ❌ LLM Error: ${event.error}`);
        break;

      case 'task_init':
        console.log(`[${ts}] [${shortId}] 📋 Task: "${event.task}" on ${event.sn}`);
        break;

      case 'task_start':
        console.log(`[${ts}] [${shortId}] 🚀 Starting (max ${event.maxSteps} actions, ${event.maxDuration/1000}s)`);
        break;

      case 'task_complete':
        const steps = event.completedSteps !== undefined 
          ? `${event.completedSteps}/${event.totalSteps} steps`
          : `${event.steps} steps`;
        console.log(`[${ts}] [${shortId}] 🏁 ${event.success ? 'SUCCESS' : 'FAILED'}: ${event.reason} (${steps}, ${event.elapsed}s)`);
        break;

      case 'timeout':
        console.log(`[${ts}] [${shortId}] ⏱️ Timeout after ${event.elapsed}ms (at step ${event.atStep + 1})`);
        break;

      case 'fatal':
        console.log(`[${ts}] [${shortId}] 💀 Fatal: ${event.message}`);
        break;

      case 'worker_exit':
        console.log(`[${ts}] [${shortId}] 👋 Worker exit (code: ${event.code}, ${event.completedSteps}/${event.totalSteps} steps)`);
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
