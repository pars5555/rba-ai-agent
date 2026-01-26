import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { log } from '../logger.js';

/**
 * LLM Client - Task Planner Architecture (Minimal)
 * 
 * Two phases:
 * 1. createPlan() - Create execution plan from task
 * 2. executeStep() - Execute current step, AI decides action
 */
class LLMClient {
  constructor(config, agentConfig, getInteractiveMessage) {
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
   * PHASE 1: Create execution plan
   */
  async createPlan(task) {
    const userPrompt = `TASK: ${task}\n\nCreate a step-by-step plan. Respond with JSON.`;
    
    log(`📋 Creating plan for: "${task}"`);

    const content = await this.callLLM(this.agentConfig.planningPrompt, userPrompt);
    const plan = JSON.parse(content);
    
    log(`📋 Plan: ${plan.steps?.length || 0} steps`);
    return plan;
  }

  /**
   * PHASE 2: Execute current step
   */
  async executeStep(task, plan, currentStepIndex, lastResult = null) {
    const userPrompt = this.buildExecutionPrompt(task, plan, currentStepIndex, lastResult);
    
    const totalChars = this.agentConfig.executionPrompt.length + userPrompt.length;
    log(`📨 LLM: ${totalChars} chars (step ${currentStepIndex + 1}/${plan.steps.length})`);

    const content = await this.callLLM(this.agentConfig.executionPrompt, userPrompt);
    const result = JSON.parse(content);

    // Validate action
    if (!result.complete && !result.stepComplete && result.action && !this.agentConfig.registry[result.action]) {
      log(`⚠️ Unknown action: ${result.action}`);
      return { action: 'get_device_snapshot', params: {}, reason: 'Checking device' };
    }

    return result;
  }

  /**
   * Build execution prompt with key state extracted prominently
   */
  buildExecutionPrompt(task, plan, currentStepIndex, lastResult) {
    let prompt = `TASK: ${task}\n`;

    // Interactive message
    const msg = this.getInteractiveMessage?.();
    if (msg) prompt += `\n💬 USER: "${msg}"\n`;

    // Plan with progress
    prompt += `\n═══ PLAN ═══\n`;
    plan.steps.forEach((step, i) => {
      const status = i < currentStepIndex ? '✓' : (i === currentStepIndex ? '▶' : '○');
      prompt += `${status} ${i + 1}. ${step.description}\n`;
    });

    // Current step
    prompt += `\n═══ CURRENT STEP ${currentStepIndex + 1}/${plan.steps.length} ═══\n`;
    prompt += `${plan.steps[currentStepIndex].description}\n`;

    // Extract and display KEY STATE prominently (before full result)
    if (lastResult) {
      const keyState = this.extractKeyState(lastResult);
      if (keyState) {
        prompt += `\n═══ ⚡ KEY STATE (IMPORTANT!) ═══\n`;
        prompt += keyState;
      }

      prompt += `\n═══ LAST RESULT ═══\n`;
      prompt += JSON.stringify(lastResult, null, 2) + '\n';
    }

    prompt += `\nRespond with JSON.`;
    return prompt;
  }

  /**
   * Extract key state from snapshot - focused element, foreground app, etc.
   */
  extractKeyState(result) {
    if (!result || !result.success) return null;

    const snap = result.snapshot || result;
    let state = '';

    // Foreground app
    if (snap.foreground_package) {
      state += `📱 App: ${snap.foreground_package}\n`;
    }

    // Device status
    if (snap.flashlight_status) state += `🔦 Flashlight: ${snap.flashlight_status}\n`;
    if (snap.is_muted !== undefined) state += `🔇 Muted: ${snap.is_muted}\n`;
    if (snap.battery_level !== undefined) state += `🔋 Battery: ${snap.battery_level}%\n`;

    // Find FOCUSED element - VERY IMPORTANT for text input
    const nodes = snap.ui_nodes?.nodes || snap.ui_nodes || [];
    if (Array.isArray(nodes)) {
      const focusedNode = nodes.find(n => n.focused === true);
      if (focusedNode) {
        state += `\n🎯 FOCUSED ELEMENT (ready for input!):\n`;
        state += `   Class: ${focusedNode.class || focusedNode.className || 'unknown'}\n`;
        if (focusedNode.text) state += `   Text: "${focusedNode.text}"\n`;
        if (focusedNode.desc) state += `   Desc: "${focusedNode.desc}"\n`;
        if (focusedNode.bounds) {
          const b = focusedNode.bounds;
          state += `   Bounds: (${b.cx || b.centerX}, ${b.cy || b.centerY})\n`;
        }
        if (focusedNode.editable) state += `   ⌨️ EDITABLE - You can type_text NOW!\n`;
      }

      // Find editable elements (text fields)
      const editables = nodes.filter(n => n.editable === true);
      if (editables.length > 0 && !focusedNode) {
        state += `\n📝 Editable fields on screen: ${editables.length}\n`;
        editables.slice(0, 3).forEach((n, i) => {
          const hint = n.text || n.desc || n.hint || 'empty';
          const b = n.bounds;
          state += `   ${i + 1}. "${hint}" at (${b?.cx || b?.centerX || '?'}, ${b?.cy || b?.centerY || '?'})\n`;
        });
      }
    }

    return state || null;
  }

  /**
   * Call LLM (OpenAI or Anthropic)
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
