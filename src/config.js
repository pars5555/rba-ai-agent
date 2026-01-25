import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load default config
const configPath = join(__dirname, '../config/config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

// Override with local config if exists
const localConfigPath = join(__dirname, '../config/local_config.json');
if (existsSync(localConfigPath)) {
  const localConfig = JSON.parse(readFileSync(localConfigPath, 'utf-8'));
  deepMerge(config, localConfig);
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

export { config };
