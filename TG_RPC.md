# Telegram RPC Mode

## 概述

RPC 模式允许 OpenClaw 的 Telegram channel 将所有 `bot.api.*` 调用转发到外部 RPC 服务，而不是直接调用 Telegram API。这对于 relay-server 架构特别有用，因为它允许中央服务器统一处理所有 Telegram API 调用。

## 架构

```
标准模式:
┌─────────────┐  Update JSON   ┌─────────────┐  bot.api.*     ┌─────────────┐
│ Telegram    │ ──────────────▶│  OpenClaw   │ ──────────────▶│ Telegram    │
│ Webhook     │                │  telegram   │                │ API         │
└─────────────┘                └─────────────┘                └─────────────┘

RPC 模式:
┌─────────────┐  Update JSON   ┌─────────────┐  RPC call      ┌─────────────┐
│ relay-server│ ──────────────▶│  OpenClaw   │ ──────────────▶│ relay-server│
│  /tgrelay   │                │  telegram   │  ALL bot.api.* │ /telegram-  │
└─────────────┘                │  channel    │  calls hooked  │   rpc       │
                               └─────────────┘                └─────────────┘
```

## 实现原理

### grammY Transformer

grammY 提供了 Transformer API，允许拦截所有 `bot.api.*` 调用。我们利用这个机制创建了 `createRpcTransformer`，它：

1. 拦截所有 Telegram API 方法调用
2. 将方法名和参数序列化为 JSON
3. 通过 HTTP POST 发送到配置的 RPC 端点
4. 返回 RPC 响应作为 API 调用结果

### 关键文件

| 文件 | 作用 |
|------|------|
| `src/config/types.telegram.ts` | 定义 `TelegramRpcConfig` 类型 |
| `src/telegram/rpc-transformer.ts` | RPC transformer 实现 |
| `src/telegram/bot.ts` | 集成 RPC transformer |

## 配置

在 `config.json5` 中启用 RPC 模式：

```json5
{
  channels: {
    telegram: {
      botToken: "placeholder", // RPC 模式下可以是占位符
      rpc: {
        enabled: true,
        rpcUrl: "http://relay-server:3001/api/telegram-rpc",
        rpcHeaders: {
          "Authorization": "Bearer ${INBOUND_SECRET}"
        },
        rpcTimeout: 30000,  // 可选，默认 30000ms
        excludeMethods: ["getMe"]  // 可选，排除的方法将直接调用 Telegram API
      }
    }
  }
}
```

### 配置项说明

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `enabled` | boolean | 是 | 是否启用 RPC 模式 |
| `rpcUrl` | string | 是 | RPC 端点 URL |
| `rpcHeaders` | Record<string, string> | 否 | 附加的 HTTP 请求头 |
| `rpcTimeout` | number | 否 | 请求超时时间（毫秒），默认 30000 |
| `excludeMethods` | string[] | 否 | 排除的方法列表，这些方法将直接调用 Telegram API |

## RPC 请求格式

RPC 端点将收到 POST 请求，body 格式为：

```json
{
  "method": "sendMessage",
  "chat_id": 123456789,
  "text": "Hello, World!",
  "parse_mode": "HTML"
}
```

其中 `method` 是 Telegram Bot API 方法名，其余字段是该方法的参数。

## RPC 响应格式

RPC 端点应返回 Telegram Bot API 的标准响应格式：

```json
{
  "ok": true,
  "result": {
    "message_id": 123,
    "chat": { "id": 123456789 },
    "text": "Hello, World!"
  }
}
```

## 使用场景

### HoldClaw 多用户架构

在 HoldClaw 项目中，每个用户有独立的 OpenClaw 容器，但所有容器共享同一个 Telegram Bot。RPC 模式允许：

1. 用户容器不需要真实的 bot token
2. 所有 Telegram API 调用通过 relay-server 统一处理
3. relay-server 可以添加额外的鉴权和限流逻辑

### HoldClaw RPC 端点实现

HoldClaw 的 relay-server 提供了 `/api/telegram-rpc/[chatId]` 端点来处理 RPC 调用：

