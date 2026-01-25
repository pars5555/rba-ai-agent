import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { log, logLlmCall, logLlmResponse, logLlmError } from '../logger.js';

/**
 * LLM Client
 * Communicates with AI providers (OpenAI, Anthropic) for decision making
 */
class LLMClient {
  constructor(agentConfig, getInteractiveMessage) {
    this.agentConfig = agentConfig;
    this.getInteractiveMessage = getInteractiveMessage;
    
    const provider = config.llm.provider;
    if (provider === 'openai') {
      this.provider = 'openai';
      this.client = new OpenAI({ apiKey: config.llm.openai.apiKey });
      this.model = config.llm.openai.model;
    } else if (provider === 'anthropic') {
      this.provider = 'anthropic';
      this.client = new Anthropic({ apiKey: config.llm.anthropic.apiKey });
      this.model = config.llm.anthropic.model;
    } else {
      throw new Error(`Unknown LLM provider: ${provider}`);
    }
  }

  /**
   * Update agent config (used when config is reloaded)
   */
  setAgentConfig(agentConfig) {
    this.agentConfig = agentConfig;
  }

  /**
   * Get next action from AI
   */
  async getNextAction(task, history, lastResult) {
    const userPrompt = this.buildUserPrompt(task, history, lastResult);

    logLlmCall(history.length, !!lastResult);

    try {
      let content;
      if (this.provider === 'openai') {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: this.agentConfig.prompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        });
        content = response.choices[0].message.content;
      } else {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 512,
          system: this.agentConfig.prompt,
          messages: [{ role: 'user', content: userPrompt }]
        });
        content = response.content[0].text;
      }

      const result = JSON.parse(content);

      logLlmResponse(result.action, result.complete, result.reason);

      // Validate action exists in registry
      if (!result.complete && result.action && !this.agentConfig.registry[result.action]) {
        log(`Unknown action: ${result.action}, falling back to snapshot`);
        return { action: 'get_device_snapshot', params: {}, reason: 'Checking device' };
      }

      return result;
    } catch (error) {
      logLlmError(error.message);
      throw error;
    }
  }

  /**
   * Build user prompt with task, history, and context
   */
  buildUserPrompt(task, history, lastResult) {
    let prompt = `TASK: ${task}\n`;

    // Info task detection
    const infoKeywords = ['check', 'what', 'is ', 'are ', 'tell me', 'show me', 'how much', 'how many', 'status', 'level', 'whether', 'weather'];
    if (infoKeywords.some(kw => task.toLowerCase().includes(kw))) {
      prompt += `[INFO TASK - reason must include THE ANSWER. Use sensors/browser/apps to find it.]\n`;
    }

    // Include interactive message if available
    const interactiveMessage = this.getInteractiveMessage?.();
    if (interactiveMessage) {
      prompt += `\n💬 USER MESSAGE: "${interactiveMessage}"\n`;
    }

    if (history.length > 0) {
      prompt += `\nHISTORY (${history.length} actions):\n`;
      history.forEach((h, i) => {
        const status = h.success ? '✓' : '✗';
        const params = h.params && Object.keys(h.params).length > 0 ? ` ${JSON.stringify(h.params)}` : '';
        prompt += `  ${i + 1}. [${status}] ${h.action}${params}\n`;
      });

      // LOOP DETECTION - check last 3 actions
      const last3 = history.slice(-3).map(h => h.action);
      if (last3.length === 3 && last3[0] === last3[1] && last3[1] === last3[2]) {
        prompt += `\n⚠️ LOOP DETECTED: "${last3[0]}" repeated 3 times!\n`;
        prompt += `→ You MUST try a DIFFERENT action or approach now.\n`;
        prompt += `→ If trying to close apps manually failed, use close_all_apps command.\n`;
        prompt += `→ If stuck, skip this step and proceed with the task.\n`;
      }

      // Suggest observation if last action wasn't an observation
      const lastAction = history[history.length - 1]?.action;
      const observeActions = ['get_device_snapshot', 'screen_analyze', 'get_all_sensors'];
      if (lastAction && !observeActions.includes(lastAction)) {
        prompt += `\n💡 TIP: Consider get_device_snapshot to see result of "${lastAction}".\n`;
      }
    }

    if (lastResult) {
      prompt += `\nLAST RESULT:\n${JSON.stringify(lastResult, null, 2)}\n`;

      // Extract key state from snapshot
      if (lastResult.action === 'get_device_snapshot' && lastResult.success) {
        prompt += this.extractKeyState(lastResult);
      }

      // Extract sensor data from get_all_sensors
      if (lastResult.action === 'get_all_sensors' && lastResult.success && lastResult.sensors) {
        prompt += this.extractSensorData(lastResult.sensors);
      }
    } else {
      prompt += `\n(Start with get_device_snapshot)\n`;
    }

    prompt += `\nNext action? Remember: observe after actions, avoid loops, use close_all_apps if manual close fails. Include "details" field explaining your reasoning`;
    return prompt;
  }

  /**
   * Extract key state information from device snapshot
   */
  extractKeyState(lastResult) {
    let state = `\n📊 KEY STATE:\n`;
    const snap = lastResult.snapshot || lastResult;

    if (snap.flashlight_status) state += `   - Torch: ${snap.flashlight_status}\n`;
    if (snap.foreground) state += `   - App: ${snap.foreground}\n`;
    if (snap.battery_level !== undefined) state += `   - Battery: ${snap.battery_level}%\n`;
    if (snap.wifi_enabled !== undefined) state += `   - WiFi: ${snap.wifi_enabled ? 'on' : 'off'}\n`;
    if (snap.bluetooth_enabled !== undefined) state += `   - Bluetooth: ${snap.bluetooth_enabled ? 'on' : 'off'}\n`;
    if (snap.gps_enabled !== undefined) state += `   - GPS: ${snap.gps_enabled ? 'on' : 'off'}\n`;
    if (snap.screen_brightness !== undefined) state += `   - Brightness: ${snap.screen_brightness}\n`;
    if (snap.location) state += `   - Location: ${JSON.stringify(snap.location)}\n`;

    // Count UI nodes and find important ones
    const nodes = snap.ui_nodes?.nodes || snap.ui_nodes || [];
    const nodeCount = Array.isArray(nodes) ? nodes.length : 0;
    state += `   - UI nodes: ${nodeCount} elements\n`;

    // Look for useful buttons/elements
    if (Array.isArray(nodes)) {
      const clearAll = nodes.find(n =>
        (n.text || n.desc || '').toLowerCase().includes('clear all')
      );
      if (clearAll && clearAll.bounds) {
        state += `   - 🎯 "Clear all" button at (${clearAll.bounds.cx}, ${clearAll.bounds.cy})\n`;
      }
    }

    // Extract sensor data from snapshot if available
    if (snap.all_sensors) {
      state += this.extractSensorData(snap.all_sensors);
    }

    return state;
  }

  /**
   * Extract sensor data from sensors object
   */
  extractSensorData(sensors) {
    let state = `\n🌡️ SENSOR DATA:\n`;
    for (const [id, sensor] of Object.entries(sensors)) {
      if (sensor.name && sensor.values) {
        const val = Array.isArray(sensor.values) ? sensor.values[0] : sensor.values;
        if (sensor.name.includes('TEMPERATURE')) state += `   - Temperature: ${val?.toFixed?.(1) || val}°C\n`;
        if (sensor.name.includes('HUMIDITY')) state += `   - Humidity: ${val?.toFixed?.(1) || val}%\n`;
        if (sensor.name.includes('PRESSURE')) state += `   - Pressure: ${val?.toFixed?.(1) || val} hPa\n`;
        if (sensor.name.includes('LIGHT')) state += `   - Light: ${val?.toFixed?.(0) || val} lux ${val > 1000 ? '(bright)' : val < 100 ? '(dim)' : ''}\n`;
      }
    }
    return state;
  }
}

export default LLMClient;
