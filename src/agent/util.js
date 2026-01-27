/**
 * Agent Utilities v1.1
 * 
 * Collection of helper functions used across the agent codebase.
 * Includes logging, error messages, response validation, and prompt building.
 * Keeping these separate makes the core files cleaner and focused on logic.
 */

import { parentPort, isMainThread } from 'worker_threads';

// ═══════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════

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

export function logApiCall(action, url, body = null, source = null) {
  emit('api_call', { action, url, bodyLength: body ? JSON.stringify(body).length : 0, source });
}

export function logApiResponse(action, status, success, source = null) {
  emit('api_response', { action, status, success, source });
}

export function logApiError(action, status, error, source = null) {
  emit('api_error', { action, status, error, source });
}

export function createLogger(source) {
  const prefix = source ? `[${source}] ` : '';
  return {
    log: (message, taskId = null) => log(`${prefix}${message}`, taskId),
    logError: (message, taskId = null) => logError(`${prefix}${message}`, taskId)
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

export function updateInstalledAppsFromSnapshot(snapshot, state) {
  if (!state) return;
  if (snapshot && Array.isArray(snapshot.installed_apps)) {
    state.installedApps = snapshot.installed_apps;
  }
}

export function validateRunAppPackage(params, installedApps) {
  if (!Array.isArray(installedApps) || installedApps.length === 0) {
    return {
      ok: false,
      error: {
        type: 'package_list_unavailable',
        message: 'installed_apps not available in snapshot. Run get_device_snapshot first.'
      }
    };
  }

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

  if (!installedApps.includes(packageName)) {
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
      case 'foreground_mismatch':
        return `I had to stop because the app I was working in is no longer open. I expected to be in ${getAppName(fatalError.expected)} but found ${getAppName(fatalError.actual)} instead. The app may have crashed or been closed.`;
      
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
  const result = { valid: true, missingProperties: [] };
  
  const cmd = registry?.[action];
  if (!cmd || !cmd.response) {
    return result; // No schema to validate against
  }

  const checkRequired = (schema, data, path = '') => {
    if (!schema || typeof schema !== 'object') return;
    
    for (const [key, def] of Object.entries(schema)) {
      const fullPath = path ? `${path}.${key}` : key;
      
      // Check if this property is required
      if (def.required === true) {
        if (data === null || data === undefined || !(key in data)) {
          result.missingProperties.push(fullPath);
          result.valid = false;
        }
      }
      
      // Recursively check nested objects (only if data exists and has the key)
      if (def.type === 'object' && def.properties && data && data[key]) {
        checkRequired(def.properties, data[key], fullPath);
      }
    }
  };

  checkRequired(cmd.response, responseData);
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

  // Verify response matches registry schema
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

  return responseData;
}

// ═══════════════════════════════════════════════════════════════
// LLM CALL WITH RETRY
// ═══════════════════════════════════════════════════════════════

/**
 * Call LLM API with automatic retry on rate limit
 * @param {object} options - Call options
 * @param {string} options.provider - 'openai' or 'anthropic'
 * @param {object} options.client - OpenAI or Anthropic client instance
 * @param {string} options.model - Model name
 * @param {string} options.systemPrompt - System prompt
 * @param {string} options.userPrompt - User prompt
 * @param {number} options.retryCount - Current retry count (default 0)
 * @param {number} options.maxRetries - Max retries (default 3)
 * @returns {Promise<string>} LLM response content
 */
export async function callLLMWithRetry({ provider, client, model, systemPrompt, userPrompt, retryCount = 0, maxRetries = 3 }) {
  try {
    if (provider === 'openai') {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      });

      if (response.usage) {
        log(`📊 Actual tokens - Prompt: ${response.usage.prompt_tokens}, Completion: ${response.usage.completion_tokens}, Total: ${response.usage.total_tokens}`);
      }

      return response.choices[0].message.content;
    } else {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });
      return response.content[0].text;
    }
  } catch (error) {
    // Retry on rate limit (429)
    if (error.status === 429 && retryCount < maxRetries) {
      const waitMatch = error.message.match(/try again in (\d+\.?\d*)s/i);
      const waitTime = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) : 5000;
      
      log(`⏳ Rate limited. Waiting ${waitTime}ms before retry ${retryCount + 1}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      return callLLMWithRetry({ provider, client, model, systemPrompt, userPrompt, retryCount: retryCount + 1, maxRetries });
    }
    
    log(`❌ LLM Error: ${error.message}`);
    throw error;
  }
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
