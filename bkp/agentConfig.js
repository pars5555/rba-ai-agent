/**
 * Shared agent config store
 * Holds prompt and registry loaded from PHP server
 */

let agentConfig = {
  prompt: null,
  registry: null,
  loadedAt: null
};

export function getAgentConfig() {
  return agentConfig;
}

export function setAgentConfig(prompt, registry) {
  agentConfig.prompt = prompt;
  agentConfig.registry = registry;
  agentConfig.loadedAt = new Date().toISOString();
}
