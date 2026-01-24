import RBAClient from './rba.js';
import LLMClient from './llm.js';
import { config } from './config.js';
import { randomUUID } from 'crypto';

/**
 * Simple Reactive Agent
 *
 * The entire logic:
 * 1. Observe screen (get_device_snapshot)
 * 2. Ask AI what to do next
 * 3. Execute AI's command
 * 4. Validate response
 * 5. Log result to server
 * 6. Repeat until complete or max steps
 *
 * NO hardcoded logic. AI decides everything.
 */
class Agent {
  constructor(deviceSerial) {
    this.sn = deviceSerial;
    this.rba = new RBAClient();
    this.llm = new LLMClient();
  }

  /**
   * Run a task
   * @param {string} task - User's task description
   * @param {object} options - { maxSteps, taskId }
   * @returns {Promise<object>} Execution result
   */
  async run(task, options = {}) {
    const maxSteps = options.maxSteps || config.agent?.maxSteps || 25;
    const pauseMs = config.agent?.pauseBetweenSteps || 300;
    const taskId = options.taskId || randomUUID();

    const history = [];
    let step = 0;
    let completed = false;
    let fatalError = null;
    let validationError = null;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🤖 AGENT START`);
    console.log(`   Task: "${task}"`);
    console.log(`   Device: ${this.sn}`);
    console.log(`   Task ID: ${taskId}`);
    console.log(`   Max steps: ${maxSteps}`);
    console.log(`${'═'.repeat(60)}\n`);

    // Report task start
    await this.report({
      uuid: this.sn,
      task_id: taskId,
      type: 'start',
      task,
      payload: {
        maxSteps,
        device: this.sn
      }
    });

    while (step < maxSteps && !completed && !fatalError && !validationError) {
      step++;
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`📍 STEP ${step}/${maxSteps}`);

      // 1. OBSERVE - Get current screen state
      const state = await this.observe();

      // Check for fatal errors
      if (state._fatal) {
        fatalError = state._fatal;
        console.log(`❌ Fatal: ${fatalError.message}`);
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { fatal: fatalError, state: this.summarizeState(state) }
        });
        break;
      }

      // Check for validation errors in observation
      if (state._validationError) {
        validationError = { type: 'observation_validation', message: state.error };
        console.log(`❌ Validation Error: ${state.error}`);
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { validationError, state: this.summarizeState(state) }
        });
        break;
      }

      console.log(`   📱 App: ${state.foregroundPackage || 'unknown'}`);
      console.log(`   📊 Nodes: ${state.accessibilityNodes?.length || 0}, Text: ${state.screenAnalysis?.textElements?.length || 0}`);

      // Log focus state
      if (state.focusedElement) {
        console.log(`   🎯 Focused: ${state.focusedElement.className} "${state.focusedElement.text || state.focusedElement.resourceId || ''}"`);
      }
      if (state.keyboardLikelyVisible) {
        console.log(`   ⌨️ Keyboard visible`);
      }

      // 2. DECIDE - Ask AI for next action
      let action;
      try {
        action = await this.llm.getNextAction(state, task, history);
        console.log(`   🤖 AI: ${action.action} - ${action.description || ''}`);
        if (action.reason) {
          console.log(`   💭 Reason: ${action.reason}`);
        }
        if (action.params && Object.keys(action.params).length > 0) {
          console.log(`   📝 Params: ${JSON.stringify(action.params)}`);
        }
      } catch (error) {
        console.error(`   ❌ LLM Error: ${error.message}`);
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { llmError: error.message, state: this.summarizeState(state) }
        });
        break;
      }

      // 3. CHECK COMPLETION
      if (action.complete === true) {
        console.log(`\n✅ TASK COMPLETE: ${action.reason || 'AI marked as complete'}`);
        completed = true;
        history.push({ step, action, result: { success: true, message: 'Completed' }, state: this.summarizeState(state) });
        
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { action, completed: true, state: this.summarizeState(state) }
        });
        break;
      }

      // 4. EXECUTE - Run the action
      const result = await this.rba.call(this.sn, action.action, action.params || {});

      // Check for fatal errors
      if (result._fatal) {
        fatalError = result._fatal;
        console.log(`   ❌ Fatal: ${fatalError.message}`);
        history.push({ step, action, result, state: this.summarizeState(state) });
        
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { action, result, fatal: fatalError, state: this.summarizeState(state) }
        });
        break;
      }

      // Check for validation errors (missing params, etc.)
      if (result._validationError) {
        validationError = { 
          type: 'param_validation', 
          message: result.error,
          missingParams: result.missingParams 
        };
        console.log(`   ❌ Validation Error: ${result.error}`);
        history.push({ step, action, result, state: this.summarizeState(state) });
        
        await this.report({
          uuid: this.sn,
          task_id: taskId,
          type: 'process',
          task,
          step,
          payload: { action, validationError, state: this.summarizeState(state) }
        });
        break;
      }

      // Check for response validation warnings
      if (result._responseValidation && !result._responseValidation.valid) {
        console.log(`   ⚠️ Response validation issues: ${result._responseValidation.errors.join(', ')}`);
      }

      // Log result
      const icon = result.success ? '✅' : '❌';
      console.log(`   ${icon} Result: ${result.success ? 'OK' : result.error || 'Failed'}`);

      // 5. RECORD - Add to history
      history.push({
        step,
        action,
        result: { success: result.success, error: result.error },
        state: this.summarizeState(state)
      });

      // Report step to server
      await this.report({
        uuid: this.sn,
        task_id: taskId,
        type: 'process',
        task,
        step,
        payload: {
          action,
          result: { success: result.success, error: result.error },
          state: this.summarizeState(state)
        }
      });

      // Pause between steps
      if (pauseMs > 0 && step < maxSteps) {
        await this.sleep(pauseMs);
      }
    }

    // Build final result
    const success = completed && !fatalError && !validationError;
    const reason = fatalError ? 'fatal_error' :
        validationError ? 'validation_error' :
        completed ? 'completed' :
        step >= maxSteps ? 'max_steps' : 'unknown';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`🏁 AGENT ${success ? 'SUCCESS' : 'STOPPED'}`);
    console.log(`   Steps: ${step}`);
    console.log(`   Reason: ${reason}`);
    if (fatalError) console.log(`   Fatal: ${fatalError.message}`);
    if (validationError) console.log(`   Validation: ${validationError.message}`);
    console.log(`${'═'.repeat(60)}\n`);

    const finalResult = {
      success,
      task,
      taskId,
      device: this.sn,
      steps: step,
      reason,
      history,
      fatalError,
      validationError
    };

    // Report task completion
    await this.report({
      uuid: this.sn,
      task_id: taskId,
      type: 'done',
      task,
      payload: finalResult,
      output: this.buildOutput(finalResult, history)
    });

    return finalResult;
  }

  /**
   * Report event to server
   */
  async report(event) {
    try {
      await this.rba.reportEvent(event);
    } catch (e) {
      // Don't fail main flow if reporting fails
      console.warn(`⚠️ Report failed: ${e.message}`);
    }
  }

  /**
   * Build human-readable output for done event
   */
  buildOutput(result, history) {
    const lines = [];
    lines.push(`Task: ${result.task}`);
    lines.push(`Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
    lines.push(`Steps: ${result.steps}`);
    lines.push(`Reason: ${result.reason}`);
    
    if (result.fatalError) {
      lines.push(`Error: ${result.fatalError.message}`);
    }
    if (result.validationError) {
      lines.push(`Validation: ${result.validationError.message}`);
    }
    
    return lines.join('\n');
  }

