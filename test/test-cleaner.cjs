'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cleaner = require('../skills/sessions/scripts/session-cleaner.cjs');
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

const tempRoots = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-clean-test-'));
  tempRoots.push(dir);
  return dir;
}

/**
 * 构造一个隔离的 .claude 目录树
 */
function makeClaudeDir() {
  const claude = path.join(makeTempDir(), '.claude');
  fs.mkdirSync(path.join(claude, 'projects'), { recursive: true });
  return claude;
}

/**
 * 写一个会话，返回文件路径
 */
function writeSession(claude, slug, sessionId, cwd) {
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
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

function writeHistory(claude, rows) {
  const file = path.join(claude, 'history.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

test('isSafeSessionId 拒绝路径分隔符与相对路径', () => {
  assert.strictEqual(cleaner.isSafeSessionId('abc123'), true);
  assert.strictEqual(cleaner.isSafeSessionId('a-b_c'), true);
  assert.strictEqual(cleaner.isSafeSessionId('a/b'), false);
  assert.strictEqual(cleaner.isSafeSessionId('a\\b'), false);
  assert.strictEqual(cleaner.isSafeSessionId('..'), false);
  assert.strictEqual(cleaner.isSafeSessionId('../etc'), false);
  assert.strictEqual(cleaner.isSafeSessionId('.hidden'), false);
  assert.strictEqual(cleaner.isSafeSessionId(''), false);
  assert.strictEqual(cleaner.isSafeSessionId(null), false);
});

test('isInsideClaudeDir 只接受目录内的子路径', () => {
  const root = path.join(makeTempDir(), '.claude');
  assert.strictEqual(cleaner.isInsideClaudeDir(path.join(root, 'a', 'b'), root), true);
  assert.strictEqual(cleaner.isInsideClaudeDir(root, root), false);
  assert.strictEqual(cleaner.isInsideClaudeDir(path.join(root, '..', 'x'), root), false);
  assert.strictEqual(cleaner.isInsideClaudeDir('C:\\Windows\\System32', root), false);
});

// ---------------------------------------------------------------------------
// 清理计划
// ---------------------------------------------------------------------------

test('planCleanup 列出会话记录与附属目录', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.strictEqual(plan.blocked, null);
  assert.strictEqual(plan.files.length, 1);
  assert.strictEqual(plan.dirs.length, 0);
  assert.ok(plan.files[0].path.endsWith('sess1.jsonl'));
});

test('planCleanup 覆盖同胞目录与环境与文件历史', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  fs.mkdirSync(path.join(claude, 'projects', 'C--proj', 'sess1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'session-env', 'sess1'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'file-history', 'sess1'), { recursive: true });

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  const dirLabels = plan.dirs.map((d) => d.label);
  assert.ok(dirLabels.includes('会话附属目录'));
  assert.ok(dirLabels.includes('会话环境'));
  assert.ok(dirLabels.includes('文件编辑历史'));
  assert.strictEqual(plan.dirs.length, 3);
});

test('planCleanup 缺失的目录不报错', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.strictEqual(plan.blocked, null);
  assert.strictEqual(plan.errors, undefined);
});

test('planCleanup 拒绝当前会话', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  const plan = cleaner.planCleanup({
    claudeDir: claude,
    sessionId: 'sess1',
    env: { CLAUDE_CODE_SESSION_ID: 'sess1' },
  });
  assert.ok(plan.blocked.includes('当前正在使用'));
});

test('planCleanup 拒绝注册表里进程存活的会话', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  const sessionsDir = path.join(claude, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 'sess1' }),
    'utf8'
  );

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.ok(plan.blocked.includes('仍在运行'));
});

test('planCleanup 拒绝非法会话 ID', () => {
  const claude = makeClaudeDir();
  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: '../../etc' });
  assert.ok(plan.blocked.includes('不合法'));
});

test('planCleanup 报告找不到的会话', () => {
  const claude = makeClaudeDir();
  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'ghost' });
  assert.ok(plan.blocked.includes('找不到'));
});

test('planCleanup 统计提示历史行数', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  writeHistory(claude, [
    { display: 'a', sessionId: 'sess1' },
    { display: 'b', sessionId: 'sess1' },
    { display: 'c', sessionId: 'other' },
  ]);

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.strictEqual(plan.historyLines, 2);
});

test('planCleanup 共享的粘贴缓存被跳过', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  fs.mkdirSync(path.join(claude, 'paste-cache'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'paste-cache', 'hash1.txt'), '共享内容', 'utf8');
  writeHistory(claude, [
    { display: 'a', sessionId: 'sess1', pastedContents: { hash1: {} } },
    { display: 'b', sessionId: 'other', pastedContents: { hash1: {} } },
  ]);

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  const skippedPaths = plan.skipped.map((s) => s.path);
  assert.ok(skippedPaths.some((p) => p.includes('hash1.txt')));
  assert.strictEqual(plan.files.filter((f) => f.path.includes('hash1.txt')).length, 0);
});

test('planCleanup 独占的粘贴缓存被纳入', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  fs.mkdirSync(path.join(claude, 'paste-cache'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'paste-cache', 'hash2.txt'), '独占内容', 'utf8');
  writeHistory(claude, [
    { display: 'a', sessionId: 'sess1', pastedContents: { hash2: {} } },
  ]);

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.strictEqual(plan.files.filter((f) => f.path.includes('hash2.txt')).length, 1);
});

