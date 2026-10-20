'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const picker = require('../skills/sessions/scripts/session-picker.cjs');

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed += 1;
  }
}

const tempRoots = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-picker-test-'));
  tempRoots.push(dir);
  return dir;
}

function makeClaudeDir() {
  const claude = path.join(makeTempDir(), '.claude');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  return claude;
}

function writeSession(claude, slug, sessionId, cwd, title) {
  const dir = path.join(claude, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    { type: 'mode', mode: 'normal', sessionId },
    {
      type: 'user',
      cwd: cwd || 'C:\\proj',
      message: { role: 'user', content: '这是第一条用户输入内容' },
      sessionId,
      isSidechain: false,
    },
  ];
  if (title) lines.push({ type: 'custom-title', customTitle: title });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

async function main() {
// ---------------------------------------------------------------------------
// 体积解析
// ---------------------------------------------------------------------------

test('parseSize 支持 K M 与裸数字', () => {
  assert.strictEqual(picker.parseSize('5K'), 5120);
  assert.strictEqual(picker.parseSize('1M'), 1048576);
  assert.strictEqual(picker.parseSize('500'), 500);
  assert.strictEqual(picker.parseSize('1.5K'), 1536);
  assert.strictEqual(picker.parseSize('5kb'), 5120);
});

test('parseSize 对非法输入返回 null', () => {
  assert.strictEqual(picker.parseSize('abc'), null);
  assert.strictEqual(picker.parseSize(''), null);
  assert.strictEqual(picker.parseSize(null), null);
});

// ---------------------------------------------------------------------------
// 时长解析
// ---------------------------------------------------------------------------

test('parseDuration 支持 d w m y 与裸数字', () => {
  assert.strictEqual(picker.parseDuration('7d'), 7 * 86400000);
  assert.strictEqual(picker.parseDuration('2w'), 14 * 86400000);
  assert.strictEqual(picker.parseDuration('1m'), 30 * 86400000);
  assert.strictEqual(picker.parseDuration('1y'), 365 * 86400000);
  assert.strictEqual(picker.parseDuration('3'), 3 * 86400000);
});

test('parseDuration 对非法输入返回 null', () => {
  assert.strictEqual(picker.parseDuration('xyz'), null);
  assert.strictEqual(picker.parseDuration(null), null);
});

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

function sampleSessions() {
  const now = Date.now();
  return [
    {
      id: 'aaaaaaaa-1111',
      title: '认证模块重构',
      firstPrompt: '帮我重构登录流程',
      project: 'C:\\work\\api',
      size: 200 * 1024,
      modified: now - 1000,
      messageCount: 10,
      sidechain: false,
    },
    {
      id: 'bbbbbbbb-2222',
      title: '前端样式调整',
      firstPrompt: '把按钮改成圆角',
      project: 'C:\\work\\web',
      size: 50 * 1024,
      modified: now - 40 * 86400000,
      messageCount: 4,
      sidechain: false,
    },
  ];
}

test('applyFilter 全部模式不过滤', () => {
  const list = sampleSessions();
  assert.strictEqual(picker.applyFilter(list, 'all', '').length, 2);
});

test('applyFilter 按项目筛选', () => {
  const list = sampleSessions();
  const filtered = picker.applyFilter(list, 'project', '', { projectFilter: 'api' });
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].id, 'aaaaaaaa-1111');
});

test('applyFilter 小会话模式筛出小于 100K 的', () => {
  const list = sampleSessions();
  const filtered = picker.applyFilter(list, 'small', '');
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].id, 'bbbbbbbb-2222');
});

test('applyFilter 旧会话模式筛出超过 30 天的', () => {
  const list = sampleSessions();
  const filtered = picker.applyFilter(list, 'old', '');
  assert.strictEqual(filtered.length, 1);
  assert.strictEqual(filtered[0].id, 'bbbbbbbb-2222');
});

test('applyFilter 搜索词匹配标题与首条消息', () => {
  const list = sampleSessions();
  assert.strictEqual(picker.applyFilter(list, 'all', '认证').length, 1);
  assert.strictEqual(picker.applyFilter(list, 'all', '圆角').length, 1);
  assert.strictEqual(picker.applyFilter(list, 'all', '不存在的词').length, 0);
});

test('applyFilter 搜索不区分大小写', () => {
  const list = sampleSessions();
  assert.strictEqual(picker.applyFilter(list, 'all', 'AUTH').length, 0);
  assert.strictEqual(picker.applyFilter(list, 'all', 'frontend').length, 0);
});

// ---------------------------------------------------------------------------
// 批量清理条件
// ---------------------------------------------------------------------------

