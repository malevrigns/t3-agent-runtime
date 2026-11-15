import { createAgentRuntime } from './composition.js';
import { FakeModelAdapter } from './model/fake-adapter.js';
import type { Principal } from './core/types.js';

async function main() {
  console.log('====================================================');
  console.log('🚀 正在启动 Pi-Style AI Agent Runtime (TypeScript V1)...');
  console.log('====================================================\n');

  // 1. 初始化模型适配器 (使用确定性 FakeModel 演示多轮交互与工具调用)
  const model = new FakeModelAdapter();

  // 2. 装配并创建 Agent Runtime
  const { runtime, registry, bus } = createAgentRuntime({
    modelAdapter: model,
    approvalMode: 'ask_for_side_effects',
  });

  // 3. 注册两个演示工具：一个只读工具，一个带副作用的计算工具
  registry.register({
    name: 'read_workspace_file',
    description: '读取工作区文件内容',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
      },
    },
    sideEffect: 'none',
    requiredPermissions: ['fs:read'],
    async execute(args: { path: string }) {
      console.log(`  🔧 [Tool: read_workspace_file] 正在读取磁盘文件: ${args.path}`);
      return {
        content: `// ${args.path}\nexport const dbConfig = { host: "127.0.0.1", port: 5432, user: "admin" };`,
      };
    },
  });

  registry.register({
    name: 'apply_patch',
    description: '修改文件内容',
    inputSchema: {
      type: 'object',
      required: ['path', 'diff'],
      properties: {
        path: { type: 'string' },
        diff: { type: 'string' },
      },
    },
    sideEffect: 'idempotent',
    requiredPermissions: ['fs:write'],
    async execute(args: { path: string; diff: string }) {
      console.log(`  🔧 [Tool: apply_patch] 正在对 ${args.path} 应用变更: ${args.diff}`);
      return {
        content: `Success: Patch applied cleanly to ${args.path}`,
      };
    },
  });

  // 4. 创建持久化会话 Session
  const session = await runtime.createSession({
    title: 'Demo Coding Session',
    config: {
      model: 'pi-agent-v1',
      systemPrompt: '你是一个专业的系统重构专家。',
      maxOutputTokens: 1000,
      tools: ['read_workspace_file', 'apply_patch'],
    },
  });
  console.log(`✅ 会话创建成功: Session ID = ${session.id}\n`);

  // 5. 监听运行时的持久事件流 (实时监控每一步流转)
  runtime.subscribe({ sessionId: session.id }, (e) => {
    switch (e.type) {
      case 'run_started':
        console.log(`📌 [Event: Run Started] Run ID = ${e.runId}`);
        break;
      case 'step_started':
        console.log(`\n▶️  [Event: Step ${e.stepIndex} Started] 准备构建上下文并向模型请求...`);
        break;
      case 'context_built':
        console.log(`  📦 [Event: Context Built] 估算 Token = ${e.estimatedTokens}, 裁剪消息数 = ${e.manifest.droppedMessageCount}`);
        break;
      case 'model_call_finished':
        console.log(`  🧠 [Event: Model Call Finished] 完成推理, 消耗 Input=${e.usage.inputTokens}, Output=${e.usage.outputTokens}, 结束原因=${e.finishReason}`);
        break;
      case 'tool_execution_started':
        console.log(`  ⚡ [Event: Tool Started] 调用工具 ${e.toolName} (CallId: ${e.toolCallId})`);
        break;
      case 'tool_execution_finished':
        console.log(`  ✅ [Event: Tool Finished] ${e.toolCallId} 执行完毕, 状态: ${e.status}, 耗时: ${e.durationMs}ms`);
        break;
      case 'run_finished':
        console.log(`\n🏁 [Event: Run Finished] 状态: ${e.status}, 终止原因: ${e.stopReason}`);
        break;
    }
  });

  // 6. 设定模型的两轮思考规划
  // Step 0: 模型思考并决定调用 read_workspace_file
  model.enqueueToolCall(
    'call_inspect_01',
    'read_workspace_file',
    { path: 'config.ts' },
    '我需要先查看 config.ts 里的数据库配置'
  );

  // Step 1: 模型拿到文件内容后，决定调用 apply_patch 修改端口
  model.enqueueToolCall(
    'call_patch_02',
    'apply_patch',
    { path: 'config.ts', diff: '+ port: 5433' },
    '发现端口是 5432，按用户要求修改为 5433'
  );

  // Step 2: 模型最终回答用户
  model.enqueueText('我已经成功查看了 config.ts 并将数据库端口更新为了 5433。');

  const principal: Principal = {
    id: 'developer_user',
    kind: 'user',
    grants: ['fs:read', 'fs:write'],
  };

  console.log('💬 [User Prompt]: 请帮我把 config.ts 里的数据库端口从 5432 改成 5433\n');

  // 7. 发起 Run 并等待结果
  const handle = await runtime.startRun({
    sessionId: session.id,
    userInput: '请帮我把 config.ts 里的数据库端口从 5432 改成 5433',
    principal,
  });

  const outcome = await handle.result;

  console.log('\n====================================================');
  console.log('🎉 最终运行结果 (Run Outcome):');
  console.log(`  状态: ${outcome.status}`);
  console.log(`  结束原因: ${outcome.stopReason}`);
  console.log(`  模型回复: "${outcome.finalText}"`);
  console.log(`  Token 统计: 输入 ${outcome.usage.inputTokens}, 输出 ${outcome.usage.outputTokens}`);
  console.log('====================================================\n');
}

main().catch(console.error);
