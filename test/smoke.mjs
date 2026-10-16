/**
 * dsh-gui-guard 自测（零依赖，`node test/smoke.mjs`）。
 *
 * 会真的做一次点击 —— 但目标是 DSH 主窗口的**标题栏空白处**，点下去只会让窗口
 * 拿到焦点，不触发任何功能。坐标是从 probe 的实时 rect 算出来的，不写死。
 */

import { runAction } from '../lib/index.js';
import * as plugin from '../lib/index.js';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✅ ${name}`);
  else {
    failed += 1;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

console.log('① list');
const list = await runAction('list');
check('返回窗口数组', Array.isArray(list.windows) && list.windows.length > 0, JSON.stringify(list).slice(0, 120));
check('能列出带标题的窗口', list.windows.every((w) => typeof w.title === 'string'));
const dshLike = list.windows.find((w) => /DeepSeek Harness/i.test(w.title));
check('找得到 DSH 主窗口（用作后续测试目标）', Boolean(dshLike), JSON.stringify(list.windows.map((w) => w.title)));

console.log('\n② probe：体检目标窗口');
const target = dshLike ? { pid: dshLike.pid } : { window: 'DeepSeek Harness' };
const probe = await runAction('probe', target);
check('probe 成功', probe.ok === true, JSON.stringify(probe).slice(0, 160));
check('拿到 DPI 与缩放', typeof probe.dpi?.scale === 'number' && probe.dpi.scale > 0, JSON.stringify(probe.dpi));
check('给出逻辑/物理两套分辨率', probe.screen?.logicalWidth > 0 && probe.screen?.physicalWidth > 0, JSON.stringify(probe.screen));
check(
  '物理 = 逻辑 × 缩放（口径自洽）',
  Math.abs(probe.screen.physicalWidth - probe.screen.logicalWidth * probe.dpi.scale) <= 2,
  `${probe.screen.physicalWidth} vs ${probe.screen.logicalWidth} × ${probe.dpi.scale}`,
);
check('返回 notes 数组（给模型看的提醒）', Array.isArray(probe.notes), typeof probe.notes);
check('返回窗口 rect', typeof probe.rect?.width === 'number' && probe.rect.width > 0, JSON.stringify(probe.rect));

console.log('\n③ 找不到窗口时要老实报错');
const missing = await runAction('probe', { window: 'dsh-gui-guard-no-such-window-xyz' });
check('ok=false', missing.ok === false);
check('error=window-not-found', missing.error === 'window-not-found', String(missing.error));

console.log('\n④ click：按物理坐标请求，内部换算成逻辑坐标');
if (probe.ok === true && probe.rect.width > 0) {
  const scale = probe.dpi.scale;
  // 标题栏中间偏左：rect 是逻辑像素，先换算成物理像素再请求
  const physX = Math.round((probe.rect.left + probe.rect.width * 0.5) * scale);
  const physY = Math.round((probe.rect.top + 8) * scale);
  const click = await runAction('click', { pid: probe.pid, x: physX, y: physY, space: 'physical' });
  check('click 成功', click.ok === true, JSON.stringify(click).slice(0, 160));
  check('请求口径记为 physical', click.requested?.space === 'physical', JSON.stringify(click.requested));
  check('落点口径记为 logical', click.applied?.space === 'logical', JSON.stringify(click.applied));
  check(
    '落点 = 请求 ÷ 缩放',
    Math.abs(click.applied.x - Math.round(physX / scale)) <= 2 && Math.abs(click.applied.y - Math.round(physY / scale)) <= 2,
    `请求(${physX},${physY}) → 落点(${click.applied?.x},${click.applied?.y})，缩放 ${scale}`,
  );
  check('光标确实到达了目标', click.cursorMatches === true, JSON.stringify(click.cursorNowAt));
} else {
  console.log('  ⏭ 跳过（没有可用的 probe 结果）');
}

console.log('\n⑤ space=logical 时不做换算');
if (probe.ok === true) {
  const logicalX = Math.round(probe.rect.left + probe.rect.width * 0.4);
  const logicalY = Math.round(probe.rect.top + 8);
  const click2 = await runAction('click', { pid: probe.pid, x: logicalX, y: logicalY, space: 'logical' });
  check('落点原样使用逻辑坐标', click2.applied?.x === logicalX && click2.applied?.y === logicalY,
    `请求(${logicalX},${logicalY}) → 落点(${click2.applied?.x},${click2.applied?.y})`);
}

console.log('\n⑥ type 的错误路径');
const badType = await runAction('type', { window: 'dsh-gui-guard-no-such-window-xyz', text: 'x' });
check('找不到窗口时 ok=false', badType.ok === false);

console.log('\n⑦ 工具返回值必须是 lossless JSON（宿主会校验；undefined 会让整次调用直接判失败）');
let registered = null;
plugin.apply({
  tools: { register: (def) => { registered = def; return () => {}; } },
  systemPrompt: { section: () => () => {} },
}, { announceToAgent: false });
check('apply 注册了工具', registered !== null && typeof registered.execute === 'function');

/** 找出对象里所有 undefined 的路径 —— 宿主校验的就是这个。 */
function findUndefined(value, path = '$', out = []) {
  if (value === undefined) { out.push(path); return out; }
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findUndefined(v, `${path}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value)) findUndefined(v, `${path}.${k}`, out);
  return out;
}

for (const args of [
  { action: 'list' },
  { action: 'probe', window: 'dsh-gui-guard-no-such-window-xyz' },
  { action: 'click', window: 'x' },
  { action: 'type', window: 'x' },
  { action: 'bogus-action' },
]) {
  const res = await registered.execute(args);
  const bad = findUndefined(res);
  check(`execute(${JSON.stringify(args)}) 无 undefined 字段`, bad.length === 0, bad.join(', '));
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
