#!/usr/bin/env node
/**
 * 生成 release 用的 `channel.json`——升级通道读的那份「最新是几、去哪下、多大、哈希多少」。
 *
 * 为什么不是发布时手写：这份文件是版本比较的唯一事实来源，写错一个数字，
 * 用户那边就会静默地「一直显示已是最新」。所以它由打包产物算出来，而不是抄一遍。
 *
 * 用法: node scripts/make-channel.mjs <tgz 路径> <channel.json 输出路径>
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const [tarballPath, outPath = 'channel.json'] = process.argv.slice(2)
if (typeof tarballPath !== 'string' || tarballPath === '') {
  process.stderr.write('usage: node scripts/make-channel.mjs <tarball> [out]\n')
  process.exit(2)
}

const bytes = readFileSync(tarballPath)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const repoUrl = typeof pkg.repository?.url === 'string'
  ? pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
  : typeof pkg.homepage === 'string'
    ? pkg.homepage.replace(/#readme$/, '')
    : ''
if (repoUrl === '') {
  process.stderr.write('package.json has no repository/homepage; cannot build release URLs\n')
  process.exit(1)
}

/* 稳定文件名：**不带版本号**。`releases/latest/download/<name>` 只解析 latest 这个 tag，
 * 不会替你改文件名；资产名带版本号的话，每一次升级都要改 spec。 */
const stableName = `${pkg.name}.tgz`

const document = {
  name: pkg.name,
  channel: 'stable',
  latest: pkg.version,
  updatedAt: new Date().toISOString(),
  homepage: repoUrl,
  engines: pkg.engines,
  versions: {
    [pkg.version]: {
      /* 指向同一次 release 里那份带版本号的资产，便于对账 */
      url: `${repoUrl}/releases/download/v${pkg.version}/${basename(tarballPath)}`,
      stableUrl: `${repoUrl}/releases/download/v${pkg.version}/${stableName}`,
      sha256,
      size: bytes.length,
      engines: pkg.engines,
      publishedAt: new Date().toISOString(),
    },
  },
}

writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`)
process.stdout.write(`channel.json: ${pkg.name}@${pkg.version} (${bytes.length} bytes, sha256 ${sha256.slice(0, 12)}…)\n`)
