# 发布指南

包名 `@sglwsjxh/claude-session-manager`，全局命令 `sessions-manager`

## 现状

发布链路已全部就绪，验证记录见 `evidence/publish-readiness.txt`

- `npm publish --dry-run --access public` 通过，无警告
- `npm pack --dry-run` 产物 9 个文件，无冗余
- `npm test` 全绿，91 个用例
- 临时 prefix 真实安装验证通过，`sessions-manager --version` 输出 `0.1.0`
- npm 账号 `sglwsjxh`，2FA 模式 `auth-and-writes`，`@sglwsjxh` scope 权限 read-write

## 为什么走 OIDC 而不是 token

npm 官方在 2026 年调整了发布策略

- bypass-2FA token 直发模式将于 2027 年 1 月移除
- 官方对 GitHub Actions 首推 trusted publishing，即 OIDC
- `npm stage publish` 暂存发布不需要 2FA，维护者以 2FA 批准后才真正上线

所以 CI 里用 `npm stage publish`，你本人在网页上点一次 Approve

## 首次发布步骤

### 1. 配 npm 侧信任关系

在项目根目录执行，需要浏览器里完成 2FA

```bash
npm trust github @sglwsjxh/claude-session-manager \
  --file publish.yml \
  --repo sglwsjxh/claude-session-manager \
  --env npm \
  --allow-stage-publish \
  --no-allow-publish
```

加 `--dry-run` 可以先预演，会打印将要写入的配置

也可以在 npmjs.com 网页配置：包页面 → Settings → Trusted Publisher → GitHub Actions，填 Organization `sglwsjxh`、Repository `claude-session-manager`、Workflow filename `publish.yml`、Environment `npm`

### 2. 推 tag 触发发布

```bash
git tag v0.1.0
git push origin v0.1.0
```

### 3. 批准暂存的版本

CI 跑完后在网页 Staged Packages 标签页点 Approve，需要 2FA

命令行方式：

```bash
npm stage list
npm stage approve <stage-id>
```

## 版本号同步

三处必须一致，`npm test` 里有断言守着

- `package.json` 的 `version`
- `.claude-plugin/plugin.json` 的 `version`
- `.claude-plugin/marketplace.json` 的 `plugins[0].version`

tag 名去掉 `v` 前缀后要和 `package.json` 的 version 相同，workflow 里有校验步骤

## 描述文案

四处必须统一为 `A Claude Code session management cli tool`

- `package.json` 的 `description`
- `.claude-plugin/plugin.json` 的 `description`
- `.claude-plugin/marketplace.json` 的 `description`
- `.claude-plugin/marketplace.json` 的 `plugins[0].description`

`skills/sessions/scripts/session-picker.cjs` 的帮助文本也用同一句

## 注意 marketplace.json 的 name

`.claude-plugin/marketplace.json` 的 `name` 保持 `claude-session-manager` 不带 scope

那是 Claude Code 插件市场的标识符，不是 npm 包名，`test/test-bin.cjs` 有断言守着

## 本地开发时全局命令指向工作区

当前全局 `sessions-manager` 是 `npm link` 装的，指向本地工作区，改代码立刻生效

发正式版后想切到 registry 版本：

```bash
npm uninstall -g claude-session-manager
npm install -g @sglwsjxh/claude-session-manager
```

## bin 执行位

Windows 打包出来的 tarball 里 `bin/sessions-manager` 是 644，npm 在安装时会 `chmod 0o777 & ~umask` 补成 755，Linux 与 Mac 用户装完可直接执行

绕过 npm 直接解包 tarball 的话，Linux 下需要自己 `chmod +x`
