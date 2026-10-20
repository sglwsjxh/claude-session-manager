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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
