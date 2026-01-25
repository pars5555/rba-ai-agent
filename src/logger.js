import { parentPort, isMainThread } from 'worker_threads';

/**
 * Centralized Logger
 * 
 * Works in both main thread and worker threads:
 * - Main thread: logs to console
 * - Worker thread: sends events to main thread via parentPort
 */

// Callback for custom event handling (used in main thread to broadcast to WebSocket)
let eventCallback = null;

/**
 * Set callback for log events (main thread only)
 * @param {function} callback - Called with (type, data) for each log event
 */
export function setLogCallback(callback) {
  eventCallback = callback;
}

/**
 * Emit a log event
 * In worker: sends to main thread via parentPort
 * In main: calls callback and/or logs to console
 */
export function emit(type, data = {}) {
  const event = { type, timestamp: Date.now(), ...data };
  
  if (!isMainThread && parentPort) {
    // Worker thread - send to main
    parentPort.postMessage(event);
  } else {
    // Main thread - call callback if set
    if (eventCallback) {
      eventCallback(event);
    }
  }
}

/**
 * Log a message
 */
export function log(message, taskId = null) {
  if (!isMainThread && parentPort) {
    emit('log', { message });
  } else {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = taskId ? `[${ts}] [${taskId.slice(0, 8)}]` : `[${ts}]`;
    console.log(`${prefix} ${message}`);
    if (eventCallback) {
      eventCallback({ type: 'log', timestamp: Date.now(), message, taskId });
    }
  }
}

/**
 * Log an error
 */
export function logError(message, taskId = null) {
  if (!isMainThread && parentPort) {
    emit('error', { message });
  } else {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = taskId ? `[${ts}] [${taskId.slice(0, 8)}]` : `[${ts}]`;
    console.error(`${prefix} ❌ ${message}`);
    if (eventCallback) {
      eventCallback({ type: 'error', timestamp: Date.now(), message, taskId });
    }
  }
}

/**
 * Log an API call
 */
export function logApiCall(action, url, body = null) {
  emit('api_call', { action, url, body: body ? JSON.stringify(body) : null, bodyLength: body ? JSON.stringify(body).length : 0 });
}

/**
 * Log an API response
 */
export function logApiResponse(action, status, success) {
  emit('api_response', { action, status, success });
}

/**
 * Log an API error
 */
export function logApiError(action, status, error) {
  emit('api_error', { action, status, error });
}

/**
 * Log an AI decision
 */
export function logAiDecision(step, action, params, reason, complete) {
  emit('ai_decision', { step, action, params, reason, complete });
}

/**
 * Log LLM call
 */
export function logLlmCall(historyLength, hasLastResult) {
  emit('llm_call', { historyLength, hasLastResult });
}

/**
 * Log LLM response
 */
export function logLlmResponse(action, complete, reason) {
  emit('llm_response', { action, complete, reason });
}

/**
 * Log LLM error
 */
export function logLlmError(error) {
  emit('llm_error', { error });
}

// Default export for convenience
export default {
  emit,
  log,
  logError,
  logApiCall,
  logApiResponse,
  logApiError,
  logAiDecision,
  logLlmCall,
  logLlmResponse,
  logLlmError,
  setLogCallback
};
