/**
 * Agent Utilities v1.1
 * 
 * Collection of helper functions used across the agent codebase.
 * Includes logging, error messages, response validation, and prompt building.
 * Keeping these separate makes the core files cleaner and focused on logic.
 */

import { parentPort, isMainThread } from 'worker_threads';

// ═══════════════════════════════════════════════════════════════
// LOGGING (level-based: verbose, debug, info, warning, error, fatal)
// ═══════════════════════════════════════════════════════════════

const LOG_LEVELS = { verbose: 0, debug: 1, info: 2, warning: 3, error: 4, fatal: 5 };
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_MAX_BODY_LOG_LENGTH = 500;

let eventCallback = null;
let loggingConfig = null;

export function setLogCallback(callback) {
  eventCallback = callback;
}

/** Set per-task logging config (called by worker at start). */
export function setLoggingConfig(cfg) {
  loggingConfig = cfg && typeof cfg === 'object' ? cfg : null;
}

export function getLoggingConfig() {
  if (loggingConfig) return loggingConfig;
  return { log_level: DEFAULT_LOG_LEVEL, maxBodyLogLength: DEFAULT_MAX_BODY_LOG_LENGTH };
}

function getLevelNum(level) {
  const n = LOG_LEVELS[String(level).toLowerCase()];
  return n !== undefined ? n : LOG_LEVELS.info;
}

function shouldLog(messageLevel) {
  const cfg = getLoggingConfig();
  const threshold = getLevelNum(cfg.log_level);
  return getLevelNum(messageLevel) >= threshold;
}

function truncateMessage(msg, maxLen) {
  const cfg = getLoggingConfig();
  const limit = typeof cfg.maxBodyLogLength === 'number' && cfg.maxBodyLogLength > 0 ? cfg.maxBodyLogLength : DEFAULT_MAX_BODY_LOG_LENGTH;
  const s = String(msg);
  if (s.length <= limit) return s;
  return s.substring(0, limit) + ` ... [truncated ${s.length - limit} chars]`;
}

export function emit(type, data = {}) {
  const event = { type, timestamp: Date.now(), ...data };

  if (!isMainThread && parentPort) {
    parentPort.postMessage(event);
  } else if (eventCallback) {
    eventCallback(event);
  }
}

/**
 * Log a message. Level defaults to 'info'. Only emits if message level >= config log_level.
 * Message is truncated to maxBodyLogLength.
 */
export function log(message, taskId = null, level = 'info') {
  if (!shouldLog(level)) return;
  const truncated = truncateMessage(message);
  if (!isMainThread && parentPort) {
    emit('log', { message: truncated });
  } else {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = taskId ? `[${ts}] [${taskId.slice(0, 8)}]` : `[${ts}]`;
    console.log(`${prefix} ${truncated}`);
    if (eventCallback) {
      eventCallback({ type: 'log', timestamp: Date.now(), message: truncated, taskId });
    }
  }
}

/**
 * Log an error. Level defaults to 'error'. Only emits if message level >= config log_level.
 */
export function logError(message, taskId = null, level = 'error') {
  if (!shouldLog(level)) return;
  const truncated = truncateMessage(message);
  if (!isMainThread && parentPort) {
    emit('error', { message: truncated });
  } else {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = taskId ? `[${ts}] [${taskId.slice(0, 8)}]` : `[${ts}]`;
    console.error(`${prefix} ❌ ${truncated}`);
    if (eventCallback) {
      eventCallback({ type: 'error', timestamp: Date.now(), message: truncated, taskId });
    }
  }
}

/** Emit api_call. When log_level is not 'verbose', body is omitted (only bodyLength). */
export function logApiCall(action, url, body = null, source = null) {
  const payload = { action, url, bodyLength: body ? JSON.stringify(body).length : 0, source };
  if (shouldLog('verbose') && body != null) {
    const cfg = getLoggingConfig();
    const maxLen = typeof cfg.maxBodyLogLength === 'number' ? cfg.maxBodyLogLength : DEFAULT_MAX_BODY_LOG_LENGTH;
    payload.body = typeof body === 'string' ? (body.length <= maxLen ? body : body.substring(0, maxLen) + ' ...') : body;
  }
  emit('api_call', payload);
}