```typescript
// relay-server/src/app/api/telegram-rpc/[chatId]/route.ts
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params;
  
  // 验证 Authorization header
  const authHeader = request.headers.get('Authorization');
  const providedSecret = authHeader?.replace('Bearer ', '');
  
  // 查询用户并验证 secret
  const user = await dbGetAsync(
    'SELECT inbound_secret FROM users WHERE chat_id = $1',
    [chatId]
  );
  
  if (!user || user.inbound_secret !== providedSecret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  
  const { method, ...payload } = await request.json();
  const bot = getSenderBot();
  
  // 根据 method 调用对应的 Telegram API
  switch (method) {
    case 'sendMessage':
      const result = await bot.api.sendMessage(payload.chat_id, payload.text, ...);
      return NextResponse.json({ ok: true, result });
    // ... 其他方法
  }
}
```

### HoldClaw 环境变量配置

在创建用户容器时，通过环境变量启用 RPC：

```bash
TELEGRAM_RPC_ENABLED=true
TELEGRAM_RPC_URL=http://host.docker.internal:3001/api/telegram-rpc/{chatId}
TELEGRAM_RPC_SECRET={inbound_secret}
```

### HoldClaw docker-entrypoint.sh 配置生成

```bash
# 生成 telegram channel 配置（带 RPC）
if [ -n "${TELEGRAM_RPC_URL}" ] && [ "${TELEGRAM_RPC_ENABLED}" = "true" ]; then
  TELEGRAM_CONFIG="
    telegram: {
      enabled: true,
      botToken: \"placeholder\",
      rpc: {
        enabled: true,
        rpcUrl: \"${TELEGRAM_RPC_URL}\",
        rpcHeaders: {
          \"Authorization\": \"Bearer ${TELEGRAM_RPC_SECRET}\"
        },
        rpcTimeout: 30000
      },
      dmPolicy: \"open\",
      groupPolicy: \"disabled\"
    }"
fi
```

### 配置示例（HoldClaw）

```json5
{
  channels: {
    // tgrelay - HTTP webhook 方式（不使用 grammY）
    tgrelay: {
      enabled: true,
      outboundUrl: "http://relay-server:3001/api/openclaw-reply",
      inboundSecret: "${INBOUND_SECRET}",
      // ...
    },
    // telegram - grammY Bot 带 RPC 模式
    telegram: {
      enabled: true,
      botToken: "placeholder",
      rpc: {
        enabled: true,
        rpcUrl: "http://relay-server:3001/api/telegram-rpc/${CHAT_ID}",
        rpcHeaders: {
          "Authorization": "Bearer ${TGRELAY_INBOUND_SECRET}"
        }
      },
      dmPolicy: "open",
      groupPolicy: "disabled"
    }
  }
}
```

### 支持的 RPC 方法

HoldClaw relay-server 的 RPC 端点支持以下 Telegram Bot API 方法：

| 方法 | 说明 |
|------|------|
| `getMe` | 获取 bot 信息 |
| `sendMessage` | 发送文本消息 |
| `sendPhoto` | 发送图片 |
| `sendDocument` | 发送文档 |
| `sendAudio` | 发送音频 |
| `sendVideo` | 发送视频 |
| `sendVoice` | 发送语音 |
| `sendAnimation` | 发送动画 |
| `sendSticker` | 发送贴纸 |
| `editMessageText` | 编辑消息文本 |
| `deleteMessage` | 删除消息 |
| `setMessageReaction` | 设置消息反应 |
| `answerCallbackQuery` | 回复回调查询 |
| `sendChatAction` | 发送聊天动作 |
| `getFile` | 获取文件信息 |
| `getChatMember` | 获取聊天成员 |
| `getChat` | 获取聊天信息 |
| ... | 更多方法 |

## 错误处理

- RPC 请求失败时会记录错误日志
- 超时由 `AbortController` 处理
- 可以通过 `excludeMethods` 让某些方法绑过 RPC（如 `getMe`）

## 测试

```bash
# 运行单元测试
pnpm vitest run src/telegram/rpc-transformer.test.ts
```
