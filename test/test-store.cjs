'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../skills/sessions/scripts/session-store.cjs');

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

// ---------------------------------------------------------------------------
// 临时目录辅助
// ---------------------------------------------------------------------------

const tempRoots = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-test-'));
  tempRoots.push(dir);
  return dir;
}

/**
 * 构造一个隔离的 .claude 目录树
 */
function makeClaudeDir() {
  const root = makeTempDir();
  const claude = path.join(root, '.claude');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  return claude;
}

/**
 * 写一个会话文件
 */
function writeSession(claude, slug, sessionId, lines) {
  const dir = path.join(claude, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

function userLine(cwd, text, extra) {
  return Object.assign(
    {
      type: 'user',
      cwd,
      message: { role: 'user', content: text },
      timestamp: '2026-10-19T20:00:00.000Z',
      sessionId: 'x',
      isSidechain: false,
    },
    extra || {}
  );
}

async function main() {
// ---------------------------------------------------------------------------
// slug 编码
// ---------------------------------------------------------------------------

test('slug 编码把非字母数字替换为连字符', () => {
  assert.strictEqual(store.projectSlug('C:\\Users\\mark3'), 'C--Users-mark3');
  assert.strictEqual(store.projectSlug('C:\\Users\\mark3\\.claude'), 'C--Users-mark3--claude');
  assert.strictEqual(
    store.projectSlug('C:\\Users\\mark3\\AppData\\Local\\Temp\\x'),
    'C--Users-mark3-AppData-Local-Temp-x'
  );
});

test('slug 编码对 POSIX 路径同样成立', () => {
  assert.strictEqual(store.projectSlug('/home/user/proj'), '-home-user-proj');
});

test('shortenCwd 把家目录替换成波浪号', () => {
  // 用 path.join 构造，保证与运行平台的路径分隔符一致
  const home = path.join('C:', 'Users', 'mark3');
  const nested = path.join(home, 'a', 'b');
  assert.strictEqual(store.shortenCwd(home, home), '~');
  // 切片保留原分隔符，所以期望值带上 path.sep
  assert.strictEqual(store.shortenCwd(nested, home), '~' + path.sep + 'a' + path.sep + 'b');
  assert.strictEqual(store.shortenCwd(path.join('D:', 'other'), home), path.join('D:', 'other'));
  assert.strictEqual(store.shortenCwd(null, home), '(未知)');
});

// ---------------------------------------------------------------------------
// 文本提取
// ---------------------------------------------------------------------------

test('extractText 处理字符串与内容块数组', () => {
  assert.strictEqual(store.extractText('hello'), 'hello');
  assert.strictEqual(
    store.extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    'a b'
  );
  assert.strictEqual(store.extractText([{ type: 'tool_use', id: 'x' }]), '');
  assert.strictEqual(store.extractText(null), '');
});

test('normalizeText 压缩空白', () => {
  assert.strictEqual(store.normalizeText('  a\n\tb  '), 'a b');
});

// ---------------------------------------------------------------------------
// 元数据解析
// ---------------------------------------------------------------------------

await testAsync('readMetadata 优先取 custom-title 且最后一条生效', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--p', 's1', [
    userLine('C:\\p', '第一条用户消息内容'),
    { type: 'custom-title', customTitle: '旧标题' },
    { type: 'custom-title', customTitle: '新标题' },
  ]);
  const meta = await store.readMetadata(file);
  assert.strictEqual(meta.title, '新标题');
  assert.strictEqual(meta.cwd, 'C:\\p');
  assert.strictEqual(meta.messageCount, 1);
});

await testAsync('readMetadata 无 custom-title 时回退 ai-title', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--p', 's2', [
    { type: 'ai-title', aiTitle: '自动标题' },
    userLine('C:\\p', '用户消息内容在此'),
  ]);
  const meta = await store.readMetadata(file);
  assert.strictEqual(meta.title, '自动标题');
});

await testAsync('readMetadata 再回退 last-prompt', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--p', 's3', [
    { type: 'last-prompt', lastPrompt: '最后输入' },
    userLine('C:\\p', '用户消息内容在此'),
  ]);
  const meta = await store.readMetadata(file);
  assert.strictEqual(meta.title, '最后输入');
});

await testAsync('readMetadata 最后回退首条有效用户消息', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--p', 's4', [
    userLine('C:\\p', '短'),
    userLine('C:\\p', '<system-reminder>注入内容</system-reminder>'),
    userLine('C:\\p', '这才是第一条真实输入'),
  ]);
  const meta = await store.readMetadata(file);
  assert.strictEqual(meta.title, '这才是第一条真实输入');
  assert.strictEqual(meta.messageCount, 3);
});

await testAsync('readMetadata 跳过系统注入但仍计消息数', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--p', 's5', [
    userLine('C:\\p', '<command-name>/clear</command-name>'),
  ]);
  const meta = await store.readMetadata(file);
  assert.strictEqual(meta.title, null);
  assert.strictEqual(meta.messageCount, 1);
});

await testAsync('readMetadata 识别 sidechain', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--p', 's6', [
    userLine('C:\\p', '子代理的输入内容', { isSidechain: true }),
  ]);
  const meta = await store.readMetadata(file);
  assert.strictEqual(meta.sidechain, true);
});

