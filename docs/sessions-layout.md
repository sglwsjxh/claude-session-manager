# Claude Code 会话存储布局

本文记录 2.1.303 版本上实测到的存储结构。官方明确声明 jsonl 条目格式是内部实现，版本间可能变化，本插件只依赖下面列出的稳定字段，并对缺失字段容错

## 目录总览

```text
~/.claude/
├── projects/<slug>/<session-id>.jsonl   会话主记录，每行一条 JSON
├── projects/<slug>/<session-id>/        同胞目录
│   ├── subagents/agent-<id>.jsonl       子代理 transcript
│   ├── tool-results/                    大体积工具输出
│   └── memory/                          会话级记忆
├── session-env/<session-id>/             SessionStart hook 注入的环境脚本
├── file-history/<session-id>/            文件编辑快照
├── sessions/<pid>.json                  活跃会话注册表
├── sessions/<pid>.<sha256>.key          会话密钥
├── history.jsonl                        每行一条 prompt 历史
├── paste-cache/<hash>.txt               粘贴内容缓存
├── plans/<name>.md                      plan 文件
├── todos/ tasks/ debug/ telemetry/ teams/   可选目录，部分版本不再写入
└── .claude.json                         全局配置，含 projects 字典
```

## slug 编码

项目目录名是工作目录路径把非字母数字字符替换为 `-`：

```js
'C:\\Users\\mark3'                        → 'C--Users-mark3'
'C:\\Users\\mark3\\.claude'               → 'C--Users-mark3--claude'
'C:\\Users\\mark3\\AppData\\Local\\Temp\\x' → 'C--Users-mark3-AppData-Local-Temp-x'
```

编码不可逆，反查真实路径要从 jsonl 里的 `cwd` 字段读，不能靠替换 `-` 猜

## 记录类型

一个会话文件里实际出现过的 `type` 值：

| type | 含义 |
|---|---|
| `user` | 用户输入，字段 `message.content` 可能是字符串或内容块数组 |
| `assistant` | 模型回复，一次响应会拆成多条，共用 `requestId` |
| `attachment` | 附件，含 hook 输出 |
| `api-request` `api-request-blob` `api-request-shape` | API 请求记录 |
| `mode` | 首行，形如 `{"type":"mode","mode":"normal","sessionId":"..."}` |
| `last-prompt` | 最后一条用户输入，字段 `lastPrompt` |
| `ai-title` | 自动生成标题，字段 `aiTitle` |
| `custom-title` | `/rename` 写入的标题，字段 `customTitle`，**多次写入时最后一条生效** |
| `file-history-snapshot` | 文件编辑快照 |
| `cost-state` | 花费统计 |
| `permission-mode` `system` `queue-operation` `atis-latch` | 状态类记录 |

`user` 记录的完整字段：

```json
{
  "parentUuid": "63fd9f11-...",
  "isSidechain": false,
  "type": "user",
  "message": { "role": "user", "content": "..." },
  "uuid": "d78f5194-...",
  "timestamp": "2026-10-19T20:47:08.146Z",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "C:\\Users\\mark3",
  "sessionId": "9777f986-...",
  "version": "2.1.303",
  "gitBranch": "HEAD"
}
```

`isSidechain` 为 true 表示子代理会话。这类会话在磁盘上但 `/resume` 选择器看不到

## 标题提取

优先级从高到低：

1. `custom-title` 记录的 `customTitle` 字段，最后写入的一条生效
2. `ai-title` 记录的 `aiTitle` 字段
3. `last-prompt` 记录的 `lastPrompt` 字段
4. 首条 `user` 消息的文本，跳过以 `<` 开头的系统注入与长度不超过 5 的片段

## 活跃会话注册表

`~/.claude/sessions/<pid>.json` 是 Claude Code 自己维护的注册表：

```json
{
  "pid": 29116,
  "sessionId": "1440fa66-95b2-4ab3-b74d-c874a94afef5",
  "cwd": "C:\\Users\\mark3",
  "kind": "interactive",
  "entrypoint": "cli",
  "name": "mark3-23",
  "nameSource": "derived",
  "status": "busy",
  "updatedAt": 1792443611842,
  "startedAt": 1792443382417
}
```

注册表可能滞后于实际进程，所以判定活跃还要校验 PID 是否存活

当前会话 ID 的环境变量真名是 `CLAUDE_CODE_SESSION_ID`。`CLAUDE_SESSION_ID` 不是环境变量，只是 skill 里 `${CLAUDE_SESSION_ID}` 的字符串替换占位符

## /resume 的过滤规则

Claude Code 内部会过滤掉以下会话，不出现在选择器里：

- `isSidechain=true` 的子代理会话
- 带 `teamName` 的会话
- 记录的工作目录与项目 slug 同名但实际不同的会话

## history.jsonl

每行一条 prompt 记录：

```json
{"display": "/model", "pastedContents": {}, "timestamp": 1792388333340, "project": "C:\\Users\\mark3", "sessionId": "5851ac4f-..."}
```

会话被删后这里的对应行不会自动消失，需要手动清理

## 关联目录的引用关系

| 路径 | 命名 | 删除条件 |
|---|---|---|
| `session-env/<session-id>/` | 等于 sessionId | 随会话删除 |
| `file-history/<session-id>/` | 等于 sessionId | 随会话删除 |
| `projects/<slug>/<session-id>/` | 等于 sessionId | 随会话删除 |
| `paste-cache/<hash>.txt` | 内容哈希 | 仅当独占该哈希的会话只有它一个时删除 |
| `plans/<name>.md` | 文件名 | 仅当引用它的会话只有它一个时删除 |
| `sessions/<pid>.json` | PID | 仅当 PID 已退出才删除 |
