import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { emit, log } from '../logger.js';

/**
 * LLM Client v3.0 - True Conversation Style
 *
 * Changes from v2.0:
 * - System prompt is STATIC (never changes)
 * - User prompt contains ALL dynamic data including step action history
 * - AI can see what actions it already tried in current step
 */
class LLMClient {
  constructor(config, agentConfig, getInteractiveMessage) {
    this.config = config;
    this.agentConfig = agentConfig;
    this.getInteractiveMessage = getInteractiveMessage;
    this.maxLogLength = config.logging?.maxBodyLogLength || 2000;

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
   * Estimate tokens (rough: 1 token ≈ 4 chars)
   */
  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  /**
   * PHASE 1: Create execution plan
   */
  async createPlan(task) {
    const systemPrompt = this.agentConfig.planningPrompt;
    const userPrompt = `TASK: ${task}\n\nCreate a step-by-step plan. Respond with JSON only.`;

    const systemTokens = this.estimateTokens(systemPrompt);
    const userTokens = this.estimateTokens(userPrompt);

    log(`\n${'═'.repeat(60)}`);
    log(`📋 PLANNING PHASE`);
    log(`${'═'.repeat(60)}`);
    log(`📝 Task: "${task}"`);
    log(`📊 System: ${systemPrompt.length} chars (~${systemTokens} tokens)`);
    log(`📊 User: ${userPrompt.length} chars (~${userTokens} tokens)`);
    log(`${'─'.repeat(60)}`);
    log(`📤 USER PROMPT:\n${userPrompt}`);
    log(`${'─'.repeat(60)}`);

    const content = await this.callLLM(systemPrompt, userPrompt);
    const plan = JSON.parse(content);

    log(`📥 PLAN: ${plan.steps?.length || 0} steps`);
    if (plan.steps) {
      plan.steps.forEach((s, i) => log(`   ${i + 1}. ${s.description}`));
    }

    return plan;
  }

  /**
   * PHASE 2: Execute current step
   *
   * @param {string} task - Original task
   * @param {object} plan - Execution plan
   * @param {number} currentStepIndex - Current step (0-indexed)
   * @param {array} stepActions - Actions already taken in THIS step [{action, params, success, result}]
   * @param {object} lastResult - Full result of last action (for snapshot data)
   */
  async executeStep(task, plan, currentStepIndex, stepActions = [], lastResult = null) {
    const systemPrompt = this.agentConfig.executionPrompt;
    const userPrompt = this.buildUserPrompt(task, plan, currentStepIndex, stepActions, lastResult);

    const systemTokens = this.estimateTokens(systemPrompt);
    const userTokens = this.estimateTokens(userPrompt);

    log(`\n${'─'.repeat(60)}`);
    log(`🎯 STEP ${currentStepIndex + 1}/${plan.steps.length}: ${plan.steps[currentStepIndex].description}`);
    log(`${'─'.repeat(60)}`);
    log(`📊 System: ${systemPrompt.length} chars (~${systemTokens} tokens)`);
    log(`📊 User: ${userPrompt.length} chars (~${userTokens} tokens)`);
    log(`📊 Total: ~${systemTokens + userTokens} tokens`);
    log(`📊 Actions in step so far: ${stepActions.length}`);
    log(`${'─'.repeat(60)}`);
    log(`📤 USER PROMPT:`);
    log(this.truncateForLog(userPrompt));
    log(`${'─'.repeat(60)}`);

    emit('llm_request', {
      step: currentStepIndex,
      totalSteps: plan.steps.length,
      stepActions: stepActions.length,
      systemChars: systemPrompt.length,
      userChars: userPrompt.length,
      estimatedTokens: systemTokens + userTokens
    });

    const content = await this.callLLM(systemPrompt, userPrompt);
    const result = JSON.parse(content);

    // Log response
    if (result.complete) {
      log(`📥 AI: ✅ TASK COMPLETE - ${result.reason}`);
    } else if (result.stepComplete) {
      log(`📥 AI: ✓ Step complete - ${result.reason}`);
    } else if (result.error) {
      log(`📥 AI: ❌ ERROR - ${result.error}`);
    } else {
      log(`📥 AI: ${result.action} - ${result.reason}`);
      if (result.params && Object.keys(result.params).length > 0) {
        log(`   Params: ${JSON.stringify(result.params)}`);
      }
    }

    // Validate action exists
    if (!result.complete && !result.stepComplete && !result.error && result.action) {
      if (!this.agentConfig.registry[result.action]) {
        log(`⚠️ Unknown action: ${result.action}, defaulting to get_device_snapshot`);
        return { action: 'get_device_snapshot', params: {}, reason: 'Checking screen' };
      }
    }

    return result;
  }

  /**
   * Build user prompt with step action history
   */
  buildUserPrompt(task, plan, currentStepIndex, stepActions, lastResult) {
    let prompt = '';

    // Task
    prompt += `TASK: ${task}\n`;

    // Interactive message if any
    const msg = this.getInteractiveMessage?.();
    if (msg) {
      prompt += `\n💬 USER MESSAGE: "${msg}"\n`;
    }

    // Plan with progress markers
    prompt += `\n═══ PLAN (${plan.steps.length} steps) ═══\n`;
    plan.steps.forEach((step, i) => {
      const marker = i < currentStepIndex ? '✓' : (i === currentStepIndex ? '▶' : '○');
      prompt += `${marker} ${i + 1}. ${step.description}\n`;
    });

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

  /**
   * Truncate for logging
   */
  truncateForLog(text) {
    if (text.length <= this.maxLogLength) return text;

    const fullResultIdx = text.indexOf('Full result:');
    if (fullResultIdx !== -1) {
      const before = text.substring(0, fullResultIdx + 50);
      const after = text.substring(text.length - 200);
      return before + `\n... [${text.length - this.maxLogLength} chars truncated] ...\n` + after;
    }

    return text.substring(0, this.maxLogLength) + `\n... [truncated ${text.length - this.maxLogLength} chars]`;
  }

  /**
   * Call LLM API
   */
  async callLLM(systemPrompt, userPrompt) {
    try {
      if (this.provider === 'openai') {
        const response = await this.client.chat.completions.create({
          model: this.model,
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
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }]
        });
        return response.content[0].text;
      }
    } catch (error) {
      log(`❌ LLM Error: ${error.message}`);
      throw error;
    }
  }
}

export default LLMClient;