#!/usr/bin/env node
/**
 * dsh-fast-search — 重启助手。
 *
 * 一键升级的最后一句话是「宿主必须重启」，而裸跑 `dsh web` 时没有任何东西会去重启它：
 * 那个进程就是用户的终端。直接退出会留下一具死掉的 GUI，所以宿主退出前把自己的命令行
 * 写到这里，由这个脱离的助手等旧进程消失后把同一条命令再拉起来。
 *
 * 三段等待，顺序不能换，否则会出现「看起来重启成功、实际没人服务」：
 *
 * 1. **旧进程** —— 端口在它退出前一直被占着；轮询 PID 是唯一不与关闭过程赛跑的等法。
 * 2. **端口** —— 进程退了，监听套接字还会在 TIME_WAIT 里停留一瞬，抢着绑定就 EADDRINUSE。
 * 3. **短暂静置** —— pnpm 可能还在收尾旧进程触发的文件操作。
 *
 * 子进程自带独立控制台、输出进日志文件、并且 unref；本助手随后退出，不留下任何东西。
 *
 * 用法: node respawn.cjs <base64(JSON{pid, argv, cwd, env, port, log})>
 */
'use strict'

const { spawn } = require('node:child_process')
const { appendFileSync, mkdirSync, openSync, closeSync } = require('node:fs')
const { dirname } = require('node:path')
const net = require('node:net')

const payloadArgument = process.argv[2]
if (typeof payloadArgument !== 'string' || payloadArgument === '') {
  process.stderr.write('respawn.cjs: missing payload\n')
  process.exit(2)
}

let payload
try {
  payload = JSON.parse(Buffer.from(payloadArgument, 'base64').toString('utf8'))
} catch (error) {
  process.stderr.write(`respawn.cjs: unreadable payload: ${String(error)}\n`)
  process.exit(2)
}

const { pid, argv, cwd, env, port, log } = payload
if (!Array.isArray(argv) || argv.length === 0) {
  process.stderr.write('respawn.cjs: payload has no argv\n')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function logLine(text) {
  if (typeof log !== 'string' || log === '') return
  try {
    mkdirSync(dirname(log), { recursive: true })
    appendFileSync(log, `${new Date().toISOString()} respawn: ${text}\n`)
  } catch { /* 写日志失败不能影响重启 */ }
}

/** 这个 PID 在本平台是否还活着。 */
function alive(candidate) {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) return false
  try {
    process.kill(candidate, 0)
    return true
  } catch (error) {
    // EPERM：进程存在但属于别人——仍然算活着。
    return error?.code === 'EPERM'
  }
}

async function waitForExit(candidate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(candidate)) return true
    await sleep(150)
  }
  return !alive(candidate)
}

/** 端口上已经没人监听时 resolve true。 */
function portFree(candidate) {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: candidate })
    const done = (free) => {
      socket.destroy()
      resolve(free)
    }
    socket.setTimeout(600)
    socket.once('connect', () => done(false))
    socket.once('timeout', () => done(true))
    socket.once('error', () => done(true))
  })
}

async function waitForPort(candidate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portFree(candidate)) return true
    await sleep(200)
  }
  return false
}

async function main() {
  const exited = await waitForExit(pid, 30000)
  logLine(exited ? `old process ${pid} exited` : `old process ${pid} still alive after 30s; starting anyway`)
  const freed = await waitForPort(port, 20000)
  logLine(freed ? `port ${port} released` : `port ${port} still busy after 20s; starting anyway`)
  await sleep(400)

  /* 子进程的输出通过继承的 fd 进日志文件。在这里打开、spawn 返回后再关是刻意的：
   * 把一个已经关掉的 fd 交给 spawn 是 EBADF——这个助手的第一版就是这样静默死掉、
   * 服务器没起来。 */
  let fd
  if (typeof log === 'string' && log !== '') {
    try {
      mkdirSync(dirname(log), { recursive: true })
      fd = openSync(log, 'a')
    } catch {
      fd = undefined
    }
  }

  const [command, ...args] = argv
  let child
  try {
    child = spawn(command, args, {
      cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
      env: env && typeof env === 'object' ? env : process.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
    })
  } catch (error) {
    logLine(`failed to start ${command}: ${String(error)}`)
    process.exit(1)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 子进程持有自己的副本 */ }
    }
  }

  child.on('error', (error) => { logLine(`child error: ${String(error)}`) })
  child.unref()
  logLine(`started pid ${child.pid ?? '?'}: ${argv.join(' ')}`)

  /* 立刻退出（端口仍被占、参数不对）是日志唯一说不清的那种失败：看起来像起来了。 */
  await sleep(1500)
  if (child.exitCode !== null && child.exitCode !== undefined) {
    logLine(`the new process exited immediately with ${child.exitCode}`)
    process.exit(1)
  }
  await sleep(200)
  process.exit(0)
}

void main()
