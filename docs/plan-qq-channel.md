# neoclaw QQ Channel 接入调研与计划

更新时间：2026-03-08

## 1. 结论（先说结论）

在当前 `neoclaw` 架构下，**增加一个可用的 QQ channel 可行，建议优先按 OneBot 11 兼容协议接入**，把 QQ 客户端适配层放在 `neoclaw` 外部网关（如 NapCat / 其他兼容实现），`neoclaw` 只负责：

- 接收 inbound 事件
- 发送 outbound 消息
- 做 target 规范化、鉴权、去重、热更新

这样能最大程度复用现有 `Channel` 抽象、消息总线、配置热更新链路，也能把平台侧不稳定因素隔离在外部桥接层。

如果目标是“先可用”，建议先做：**OneBot 11 HTTP 入站 + HTTP 出站 + 文本消息 + mention / allowFrom / 去重**。  
如果目标是“稳定可长期运行”，再补：**持久化去重、重连、限流、媒体消息、错误恢复、系统化测试**。

## 2. 为什么优先 OneBot 11

从当前可查资料看，QQ 侧有两条路线：

### 方案 A：官方 QQ 开放平台

- 优点：官方能力、文档稳定、合规性更好
- 缺点：产品模型更偏“官方机器人 / 开放平台应用”，和当前 `neoclaw` 面向“多聊天工具自然收发”的定位不完全一致
- 更适合：以后如果要做正式平台应用、审核发布、官方事件订阅

### 方案 B：OneBot 11 兼容桥接（推荐 MVP）

- 优点：实现简单，和 `neoclaw` 现有 channel 模型最贴近
- 优点：消息事件天然适合映射到 `InboundMessage` / `OutboundMessage`
- 优点：可通过 NapCat 这类桥接层快速打通 QQ 收发
- 风险：依赖非官方桥接层，稳定性、风控、部署方式需要额外关注

**结论：**

- **MVP 推荐：OneBot 11 兼容接入**
- **长期可选：再评估官方 QQ 开放平台适配器**

## 3. 当前 neoclaw 现状（适合落点）

当前仓库已经具备接入新 channel 的主要基础设施：

- `src/channels/channel.ts` 已定义统一 `Channel` 接口
- `src/channels/manager.ts` 已负责 channel 注册、启动、停止、热更新、出站分发
- `src/config/schema.ts` 已有按 channel 组织的配置结构
- `src/bus/types.ts` 已定义统一的 `InboundMessage` / `OutboundMessage`
- `src/channels/feishu.ts` 已提供“企业 IM + webhook / websocket + target 规范化 + 去重”的近期参考样板

也就是说，QQ 接入不需要改整体架构，重点是新增一个 `qq` channel 并把配置、目标路由、协议映射补齐。

## 4. 参考项目可借鉴点

## 4.1 openclaw 可借鉴点

虽然 `openclaw` 当前同级仓库里没有直接可复用的 QQ 实现，但它在 channel 演进上有几个很值得借鉴的点：

- **target 规范化明确**：统一 `user:` / `channel:` 语义，避免平台 ID 歧义
- **channel routing 思路成熟**：路由由宿主决定，模型不直接决定 channel
- **多 channel 元数据组织清晰**：新增 channel 时，能力边界、target 规则、文档入口清楚

对 `neoclaw` 的启发：

- QQ 也应尽早确定统一 target 语义，而不是让业务层直接拼 OneBot 原始字段
- 建议从一开始就支持 `group:` / `private:` 这类稳定前缀

## 4.2 Memoh-v2 可借鉴点

`Memoh-v2` 的 channel 设计更接近我们当前要做的事：

- `adapter / descriptor / config / target` 分层清楚
- `manager` 负责连接生命周期与消息分发
- 适配器内部专注平台协议映射

对 `neoclaw` 的启发：

- QQ channel 内部最好拆出“配置校验 / target 解析 / 事件解析 / outbound 发送”几个 helper
- 不要把所有协议逻辑揉成一个超大文件；即便先单文件实现，也应按 helper 函数分层

## 5. QQ Channel 推荐技术方案

## 5.1 MVP 协议与部署形态

建议第一版采用：

- `neoclaw` 作为 **OneBot 11 HTTP 反向上报接收方**
- `neoclaw` 通过 **OneBot 11 HTTP API** 调用外部 QQ 网关发消息
- 外部 QQ 网关建议兼容 OneBot 11（如 NapCat）

这样对应到当前 `neoclaw` 最自然：

- inbound：类似现有 webhook channel
- outbound：类似现有 HTTP API 发送型 channel

首版**不建议**一上来就做 reverse websocket：

- 调试链路更复杂
- 热更新与断线恢复成本更高
- 先用 HTTP 打通最短路径，后续再补 websocket 模式更稳妥

## 5.2 chatId / senderId 规范

建议在 `neoclaw` 内部统一为：

- 群消息：`chatId = "group:<group_id>"`
- 私聊：`chatId = "private:<user_id>"`
- 发送者：`senderId = "<user_id>|<nickname?>"`

