'use strict';

// 校验 GitHub Actions workflow 文件的 YAML 结构
// 只做结构检查，不引入 yaml 依赖

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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
const file = path.join(root, '.github', 'workflows', 'publish.yml');
const src = fs.readFileSync(file, 'utf8');
const lines = src.split(/\r?\n/);

test('workflow 文件存在', () => {
  assert.ok(fs.existsSync(file));
});

test('不含制表符', () => {
  const bad = lines.map((l, i) => (l.includes('\t') ? i + 1 : 0)).filter(Boolean);
  assert.deepStrictEqual(bad, [], '制表符出现在行 ' + bad.join(','));
});

test('缩进为偶数空格', () => {
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    assert.strictEqual(indent % 2, 0, '第 ' + (i + 1) + ' 行缩进 ' + indent + ' 不是偶数');
  }
});

test('引号成对', () => {
  const quotes = (src.match(/"/g) || []).length;
  assert.strictEqual(quotes % 2, 0, '双引号数量为奇数');
});

test('顶层键为 name on permissions jobs', () => {
  const top = lines.filter((l) => /^[A-Za-z_]/.test(l)).map((l) => l.split(':')[0]);
  assert.deepStrictEqual(top, ['name', 'on', 'permissions', 'jobs']);
});

test('触发器含 push tag 与 workflow_dispatch', () => {
  assert.ok(/^on:/m.test(src), '缺少 on 块');
  assert.ok(/"v\*"/.test(src), '缺少 v* tag 匹配');
  assert.ok(/workflow_dispatch:/.test(src), '缺少手动触发');
});

test('发布 job 使用 NPM_TOKEN secret 认证', () => {
  const publishBlock = src.slice(src.indexOf('  publish:'), src.indexOf('  release:'));
  assert.ok(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/.test(publishBlock), '发布 job 未引用 NPM_TOKEN secret');
  assert.ok(/registry-url:\s*"https:\/\/registry\.npmjs\.org\/"/.test(publishBlock), '缺 registry-url');
});

test('发布 job 支持 stage 与 publish 两种模式', () => {
  const publishBlock = src.slice(src.indexOf('  publish:'), src.indexOf('  release:'));
  assert.ok(/npm stage publish/.test(publishBlock), '缺暂存分支');
  assert.ok(/npm publish/.test(publishBlock), '缺直发分支');
  assert.ok(/mode="stage"/.test(publishBlock), '缺默认 stage 兜底');
});

test('手动触发提供 mode 选项且默认 stage', () => {
  assert.ok(/mode:/.test(src), '缺 mode 输入');
  assert.ok(/options:\s*\[stage,\s*publish\]/.test(src), 'mode 选项不对');
  assert.ok(/default:\s*stage/.test(src), 'mode 默认值应为 stage');
});

test('发布 job 只需读权限不需写内容', () => {
  const publishBlock = src.slice(src.indexOf('  publish:'), src.indexOf('  release:'));
  assert.ok(/contents:\s*read/.test(publishBlock), '发布 job 缺 contents read');
  assert.ok(!/contents:\s*write/.test(publishBlock), '发布 job 不该有 contents write');
});

test('发布 job 校验 tag 版本与包清单一致', () => {
  const publishBlock = src.slice(src.indexOf('  publish:'), src.indexOf('  release:'));
  assert.ok(/require\('\.\/package\.json'\)\.version/.test(publishBlock), '缺版本比对');
});

test('创建 Release 的 job 具备写内容权限', () => {
  const releaseBlock = src.slice(src.indexOf('  release:'));
  assert.ok(/contents:\s*write/.test(releaseBlock), 'Release job 缺 contents write');
  assert.ok(/softprops\/action-gh-release/.test(releaseBlock), '缺 Release 步骤');
});

test('action 版本为当前存在的 v7 与 v3', () => {
  assert.ok(/actions\/checkout@v7/.test(src), 'checkout 版本异常');
  assert.ok(/actions\/setup-node@v7/.test(src), 'setup-node 版本异常');
  assert.ok(/softprops\/action-gh-release@v3/.test(src), 'gh-release 版本异常');
});

test('仓库不提交 .npmrc 避免覆盖本机凭据', () => {
  assert.ok(!fs.existsSync(path.join(root, '.npmrc')), '项目级 .npmrc 会让无 NPM_TOKEN 变量的本机认证失效');
});

test('发布 job 禁用 npm 缓存', () => {
  const publishBlock = src.slice(src.indexOf('  publish:'), src.indexOf('  release:'));
  assert.ok(/package-manager-cache:\s*false/.test(publishBlock), 'release 构建不该缓存');
});

test('测试 job 覆盖双平台', () => {
  const testBlock = src.slice(src.indexOf('  test:'), src.indexOf('  publish:'));
  assert.ok(/windows-latest/.test(testBlock), '缺 Windows');
  assert.ok(/ubuntu-latest/.test(testBlock), '缺 Ubuntu');
  assert.ok(/npm test/.test(testBlock), '缺测试步骤');
});

test('不使用已废弃的 npm ci', () => {
  assert.ok(!/npm ci/.test(src), '本项目无 lock 文件，npm ci 会失败');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
