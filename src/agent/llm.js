import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { emit, estimateTokens, truncateForLog, buildUserPrompt, callLLMWithRetry, createLogger } from './util.js';

/**
 * LLM Client v3.1 - Minimal with utils
 */
class LLMClient {
  constructor(config, agentConfig, getInteractiveMessage) {
    const { log } = createLogger('llm.js');
    this.log = log;
    this.agentConfig = agentConfig;
    this.getInteractiveMessage = getInteractiveMessage;
    this.maxLogLength = config.logging?.maxBodyLogLength || 2000;

    const provider = config.llm.provider;
    this.provider = provider;
    this.temperature = config.llm.temperature;

    if (provider === 'openai') {
      this.client = new OpenAI({ apiKey: config.llm.openai.apiKey });
      this.model = config.llm.openai.model;
    } else if (provider === 'anthropic') {
      this.client = new Anthropic({ apiKey: config.llm.anthropic.apiKey });
      this.model = config.llm.anthropic.model;
    } else {
      throw new Error(`Unknown LLM provider: ${provider}`);
    }
  }

  async createPlan(task) {
    const systemPrompt = this.agentConfig.planningPrompt;
    const userPrompt = `TASK: ${task}\n\nCreate a step-by-step plan. Respond with JSON only.`;

    this.log(`\n${'═'.repeat(60)}`);
    this.log(`📋 PLANNING PHASE`);
    this.log(`${'═'.repeat(60)}`);
    this.log(`📝 Task: "${task}"`);
    this.log(`📊 ~${estimateTokens(systemPrompt + userPrompt)} tokens`);

    const content = await callLLMWithRetry({
      provider: this.provider, client: this.client, model: this.model,
      systemPrompt, userPrompt, temperature: this.temperature
    });

    const plan = JSON.parse(content);
    this.log(`📥 PLAN: ${plan.steps?.length || 0} steps`);
    plan.steps?.forEach((s, i) => this.log(`   ${i + 1}. ${s.description}`));
    return plan;
  }

  async executeStep(task, plan, currentStepIndex, stepActions = [], lastResult = null) {
    const systemPrompt = this.agentConfig.executionPrompt;
    const interactiveMessage = this.getInteractiveMessage?.();
    
    const userPrompt = buildUserPrompt({ task, plan, currentStepIndex, stepActions, lastResult, interactiveMessage });

    this.log(`\n${'─'.repeat(60)}`);
    this.log(`🎯 STEP ${currentStepIndex + 1}/${plan.steps.length}: ${plan.steps[currentStepIndex].description}`);
    this.log(`📊 ~${estimateTokens(systemPrompt + userPrompt)} tokens, ${stepActions.length} actions in step`);
    this.log(`📤 USER PROMPT:`);
    this.log(truncateForLog(userPrompt, this.maxLogLength));
    this.log(`${'─'.repeat(60)}`);

    emit('llm_request', {
      step: currentStepIndex, totalSteps: plan.steps.length, stepActions: stepActions.length,
      estimatedTokens: estimateTokens(systemPrompt + userPrompt),
      source: 'llm.js'
    });

    const content = await callLLMWithRetry({
      provider: this.provider, client: this.client, model: this.model,
      systemPrompt, userPrompt, temperature: this.temperature
    });

    this.log(`📥 AI RAW: ${content}`);
    
    let result;
    try {
      result = JSON.parse(content);
    } catch (e) {
      this.log(`❌ JSON Parse Error: ${e.message}`);
      throw new Error(`Invalid JSON from AI: ${e.message}`);
    }

    // Log parsed response
    if (result.complete) this.log(`📥 AI: ✅ TASK COMPLETE - ${result.reason}`);
    else if (result.stepComplete) this.log(`📥 AI: ✓ Step complete - ${result.reason}`);
    else if (result.error) this.log(`📥 AI: ❌ ERROR - ${result.error}`);
    else {
      this.log(`📥 AI: ${result.action} - ${result.reason}`);
      if (result.params && Object.keys(result.params).length > 0) this.log(`   Params: ${JSON.stringify(result.params)}`);
    }

    // Validate action exists
    if (!result.complete && !result.stepComplete && !result.error && result.action) {
      if (!this.agentConfig.registry[result.action]) {
        this.log(`⚠️ Unknown action: ${result.action}, defaulting to get_device_snapshot`);
        return { action: 'get_device_snapshot', params: {}, reason: 'Checking screen' };
      }
    }

    return result;
  }
}

export default LLMClient;