Outbound 目标建议支持以下输入：

- `group:<group_id>`
- `private:<user_id>`
- `qq:group:<group_id>`
- `qq:private:<user_id>`

不建议直接暴露 OneBot 原始 target 结构给上层业务，否则后续替换桥接层会很痛。

## 5.3 推荐配置草案

建议在 `src/config/schema.ts` 增加：

```ts
interface QQConfig {
  enabled: boolean;
  apiBase: string;
  accessToken: string;
  webhookPort: number;
  webhookPath: string;
  secret?: string;
  allowFrom?: string[];
  requireMention?: boolean;
  dedupPersist?: boolean;
  dedupFile?: string;
  webhookMaxBodyBytes?: number;
  webhookBodyTimeoutMs?: number;
  webhookRateLimitPerMin?: number;
}
```

首版就应该把这些留出来：

- 基础鉴权：`accessToken` / `secret`
- 入站安全：body 限额、超时、简单限流
- 运行稳定性：去重持久化
- 群聊控制：`requireMention`

## 5.4 OneBot 事件映射建议

### inbound

OneBot 常见事件可先支持：

- `message.private`
- `message.group`

映射建议：

- `post_type=message`
- `message_type=private|group`
- `raw_message` / 文本 segment 合成为 `content`
- `user_id` → `senderId`
- `group_id` / `user_id` → `chatId`
- `message_id`、`self_id`、原始 payload 放进 `metadata`

### outbound

首版仅支持文本：

- `group:<id>` → `send_group_msg`
- `private:<id>` → `send_private_msg`

第二阶段再补：

- 图片 / 文件 / 回复引用
- 合并转发 / markdown / richer segments

## 6. 开发切入点

建议变更点如下：

- 新增 `src/channels/qq.ts`
- 更新 `src/bus/types.ts` 的 `ChannelName`
- 更新 `src/config/schema.ts` 的 `ChannelsConfig`
- 更新 `src/channels/manager.ts`，接入 `QQChannel`
- 更新 `src/commands/web.ts` 的配置读写与脱敏逻辑
- 如 Web 管理台要支持，再补 `webapp` 的 channels 配置 UI
- 新增 `src/channels/__tests__/qq.test.ts`

## 7. 分阶段计划

## 阶段 A：协议与模型定稿（0.5 天）

- 明确 MVP 只支持 OneBot 11 HTTP 模式
- 敲定 `chatId` / `senderId` / outbound target 格式
- 明确配置字段与默认值

验收标准：

- 有一份稳定 target 规范，不再反复改名
- 配置字段足够支持本地调试与最小线上部署

## 阶段 B：最小可用实现（1 天）

- 新增 `QQChannel`
- 实现 webhook 接收入站
- 实现 HTTP API 文本发送
- 实现 `allowFrom`、`requireMention`
- 接入 `manager`、`schema`、`status`、配置热更新

验收标准：

- QQ 私聊可收发
- QQ 群聊被 @ 后可收发
- 配置更新后无需重启即可生效（能力允许范围内）

## 阶段 C：稳定性补齐（1~1.5 天）

- 入站去重（内存 + 可选持久化）
- webhook body 限额 / 超时 / 限流
- 同 chat 串行处理与错误日志完善
- OneBot 错误码包装成可读报错

验收标准：

- 重复事件不会短时间内重复入队
- 异常请求可快速 fail-close
- 常见配置错误能直接定位

## 阶段 D：消息能力增强（1 天）

- 图片 / 文件发送
- 回复引用映射
- 更多 CQ / segment 转纯文本规则

验收标准：

- 常见消息格式不会乱码或整段丢失
- 回复链在主要场景可用

## 阶段 E：测试与文档（0.5~1 天）

- 单测：target 解析、配置校验、事件解析、去重
- 文档：接入步骤、示例配置、NapCat 对接说明
- 如有需要，再补 Web 配置面板

验收标准：

- 核心逻辑有回归保护
- 新用户可按文档独立完成接入

## 8. 主要风险点

- **平台侧风险**：QQ 桥接层不是 `neoclaw` 自己控制，登录态与风控要单独兜底
- **协议差异**：不同 OneBot 兼容实现细节可能不完全一致
- **消息格式**：CQ / segment 到纯文本、媒体、引用的映射容易出现边界问题
- **群聊触发**：`@` 识别、昵称提及、撤回重放都要谨慎处理
- **现有工作区脏状态**：当前仓库已有未提交改动，开发时要避免和现有 Web 控制台改动互相污染

## 9. 我建议的实际开发顺序

1. 先做 `阶段 A + B`
2. 先不碰媒体与复杂 segment
3. 先只支持 `group:` / `private:` 两类 target
4. 先把测试补在 `qq.test.ts`
5. Web UI 最后接，避免在协议还没定时反复改表单

## 10. 参考资料

- OneBot 11 规范（消息与 API 基础）
- NapCat 官方仓库（OneBot 11 兼容桥接）
- QQ 开放平台官方文档（若后续要走官方机器人路线）
