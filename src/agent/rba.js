import axios from 'axios';
import { logApiCall, logApiResponse, logApiError } from '../logger.js';

/**
 * RBA API Client
 * Communicates with the RBA backend to control Android devices
 * 
 * Config is passed via constructor (from workerData)
 */
class RBAClient {
  constructor(config, registry) {
    this.baseURL = config.rba.apiBaseUrl;
    this.apiKey = config.rba.apiKey;
    this.registry = registry;
  }

  /**
   * Update registry (used when config is reloaded)
   */
  setRegistry(registry) {
    this.registry = registry;
  }

  /**
   * Execute any command from the registry
   */
  async call(sn, action, params = {}) {
    // Handle local actions
    if (action === 'wait') {
      const ms = params.ms || 1000;
      await new Promise(r => setTimeout(r, ms));
      return { success: true, action: 'wait', waited_ms: ms };
    }

    const cmd = this.registry?.[action];
    if (!cmd) {
      return { success: false, error: `Unknown action: ${action}` };
    }
    if (!cmd.endpoint) {
      return { success: false, error: `No endpoint for: ${action}` };
    }

    const body = { uuid: sn, ...params };

    try {
      const url = `${this.baseURL}${cmd.endpoint}`;
      logApiCall(action, url, body);

      const response = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 30000
      });

      logApiResponse(action, response.status, response.data?.success);

      // Check for fatal errors
      const fatal = this.checkFatal(response.data);
      if (fatal) return { ...response.data, _fatal: fatal };

      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const errorMsg = error.response?.data?.message || error.message;

      logApiError(action, status, errorMsg);

      if (status === 401) {
        return { success: false, error: 'Auth failed', _fatal: { type: 'auth_error', message: 'Invalid API key' } };
      }

      const fatal = this.checkFatal({ message: error.message });
      if (fatal) return { success: false, error: errorMsg, _fatal: fatal };

      return { success: false, error: errorMsg };
    }
  }

  /**
   * Check for fatal transport errors
   */
  checkFatal(payload) {
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

  /**
   * Report agent event to backend
   */
  async reportEvent(event) {
    try {
      await axios.post(`${this.baseURL}/agent/report`, event, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 5000
      });
    } catch (e) {
      // Silent fail - don't break main flow
    }
  }
}

export default RBAClient;
