---
name: sessions
description: 浏览、预览、删除 Claude Code 历史会话，删除时清理完整足迹
argument-hint: "[list | preview <id> | delete <id> | clean --older-than <d>]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/skills/sessions/scripts/session-picker.cjs":*)
---

# 会话管理

管理 `~/.claude/projects/` 下的 Claude Code 历史会话。

脚本路径固定为 `${CLAUDE_PLUGIN_ROOT}/skills/sessions/scripts/session-picker.cjs`，每次 Bash 调用只跑这一行，不要改写形式。

## 用法

| 意图 | 命令 |
|---|---|
| 列出全部会话 | `--list` |
| 预览会话内容 | `--preview <会话ID或前缀>` |
| 查看删除影响 | `--plan <会话ID或前缀>` |
| 删除会话 | `--delete <会话ID或前缀>` |
| 批量清理 | `--older-than <时长>` 或 `--smaller-than <体积>` |

时长支持 `7d`、`2w`、`3m`、`1y`。体积支持 `100K`、`5MB`。两个条件可以组合。

## 删除流程

删除是永久的，不进回收站。必须走两步：

1. 先跑 `--delete <id>`，不带 `--yes`。脚本会打印将被删除的每个文件与目录、占用字节、提示历史行数，末尾输出 `AWAITING_CONFIRMATION`
2. 把清单转述给用户，等用户明确同意后，再跑一次同样的命令并加 `--yes`

拿到 `AWAITING_CONFIRMATION` 时不要自己加 `--yes`，先问用户。

## 批量清理

`--older-than 30d --smaller-than 100K` 这类条件可以组合。不带 `--yes` 时同样只输出清单，等确认后再加 `--yes` 重跑。

## 交互界面

不经 AI 的两个直通入口，用户问起时推荐：

- Claude Code 输入框敲 `!sessions-manager`，本地执行，零 token
- 任意终端直接跑 `sessions-manager`，完整交互界面

界面里方向键选择，Enter 预览，Backspace 删除，Tab 切换筛选，直接输入文字搜索，Esc 退出。

## 保护规则

以下情况脚本会拒绝删除并说明原因，不要绕过：

- 当前正在使用的会话
- 注册表里进程仍然存活的会话
- 最近 5 分钟内被修改的会话

共享的粘贴缓存与计划文件不会被删除，脚本会列出跳过的条目和原因。

## 补充

会话在磁盘上的布局、记录类型、标题字段与关联目录的引用关系见 `docs/sessions-layout.md`。