await testAsync('readMetadata 对损坏行容错', async () => {
  const claude = makeClaudeDir();
  const dir = path.join(claude, 'projects', 'C--p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'broken.jsonl');
  fs.writeFileSync(file, '{ 这不是合法 JSON\n{"type":"ai-title","aiTitle":"标题"}\n', 'utf8');
  const meta = await store.readMetadata(file);
  assert.strictEqual(meta.title, '标题');
});

// ---------------------------------------------------------------------------
// 会话扫描
// ---------------------------------------------------------------------------

await testAsync('scanSessions 跨项目列出全部会话', async () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--a', 'sa', [userLine('C:\\a', '项目甲的第一条输入')]);
  writeSession(claude, 'C--b', 'sb', [userLine('C:\\b', '项目乙的第一条输入')]);

  const sessions = await store.scanSessions({ claudeDir: claude });
  assert.strictEqual(sessions.length, 2);
  const ids = sessions.map((s) => s.id).sort();
  assert.deepStrictEqual(ids, ['sa', 'sb']);
});

await testAsync('scanSessions 跳过 agent- 前缀的子代理文件', async () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--a', 'sa', [userLine('C:\\a', '主会话的输入内容')]);
  writeSession(claude, 'C--a', 'agent-xyz', [userLine('C:\\a', '子代理输入内容')]);

  const sessions = await store.scanSessions({ claudeDir: claude });
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].id, 'sa');
});

await testAsync('scanSessions 跳过空文件', async () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--a', 'sa', [userLine('C:\\a', '正常会话输入内容')]);
  const dir = path.join(claude, 'projects', 'C--a');
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '', 'utf8');

  const sessions = await store.scanSessions({ claudeDir: claude });
  assert.strictEqual(sessions.length, 1);
});

await testAsync('scanSessions 记录同胞目录与体积', async () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--a', 'sa', [userLine('C:\\a', '带同胞目录的会话')]);
  fs.mkdirSync(path.join(claude, 'projects', 'C--a', 'sa', 'subagents'), { recursive: true });

  const sessions = await store.scanSessions({ claudeDir: claude });
  assert.strictEqual(sessions[0].hasCompanion, true);
  assert.ok(sessions[0].size > 0);
});

await testAsync('scanSessions 目录缺失时返回空数组', async () => {
  const sessions = await store.scanSessions({ claudeDir: path.join(makeTempDir(), 'none') });
  assert.deepStrictEqual(sessions, []);
});

await testAsync('scanSessions 按修改时间倒序', async () => {
  const claude = makeClaudeDir();
  const older = writeSession(claude, 'C--a', 'old', [userLine('C:\\a', '较早的会话输入')]);
  const newer = writeSession(claude, 'C--a', 'new', [userLine('C:\\a', '较新的会话输入')]);
  const past = Date.now() - 60000;
  fs.utimesSync(older, past / 1000, past / 1000);

  const sessions = await store.scanSessions({ claudeDir: claude });
  assert.strictEqual(sessions[0].id, 'new');
  assert.ok(newer);
});

// ---------------------------------------------------------------------------
// 活跃会话
// ---------------------------------------------------------------------------

test('activeSessionIds 忽略已退出进程的注册表记录', () => {
  const claude = makeClaudeDir();
  const sessionsDir = path.join(claude, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  fs.writeFileSync(
    path.join(sessionsDir, '999999.json'),
    JSON.stringify({ pid: 999999, sessionId: 'dead-session' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(sessionsDir, 'broken.json'),
    '{ 不是合法 JSON',
    'utf8'
  );

  const active = store.activeSessionIds({ claudeDir: claude });
  assert.strictEqual(active.has('dead-session'), false);
});

test('activeSessionIds 目录缺失时返回空集合', () => {
  const active = store.activeSessionIds({ claudeDir: path.join(makeTempDir(), 'none') });
  assert.strictEqual(active.size, 0);
});

test('currentSessionId 取 CLAUDE_CODE_SESSION_ID', () => {
  assert.strictEqual(
    store.currentSessionId({ CLAUDE_CODE_SESSION_ID: 'abc' }),
    'abc'
  );
});

test('currentSessionId 兼容回退到 CLAUDE_SESSION_ID', () => {
  assert.strictEqual(store.currentSessionId({ CLAUDE_SESSION_ID: 'def' }), 'def');
});

test('currentSessionId 都没有时返回 null', () => {
  assert.strictEqual(store.currentSessionId({}), null);
});

test('pidAlive 对当前进程返回 true', () => {
  assert.strictEqual(store.pidAlive(process.pid), true);
});

test('pidAlive 对非法 pid 返回 false', () => {
  assert.strictEqual(store.pidAlive(0), false);
  assert.strictEqual(store.pidAlive(-1), false);
  assert.strictEqual(store.pidAlive(1.5), false);
});

// ---------------------------------------------------------------------------
// 消息预览
// ---------------------------------------------------------------------------

await testAsync('readMessages 返回用户与助手消息', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--a', 's1', [
    userLine('C:\\a', '用户的提问内容'),
    { type: 'assistant', message: { role: 'assistant', content: '助手的回答内容' } },
  ]);
  const messages = await store.readMessages(file);
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].role, 'user');
  assert.strictEqual(messages[1].role, 'assistant');
});

await testAsync('readMessages 跳过 sidechain', async () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--a', 's1', [
    userLine('C:\\a', '主会话的用户提问'),
    userLine('C:\\a', '子代理的提问', { isSidechain: true }),
  ]);
  const messages = await store.readMessages(file);
  assert.strictEqual(messages.length, 1);
});

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

test('formatSize 按量级切换单位', () => {
  assert.strictEqual(store.formatSize(512), '512B');
  assert.strictEqual(store.formatSize(2048), '2K');
  assert.strictEqual(store.formatSize(1572864), '1.5M');
  assert.strictEqual(store.formatSize(0), '0B');
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