test('selectByCondition 按时间筛选', () => {
  const list = sampleSessions();
  const selected = picker.selectByCondition(list, { olderThan: '30d' });
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].id, 'bbbbbbbb-2222');
});

test('selectByCondition 按体积筛选', () => {
  const list = sampleSessions();
  const selected = picker.selectByCondition(list, { smallerThan: '100K' });
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(selected[0].id, 'bbbbbbbb-2222');
});

test('selectByCondition 两个条件同时生效', () => {
  const list = sampleSessions();
  const selected = picker.selectByCondition(list, { olderThan: '30d', smallerThan: '100K' });
  assert.strictEqual(selected.length, 1);
});

test('selectByCondition 无条件时返回空数组', () => {
  assert.deepStrictEqual(picker.selectByCondition(sampleSessions(), {}), []);
});

// ---------------------------------------------------------------------------
// 文本处理
// ---------------------------------------------------------------------------

test('truncate 截断超长文本并加省略号', () => {
  const result = picker.truncate('一二三四五六七八九十', 5);
  assert.strictEqual(result.length, 5);
  assert.ok(result.endsWith('…'));
});

test('truncate 保留短文本', () => {
  assert.strictEqual(picker.truncate('短', 10), '短');
});

test('truncate 压缩空白', () => {
  assert.strictEqual(picker.truncate('  a   b  ', 10), 'a b');
});

test('visibleLength 忽略 ANSI 序列', () => {
  const colored = String.fromCharCode(27) + "[31mabc" + String.fromCharCode(27) + "[0m";
  assert.strictEqual(picker.visibleLength(colored), 3);
});

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test('renderList 列出全部会话', () => {
  const list = sampleSessions();
  const state = {
    activeIds: new Set(),
    currentId: null,
    totalSize: list.reduce((sum, s) => sum + s.size, 0),
  };
  const text = picker.renderList(list, state).join('\n');
  assert.ok(text.includes('认证模块重构'));
  assert.ok(text.includes('前端样式调整'));
  assert.ok(text.includes('2 个会话'));
});

test('renderList 标记当前会话与运行中会话', () => {
  const list = sampleSessions();
  const state = {
    activeIds: new Set(['aaaaaaaa-1111']),
    currentId: 'bbbbbbbb-2222',
    totalSize: 0,
  };
  const text = picker.renderList(list, state).join('\n');
  assert.ok(text.includes('运行中'));
  assert.ok(text.includes('当前'));
});

test('renderList 空列表给出提示', () => {
  const state = { activeIds: new Set(), currentId: null, totalSize: 0 };
  const text = picker.renderList([], state).join('\n');
  assert.ok(text.includes('没有匹配的会话'));
});

test('renderList 标记子代理会话', () => {
  const list = sampleSessions();
  list[0].sidechain = true;
  const state = { activeIds: new Set(), currentId: null, totalSize: 0 };
  const text = picker.renderList(list, state).join('\n');
  assert.ok(text.includes('子代理'));
});

// ---------------------------------------------------------------------------
// 会话查找
// ---------------------------------------------------------------------------

await testAsync('findSession 按完整 ID 找到会话', async () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--p', 'abcdef12-3456', 'C:\\p');
  const found = await picker.findSession('abcdef12-3456', { claudeDir: claude });
  assert.ok(found);
  assert.strictEqual(found.id, 'abcdef12-3456');
});

await testAsync('findSession 按 ID 前缀找到会话', async () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--p', 'abcdef12-3456', 'C:\\p');
  const found = await picker.findSession('abcdef12', { claudeDir: claude });
  assert.ok(found);
  assert.strictEqual(found.id, 'abcdef12-3456');
});

await testAsync('findSession 找不到时返回 null', async () => {
  const claude = makeClaudeDir();
  const found = await picker.findSession('ghost', { claudeDir: claude });
  assert.strictEqual(found, null);
});

// ---------------------------------------------------------------------------
// 试运行删除
// ---------------------------------------------------------------------------

await testAsync('commandDelete 带 dryRun 时不删除文件', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--p', 'abcdef12-3456', 'C:\\p');
  await picker.commandDelete('abcdef12-3456', {
    claudeDir: claude,
    yes: true,
    dryRun: true,
  });
  assert.ok(fs.existsSync(file), 'dryRun 下会话文件应保留');
});

await testAsync('commandDelete 不带 dryRun 时删除文件', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--p', 'abcdef12-3456', 'C:\\p');
  await picker.commandDelete('abcdef12-3456', {
    claudeDir: claude,
    yes: true,
  });
  assert.ok(!fs.existsSync(file), '非 dryRun 下会话文件应被删除');
});

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

for (const dir of tempRoots) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响测试结论
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
