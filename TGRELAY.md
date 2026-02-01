# Telegram Relay (tgrelay) 接入文档

Telegram Relay 是一个 HTTP webhook 桥接通道，允许你通过自定义的 HTTP 服务将 Telegram 消息转发到 OpenClaw，并将回复发送回 Telegram。

## 架构概述

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Telegram   │────▶│  你的中继服务     │────▶│  OpenClaw   │
│  Bot API    │◀────│  (Relay Server)  │◀────│  Gateway    │
└─────────────┘     └──────────────────┘     └─────────────┘
```

**工作流程：**
1. Telegram 用户发送消息到你的 Bot
2. Telegram Bot API 将消息推送到你的中继服务
3. 中继服务将消息转发到 OpenClaw Gateway（Telegram Update 格式）
4. OpenClaw 处理消息并生成回复
5. OpenClaw 将回复发送到你配置的 `outboundUrl`
6. 你的中继服务调用 Telegram Bot API 发送回复

## 快速开始

### 1. 安装扩展

```bash
openclaw plugins install @openclaw/tgrelay
```

### 2. 配置 OpenClaw

在 `~/.openclaw/config.json5` 中添加：

```json5
{
  channels: {
    tgrelay: {
      enabled: true,
      // 接收 OpenClaw 回复的 URL（你的中继服务）
      outboundUrl: "https://your-relay-server.com/openclaw-reply",
      // 可选：webhook 路径（默认 /tgrelay）
      webhookPath: "/tgrelay",
      // 可选：入站请求验证密钥
      inboundSecret: "your-secret-token",
      // 可选：出站请求头
      outboundHeaders: {
        "Authorization": "Bearer your-api-key"
      },
      // 可选：Bot 用户名（用于群组 @mention 检测）
      botUsername: "your_bot",
      // DM 访问策略
      dm: {
        policy: "pairing",  // pairing | allowlist | open | disabled
        allowFrom: []       // 允许的用户 ID 列表
      },
      // 群组策略
      groupPolicy: "allowlist",  // open | allowlist | disabled
      groups: {
        "*": { requireMention: true }
      }
    }
  }
}
```

### 3. 启动 Gateway

```bash
openclaw gateway run
```

## 入站消息格式（发送到 OpenClaw）

你的中继服务需要将 Telegram 消息转发到 OpenClaw Gateway 的 webhook 端点。

**请求格式：**

```http
POST /tgrelay HTTP/1.1
Host: your-openclaw-gateway:8787
Content-Type: application/json
X-Telegram-Bot-Api-Secret-Token: your-secret-token

{
  "update_id": 123456789,
  "message": {
    "message_id": 1,
    "from": {
      "id": 123456789,
      "is_bot": false,
      "first_name": "John",
      "last_name": "Doe",
      "username": "johndoe"
    },
    "chat": {
      "id": 123456789,
      "type": "private",
      "first_name": "John",
      "last_name": "Doe",
      "username": "johndoe"
    },
    "date": 1704067200,
    "text": "Hello, bot!"
  }
}
```

**支持的消息类型：**

- `message` - 普通消息
- `edited_message` - 编辑的消息
- `channel_post` - 频道消息

**消息字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `update_id` | number | 必需，更新 ID |
| `message.message_id` | number | 消息 ID |
| `message.from.id` | number | 发送者用户 ID |
| `message.from.username` | string | 发送者用户名 |
| `message.from.first_name` | string | 发送者名字 |
| `message.chat.id` | number | 聊天 ID |
| `message.chat.type` | string | 聊天类型：private/group/supergroup/channel |
| `message.date` | number | Unix 时间戳 |
| `message.text` | string | 消息文本 |
| `message.caption` | string | 媒体消息的标题 |
| `message.reply_to_message` | object | 回复的消息 |
| `message.message_thread_id` | number | 话题 ID（论坛群组） |

## 出站消息格式（OpenClaw 发送的回复）

OpenClaw 会将回复发送到你配置的 `outboundUrl`。

**请求格式：**

```http
POST /openclaw-reply HTTP/1.1
Host: your-relay-server.com
Content-Type: application/json
Authorization: Bearer your-api-key

{
  "method": "sendMessage",
  "chat_id": 123456789,
  "text": "Hello! How can I help you?",
  "parse_mode": "HTML",
  "reply_to_message_id": 1,
  "message_thread_id": null,
  "disable_notification": false
}
```

**支持的方法：**

| 方法 | 说明 |
|------|------|
| `sendMessage` | 发送文本消息 |
| `sendPhoto` | 发送图片 |
| `sendDocument` | 发送文件 |
| `sendAudio` | 发送音频 |
| `sendVideo` | 发送视频 |
| `sendVoice` | 发送语音 |

**响应格式：**

你的中继服务应返回 JSON 响应：

```json
{
  "ok": true,
  "result": {
    "message_id": 2,
    "chat": {
      "id": 123456789
    }
  }
}
```

或简化格式：

```json
{
  "ok": true,
  "message_id": 2,
  "chat_id": 123456789
}
```

## 中继服务示例

### Node.js 示例

```javascript
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENCLAW_GATEWAY_URL = 'http://localhost:8787/tgrelay';
const INBOUND_SECRET = 'your-secret-token';

// 接收 Telegram webhook，转发到 OpenClaw
app.post('/telegram-webhook', async (req, res) => {
  try {
    await axios.post(OPENCLAW_GATEWAY_URL, req.body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': INBOUND_SECRET
      }
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Forward to OpenClaw failed:', error.message);
    res.status(500).json({ ok: false });
  }
});