function sanitizeForLog(obj, maxStringLen, depth = 0) {
  if (depth > 5) return '<deep>';
  if (obj == null) return obj;
  const maxLen = typeof maxStringLen === 'number' && maxStringLen > 0 ? maxStringLen : 500;
  if (typeof obj === 'string') {
    return obj.length <= maxLen ? obj : `<string ${obj.length} chars>`;
  }
  if (Array.isArray(obj)) {
    return obj.slice(0, 20).map((v) => sanitizeForLog(v, maxLen, depth + 1));
  }
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeForLog(v, maxLen, depth + 1);
    }
    return out;
  }
  return obj;
}

/** Emit api_response. When log_level is not 'verbose', response body is omitted. */
export function logApiResponse(action, status, success, source = null, responseData = null) {
  const payload = { action, status, success, source };
  if (responseData != null && shouldLog('verbose')) {
    const cfg = getLoggingConfig();
    const maxLen = typeof cfg.maxBodyLogLength === 'number' ? cfg.maxBodyLogLength : DEFAULT_MAX_BODY_LOG_LENGTH;
    payload.response = sanitizeForLog(responseData, maxLen);
  }
  emit('api_response', payload);
}

export function logApiError(action, status, error, source = null) {
  emit('api_error', { action, status, error, source });
}

/**
 * Create a logger with level methods. Uses config.logging if provided, else getLoggingConfig().
 * All messages truncated to maxBodyLogLength. Levels: verbose, debug, info, warning, error, fatal.
 */
export function createLogger(source, config = null) {
  const prefix = source ? `[${source}] ` : '';
  return {
    verbose: (msg, taskId = null) => log(prefix + msg, taskId, 'verbose'),
    debug: (msg, taskId = null) => log(prefix + msg, taskId, 'debug'),
    info: (msg, taskId = null) => log(prefix + msg, taskId, 'info'),
    warning: (msg, taskId = null) => log(prefix + msg, taskId, 'warning'),
    error: (msg, taskId = null) => logError(prefix + msg, taskId, 'error'),
    fatal: (msg, taskId = null) => logError(prefix + msg, taskId, 'fatal'),
    log: (message, taskId = null) => log(prefix + message, taskId, 'info'),
    logError: (message, taskId = null) => logError(prefix + message, taskId, 'error')
  };
}

// ═══════════════════════════════════════════════════════════════
// KNOWN APP NAMES
// ═══════════════════════════════════════════════════════════════

/**
 * Map of package names to human-readable app names
 */
export const KNOWN_APPS = {
  'com.android.chrome': 'Chrome browser',
  'com.brave.browser': 'Brave browser',
  'com.android.settings': 'Settings',
  'com.google.android.youtube': 'YouTube',
  'com.facebook.katana': 'Facebook',
  'com.instagram.android': 'Instagram',
  'com.whatsapp': 'WhatsApp',
  'com.twitter.android': 'Twitter',
  'com.google.android.gm': 'Gmail',
  'com.android.vending': 'Play Store',
  'com.android.launcher': 'Home screen',
  'com.android.launcher3': 'Home screen',
  'com.google.android.apps.nexuslauncher': 'Home screen'
};

/**
 * Get human-readable app name from package name
 * @param {string} packageName - Android package name
 * @returns {string} Human-readable name or original package name
 */
export function getAppName(packageName) {
  return KNOWN_APPS[packageName] || packageName;
}

// ═══════════════════════════════════════════════════════════════
// INSTALLED APPS VALIDATION
// ═══════════════════════════════════════════════════════════════

