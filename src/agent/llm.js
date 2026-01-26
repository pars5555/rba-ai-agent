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
   * Build execution prompt - just task, plan, current step, and last result
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

    // Last result
    if (lastResult) {
      prompt += `\n═══ LAST RESULT ═══\n`;
      prompt += JSON.stringify(lastResult, null, 2) + '\n';
    }

    prompt += `\nRespond with JSON.`;
    return prompt;
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
