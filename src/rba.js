import axios from 'axios';
import { config, registry } from './config.js';

/**
 * Simplified RBA API Client
 * - Single generic method to call any command from registry
 * - Response validation against registry schema
 * - Agent event reporting to server
 */
class RBAClient {
  constructor() {
    this.baseURL = config.rba.apiBaseUrl;
    this.apiKey = config.rba.apiKey;
    
    if (!this.apiKey) {
      console.warn('⚠️  RBA API key not set in config');
    }
  }

  /**
   * Execute any command from the registry
   * @param {string} sn - Device serial number
   * @param {string} action - Action name from registry
   * @param {object} params - Action parameters
   * @returns {Promise<object>} API response
   */
  async call(sn, action, params = {}) {
    // Handle local actions (like wait)
    if (action === 'wait') {
      const ms = params.ms || 1000;
      await this.sleep(ms);
      return { success: true, action: 'wait', waited_ms: ms };
    }

    // Get command definition from registry
    const cmd = registry[action];
    if (!cmd) {
      return { success: false, error: `Unknown action: ${action}`, _validationError: true };
    }

    if (!cmd.endpoint) {
      return { success: false, error: `Action "${action}" has no endpoint defined`, _validationError: true };
    }

    if (cmd.safe === false) {
      return { success: false, error: `Action "${action}" is not safe for AI use`, _validationError: true };
    }

    // Validate required parameters
    const paramErrors = this.validateParams(action, params, cmd.parameters);
    if (paramErrors.length > 0) {
      const errorMsg = `Missing required params for ${action}: ${paramErrors.join(', ')}`;
      console.error(`   ❌ ${errorMsg}`);
      return { 
        success: false, 
        error: errorMsg, 
        _validationError: true,
        missingParams: paramErrors
      };
    }

    // Build request body
    const body = { uuid: sn, ...params };

    try {
      const url = `${this.baseURL}${cmd.endpoint}`;
      
      // Log request
      console.log(`📤 ${action}`);
      console.log(`   URL: ${url}`);
      console.log(`   Body: ${JSON.stringify(body).slice(0, 200)}${JSON.stringify(body).length > 200 ? '...' : ''}`);

      const response = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 30000
      });

      // Log response (compact)
      const respStr = JSON.stringify(response.data);
      console.log(`   ← ${response.status}: ${respStr.length > 150 ? respStr.slice(0, 150) + '...' : respStr}`);

      // Check for fatal errors (device unreachable, etc.)
      const fatal = this.checkFatal(response.data);
      if (fatal) {
        return { ...response.data, success: false, _fatal: fatal };
      }

      // Validate response against schema
      const responseErrors = this.validateResponse(action, response.data, cmd.response);
      if (responseErrors.length > 0) {
        console.warn(`   ⚠️ Response validation: ${responseErrors.join(', ')}`);
        return {
          ...response.data,
          _responseValidation: {
            valid: false,
            errors: responseErrors
          }
        };
      }

      return response.data;

    } catch (error) {
      const status = error.response?.status;
      const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
      console.error(`   ← ❌ HTTP ${status || 'ERR'}: ${errorMsg}`);
      
      if (status === 401) {
        console.error(`   ⚠️  Authentication failed. Check your API key in config/local_config.json`);
        return { success: false, error: 'Authentication failed (401)', _fatal: { fatal: true, type: 'auth_error', message: 'Invalid or missing API key' } };
      }

      // Check for fatal transport errors
      const fatal = this.checkFatal({ message: error.message });
      if (fatal) {
        return { success: false, error: errorMsg, _fatal: fatal };
      }

      return { success: false, error: errorMsg, httpStatus: status };
    }
  }

  /**
   * Validate input parameters against schema
   * @returns {string[]} List of missing required parameters
   */
  validateParams(action, params, schema) {
    if (!schema) return [];
    
    const errors = [];
    for (const [name, def] of Object.entries(schema)) {
      if (def.required && (params[name] === undefined || params[name] === null)) {
        errors.push(name);
      }
    }
    return errors;
  }

  /**
   * Validate response against schema
   * @returns {string[]} List of validation errors
   */
  validateResponse(action, response, schema) {
    if (!schema) return [];
    
    const errors = [];
    
    for (const [name, def] of Object.entries(schema)) {
      if (def.required && response[name] === undefined) {
        errors.push(`missing required field: ${name}`);
      }
      
      if (response[name] !== undefined && def.type) {
        const actualType = typeof response[name];
        const expectedType = def.type;
        
        // Handle object type specially (includes arrays and null)
        if (expectedType === 'object') {
          if (actualType !== 'object' || response[name] === null) {
            // Allow null for non-required fields
            if (def.required || response[name] !== null) {
              errors.push(`${name}: expected object, got ${actualType}`);
            }
          }
        } else if (expectedType === 'number' && actualType !== 'number') {
          errors.push(`${name}: expected number, got ${actualType}`);
        } else if (expectedType === 'string' && actualType !== 'string') {
          errors.push(`${name}: expected string, got ${actualType}`);
        } else if (expectedType === 'boolean' && actualType !== 'boolean') {
          errors.push(`${name}: expected boolean, got ${actualType}`);
        }
      }
    }
    
    return errors;
  }

  /**
   * Check if error is fatal (should stop execution)
   */
  checkFatal(payload) {
    const msg = String(payload?.message || payload?.error || '').toLowerCase();
    
    const fatalPatterns = [
      'device frp http not connected',
      'device not connected',
      'device unreachable',
      'connection refused',
      'econnrefused',
      'timeout',
      'socket hang up'
    ];

    for (const pattern of fatalPatterns) {
      if (msg.includes(pattern)) {
        return { fatal: true, type: 'device_unreachable', message: msg };
      }
    }
    return null;
  }

  /**
   * Report agent event to server (for logging/monitoring)
   * @param {object} event - Event data { uuid, task_id, type, task, step, payload, output }
   */
  async reportEvent(event) {
    try {
      const url = `${this.baseURL}/agent/report`;
      const response = await axios.post(url, event, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 5000
      });

      const respStr = JSON.stringify(response.data);
      console.log(`📊 Report: ${respStr.length > 100 ? respStr.slice(0, 100) + '...' : respStr}`);

      return response.data;
    } catch (error) {
      // Don't fail the main flow if reporting fails
      console.warn(`   ⚠️ Report failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get list of safe commands for AI prompt
   */
  getSafeCommands() {
    return Object.entries(registry)
      .filter(([_, cmd]) => cmd.safe === true)
      .map(([name, cmd]) => ({
        name,
        description: cmd.description,
        parameters: cmd.parameters || {},
        response: cmd.response || {}
      }));
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default RBAClient;