/** System/default apps: run_app is allowed without checking installed_apps. */
const SYSTEM_PACKAGES_ALLOWLIST = new Set([
  'com.android.settings',
  'com.android.dialer',
  'com.android.contacts',
  'com.android.mms',
  'com.google.android.apps.messaging',
  'com.android.phone',
  'com.android.server.telecom',
  'com.android.documentsui',
  'com.android.calendar',
  'com.android.gallery3d',
  'com.google.android.apps.photos',
  'com.android.camera',
  'com.android.camera2',
  'com.android.vending',
  'com.google.android.contacts',
  'com.google.android.dialer',
  'com.android.launcher',
  'com.android.launcher3',
  'com.google.android.apps.nbu.files',
  'com.android.soundrecorder',
]);

function isInstalledAppsUsable(val) {
  if (val == null) return false;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object' && !Array.isArray(val)) return Object.keys(val).length > 0;
  return false;
}

function hasPackage(installedApps, packageName) {
  if (Array.isArray(installedApps)) return installedApps.includes(packageName);
  if (installedApps && typeof installedApps === 'object') return Object.prototype.hasOwnProperty.call(installedApps, packageName);
  return false;
}

export function updateInstalledAppsFromSnapshot(snapshot, state) {
  if (!state) return;
  const apps = snapshot?.installed_apps;
  if (!apps) return;
  if (Array.isArray(apps) || (typeof apps === 'object' && apps !== null && !Array.isArray(apps))) {
    state.installedApps = apps;
  }
}

