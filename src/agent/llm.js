import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { log, logLlmCall, logLlmResponse, logLlmError } from '../logger.js';

/**
 * LLM Client with Task Planner Architecture
 * 
 * Two-phase approach:
 * 1. Planning Phase: Create a structured plan from the task
 * 2. Execution Phase: Execute each step, only sending plan context (not growing history)
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
   * Update agent config (used when config is reloaded)
   */
  setAgentConfig(agentConfig) {
    this.agentConfig = agentConfig;
  }

  /**
   * PHASE 1: Create a plan for the task
   * Returns a structured plan with steps
   */
  async createPlan(task, initialSnapshot = null) {
    const planningPrompt = this.buildPlanningPrompt(task, initialSnapshot);
    
    logLlmCall(0, false);
    log(`📋 Creating plan for task: "${task}"`);

    try {
      let content;
      if (this.provider === 'openai') {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: this.agentConfig.planningPrompt },
            { role: 'user', content: planningPrompt }
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        });
        content = response.choices[0].message.content;
      } else {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 1024,
          system: this.agentConfig.planningPrompt,
          messages: [{ role: 'user', content: planningPrompt }]
        });
        content = response.content[0].text;
      }

      const plan = JSON.parse(content);
      logLlmResponse('plan_created', false, `${plan.steps?.length} steps`);

      return plan;
    } catch (error) {
      logLlmError(error.message);
      throw error;
    }
  }

  /**
   * PHASE 2: Execute a specific step from the plan
   * Only sends plan context + current step (no growing history)
   */
  async executeStep(task, plan, currentStepIndex, lastResult = null) {
    const executionPrompt = this.buildExecutionPrompt(task, plan, currentStepIndex, lastResult);
    
    logLlmCall(currentStepIndex, !!lastResult);

    try {
      let content;
      if (this.provider === 'openai') {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: this.agentConfig.executionPrompt },
            { role: 'user', content: executionPrompt }
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        });
        content = response.choices[0].message.content;
      } else {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 512,
          system: this.agentConfig.executionPrompt,
          messages: [{ role: 'user', content: executionPrompt }]
        });
        content = response.content[0].text;
      }

      const totalChars = this.agentConfig.executionPrompt.length + executionPrompt.length;
      log(`📨 LLM Request: ${totalChars} chars (step ${currentStepIndex + 1}/${plan.steps.length})`);

      const result = JSON.parse(content);
      logLlmResponse(result.action, result.complete || result.stepComplete, result.reason);

      // Validate action exists in registry
      if (!result.complete && !result.stepComplete && result.action && !this.agentConfig.registry[result.action]) {
        log(`Unknown action: ${result.action}, falling back to snapshot`);
        return { action: 'get_device_snapshot', params: {}, reason: 'Checking device state' };
      }

      return result;
    } catch (error) {
      logLlmError(error.message);
      throw error;
    }
  }

  /**
   * Build prompt for planning phase
   */
  buildPlanningPrompt(task, snapshot = null) {
    let prompt = `TASK: ${task}\n`;

    if (snapshot) {
      prompt += `\nCURRENT DEVICE STATE:\n`;
      prompt += `- Foreground app: ${snapshot.foreground_package || 'unknown'}\n`;
      prompt += `- Screen: ${snapshot.screen_width}x${snapshot.screen_height}\n`;
      if (snapshot.flashlight_status) prompt += `- Flashlight: ${snapshot.flashlight_status}\n`;
      if (snapshot.battery_level) prompt += `- Battery: ${snapshot.battery_level}%\n`;
      if (snapshot.is_wifi_connected !== undefined) prompt += `- WiFi: ${snapshot.is_wifi_connected ? 'connected' : 'disconnected'}\n`;
    }

    prompt += `\nCreate a step-by-step plan to complete this task. Respond with JSON.`;
    return prompt;
  }

  /**
   * Build prompt for execution phase
   */
  buildExecutionPrompt(task, plan, currentStepIndex, lastResult = null) {
    let prompt = `TASK: ${task}\n`;

    // Include interactive message if available
    const interactiveMessage = this.getInteractiveMessage?.();
    if (interactiveMessage) {
      prompt += `\n💬 USER MESSAGE: "${interactiveMessage}"\n`;
    }

    // Show the plan with progress
    prompt += `\n═══ PLAN PROGRESS ═══\n`;
    plan.steps.forEach((step, i) => {
      const status = i < currentStepIndex ? '✓' : (i === currentStepIndex ? '▶' : '○');
      prompt += `${status} Step ${i + 1}: ${step.description}\n`;
    });

    prompt += `\n═══ CURRENT STEP ═══\n`;
    prompt += `Step ${currentStepIndex + 1}/${plan.steps.length}: ${plan.steps[currentStepIndex].description}\n`;
    
    if (plan.steps[currentStepIndex].expectedAction) {
      prompt += `Expected action: ${plan.steps[currentStepIndex].expectedAction}\n`;
    }

    if (lastResult) {
      prompt += `\n═══ LAST RESULT ═══\n`;
      prompt += JSON.stringify(lastResult, null, 2) + '\n';
    }

    prompt += `\nExecute this step. Return JSON with action or mark stepComplete/complete if done.`;
    return prompt;
  }
}

export default LLMClient;
