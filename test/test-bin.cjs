'use strict';

// bin 壳冒烟测试：从任意 cwd 调用都能正确定位主脚本
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed += 1;
  }
}

const root = path.resolve(__dirname, '..');
const shell = path.join(root, 'bin', 'sessions-manager');

test('bin 壳文件存在', () => {
  assert.ok(fs.existsSync(shell), '缺少 bin/sessions-manager');
});

test('bin 壳用 node shebang，Windows 下 npm 才能生成可用 shim', () => {
  const content = fs.readFileSync(shell, 'utf8');
  assert.ok(content.startsWith('#!/usr/bin/env node'), '入口应为 node shebang');
});

test('从临时目录调用仍能定位主脚本', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-bin-'));
  try {
    const out = execFileSync(process.execPath, [shell, '--list'], { cwd: tmp, encoding: 'utf8' });
    assert.ok(out.includes('Claude Code 会话'), '输出应包含会话标题');
    assert.ok(out.includes('个会话'), '输出应包含会话计数');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('marketplace.json 名字不含 local', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.strictEqual(m.name, 'claude-session-manager');
  assert.ok(!m.description.includes('本地市场'), '描述不应含本地市场字样');
});

test('package.json bin 字段指向正确', () => {
  const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(p.bin['sessions-manager'], 'bin/sessions-manager');
});

test('版本号在包清单、插件清单与市场清单间一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.strictEqual(pkg.version, '0.1.0');
  assert.strictEqual(plugin.version, pkg.version);
  assert.strictEqual(market.plugins[0].version, pkg.version);
});

test('描述三处统一为英文标语', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const expected = 'A Claude Code session management cli tool';
  assert.strictEqual(pkg.description, expected);
  assert.strictEqual(plugin.description, expected);
  assert.strictEqual(market.description, expected);
  assert.strictEqual(market.plugins[0].description, expected);
});

test('--version 输出版本号', () => {
  const out = execFileSync(process.execPath, [shell, '--version'], { encoding: 'utf8' });
  assert.strictEqual(out.trim(), '0.1.0');
});

test('--help 输出用法与选项', () => {
  const out = execFileSync(process.execPath, [shell, '--help'], { encoding: 'utf8' });
  assert.ok(out.includes('--list'), '应列出 --list');
  assert.ok(out.includes('--delete'), '应列出 --delete');
  assert.ok(out.includes('--version'), '应列出 --version');
  assert.ok(out.includes('A Claude Code session management cli tool'), '应含英文描述');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