export function validateRunAppPackage(params, installedApps) {
  const packageName = params?.package_name;
  if (!packageName) {
    return {
      ok: false,
      error: {
        type: 'package_not_available',
        message: 'Package not available on device: (missing package_name)',
        package: null
      }
    };
  }

  if (SYSTEM_PACKAGES_ALLOWLIST.has(packageName)) {
    return { ok: true };
  }

  if (!isInstalledAppsUsable(installedApps)) {
    return {
      ok: false,
      error: {
        type: 'package_list_unavailable',
        message: 'installed_apps not available in snapshot. Run get_device_snapshot first.'
      }
    };
  }

  if (!hasPackage(installedApps, packageName)) {
    return {
      ok: false,
      error: {
        type: 'package_not_available',
        message: `Package not available on device: ${packageName}`,
        package: packageName
      }
    };
  }

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
// ERROR MESSAGES
// ═══════════════════════════════════════════════════════════════

/**
 * Generate human-understandable error message for text-to-speech
 * @param {object|null} fatalError - Fatal error object with type and message
 * @param {string} reason - Reason code (timeout, max_actions, completed, fatal_error)
 * @param {number} currentStep - Current step number
 * @param {number} totalSteps - Total number of steps
 * @returns {string} Human-readable error message
 */
export function getHumanErrorMessage(fatalError, reason, currentStep, totalSteps) {
  if (fatalError) {
    switch (fatalError.type) {
      case 'response_validation_error':
        return `I had to stop because the device gave an unexpected response. Some required data was missing: ${fatalError.missingProperties?.join(', ') || 'unknown properties'}.`;
      
      case 'device_unreachable':
        return `I had to stop because I lost connection to the device. The device may be disconnected or not responding.`;
      
      case 'auth_error':
        return `I had to stop because authentication failed. The API key may be invalid.`;
      
      case 'llm_error':
        return `I had to stop due to an AI processing error. ${fatalError.message || ''}`;
      
      default:
        return `I had to stop due to an error: ${fatalError.message || 'Unknown error occurred.'}`;
    }
  }
  
  switch (reason) {
    case 'timeout':
      return `I had to stop because the task took too long. I completed ${currentStep} out of ${totalSteps} steps before timing out.`;
    
    case 'max_actions':
      return `I had to stop because I reached the maximum number of actions allowed. I completed ${currentStep} out of ${totalSteps} steps.`;
    
    case 'completed':
      return `Task completed successfully. I finished all ${totalSteps} steps.`;
    
    default:
      return `Task ended with status: ${reason}.`;
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTRY VALIDATION
// ═══════════════════════════════════════════════════════════════

/** Set to false to disable registry validation (request + response) for debugging. */
export const REGISTRY_VALIDATION_ENABLED = true;

// ═══════════════════════════════════════════════════════════════
// RESPONSE VALIDATION
// ═══════════════════════════════════════════════════════════════

/**
 * Verify response data matches registry schema
 * @param {object} registry - Command registry
 * @param {string} action - Action name
 * @param {object} responseData - Response data from API
 * @returns {{ valid: boolean, missingProperties: string[] }}
 */
export function verifyResponse(registry, action, responseData) {
  const result = { valid: true, missingProperties: [], unexpectedProperties: [] };
  
  const cmd = registry?.[action];
  if (!cmd || !cmd.response) {
    return result; // No schema to validate against
  }
  // Skip schema validation for error responses; required fields (e.g. data, width, height) only apply when success is true
  if (responseData && responseData.success === false) {
    return result;
  }

  const checkSchema = (schema, data, path = '') => {
    if (!schema || typeof schema !== 'object') return;
    const hasDataObject = data && typeof data === 'object';
    
    for (const [key, def] of Object.entries(schema)) {
      const fullPath = path ? `${path}.${key}` : key;
      const isRequired = def.optional !== true && def.required !== false;
      
      if (isRequired) {
        if (!hasDataObject || !(key in data)) {
          result.missingProperties.push(fullPath);
          result.valid = false;
        }
      }
      
      // Recursively check nested objects (only if data exists and has the key)
      if (def.type === 'object' && def.properties && hasDataObject && data[key]) {
        checkSchema(def.properties, data[key], fullPath);
      }
    }

    // Do not fail on unexpected keys. API often adds metadata (action, code, am.checkout.rbamaster)
    // and device may return extra fields (e.g. closed_apps). We only enforce missing required.
  };

  checkSchema(cmd.response, responseData);
  return result;
}

/**
 * Validate request params against registry schema (missing/extra)
 * @param {object} registry - Command registry
 * @param {string} action - Action name
 * @param {object} params - Request params to send
 * @returns {{ valid: boolean, missingParameters: string[], unexpectedParameters: string[] }}
 */
export function validateRequestParams(registry, action, params) {
  const result = { valid: true, missingParameters: [], unexpectedParameters: [] };
  const cmd = registry?.[action];
  if (!cmd || !cmd.parameters) return result;

  const checkParams = (schema, data, path = '') => {
    if (!schema || typeof schema !== 'object') return;
    const hasDataObject = data && typeof data === 'object';

    for (const [key, def] of Object.entries(schema)) {
      const fullPath = path ? `${path}.${key}` : key;
      const isRequired = def.required === true;
      const hasDefault = Object.prototype.hasOwnProperty.call(def, 'default');
      if (isRequired && !hasDefault) {
        if (!hasDataObject || !(key in data)) {
          result.missingParameters.push(fullPath);
          result.valid = false;
        }
      }
      if (def.type === 'object' && def.properties && hasDataObject && data[key]) {
        checkParams(def.properties, data[key], fullPath);
      }
    }

    if (hasDataObject) {
      for (const key of Object.keys(data)) {
        if (!schema.hasOwnProperty(key)) {
          const fullPath = path ? `${path}.${key}` : key;
          result.unexpectedParameters.push(fullPath);
          result.valid = false;
        }
      }
    }
  };

  checkParams(cmd.parameters, params);
  return result;
}

/**
 * Check for fatal transport errors in response
 * @param {object} payload - Response payload
 * @returns {object|null} Fatal error object or null
 */
export function checkFatalError(payload) {
  const msg = String(payload?.message || payload?.error || '').toLowerCase();
  const fatalPatterns = [
    'device frp http not connected',
    'device not connected',
    'device unreachable',
    'connection refused',
    'econnrefused',
    'socket hang up'
  ];

  for (const pattern of fatalPatterns) {
    if (msg.includes(pattern)) {
      return { type: 'device_unreachable', message: msg };
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// RESPONSE ENRICHMENT (for RBA client)
// ═══════════════════════════════════════════════════════════════

/**
 * Validate response and add error metadata if validation fails
 * Combines fatal error check and schema validation into one call
 * @param {object} registry - Command registry
 * @param {string} action - Action name
 * @param {object} responseData - Response data from API
 * @returns {object} Response with _fatal or _responseValidationError if needed
 */
export function validateAndEnrichResponse(registry, action, responseData) {
  // Check for fatal errors first
  const fatal = checkFatalError(responseData);
  if (fatal) {
    return { ...responseData, _fatal: fatal };
  }

  if (REGISTRY_VALIDATION_ENABLED) {
    const validation = verifyResponse(registry, action, responseData);
    if (validation.missingProperties.length > 0) {
      return {
        ...responseData,
        _responseValidationError: {
          action,
          missingProperties: validation.missingProperties,
          message: `Response missing required properties: ${validation.missingProperties.join(', ')}`
        }
      };
    }
  }

  return responseData;
}

// ═══════════════════════════════════════════════════════════════
// LLM CALL WITH RETRY
// ═══════════════════════════════════════════════════════════════

/** ~20 s per step (LLM + device actions). Used to pick cache TTL. */
const ESTIMATED_SECONDS_PER_STEP = 20;
/** Threshold (seconds) above which we use 1h cache instead of 5m. */
const CACHE_TTL_THRESHOLD_SECONDS = 5 * 60; // 5 min

/**
 * Pick Anthropic cache TTL from plan length. Use 1h if estimated task duration > 5 min, else 5m.
 * @param {{ steps?: unknown[] }} plan - Execution plan with steps
 * @returns {'5m' | '1h'}
 */
export function getCacheTtlForExecution(plan) {
  const steps = plan?.steps;
  const n = Array.isArray(steps) && steps.length > 0 ? steps.length : 1;
  const estimatedSeconds = n * ESTIMATED_SECONDS_PER_STEP;
  return estimatedSeconds > CACHE_TTL_THRESHOLD_SECONDS ? '1h' : '5m';
}

/**
 * Call LLM API with automatic retry on rate limit
 * @param {object} options - Call options
 * @param {string} options.provider - 'openai' or 'anthropic'
 * @param {object} options.client - OpenAI or Anthropic client instance
 * @param {string} options.model - Model name
 * @param {string} options.systemPrompt - System prompt
 * @param {string} options.userPrompt - User prompt
 * @param {number} [options.temperature] - Optional; omit to use API default (some models only support default 1)
 * @param {'5m'|'1h'} [options.cacheTtl] - Anthropic only: cache TTL for system prompt ('5m' or '1h')
 * @param {number} options.retryCount - Current retry count (default 0)
 * @param {number} options.maxRetries - Max retries (default 3)
 * @returns {Promise<string>} LLM response content
 */
export async function callLLMWithRetry({ provider, client, model, systemPrompt, userPrompt, temperature, cacheTtl, retryCount = 0, maxRetries = 3 }) {
  try {
    if (provider === 'openai') {
      const body = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        response_format: { type: 'json_object' }
      };
      if (temperature !== undefined && temperature !== null && Number.isFinite(Number(temperature))) {
        body.temperature = Number(temperature);
      }
      const response = await client.chat.completions.create(body);

      if (response.usage) {
        log(`📊 Actual tokens - Prompt: ${response.usage.prompt_tokens}, Completion: ${response.usage.completion_tokens}, Total: ${response.usage.total_tokens}`);
      }

      return response.choices[0].message.content;
    } else {
      const body = {
        model,
        max_tokens: 1024,
        system: cacheTtl === '5m' || cacheTtl === '1h'
          ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: cacheTtl } }]
          : systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      };
      if (temperature !== undefined && temperature !== null && Number.isFinite(Number(temperature))) {
        body.temperature = Number(temperature);
      }
      const response = await client.messages.create(body);

      const u = response.usage;
      if (u) {
        const parts = [`Prompt: ${u.input_tokens ?? 0}`, `Completion: ${u.output_tokens ?? 0}`];
        const cr = u.cache_read_input_tokens ?? 0;
        const cc = u.cache_creation_input_tokens ?? 0;
        if (cr > 0 || cc > 0) {
          parts.push(`Cache read: ${cr}`, `Cache creation: ${cc}`);
        }
        log(`📊 Anthropic tokens - ${parts.join(', ')}`);
      }

      return response.content[0].text;
    }
  } catch (error) {
    // Retry on rate limit (429)
    if (error.status === 429 && retryCount < maxRetries) {
      const waitMatch = error.message.match(/try again in (\d+\.?\d*)s/i);
      const waitTime = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) : 5000;

      log(`⏳ Rate limited. Waiting ${waitTime}ms before retry ${retryCount + 1}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));

      return callLLMWithRetry({ provider, client, model, systemPrompt, userPrompt, temperature, cacheTtl, retryCount: retryCount + 1, maxRetries });
    }

    log(`❌ LLM Error: ${error.message}`);
    throw error;
  }
}

/**
 * Parse JSON from LLM response. Handles extra text before/after (e.g. Anthropic).
 * Tries: direct parse, strip ```json/``` blocks, extract first {...} via brace-matching.
 * @param {string} raw - Raw LLM response
 * @returns {object} Parsed object
 * @throws {Error} If no valid JSON found
 */
export function parseJsonFromLLM(raw) {
  if (raw == null || typeof raw !== 'string') {
    throw new Error('parseJsonFromLLM expects a string');
  }
  let s = raw.trim();

  function tryParse(str) {
    const t = String(str).trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  let parsed = tryParse(s);
  if (parsed != null) return parsed;

  const block = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) {
    parsed = tryParse(block[1]);
    if (parsed != null) return parsed;
  }

  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in LLM response');

  let depth = 0, inString = false, escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = false; continue; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        parsed = tryParse(slice);
        if (parsed != null) return parsed;
        throw new Error('Extracted {...} is not valid JSON');
      }
    }
  }
  throw new Error('No complete JSON object found in LLM response');
}

// ═══════════════════════════════════════════════════════════════
// TOKEN & TEXT UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Estimate token count (rough: 1 token ≈ 4 chars)
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text for logging while keeping important parts visible
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length (default 2000)
 * @returns {string} Truncated text
 */
export function truncateForLog(text, maxLength = 2000) {
  // Always show full prompt up to "Full result:" section
  const fullResultIdx = text.indexOf('Full result:');
  if (fullResultIdx !== -1 && fullResultIdx < maxLength) {
    // Show everything before "Full result:" + truncated result
    const beforeResult = text.substring(0, fullResultIdx + 13); // include "Full result:\n"
    const resultPart = text.substring(fullResultIdx + 13);
    
    if (resultPart.length > 500) {
      return beforeResult + resultPart.substring(0, 300) + `\n... [${resultPart.length - 500} chars truncated] ...\n` + resultPart.substring(resultPart.length - 200);
    }
    return text;
  }

  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + `\n... [truncated ${text.length - maxLength} chars]`;
}

// ═══════════════════════════════════════════════════════════════
// PROMPT BUILDING
// ═══════════════════════════════════════════════════════════════

/**
 * Build user prompt for LLM with step action history
 * @param {object} options - Prompt options
 * @param {string} options.task - Original task
 * @param {object} options.plan - Execution plan
 * @param {number} options.currentStepIndex - Current step (0-indexed)
 * @param {array} options.stepActions - Actions already taken in this step
 * @param {object|null} options.lastResult - Full result of last action
 * @param {string|null} options.interactiveMessage - Optional user message
 * @returns {string} Formatted prompt
 */
export function buildUserPrompt({ task, plan, currentStepIndex, stepActions, lastResult, interactiveMessage }) {
  let prompt = '';

  // Only include full TASK on first action of first step (to save tokens)
  const isFirstAction = currentStepIndex === 0 && stepActions.length === 0;
  if (isFirstAction) {
    prompt += `TASK: ${task}\n`;
  }

  // Interactive message if any
  if (interactiveMessage) {
    prompt += `\n💬 USER MESSAGE: "${interactiveMessage}"\n`;
  }

  // Plan with progress markers
  prompt += `\n═══ PLAN (${plan.steps.length} steps) ═══\n`;
  plan.steps.forEach((step, i) => {
    const marker = i < currentStepIndex ? '✓' : (i === currentStepIndex ? '▶' : '○');
    prompt += `${marker} ${i + 1}. ${step.description}\n`;
  });

  // CRITICAL: Warning about completed steps
  if (currentStepIndex > 0) {
    prompt += `\n⚠️ STEPS 1-${currentStepIndex} marked complete. Do NOT repeat them.\n`;
    prompt += `BUT: If the element you need to tap is near screen edge (cy<150 or cy>screen_height-200), SCROLL FIRST to center it before tapping!\n`;
  }

  // Current step
  prompt += `\n═══ CURRENT STEP: ${currentStepIndex + 1} of ${plan.steps.length} ═══\n`;
  prompt += `${plan.steps[currentStepIndex].description}\n`;
  if (plan.steps[currentStepIndex].verifyBy) {
    prompt += `Verify by: ${plan.steps[currentStepIndex].verifyBy}\n`;
  }

  // ACTION HISTORY FOR THIS STEP - CRITICAL FOR LOOP DETECTION
  if (stepActions.length > 0) {
    prompt += `\n═══ ACTIONS ALREADY TRIED IN THIS STEP (${stepActions.length}) ═══\n`;
    stepActions.forEach((a, i) => {
      const status = a.success ? '✓' : '✗';
      const params = a.params && Object.keys(a.params).length > 0 ? ` ${JSON.stringify(a.params)}` : '';
      prompt += `${i + 1}. [${status}] ${a.action}${params}\n`;
    });

    // Warning if many actions
    if (stepActions.length >= 5) {
      prompt += `\n⚠️ WARNING: ${stepActions.length} actions already tried! Consider marking stepComplete or reporting error.\n`;
    }
  }

  // Last result with key state extraction
  if (lastResult) {
    prompt += `\n═══ LAST ACTION RESULT ═══\n`;

    // Extract key info prominently
    if (lastResult.snapshot) {
      const snap = lastResult.snapshot;
      prompt += `📱 App: ${snap.foreground_package || 'unknown'}\n`;
      prompt += `📐 Screen: ${snap.screen_width}x${snap.screen_height}\n`;

      // Find focused element
      const nodes = snap.ui_nodes?.nodes || [];
      const focused = nodes.find(n => n.focused === true);
      if (focused) {
        prompt += `\n🎯 FOCUSED ELEMENT:\n`;
        prompt += `   Text: "${focused.text || ''}"\n`;
        prompt += `   Class: ${focused.class || 'unknown'}\n`;
        if (focused.bounds) {
          prompt += `   Center: (${focused.bounds.cx}, ${focused.bounds.cy})\n`;
        }
        prompt += `   Editable: ${focused.editable || false}\n`;
      }

      prompt += `UI Nodes: ${snap.ui_nodes?.count || nodes.length}\n`;
    }

    prompt += `\nFull result:\n${JSON.stringify(lastResult)}\n`;
  }

  prompt += `\nRespond with JSON only.`;
  return prompt;
}
