# T3 Agent Runtime

T3 的终端 Agent 运行时。单代理循环，会话、记忆、项目沙箱和终端界面都在这个仓库里。

## 核心设计特性

1. **三层解耦与显式契约**：严格遵循 [backend-skill](https://github.com/malevrigns/backend-skill) 架构准则，将 Model Adapter、Tool Registry、Tool Executor、Memory Manager、Session Store 完全接口解耦。
2. **唯一组合根 (`composition.ts`)**：全系统只有装配根 import 具体基础设施实现，业务与编排层不直接耦合底层驱动。
3. **确定性状态机与单活动 Run 互斥锁**：
   - SQLite 局部唯一索引保证同一 Session 内同一时刻只有一个活动 Run。
   - 彻底避免并发数据写穿与状态错乱。
4. **工具执行幂等性与意图先行 (WAL)**：
   - 执行前先写入 `tool_executions(status='running')` 与幂等键；
   - 重复请求安全复用已有结果，防止副作用工具双重调用。
5. **生产级崩溃恢复 (Crash Recovery)**：
   - 基于 Lease 租约过期自动感知宕机；
   - 自动将悬空工具标记终态（非幂等标记为 `unknown`，只读标记为 `failed`）；
   - **自动合成 `tool_result` 消息补齐 LLM 对话协议**，恢复后历史自洽，Session 立即解封。
6. **零外部重依赖**：
   - 存储层采用 Node.js 22+ 原生自带的高性能 `node:sqlite` (DatabaseSync)，无需编译 C++ 原生模块，开箱即用。

## 目录结构

```
.
├── src/
│   ├── core/           # 领域类型、错误定义、ULID 生成器
│   ├── model/          # ModelAdapter 接口契约与 FakeModel 桩
│   ├── tools/          # ToolRegistry、ToolExecutor、权限策略
│   ├── memory/         # ContextBuilder 上下文装配与摘要维护
│   ├── store/          # SessionStore 契约与 Sqlite 驱动实现
│   ├── events/         # 异步解耦事件总线 EventBus
│   ├── runtime/        # AgentLoop 编排主循环、RecoveryService、Runtime 门面
│   ├── composition.ts  # 依赖装配根
│   └── index.ts        # 模块统一导出
└── tests/
    ├── store.contract.test.ts  # SQLite 存储契约与互斥测试
    ├── recovery.test.ts        # 断电/崩溃与 Lease 过期恢复测试
    └── e2e.test.ts             # 端到端多轮 LLM->Tool->LLM 测试
```

## 构建与运行测试

```bash
# 编译 TypeScript
npm run build

npm test
```
