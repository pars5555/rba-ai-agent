import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config, registry } from './config.js';

/**
 * LLM Client - Handles AI decision making
 * Single method: getNextAction(state, task, history)
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

    // Build system prompt once (with all commands)
    this.systemPrompt = this.buildSystemPrompt();
  }

  /**
   * Get next action from AI
   * @param {object} state - Current device state from get_device_snapshot
   * @param {string} task - User's task
   * @param {Array} history - Previous actions and results
   * @returns {Promise<object>} Next action: { action, params, description, complete }
   */
  async getNextAction(state, task, history = []) {
    const userPrompt = this.buildUserPrompt(state, task, history);

    if (config.debug?.logPrompts) {
      console.log('\n📝 USER PROMPT:\n', userPrompt);
    }

    try {
      let content;

      if (this.provider === 'openai') {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3,
          response_format: { type: 'json_object' }
        });
        content = response.choices[0].message.content;
      } else {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 1024,
          system: this.systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        });
        content = response.content[0].text;
      }

      // Parse JSON response
      const result = JSON.parse(content);

      // Validate action exists in registry
      if (!result.complete && !registry[result.action]) {
        console.warn(`⚠️ AI returned unknown action: ${result.action}`);
        return { action: 'wait', params: { ms: 1000 }, description: 'Unknown action, waiting', complete: false };
      }

      return result;

    } catch (error) {
      console.error('LLM error:', error.message);
      throw error;
    }
  }

  /**
   * Build comprehensive system prompt with all commands
   */
  buildSystemPrompt() {
    // Build commands documentation from registry
    const commandDocs = Object.entries(registry)
        .filter(([_, cmd]) => cmd.safe === true)
        .map(([name, cmd]) => {
          let doc = `### ${name}\n${cmd.description}`;

          if (cmd.parameters && Object.keys(cmd.parameters).length > 0) {
            doc += '\nParameters:';
            for (const [param, info] of Object.entries(cmd.parameters)) {
              const req = info.required ? 'REQUIRED' : 'optional';
              const def = info.default !== undefined ? `, default: ${info.default}` : '';
              doc += `\n  - ${param} (${info.type}, ${req}${def}): ${info.description || ''}`;
            }
          } else {
            doc += '\nParameters: none';
          }

          return doc;
        })
        .join('\n\n');

    return `You are an AI agent controlling an Android device. You observe the screen state and decide the NEXT SINGLE ACTION to take.

## AVAILABLE COMMANDS

${commandDocs}

## COMMON APP PACKAGES
- Chrome: com.android.chrome
- Settings: com.android.settings  
- YouTube: com.google.android.youtube
- Calculator: com.google.android.calculator
- Camera: com.android.camera2
- Gmail: com.google.android.gm
- Maps: com.google.android.apps.maps
- Play Store: com.android.vending
- Phone: com.android.dialer
- Messages: com.google.android.apps.messaging
- Clock: com.google.android.deskclock
- Calendar: com.google.android.calendar
- Photos: com.google.android.apps.photos
- Files: com.google.android.documentsui

## CRITICAL RULES

1. **Use EXACT coordinates from observation** - Screen state includes element positions. Use the actual coordinates provided, never guess!

2. **One action at a time** - Return exactly ONE action per response.

3. **Focus before typing** - You MUST tap on an input field before using type_text. Look for EditText in accessibility nodes or text input areas.

4. **Wait after major actions** - After launching apps or tapping, the UI needs time to update. Use wait action.

5. **Handle popups/dialogs** - If you see permission dialogs, cookie banners, or popups, dismiss them first before continuing with the main task.

6. **Verify app is open** - After run_app, check if foreground_package matches before proceeding.

7. **Mark completion correctly** - Set "complete": true ONLY when you can see evidence the task is done.

8. **Don't repeat failed actions** - If an action failed, try a different approach.

9. **Use accessibility nodes when available** - They have reliable coordinates. Fall back to screen_analysis text elements if nodes don't have what you need.

10. **Detecting input focus** - After tapping an input field:
   - Look for "🎯 FOCUSED ELEMENT" in the screen state
   - Look for "⌨️ Keyboard visible" indicator
   - If you see either, the input is focused — proceed to type_text!
   - NEVER tap the same input field twice in a row

11. **After tapping input** - If you just tapped an input field, your NEXT action MUST be type_text (not another tap).

12. **Keyboard visible = ready to type** - When you see keyboard is visible, use type_text immediately.

13. if the task is to open browser and there is already browser foregrounded then try to open a new tab instead of using the existing tab.

14. if user ask something that need to search in the browser then please parse the user prompt and extract the search query and then use that to search in the browser, like if user ask to "check gold price", you should search for "gold price" .


## RESPONSE FORMAT

Return valid JSON with these fields:
{
  "action": "action_name",
  "params": { ... },
  "description": "What this action does",
  "reason": "Why this is the right next step based on current screen",
  "complete": false
}

When task is complete:
{
  "action": "wait",
  "params": { "ms": 500 },
  "description": "Task completed",
  "reason": "Evidence that task is done: [what you see on screen]",
  "complete": true
}

## COORDINATE TIPS

- Typical screen size: 1080x1920 or 1080x2400
- Elements have bounds: {left, top, right, bottom}
- Center = ((left+right)/2, (top+bottom)/2)
- For scrolling DOWN (see more): swipe from y=1500 to y=500
- For scrolling UP: swipe from y=500 to y=1500`;
  }

  /**
   * Build user prompt with current state
   */
  buildUserPrompt(state, task, history) {
    // Format history concisely
    let historyStr = 'None yet';
    if (history.length > 0) {
      historyStr = history.map((h, i) => {
        const status = h.result?.success ? '✅' : '❌';
        const params = JSON.stringify(h.action?.params || {});
        return `${i + 1}. ${status} ${h.action?.action} ${params.length > 80 ? params.slice(0, 80) + '...' : params}`;
      }).join('\n');
    }

    // Check for repeated actions (loop detection) - especially for taps
    let loopWarning = '';
    if (history.length >= 1) {
      const last = history[history.length - 1];
      const lastAction = last?.action?.action;

      // If last action was a tap and it succeeded, warn about typing
      if (lastAction === 'input_tap' && last?.result?.success) {
        // Check if there's a focused element or keyboard visible
        if (state.focusedElement || state.keyboardLikelyVisible) {
          loopWarning = `
⚠️ INPUT READY: You just tapped and now there's a focused input/keyboard visible.
→ Your next action should be type_text, NOT another tap!
`;
        }
      }

      // Check for repeated identical actions
      if (history.length >= 2) {
        const prev = history[history.length - 2];
        const lastSig = `${lastAction}:${JSON.stringify(last?.action?.params || {})}`;
        const prevSig = `${prev?.action?.action}:${JSON.stringify(prev?.action?.params || {})}`;

        if (lastSig === prevSig) {
          if (lastAction === 'input_tap') {
            loopWarning = `
⚠️ LOOP DETECTED: You tapped the same location twice!
→ If you tapped an input field, it IS focused now — use type_text
→ If you tapped a button that didn't respond, try a different approach
→ DO NOT tap the same location again!
`;
          } else {
            loopWarning = `
⚠️ LOOP WARNING: Last two actions are identical.
→ Choose a DIFFERENT action or mark complete if task is done.
`;
          }
        }
      }
    }

    // Format screen state
    let screenInfo = this.formatScreenState(state);

    return `## TASK
"${task}"

## PREVIOUS ACTIONS
${historyStr}
${loopWarning}
## CURRENT SCREEN STATE
${screenInfo}

## YOUR DECISION
Based on the screen state and history, what is the NEXT SINGLE action?
Return JSON only.`;
  }

  /**
   * Format screen state for prompt
   */
  formatScreenState(state) {
    if (!state) return 'No screen state available';

    let info = '';

    // Foreground app
    if (state.foregroundPackage) {
      info += `📱 Foreground app: ${state.foregroundPackage}\n`;
    }

    // Screen size
    if (state.screenWidth && state.screenHeight) {
      info += `📐 Screen: ${state.screenWidth}x${state.screenHeight}\n`;
    }

    // FOCUS STATE - Show prominently at the top!
    if (state.focusedElement) {
      info += `\n🎯 FOCUSED ELEMENT: ${state.focusedElement.className} "${state.focusedElement.text || state.focusedElement.resourceId || '[empty]'}"\n`;
      if (state.focusedElement.isEditText) {
        info += `   ✅ INPUT FIELD IS FOCUSED — use type_text now!\n`;
      }
    }

    if (state.keyboardLikelyVisible) {
      info += `⌨️ KEYBOARD IS VISIBLE — ready for type_text!\n`;
    }

    // Installed apps (if available, just count)
    if (state.installedApps) {
      const count = Object.keys(state.installedApps).length;
      info += `📦 Installed apps: ${count}\n`;
    }

    // Accessibility nodes (most reliable for coordinates)
    if (state.accessibilityNodes && state.accessibilityNodes.length > 0) {
      info += `\n♿ ACCESSIBILITY NODES (use these coordinates!):\n`;
      state.accessibilityNodes.slice(0, 20).forEach((node, i) => {
        const label = node.text || node.contentDescription || '[no text]';
        const type = node.className || 'unknown';
        const pos = node.center ? `(${node.center.x}, ${node.center.y})` : 'no pos';
        const flags = [
          node.clickable ? '🖱️click' : '',
          node.focused ? '🎯FOCUSED' : '',
          node.selected ? '✓sel' : ''
        ].filter(Boolean).join(' ');
        info += `  ${i + 1}. ${type}: "${label.slice(0, 40)}" at ${pos} ${flags}\n`;
      });
    }

    // Screen analysis (OCR text)
    if (state.screenAnalysis?.textElements?.length > 0) {
      info += `\n📝 TEXT ON SCREEN (from OCR):\n`;
      state.screenAnalysis.textElements.slice(0, 15).forEach((el, i) => {
        const text = el.text || '[empty]';
        const pos = el.center ? `(${el.center.x}, ${el.center.y})` : 'no pos';
        info += `  ${i + 1}. "${text.slice(0, 50)}" at ${pos}\n`;
      });
    }

    // UI elements
    if (state.screenAnalysis?.uiElements?.length > 0) {
      info += `\n🔲 UI ELEMENTS:\n`;
      state.screenAnalysis.uiElements.slice(0, 10).forEach((el, i) => {
        const pos = el.center ? `(${el.center.x}, ${el.center.y})` : 'no pos';
        info += `  ${i + 1}. ${el.type || 'unknown'} at ${pos}\n`;
      });
    }

    return info || 'Screen state empty';
  }
}

export default LLMClient;