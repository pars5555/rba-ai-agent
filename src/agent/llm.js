import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { log, logLlmCall, logLlmResponse, logLlmError } from '../logger.js';

/**
 * LLM Client
 * Communicates with AI providers (OpenAI, Anthropic) for decision making
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
      const totalChars = this.agentConfig.prompt.length + userPrompt.length;
      log(`📨 LLM Request: ${totalChars} chars (system: ${this.agentConfig.prompt.length}, user: ${userPrompt.length})`);

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

    // Include interactive message if available
    const interactiveMessage = this.getInteractiveMessage?.();
    if (interactiveMessage) {
      prompt += `\n💬 USER MESSAGE DURING TASK: "${interactiveMessage}"\n`;
    }

    if (history.length > 0) {
      prompt += `\nHISTORY (${history.length} actions):\n`;
      history.forEach((h, i) => {
        const status = h.success ? '✓' : '✗';
        const params = h.params && Object.keys(h.params).length > 0 ? ` ${JSON.stringify(h.params)}` : '';
        prompt += `  ${i + 1}. [${status}] ${h.action}${params}\n`;
      });

    }

    if (lastResult) {
      prompt += `\nLAST RESULT:\n${JSON.stringify(lastResult, null, 2)}\n`;
    }

    prompt += `\nNext action? Remember: observe after actions, avoid loops. Include "details" field explaining your reasoning.`;
    return prompt;
  }
}

export default LLMClient;