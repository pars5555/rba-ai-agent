import axios from 'axios';
import https from 'https';
import { logApiCall, logApiResponse, logApiError, validateAndEnrichResponse, checkFatalError } from './util.js';

const axiosInsecure = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

/**
 * RBA API Client - Minimal
 */
class RBAClient {
  constructor(config, registry) {
    this.baseURL = config.rba.apiBaseUrl;
    this.apiKey = config.rba.apiKey;
    this.registry = registry;
  }

  setRegistry(registry) {
    this.registry = registry;
  }

  async call(sn, action, params = {}) {
    // Local wait action
    if (action === 'wait') {
      const ms = params.ms || 1000;
      await new Promise(r => setTimeout(r, ms));
      return { success: true, action: 'wait', waited_ms: ms };
    }

    const cmd = this.registry?.[action];
    if (!cmd) return { success: false, error: `Unknown action: ${action}` };
    if (!cmd.endpoint) return { success: false, error: `No endpoint for: ${action}` };

    const url = `${this.baseURL}${cmd.endpoint}`;
    const body = { uuid: sn, ...params };

    try {
      logApiCall(action, url, body);
      const response = await axiosInsecure.post(url, body, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        timeout: 30000
      });
      logApiResponse(action, response.status, response.data?.success);

      return validateAndEnrichResponse(this.registry, action, response.data);
    } catch (error) {
      const status = error.response?.status;
      const errorMsg = error.response?.data?.message || error.message;
      logApiError(action, status, errorMsg);

      if (status === 401) return { success: false, error: 'Auth failed', _fatal: { type: 'auth_error', message: 'Invalid API key' } };
      
      const fatal = checkFatalError({ message: error.message });
      return fatal ? { success: false, error: errorMsg, _fatal: fatal } : { success: false, error: errorMsg };
    }
  }

  async reportEvent(event) {
    try {
      await axiosInsecure.post(`${this.baseURL}/agent/report`, event, {
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
        timeout: 5000
      });
    } catch (e) { /* silent */ }
  }
}

export default RBAClient;
