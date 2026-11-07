#!/usr/bin/env node
/**
 * 真机验证升级通道：对着本机 profile 和真 GitHub Release 跑一次 `check()`。
 *
 * 这条链路有五个环节都可能静默出错——profile 里的安装 spec、通道分类、网络查询、
 * 版本比较、安装 spec 拼装——所以不能只靠单测里的假 fetch。
 *
 * 用法: node bench/probe-update.mjs [--json]
 */
import { createUpdater, PACKAGE_NAME, LOADED_VERSION, classifySpec, resolveChannel } from '../update.js';

const json = process.argv.includes('--json');
const updater = createUpdater({ logger: (m) => process.stderr.write(`[update] ${m}\n`) });
const view = await updater.check({ force: true });

const facts = {
  loaded: LOADED_VERSION,
  ok: view.ok,
  current: view.current,
  latest: view.latest,
  hasUpdate: view.hasUpdate,
  canUpgrade: view.canUpgrade,
  channel: view.channel,
  installSpec: view.installSpec,
  installedSpec: view.installedSpec,
  profile: view.profile?.name,
  runtime: view.runtime,
  compatible: view.compatible,
  engines: view.engines,
  stale: view.stale,
  restartRequired: view.restartRequired,
  error: view.error,
};

if (json) {
  process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
} else {
  const line = (label, value) => process.stdout.write(`${label.padEnd(14)} ${value ?? '—'}\n`);
  line('loaded', facts.loaded);
  line('current', facts.current);
  line('latest', facts.latest);
  line('hasUpdate', facts.hasUpdate);
  line('canUpgrade', facts.canUpgrade);
  line('channel', facts.channel.kind + ' / ' + facts.channel.origin + (facts.channel.repo ? ' / ' + facts.channel.repo : ''));
  line('installedSpec', facts.installedSpec);
  line('installSpec', facts.installSpec);
  line('profile', facts.profile);
  line('runtime', facts.runtime);
  line('compatible', facts.compatible);
  line('error', facts.error);
}

process.exitCode = facts.ok ? 0 : 1;
