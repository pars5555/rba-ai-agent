import { parentPort, isMainThread } from 'worker_threads';

/**
 * Logger v2.0
 * - Cleaner formatting
 * - Better event emission
 */

let eventCallback = null;

export function setLogCallback(callback) {
  eventCallback = callback;
}

export function emit(type, data = {}) {
  const event = { type, timestamp: Date.now(), ...data };

  if (!isMainThread && parentPort) {
    parentPort.postMessage(event);
  } else if (eventCallback) {
    eventCallback(event);
  }
}

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

export function logApiCall(action, url, body = null) {
  emit('api_call', { action, url, bodyLength: body ? JSON.stringify(body).length : 0 });
}

export function logApiResponse(action, status, success) {
  emit('api_response', { action, status, success });
}

export function logApiError(action, status, error) {
  emit('api_error', { action, status, error });
}

export default {
  emit,
  log,
  logError,
  logApiCall,
  logApiResponse,
  logApiError,
  setLogCallback
};