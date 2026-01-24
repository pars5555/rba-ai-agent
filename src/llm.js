import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config, registry } from './config.js';

/**
 * LLM Client - AI decides all actions
 */
class LLMClient {
  constructor() {
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
    this.systemPrompt = this.buildSystemPrompt();
  }

  async getNextAction(task, history, lastResult) {
    const userPrompt = this.buildUserPrompt(task, history, lastResult);

    try {
      let content;
      if (this.provider === 'openai') {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
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
          system: this.systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        });
        content = response.content[0].text;
      }

      const result = JSON.parse(content);
      if (!result.complete && result.action && !registry[result.action]) {
        console.warn(`Unknown action: ${result.action}`);
        return { action: 'get_device_snapshot', params: {}, reason: 'Checking device', details: `Unknown action "${result.action}", falling back to snapshot` };
      }
      return result;
    } catch (error) {
      console.error('LLM error:', error.message);
      throw error;
    }
  }

  buildSystemPrompt() {
    const commands = Object.entries(registry)
        .map(([name, cmd]) => {
          const params = cmd.parameters ? Object.keys(cmd.parameters).join(', ') : '';
          return `- ${name}${params ? `: {${params}}` : ''} - ${cmd.description.split('.')[0]}`;
        })
        .join('\n');

    return `You control an Android device. Return ONE JSON action per response.

COMMANDS:
${commands}

═══════════════════════════════════════════════════════════════
RESPONSE FORMAT
═══════════════════════════════════════════════════════════════

Always return JSON with these fields:

{
  "action": "command_name",
  "params": {},
  "reason": "<SPOKEN to user - keep SHORT>",
  "details": "<FOR DEBUGGING - explain WHY, what data you used/need>"
}

Or when complete:
{
  "complete": true,
  "reason": "<SPOKEN - the answer or 'Done'>",
  "details": "<FOR DEBUGGING - explain decision, what data was available/missing>"
}

FIELD PURPOSES:
- reason: Spoken via TTS - keep natural and concise (5-10 words max)
- details: Logged for debugging - explain your reasoning, data used, limitations

═══════════════════════════════════════════════════════════════
CRITICAL: AVOID LOOPS - OBSERVE AFTER ACTIONS
═══════════════════════════════════════════════════════════════

RULES:
1. NEVER repeat the same action more than 2 times in a row
2. After EVERY action that changes screen, do get_device_snapshot to see result
3. If action doesn't work, try a DIFFERENT approach
4. If stuck after 3 attempts, skip to next part of task

PATTERN: action → observe → decide (NOT: action → action → action)

═══════════════════════════════════════════════════════════════
HOW TO DO COMMON TASKS
═══════════════════════════════════════════════════════════════

CLOSE ALL APPS:
Option 1 (preferred): Use close_all_apps command directly
Option 2 (manual): press_recent → get_device_snapshot → find "Clear all" in ui_nodes → input_tap

OPEN APP AND TYPE URL:
1. run_app {package_name: "com.brave.browser"} 
2. wait {ms: 2000}
3. get_device_snapshot → find address bar in ui_nodes
4. input_tap on address bar (look for node with "url" or "address" or "Search")
5. type_text {text: "https://example.com"}
6. press_enter

FILL FORM:
1. get_device_snapshot → find input fields
2. input_tap on field to focus it
3. type_text {text: "value"}
4. Repeat for each field
5. Find submit button → input_tap

TAB/SECTION NAVIGATION:
1. get_device_snapshot → look for tab names in ui_nodes text
2. input_tap on the tab you need
3. get_device_snapshot → verify tab changed

═══════════════════════════════════════════════════════════════
BE RESOURCEFUL - TRY MULTIPLE APPROACHES
═══════════════════════════════════════════════════════════════

NEVER say "cannot" until you've tried ALL options:

1. USE SENSOR DATA for environmental info:
   - Temperature sensor → ambient temperature
   - Light sensor → brightness (high=sunny, low=dark)

2. USE THE INTERNET - device has WiFi/data:
   - Open browser, search for info

3. USE APPS:
   - Weather apps, maps, browsers

4. READ THE SCREEN:
   - Use screen_analyze for OCR if ui_nodes don't help

═══════════════════════════════════════════════════════════════

TASK TYPES:

1. ACTION TASKS ("turn on X", "open Y"):
   - Execute the action
   - reason = short description: "Turning on torch"
   - On complete: reason = "Done"

2. INFORMATION TASKS ("check X", "what is Y", "is Z on?"):
   - Gather the information
   - reason = THE ANSWER: "Battery is 75 percent"

═══════════════════════════════════════════════════════════════

DEVICE SNAPSHOT CONTAINS:
- flashlight_status: "on" / "off"
- foreground: current app package
- battery_level, wifi_enabled, bluetooth_enabled
- gps_enabled, screen_brightness, is_muted
- ui_nodes: screen elements with bounds

SENSOR DATA (in snapshot.all_sensors or from get_all_sensors):
- AMBIENT_TEMPERATURE: °C
- RELATIVE_HUMIDITY: %
- LIGHT: lux (>1000 = bright)

NODE FORMAT:
{text, desc, class, bounds:{cx,cy,...}, clickable, focused, editable}

Use bounds.cx and bounds.cy for input_tap coordinates!

PACKAGES:
Chrome: com.android.chrome
Brave: com.brave.browser
Settings: com.android.settings
YouTube: com.google.android.youtube

CHECK STATE BEFORE ACTING:
- If desired state already achieved → complete immediately`;
  }

  buildUserPrompt(task, history, lastResult) {
    let prompt = `TASK: ${task}\n`;

    // Detect if this is an information request
    const infoKeywords = ['check', 'what', 'is ', 'are ', 'tell me', 'show me', 'how much', 'how many', 'status', 'level', 'whether', 'weather'];
    const isInfoTask = infoKeywords.some(kw => task.toLowerCase().includes(kw));

    if (isInfoTask) {
      prompt += `[INFO TASK - reason must include THE ANSWER. Use sensors/browser/apps to find it.]\n`;
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
        prompt += `\n📊 KEY STATE:\n`;
        const snap = lastResult.snapshot || lastResult;
        if (snap.flashlight_status) prompt += `   - Torch: ${snap.flashlight_status}\n`;
        if (snap.foreground) prompt += `   - App: ${snap.foreground}\n`;
        if (snap.battery_level !== undefined) prompt += `   - Battery: ${snap.battery_level}%\n`;
        if (snap.wifi_enabled !== undefined) prompt += `   - WiFi: ${snap.wifi_enabled ? 'on' : 'off'}\n`;
        if (snap.bluetooth_enabled !== undefined) prompt += `   - Bluetooth: ${snap.bluetooth_enabled ? 'on' : 'off'}\n`;
        if (snap.gps_enabled !== undefined) prompt += `   - GPS: ${snap.gps_enabled ? 'on' : 'off'}\n`;
        if (snap.screen_brightness !== undefined) prompt += `   - Brightness: ${snap.screen_brightness}\n`;
        if (snap.location) prompt += `   - Location: ${JSON.stringify(snap.location)}\n`;

        // Count UI nodes and find important ones
        const nodes = snap.ui_nodes?.nodes || snap.ui_nodes || [];
        const nodeCount = Array.isArray(nodes) ? nodes.length : 0;
        prompt += `   - UI nodes: ${nodeCount} elements\n`;

        // Look for useful buttons/elements
        if (Array.isArray(nodes)) {
          const clearAll = nodes.find(n =>
              (n.text || n.desc || '').toLowerCase().includes('clear all')
          );
          if (clearAll && clearAll.bounds) {
            prompt += `   - 🎯 "Clear all" button at (${clearAll.bounds.cx}, ${clearAll.bounds.cy})\n`;
          }
        }

        // Extract sensor data from snapshot if available
        if (snap.all_sensors) {
          prompt += `\n🌡️ SENSOR DATA:\n`;
          for (const [id, sensor] of Object.entries(snap.all_sensors)) {
            if (sensor.name && sensor.values) {
              const val = Array.isArray(sensor.values) ? sensor.values[0] : sensor.values;
              if (sensor.name.includes('TEMPERATURE')) prompt += `   - Temperature: ${val?.toFixed?.(1) || val}°C\n`;
              if (sensor.name.includes('HUMIDITY')) prompt += `   - Humidity: ${val?.toFixed?.(1) || val}%\n`;
              if (sensor.name.includes('PRESSURE')) prompt += `   - Pressure: ${val?.toFixed?.(1) || val} hPa\n`;
              if (sensor.name.includes('LIGHT')) prompt += `   - Light: ${val?.toFixed?.(0) || val} lux ${val > 1000 ? '(bright)' : val < 100 ? '(dim)' : ''}\n`;
            }
          }
        }
      }

      // Extract sensor data from get_all_sensors
      if (lastResult.action === 'get_all_sensors' && lastResult.success && lastResult.sensors) {
        prompt += `\n🌡️ SENSOR DATA:\n`;
        const sensors = lastResult.sensors;
        for (const [id, sensor] of Object.entries(sensors)) {
          if (sensor.name && sensor.values) {
            const val = Array.isArray(sensor.values) ? sensor.values[0] : sensor.values;
            if (sensor.name.includes('TEMPERATURE')) prompt += `   - Temperature: ${val?.toFixed?.(1) || val}°C\n`;
            if (sensor.name.includes('HUMIDITY')) prompt += `   - Humidity: ${val?.toFixed?.(1) || val}%\n`;
            if (sensor.name.includes('PRESSURE')) prompt += `   - Pressure: ${val?.toFixed?.(1) || val} hPa\n`;
            if (sensor.name.includes('LIGHT')) prompt += `   - Light: ${val?.toFixed?.(0) || val} lux ${val > 1000 ? '(bright)' : val < 100 ? '(dim)' : ''}\n`;
          }
        }
      }
    } else {
      prompt += `\n(Start with get_device_snapshot)\n`;
    }

    prompt += `\nNext action? Remember: observe after actions, avoid loops, use close_all_apps if manual close fails. Include "details" field explaining your reasoning`;
    return prompt;
  }
}

export default LLMClient;