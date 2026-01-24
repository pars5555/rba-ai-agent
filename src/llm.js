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
        return { action: 'get_device_snapshot', params: {}, reason: 'Unknown action, refreshing state' };
      }
      return result;
    } catch (error) {
      console.error('LLM error:', error.message);
      throw error;
    }
  }

  buildSystemPrompt() {
    // Build commands list from registry
    const commands = Object.entries(registry)
        .map(([name, cmd]) => {
          const params = cmd.parameters ? Object.keys(cmd.parameters).join(', ') : '';
          return `- ${name}${params ? `: {${params}}` : ''} - ${cmd.description.split('.')[0]}`;
        })
        .join('\n');

    return `You control an Android device. Return ONE JSON action per response.

COMMANDS:
${commands}

KEY COMMANDS:
- get_device_snapshot: Primary observation - get screen state with UI nodes AND device status
- screen_analyze: Use when ui_nodes don't show what you need (OCR text detection)
- press_recent: Open recent apps / app switcher (for closing apps)
- input_swipe: {x1,y1,x2,y2,duration_ms} - swipe gestures
- input_scroll: {x,y,ticks} - scroll. Use ticks=300-500 for normal scroll. Negative=down, Positive=up

DEVICE SNAPSHOT CONTAINS:
- flashlight_status: "on" / "off" - current torch state
- foreground: current app package name
- screen_brightness, volume levels, wifi/bluetooth status, etc.
- ui_nodes: clickable elements on screen

═══════════════════════════════════════════════════════════════
CRITICAL: CHECK STATE BEFORE ACTING
═══════════════════════════════════════════════════════════════

ALWAYS check the current device state from snapshot BEFORE executing any action.
If the desired state is ALREADY achieved, SKIP the action or COMPLETE the task.

STATE CHECK EXAMPLES:

1. FLASHLIGHT:
   - Task: "turn on torch" + snapshot shows flashlight_status:"on"
     → COMPLETE immediately: {"complete":true, "reason":"Torch is already on"}
   - Task: "turn on torch for 5s then off" + flashlight_status:"on"
     → SKIP enable, go directly to wait then disable
   - Task: "turn off torch" + flashlight_status:"off"
     → COMPLETE: {"complete":true, "reason":"Torch is already off"}

2. APPS:
   - Task: "open Chrome" + foreground:"com.android.chrome"
     → COMPLETE: {"complete":true, "reason":"Chrome is already open"}
   - Task: "open Settings" + foreground:"com.android.settings"
     → COMPLETE: already open

3. SETTINGS:
   - Task: "set brightness to 50%" + screen_brightness:128 (50%)
     → COMPLETE: already at target
   - Task: "enable wifi" + wifi_enabled:true
     → COMPLETE: already enabled

4. GENERAL RULE:
   - If snapshot shows X is already in desired state → don't do X again
   - Report what you found and skip/complete appropriately

═══════════════════════════════════════════════════════════════

WORKFLOW:

1. Start with get_device_snapshot to see current state
2. CHECK if task goal is already satisfied → complete if yes
3. If not, execute needed actions
4. For sequence tasks (torch timer, etc): adjust based on current state
5. Verify completion and return {"complete":true}

TASK TYPES:

1. VISUAL TASKS (apps, UI interaction):
   - Check foreground app first
   - Use bounds.cx, bounds.cy from nodes for tap
   - After tap on input: immediately type_text
   - After type: press_enter to submit

2. SEQUENCE TASKS (torch, vibrate, brightness, volume, etc.):
   - Check current state first
   - Skip steps that are already done
   - Execute only what's needed

COMPLETION RULES:
- Check HISTORY - if task was accomplished, return {"complete":true}
- Check SNAPSHOT - if desired state exists, return {"complete":true}
- NEVER repeat actions that already succeeded
- NEVER enable something that's already enabled
- NEVER open an app that's already in foreground

NODE FORMAT:
{text, desc, class, bounds:{cx,cy,...}, clickable, focused, editable, scrollable}
Only non-empty/true values included. Use bounds.cx, bounds.cy for tap.

PACKAGES:
Chrome: com.android.chrome, Settings: com.android.settings, YouTube: com.google.android.youtube

RESPONSE:
{"action":"...", "params":{...}, "reason":"..."}
When done: {"complete":true, "reason":"..."}`;
  }

  buildUserPrompt(task, history, lastResult) {
    let prompt = `TASK: ${task}\n`;

    if (history.length > 0) {
      prompt += `\nHISTORY (${history.length} actions):\n`;
      history.forEach((h, i) => {
        const status = h.success ? '✓' : '✗';
        const params = h.params && Object.keys(h.params).length > 0 ? ` ${JSON.stringify(h.params)}` : '';
        prompt += `  ${i + 1}. [${status}] ${h.action}${params}\n`;
      });
      prompt += '\n';
    }

    if (lastResult) {
      prompt += `LAST RESULT:\n${JSON.stringify(lastResult, null, 2)}\n`;

      // Highlight key state info if it's a snapshot
      if (lastResult.action === 'get_device_snapshot' && lastResult.success) {
        prompt += `\n📊 CURRENT STATE SUMMARY:\n`;
        if (lastResult.flashlight_status) {
          prompt += `   - Flashlight: ${lastResult.flashlight_status}\n`;
        }
        if (lastResult.foreground) {
          prompt += `   - Foreground app: ${lastResult.foreground}\n`;
        }
        if (lastResult.screen_brightness !== undefined) {
          prompt += `   - Brightness: ${lastResult.screen_brightness}\n`;
        }
        prompt += `\n⚠️ CHECK: Is the task goal ALREADY satisfied by current state? If YES → {"complete":true}\n`;
      }
    } else {
      prompt += `(No observation yet - start with get_device_snapshot to check current state)\n`;
    }

    if (history.length > 0) {
      prompt += `\n⚠️ CHECK HISTORY: Was the task already accomplished? If YES → {"complete":true}\n`;
    }

    prompt += `\nNext action? JSON only.`;
    return prompt;
  }
}

export default LLMClient;