test('planCleanup 共享的 plan 文件被跳过', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  fs.mkdirSync(path.join(claude, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'plans', 'shared.md'), '# plan', 'utf8');
  writeHistory(claude, [
    { display: '看 shared.md', sessionId: 'sess1' },
    { display: '看 shared.md', sessionId: 'other' },
  ]);

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.strictEqual(plan.files.filter((f) => f.path.includes('shared.md')).length, 0);
  assert.ok(plan.skipped.some((s) => s.path.includes('shared.md')));
});

test('planCleanup 独占的 plan 文件被纳入', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  fs.mkdirSync(path.join(claude, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'plans', 'solo.md'), '# plan', 'utf8');
  writeHistory(claude, [{ display: '看 solo.md', sessionId: 'sess1' }]);

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.strictEqual(plan.files.filter((f) => f.path.includes('solo.md')).length, 1);
});

test('planCleanup 进程已退出的注册表记录被纳入', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  const sessionsDir = path.join(claude, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, '999999.json'),
    JSON.stringify({ pid: 999999, sessionId: 'sess1' }),
    'utf8'
  );

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.strictEqual(plan.files.filter((f) => f.label === '会话注册表').length, 1);
});

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

test('executeCleanup 删除会话记录与附属目录', () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--proj', 'sess1');
  fs.mkdirSync(path.join(claude, 'projects', 'C--proj', 'sess1', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'session-env', 'sess1'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'file-history', 'sess1'), { recursive: true });

  const result = cleaner.executeCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(fs.existsSync(path.join(claude, 'projects', 'C--proj', 'sess1')), false);
  assert.strictEqual(fs.existsSync(path.join(claude, 'session-env', 'sess1')), false);
  assert.strictEqual(fs.existsSync(path.join(claude, 'file-history', 'sess1')), false);
});

test('executeCleanup 从提示历史移除对应行', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  writeHistory(claude, [
    { display: 'a', sessionId: 'sess1' },
    { display: 'b', sessionId: 'other' },
  ]);

  const result = cleaner.executeCleanup({ claudeDir: claude, sessionId: 'sess1' });
  assert.strictEqual(result.historyRemoved, 1);

  const remaining = fs
    .readFileSync(path.join(claude, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  assert.strictEqual(remaining.length, 1);
  assert.strictEqual(JSON.parse(remaining[0]).sessionId, 'other');
});

test('executeCleanup 改写后提示历史仍是合法 JSONL', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  writeHistory(claude, [
    { display: 'a', sessionId: 'sess1' },
    { display: 'b', sessionId: 'other' },
  ]);

  cleaner.executeCleanup({ claudeDir: claude, sessionId: 'sess1' });
  const lines = fs
    .readFileSync(path.join(claude, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test('executeCleanup 不留临时文件', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  writeHistory(claude, [{ display: 'a', sessionId: 'sess1' }]);

  cleaner.executeCleanup({ claudeDir: claude, sessionId: 'sess1' });
  const leftovers = fs.readdirSync(claude).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, []);
});

test('executeCleanup 在 dryRun 下不删除任何东西', () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--proj', 'sess1');
  writeHistory(claude, [{ display: 'a', sessionId: 'sess1' }]);

  const result = cleaner.executeCleanup({
    claudeDir: claude,
    sessionId: 'sess1',
    dryRun: true,
  });
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(fs.existsSync(file), true);
  assert.ok(result.plan.files.length > 0);
});

test('executeCleanup 拒绝删除当前会话', () => {
  const claude = makeClaudeDir();
  const file = writeSession(claude, 'C--proj', 'sess1');

  const result = cleaner.executeCleanup({
    claudeDir: claude,
    sessionId: 'sess1',
    env: { CLAUDE_CODE_SESSION_ID: 'sess1' },
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.blocked.includes('当前正在使用'));
  assert.strictEqual(fs.existsSync(file), true);
});

test('executeCleanup 删除其他会话后当前会话不受影响', () => {
  const claude = makeClaudeDir();
  const keep = writeSession(claude, 'C--proj', 'keep');
  const drop = writeSession(claude, 'C--proj', 'drop');

  cleaner.executeCleanup({
    claudeDir: claude,
    sessionId: 'drop',
    env: { CLAUDE_CODE_SESSION_ID: 'keep' },
  });
  assert.strictEqual(fs.existsSync(drop), false);
  assert.strictEqual(fs.existsSync(keep), true);
});

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test('formatPlan 在被拦截时给出原因', () => {
  const claude = makeClaudeDir();
  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'ghost' });
  assert.ok(cleaner.formatPlan(plan).includes('无法删除'));
});

test('formatPlan 列出文件与目录', () => {
  const claude = makeClaudeDir();
  writeSession(claude, 'C--proj', 'sess1');
  fs.mkdirSync(path.join(claude, 'session-env', 'sess1'), { recursive: true });

  const plan = cleaner.planCleanup({ claudeDir: claude, sessionId: 'sess1' });
  const text = cleaner.formatPlan(plan);
  assert.ok(text.includes('文件'));
  assert.ok(text.includes('目录'));
  assert.ok(text.includes('会话记录'));
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
