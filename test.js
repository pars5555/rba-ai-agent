import Agent from './src/agent.js';

/**
 * Test script - Run a task directly without server
 * 
 * Usage:
 *   node test.js "Open Chrome and search for weather"
 *   node test.js "Open Settings" DEVICE_SERIAL
 */

const task = process.argv[2] || 'Open Chrome and search for weather';
const deviceSN = process.argv[3] || 'TEST_DEVICE';

async function main() {
  console.log('🧪 Testing RBA AI Agent (Simplified)\n');
  console.log(`Task: "${task}"`);
  console.log(`Device: ${deviceSN}\n`);

  const agent = new Agent(deviceSN);
  const result = await agent.run(task);

  console.log('\n📊 Final Result:');
  console.log(JSON.stringify({
    success: result.success,
    task: result.task,
    steps: result.steps,
    reason: result.reason
  }, null, 2));

  if (result.history?.length > 0) {
    console.log('\n📜 Action History:');
    result.history.forEach((h, i) => {
      const icon = h.result?.success ? '✅' : '❌';
      console.log(`  ${icon} ${h.step}. ${h.action?.action} - ${h.action?.description || ''}`);
    });
  }
}

main().catch(console.error);