  /**
   * Observe current screen state
   */
  async observe() {
    const response = await this.rba.call(this.sn, 'get_device_snapshot', {
      include_screen_analysis: true,
      include_ui_nodes: true,
      ui_nodes_limit: 500
    });

    if (!response.success) {
      return { 
        _fatal: response._fatal,
        _validationError: response._validationError,
        error: response.error
      };
    }

    const snapshot = response.snapshot || {};

    // Parse and structure the state
    const state = {
      foregroundPackage: snapshot.foreground_package,
      screenWidth: snapshot.screen_width,
      screenHeight: snapshot.screen_height,
      installedApps: snapshot.installed_apps,
      screenAnalysis: null,
      accessibilityNodes: null,
      focusedElement: null,
      keyboardLikelyVisible: false
    };

    // Screen analysis (OCR)
    if (snapshot.screen_analysis) {
      const sa = snapshot.screen_analysis;
      state.screenAnalysis = {
        screenWidth: sa.screenWidth,
        screenHeight: sa.screenHeight,
        textCount: sa.textCount,
        uiCount: sa.uiCount,
        textElements: (sa.textElements || []).slice(0, 20).map(el => ({
          text: el.text,
          center: el.center,
          bounds: el.bounds,
          confidence: el.confidence
        })),
        uiElements: (sa.uiElements || []).slice(0, 15).map(el => ({
          type: el.type,
          center: el.center,
          bounds: el.bounds
        }))
      };
    }

    // Accessibility nodes
    const nodes = snapshot.ui_nodes?.nodes || [];
    if (nodes.length > 0) {
      // Detect focused element
      const focusedNode = nodes.find(n => n.focused === true);
      if (focusedNode) {
        state.focusedElement = {
          text: focusedNode.text,
          className: focusedNode.className?.split('.').pop(),
          resourceId: focusedNode.resourceId,
          isEditText: focusedNode.className?.includes('EditText'),
          center: focusedNode.bounds ? {
            x: Math.round((focusedNode.bounds.left + focusedNode.bounds.right) / 2),
            y: Math.round((focusedNode.bounds.top + focusedNode.bounds.bottom) / 2)
          } : null
        };
      }

      // Detect if keyboard might be visible (heuristic: many small clickable nodes at bottom)
      const screenHeight = snapshot.screen_height || 2000;
      const bottomNodes = nodes.filter(n =>
          n.bounds &&
          n.bounds.top > screenHeight * 0.6 &&
          n.clickable &&
          (n.bounds.bottom - n.bounds.top) < 150  // Small height = likely keyboard key
      );
      state.keyboardLikelyVisible = bottomNodes.length > 10;

      // Filter to interesting nodes (clickable, focusable, text inputs)
      const interesting = nodes
          .filter(n => n.clickable || n.focusable || n.focused ||
              n.className?.includes('EditText') ||
              n.className?.includes('Button'))
          .slice(0, 30);

      state.accessibilityNodes = interesting.map(n => ({
        text: n.text,
        className: n.className?.split('.').pop(),
        contentDescription: n.contentDescription,
        resourceId: n.resourceId,
        bounds: n.bounds,
        center: n.bounds ? {
          x: Math.round((n.bounds.left + n.bounds.right) / 2),
          y: Math.round((n.bounds.top + n.bounds.bottom) / 2)
        } : null,
        clickable: n.clickable,
        focusable: n.focusable,
        focused: n.focused,
        selected: n.selected
      }));
    }

    return state;
  }

  /**
   * Create a brief state summary for history
   */
  summarizeState(state) {
    return {
      app: state.foregroundPackage,
      nodes: state.accessibilityNodes?.length || 0,
      texts: state.screenAnalysis?.textElements?.length || 0,
      focused: state.focusedElement?.className || null,
      keyboard: state.keyboardLikelyVisible
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default Agent;
