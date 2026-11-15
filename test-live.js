import { createAgentRuntime } from './dist/src/composition.js';
import { OpenAICompatibleAdapter } from './dist/src/model/openai-adapter.js';

async function testLive() {
  const apiKey = process.env.PI_AGENT_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Set PI_AGENT_API_KEY or OPENAI_API_KEY before running test-live.js');
  }
  const modelAdapter = new OpenAICompatibleAdapter({
    apiKey,
    baseURL: process.env.PI_AGENT_BASE_URL || 'https://api.openai.com/v1',
    proxy: process.env.PI_AGENT_PROXY || process.env.HTTP_PROXY,
  });

  const { runtime, registry } = createAgentRuntime({
    modelAdapter,
    approvalMode: 'never',
  });

  registry.register({
    name: 'execute_calc',
    description: '执行精准数学计算表达式',
    inputSchema: {
      type: 'object',
      required: ['expression'],
      properties: { expression: { type: 'string' } },
    },
    sideEffect: 'none',
    requiredPermissions: ['math:calc'],
    async execute(args) {
      console.log(`\n  ⚡ [Tool Executed Locally] 正在计算: ${args.expression}`);
      if (!/^[\d.+\-*/%()\s]+$/.test(args.expression)) {
        return { content: 'Error: unsupported expression', isError: true };
      }
      const val = Function(`'use strict'; return (${args.expression})`)();
      return { content: `Result: ${val}` };
    },
  });

  const session = await runtime.createSession({
    config: {
      model: 'cn:auto',
      systemPrompt: '你是一个内置在 Pi Runtime 里的高能力智能助手。遇到运算问题，请调用工具 execute_calc。',
      maxOutputTokens: 1000,
    },
  });

  console.log(`\n======================================================`);
  console.log(`🚀 正在发起真实模型对话与工具调用 (Tokyo wb2api)...`);
  console.log(`======================================================\n`);
  console.log(`💬 User: 请帮我用工具计算 (355 / 113) * 1000 的数值结果\n`);

  runtime.subscribe({ sessionId: session.id }, (e) => {
    if (e.type === 'step_started') {
      console.log(`\n▶️  [Step ${e.stepIndex}] 正在与模型交互...`);
    } else if (e.type === 'tool_execution_started') {
      console.log(`  ⚡ [Agent Loop] 捕获到模型发出的 Tool Call: ${e.toolName} (ID: ${e.toolCallId})`);
    } else if (e.type === 'tool_execution_finished') {
      console.log(`  ✔ [Agent Loop] 工具执行成功, 状态: ${e.status}, 耗时: ${e.durationMs}ms`);
    } else if (e.type === 'model_delta') {
      process.stdout.write(e.text);
    }
  });

  const handle = await runtime.startRun({
    sessionId: session.id,
    userInput: '请帮我用工具计算 (355 / 113) * 1000 的数值结果',
    principal: { id: 'live_user', kind: 'user', grants: ['math:calc'] },
  });

  const outcome = await handle.result;

  console.log(`\n\n======================================================`);
  console.log(`🎉 真实大模型 Run 完成:`);
  console.log(`  最终状态: ${outcome.status}`);
  console.log(`  停止原因: ${outcome.stopReason}`);
  console.log(`  最终回答: ${outcome.finalText}`);
  console.log(`======================================================\n`);
}

testLive().catch(console.error);