// 接收 OpenClaw 回复，发送到 Telegram
app.post('/openclaw-reply', async (req, res) => {
  const { method, chat_id, text, caption, photo, document, ...rest } = req.body;

  try {
    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    const response = await axios.post(telegramUrl, {
      chat_id,
      text,
      caption,
      photo,
      document,
      ...rest
    });

    res.json({
      ok: true,
      result: response.data.result
    });
  } catch (error) {
    console.error('Send to Telegram failed:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(3000, () => {
  console.log('Relay server running on port 3000');
});
```

### Python 示例

```python
from flask import Flask, request, jsonify
import requests
import os

app = Flask(__name__)

TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
OPENCLAW_GATEWAY_URL = 'http://localhost:8787/tgrelay'
INBOUND_SECRET = 'your-secret-token'

@app.route('/telegram-webhook', methods=['POST'])
def telegram_webhook():
    """接收 Telegram webhook，转发到 OpenClaw"""
    try:
        response = requests.post(
            OPENCLAW_GATEWAY_URL,
            json=request.json,
            headers={
                'Content-Type': 'application/json',
                'X-Telegram-Bot-Api-Secret-Token': INBOUND_SECRET
            }
        )
        return jsonify({'ok': True})
    except Exception as e:
        print(f'Forward to OpenClaw failed: {e}')
        return jsonify({'ok': False}), 500

@app.route('/openclaw-reply', methods=['POST'])
def openclaw_reply():
    """接收 OpenClaw 回复，发送到 Telegram"""
    data = request.json
    method = data.pop('method', 'sendMessage')

    try:
        telegram_url = f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}'
        response = requests.post(telegram_url, json=data)
        result = response.json()

        return jsonify({
            'ok': True,
            'result': result.get('result', {})
        })
    except Exception as e:
        print(f'Send to Telegram failed: {e}')
        return jsonify({'ok': False, 'error': str(e)}), 500

if __name__ == '__main__':
    app.run(port=3000)
```

## 验证入站请求

OpenClaw 支持多种方式验证入站请求：

1. **X-Telegram-Bot-Api-Secret-Token 头**（推荐）
   ```
   X-Telegram-Bot-Api-Secret-Token: your-secret-token
   ```

2. **查询参数**
   ```
   POST /tgrelay?secret=your-secret-token
   ```

3. **Authorization 头**
   ```
   Authorization: Bearer your-secret-token
   ```

## 多账户配置

支持配置多个 tgrelay 账户：

```json5
{
  channels: {
    tgrelay: {
      enabled: true,
      accounts: {
        bot1: {
          webhookPath: "/tgrelay/bot1",
          outboundUrl: "https://relay1.example.com/reply",
          inboundSecret: "secret1",
          botUsername: "bot1"
        },
        bot2: {
          webhookPath: "/tgrelay/bot2",
          outboundUrl: "https://relay2.example.com/reply",
          inboundSecret: "secret2",
          botUsername: "bot2"
        }
      }
    }
  }
}
```

## 访问控制

### DM 策略

| 策略 | 说明 |
|------|------|
| `pairing` | 默认。新用户需要配对码验证 |
| `allowlist` | 只允许 `dm.allowFrom` 中的用户 |
| `open` | 允许所有用户 |
| `disabled` | 禁用 DM |

### 群组策略

| 策略 | 说明 |
|------|------|
| `allowlist` | 默认。只允许配置的群组 |
| `open` | 允许所有群组（需要 @mention） |
| `disabled` | 禁用群组消息 |

### 群组配置示例

```json5
{
  channels: {
    tgrelay: {
      groupPolicy: "allowlist",
      groups: {
        "-1001234567890": {
          enabled: true,
          requireMention: true,
          users: [123456789, 987654321],
          systemPrompt: "你是一个友好的助手"
        },
        "*": {
          requireMention: true
        }
      }
    }
  }
}
```

## 状态检查

```bash
# 查看 tgrelay 状态
openclaw channels status tgrelay

# 探测连接
openclaw channels status tgrelay --probe
```

## 故障排除

### 常见问题

1. **收不到消息**
   - 检查 `webhookPath` 是否正确
   - 检查 `inboundSecret` 是否匹配
   - 查看 Gateway 日志：`openclaw logs --follow`

2. **回复发送失败**
   - 检查 `outboundUrl` 是否可访问
   - 检查 `outboundHeaders` 是否正确
   - 确认中继服务正在运行

3. **群组消息被忽略**
   - 检查 `groupPolicy` 设置
   - 确认群组 ID 在 `groups` 配置中
   - 检查是否需要 @mention

### 调试日志

```bash
# 启用详细日志
OPENCLAW_LOG_LEVEL=debug openclaw gateway run
```

## 配置参考

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | false | 启用/禁用通道 |
| `webhookPath` | string | "/tgrelay" | Webhook 路径 |
| `inboundSecret` | string | - | 入站请求验证密钥 |
| `outboundUrl` | string | - | 回复发送目标 URL |
| `outboundHeaders` | object | - | 出站请求头 |
| `botUsername` | string | - | Bot 用户名 |
| `dm.policy` | string | "pairing" | DM 访问策略 |
| `dm.allowFrom` | array | [] | DM 允许列表 |
| `groupPolicy` | string | "allowlist" | 群组策略 |
| `groups` | object | - | 群组配置 |
| `requireMention` | boolean | true | 群组是否需要 @mention |
| `mediaMaxMb` | number | 20 | 媒体大小限制 (MB) |

## 与原生 Telegram 通道的区别

| 特性 | tgrelay | telegram |
|------|---------|----------|
| 连接方式 | HTTP webhook 中继 | 直接 Bot API |
| 需要 Bot Token | 否（由中继服务管理） | 是 |
| 自定义处理 | 支持 | 有限 |
| 部署复杂度 | 需要中继服务 | 简单 |
| 适用场景 | 自定义集成、多租户 | 标准 Bot |
