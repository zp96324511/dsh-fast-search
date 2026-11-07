#!/usr/bin/env node
/**
 * 发布前自检：package.json 里写了什么，磁盘上就必须真有什么。
 *
 * 这个仓库的安装形态是「从 GitHub Release 的 tarball 直接装」，没有 registry 帮忙兜底——
 * 一个漏进 `files` 的文件不会在本地报错，只会在别人装完之后变成一个缺胳膊的插件。
 * 所以 `npm run check` 的第一件事是逐个 stat 那些路径，而不是相信清单。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const fail = (message) => problems.push(message)

function readJson(relative) {
  const file = join(root, relative)
  if (!existsSync(file)) {
    fail(`missing ${relative}`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`${relative} is not valid JSON: ${String(error.message ?? error)}`)
    return undefined
  }
}

const pkg = readJson('package.json')
if (pkg !== undefined) {
  if (pkg.name !== 'dsh-fast-search') fail(`unexpected name: ${pkg.name}`)
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
    fail(`version is not a release version: ${String(pkg.version)}`)
  }
  if (pkg.type !== 'module') fail('package must be ESM ("type": "module")')
  if (pkg.dependencies !== undefined && Object.keys(pkg.dependencies).length > 0) {
    // 零依赖是刻意的：profile 的 node_modules 根目录不保证有 schemastery 之类的东西。
    fail(`runtime dependencies are not allowed: ${Object.keys(pkg.dependencies).join(', ')}`)
  }
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch must point at ./cordis.patch.yml')
  if (pkg.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be "web"')

  const files = Array.isArray(pkg.files) ? pkg.files : []
  if (files.length === 0) fail('files[] is empty: the tarball would ship nothing')
  for (const entry of files) {
    if (isAbsolute(entry)) fail(`files[] entry is absolute: ${entry}`)
    if (!existsSync(join(root, entry))) fail(`files[] entry does not exist: ${entry}`)
  }
  for (const required of ['index.js', 'client.js', 'update.js', 'respawn.cjs', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    if (!files.includes(required)) fail(`files[] must include ${required}`)
  }

  const exportsField = pkg.exports ?? {}
  for (const [key, value] of Object.entries(exportsField)) {
    if (typeof value !== 'string') continue
    const target = value.startsWith('./') ? value.slice(2) : value
    if (isAbsolute(target)) fail(`exports["${key}"] is absolute`)
    if (!existsSync(join(root, target))) fail(`exports["${key}"] points at a missing file: ${value}`)
  }
  for (const required of ['.', './client', './update', './cordis.patch.yml', './package.json']) {
    if (exportsField[required] === undefined) fail(`exports is missing "${required}"`)
  }
}

/* patch 文件本身：必须能被 cordis 当作「插入一个插件」读懂 */
const patch = join(root, 'cordis.patch.yml')
if (existsSync(patch)) {
  const text = readFileSync(patch, 'utf8')
  if (!text.includes('id: fast-search')) fail('cordis.patch.yml has no `id: fast-search` entry')
  if (!text.includes('name: dsh-fast-search')) fail('cordis.patch.yml has no `name: dsh-fast-search` entry')
}

/* client.js 的 bundle 约定 */
const client = join(root, 'client.js')
if (existsSync(client)) {
  const text = readFileSync(client, 'utf8')
  if (!text.includes('__ModuleLoader__.load')) fail('client.js does not call __ModuleLoader__.load')
  if (!text.includes("id: 'dsh-fast-search'")) fail("client.js must declare id: 'dsh-fast-search'")
}

/* 版本一致性：CHANGELOG 顶部必须提到当前版本，免得发出去的 release 说不清改了什么 */
const changelog = join(root, 'CHANGELOG.md')
if (pkg !== undefined && existsSync(changelog)) {
  const text = readFileSync(changelog, 'utf8')
  if (!text.includes(pkg.version)) fail(`CHANGELOG.md does not mention ${pkg.version}`)
}

for (const required of ['README.md', 'LICENSE']) {
  const file = join(root, required)
  if (existsSync(file) && statSync(file).size < 64) fail(`${required} looks empty`)
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`  ✗ ${problem}\n`)
  process.stderr.write(`\ncheck-manifest: ${problems.length} problem(s)\n`)
  process.exit(1)
}
process.stdout.write(`check-manifest: ok (${pkg?.name}@${pkg?.version})\n`)
