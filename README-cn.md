<h1 align="center">claude-session-manager · Claude Code 会话管理工具</h1>

<p align="center"><a href="README.md">English</a> | <a href="README-cn.md">简体中文</a></p>

## 简介

Claude Code 只能恢复历史会话，不能删除。这是一个终端工具，用来浏览、预览、删除会话，删除时一次清掉会话在磁盘上的全部足迹：附属目录、环境脚本、文件编辑历史、提示历史、粘贴缓存等

纯 Node.js 实现，零运行时依赖

## 快速开始

```bash
git clone https://github.com/sglwsjxh/claude-session-manager.git
cd claude-session-manager
npm test
bin/sessions-manager --list
```

想把 `sessions-manager` 命令装进 PATH，在仓库目录跑 `npm link`，或发布后全局安装

## 交互界面

```bash
sessions-manager
```

| 按键 | 作用 |
|---|---|
| ↑ ↓ | 选择会话 |
| Enter | 预览对话内容 |
| Backspace | 删除选中的会话 |
| Tab | 切换筛选：全部、按项目、小于 100K、超过 30 天 |
| 直接输入 | 搜索标题与首条消息 |
| Esc | 退出 |

删除前会弹出确认框，列出将删除的每个文件与目录

## 命令行

```bash
sessions-manager --list
sessions-manager --preview <会话ID>
sessions-manager --plan <会话ID>
sessions-manager --delete <会话ID>
sessions-manager --older-than 30d
sessions-manager --smaller-than 100K
```

会话 ID 可写完整 UUID 或只写前缀

删除与批量清理分两步：第一次只输出清单，末尾带 `AWAITING_CONFIRMATION`；确认后加 `--yes` 执行

加 `--json` 输出结构化结果

## 清理范围

| 位置 | 内容 | 规则 |
|---|---|---|
| `projects/<slug>/<id>.jsonl` | 会话主记录 | 必删 |
| `projects/<slug>/<id>/` | 附属目录，含子代理记录与工具输出 | 必删 |
| `session-env/<id>/` | 会话环境脚本 | 必删 |
| `file-history/<id>/` | 文件编辑快照 | 必删 |
| `sessions/<pid>.json` | 会话注册表 | 进程已退出才删 |
| `history.jsonl` | 提示历史 | 原子改写，移除对应行 |
| `paste-cache/<hash>.txt` | 粘贴缓存 | 独占才删 |
| `plans/<name>.md` | 计划文件 | 独占才删 |
| `todos/` `tasks/` `debug/` `telemetry/` `teams/` | 可选目录 | 存在才删 |

共享的粘贴缓存与计划文件会被跳过，并标明原因

## 安全

三种情况拒绝删除：

1. 当前正在使用的会话
2. 注册表里进程仍然存活的会话
3. 最近 5 分钟内被修改的会话

路径安全方面，会话 ID 含路径分隔符或 `..` 会被拒绝，目标路径必须落在 `.claude` 目录内

删除是永久的，不进回收站。`history.jsonl` 走临时文件加原子替换，不留备份副本

## 已知限制

- 无会话内斜杠命令。Claude Code 插件组件不提供本地前端命令：skill 与 command 的斜杠命令本质是发给模型的 prompt，`/resume` 这类原生命令编译在 CLI 内部，插件无法企及；输入框的 `!` 前缀直通在跑完后仍会把输出报回 AI。因此会话管理留在终端，直接跑 `sessions-manager`
- JSONL 条目格式是 Claude Code 的内部实现，版本间可能变化。本工具只读稳定字段（`type`、`cwd`、`customTitle`、`aiTitle`、`lastPrompt`），缺失时降级而非报错

## 开发

```bash
npm test
```

四个测试文件用 `node:assert` 写成，零依赖，临时目录隔离

```
skills/sessions/scripts/
├── session-store.cjs      会话发现与元数据解析
├── session-cleaner.cjs    足迹清理
└── session-picker.cjs     交互界面与命令行
```

存储布局的实测记录见 [docs/sessions-layout.md](docs/sessions-layout.md)

## 许可证

[MIT](LICENSE)

## 致谢

- [GravesXX/session-manager](https://github.com/GravesXX/session-manager)（MIT）——交互式会话浏览器的形态参考
- [KenCheung-AIxFinance/claude-code-session-manager](https://github.com/KenCheung-AIxFinance/claude-code-session-manager)——删除足迹清单与共享资源判断逻辑参考
- [zzusp/claude-code-session](https://github.com/zzusp/claude-code-session)——活跃会话判定与路径安全策略参考
