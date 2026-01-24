import axios from 'axios';
import { config, registry } from './config.js';

/**
 * Simplified RBA API Client
 * - Single generic method to call any command
 * - Only checks for fatal transport errors
 * - AI analyzes all responses
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
      return { success: false, error: `Unknown action: ${action}` };
    }

    if (!cmd.endpoint) {
      return { success: false, error: `Action "${action}" has no endpoint defined` };
    }

    // Build request body
    const body = { uuid: sn, ...params };

    try {
      const url = `${this.baseURL}${cmd.endpoint}`;

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

      const respStr = JSON.stringify(response.data);
      console.log(`   ← ${response.status}: ${respStr.length > 150 ? respStr.slice(0, 150) + '...' : respStr}`);

      // Only check for fatal transport errors
      const fatal = this.checkFatal(response.data);
      if (fatal) {
        return { ...response.data, _fatal: fatal };
      }

      // Return raw response - AI will analyze it
      return response.data;

    } catch (error) {
      const status = error.response?.status;
      const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message;
      console.error(`   ← ❌ HTTP ${status || 'ERR'}: ${errorMsg}`);

      if (status === 401) {
        return { success: false, error: 'Auth failed (401)', _fatal: { type: 'auth_error', message: 'Invalid API key' } };
      }

      const fatal = this.checkFatal({ message: error.message });
      if (fatal) {
        return { success: false, error: errorMsg, _fatal: fatal };
      }

      return { success: false, error: errorMsg };
    }
  }

  /**
   * Check for fatal transport errors only
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

  async reportEvent(event) {
    try {
      const url = `${this.baseURL}/agent/report`;
      await axios.post(url, event, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 5000
      });
    } catch (error) {
      // Silent fail - don't break main flow
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default RBAClient;