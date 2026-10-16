/**
 * dsh-gui-guard — host 入口
 *
 * 一个工具，五种动作，把「agent 操作 Windows 窗口」这件事里最容易翻车的四步
 * 收进一次原子调用：
 *
 *   1. 窗口被最小化        → prepare / click 会自动还原
 *   2. 窗口不在前台        → click / type 会先激活，再动手
 *   3. DPI 缩放导致两套坐标 → click 默认按「物理像素」收坐标，内部换算成逻辑像素
 *   4. 输入首字符被吃掉     → type 把「激活」和「输入」分成两步做
 *
 * 后端是同目录的 win32.ps1（纯 ASCII，避免 Windows PowerShell 5.1 把 UTF-8
 * 无 BOM 的中文读成乱码）。node 与它之间**只通过 base64 JSON 通信**，
 * 彻底躲开命令行的引号与转义问题。
 *
 * @module dsh-gui-guard
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 插件身份。 */
export const name = 'dsh-gui-guard';

/** 需要宿主注入的服务。 */
export const inject = ['tools', 'systemPrompt'];

const SECTION_ORDER = 203;
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'win32.ps1');

/** 面向模型的公告。 */
export const GUI_GUARD_GUIDANCE = [
  '本机已安装 **dsh-gui-guard**（Windows 窗口操作的可靠性层）：提供 `gui_guard` 工具，把「这个窗口现在能不能安全操作」和「点击/输入该怎么做才对」变成一次调用。',
  '**什么时候用**：任何要按屏幕坐标点击、往窗口里打字、或截图/OCR 之后准备动手的时刻 —— 尤其是目标窗口是 Flutter / Electron / Qt 这类自绘界面（UIA 抓不到控件，只能靠坐标）时。',
  '动作：`probe`（体检：是否最小化 / 是否前台 / DPI 缩放 / 逻辑与物理分辨率）、`prepare`（还原并置于前台，可选移动尺寸）、`click`、`type`、`list`（列出有窗口的进程）。',
  '**两条它替你挡掉的坑**：① 窗口最小化或不在前台时，直接按坐标点击会落空 —— 用 `click`，它会先还原再激活；② 系统有 DPI 缩放时，**截图/OCR 给的是物理像素、GetWindowRect 给的是逻辑像素**，`click` 默认就按物理像素收坐标并在内部换算，**不要自己乘除**。',
  '它只操作本机窗口，不联网、不上传任何东西。',
].join('\n');

/** 可选 shell：pwsh 优先（原生 UTF-8），否则退回系统 Windows PowerShell。 */
let shellPromise = null;
function pickShell() {
  if (shellPromise === null) {
    shellPromise = (async () => {
      for (const candidate of ['pwsh', 'powershell.exe']) {
        try {
          await new Promise((resolve, reject) => {
            execFile(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
              { timeout: 8000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
          });
          return candidate;
        } catch {
          /* 试下一个 */
        }
      }
      return 'powershell.exe';
    })();
  }
  return shellPromise;
}

/**
 * 跑一次后端动作。
 * @param {string} action list | probe | prepare | click | type
 * @param {object} payload 动作参数
 * @returns {Promise<object>} 后端返回的 JSON
 */
async function runAction(action, payload = {}) {
  const shell = await pickShell();
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT_PATH, '-Action', action, '-Payload64', b64,
  ];
  return await new Promise((resolve, reject) => {
    execFile(shell, args, {
      encoding: 'utf8',
      timeout: 45000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const text = String(stdout || '').trim();
      const lastLine = text.split(/\r?\n/).filter((l) => l.trim() !== '').pop();
      if (lastLine) {
        try {
          resolve(JSON.parse(lastLine));
          return;
        } catch {
          /* 落到下面的错误分支 */
        }
      }
      if (err) {
        reject(new Error(`${err.message}${stderr ? ` | ${String(stderr).slice(0, 300)}` : ''}`));
        return;
      }
      reject(new Error(`后端没有返回可解析的 JSON：${text.slice(0, 200)}`));
    });
  });
}

/** 把一次动作的结果压成给模型看的一段话。 */
function renderText(action, value) {
  if (value === null || typeof value !== 'object') return `gui_guard ${action}: （无输出）`;
  if (value.ok === false) return `gui_guard ${action} 失败：${value.error ?? '未知错误'}`;

  switch (action) {
    case 'list': {
      const rows = Array.isArray(value.windows) ? value.windows : [];
      const head = `gui_guard list：${rows.length} 个有窗口的进程`;
      const body = rows.map((w) => `- ${w.minimized ? '🗕 ' : ''}${w.name} (pid ${w.pid}) — ${w.title}`).join('\n');
      return [head, body].filter(Boolean).join('\n');
    }
    case 'probe':
    case 'prepare': {
      const lines = [
        `gui_guard ${action}：${value.process} (pid ${value.pid}) — ${value.title}`,
        `  窗口状态：${value.minimized ? '已最小化' : '正常'}｜${value.foreground ? '在前台' : '不在前台'}`,
        `  窗口位置（逻辑像素）：left=${value.rect?.left} top=${value.rect?.top} ${value.rect?.width}×${value.rect?.height}`,
        `  DPI：${value.dpi?.window}（缩放 ${(value.dpi?.scale ?? 1) * 100}%）`,
        `  屏幕：逻辑 ${value.screen?.logicalWidth}×${value.screen?.logicalHeight}｜物理 ${value.screen?.physicalWidth}×${value.screen?.physicalHeight}`,
      ];
      if (Array.isArray(value.notes) && value.notes.length > 0) {
        lines.push('  提示：');
        for (const n of value.notes) lines.push(`    · ${n}`);
      }
      return lines.join('\n');
    }
    case 'click': {
      const lines = [
        `gui_guard click：已点击 ${value.window} (pid ${value.pid})`,
        `  请求坐标：(${value.requested?.x}, ${value.requested?.y}) 空间=${value.requested?.space}`,
        `  实际落点：(${value.applied?.x}, ${value.applied?.y}) 空间=logical，缩放 ${value.applied?.scale}`,
        `  光标现在：(${value.cursorNowAt?.x}, ${value.cursorNowAt?.y})${value.cursorMatches ? ' ✓ 与目标一致' : ' ⚠ 与目标不一致'}`,
        `  点击前：${value.wasMinimized ? '最小化' : '正常'}｜${value.wasForeground ? '前台' : '非前台'}`,
      ];
      if (value.note) lines.push(`  ⚠ ${value.note}`);
      return lines.join('\n');
    }
    case 'type': {
      return [
        `gui_guard type：已向 ${value.window} 发送 ${value.sentLength} 个字符`,
        `  发送前：${value.wasMinimized ? '最小化' : '正常'}｜${value.wasForeground ? '前台' : '非前台'}`,
      ].join('\n');
    }
    default:
      return `gui_guard ${action}：${JSON.stringify(value).slice(0, 600)}`;
  }
}

/** 动态取 defineTool：宿主里有就用真的，单测时退化成恒等。 */
let defineTool = (def) => def;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch {
  /* 宿主外运行 */
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ announceToAgent?: boolean, enabled?: boolean }} [config]
 */
export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return;
  const disposers = [];

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    disposers.push(ctx.tools.register(defineTool({
      name: 'gui_guard',
      description: [
        '在按坐标点击/打字之前，先确认「现在这个窗口能不能安全操作」，并让点击与输入自动处理还原、激活与 DPI 坐标口径。',
        "action='probe'：体检一个窗口 —— 是否最小化、是否在前台、DPI 缩放、屏幕的逻辑与物理分辨率、以及该注意什么。先 probe 再动手。",
        "action='prepare'：把窗口还原（取消最小化）并置于前台，可选同时移动/改尺寸（给 x/y/width/height）。",
        "action='click'：安全点击。会自动还原+激活窗口，再落点。坐标默认按**物理像素**（截图/OCR 给出的那种）解释，内部换算成逻辑像素；如果你的坐标本来就是逻辑像素，传 space=\"logical\"。",
        "action='type'：安全输入。会把「激活窗口」和「发送按键」分成两步，避免刚激活时第一个字符被吞。",
        "action='list'：列出当前所有带窗口的进程（找目标用）。",
        '窗口定位：给 window（标题子串，精确匹配优先）或 pid，二选一。',
        '纯本地：不联网、不上传，只操作本机窗口。',
      ].join('\n'),
      timeoutMs: 90000,
      parameters: {
        action: {
          type: 'string',
          description: "One of: probe, prepare, click, type, list. 'list' 不需要 window/pid。",
        },
        window: {
          type: 'string',
          description: '窗口标题（精确匹配优先，否则取第一个子串命中）。与 pid 二选一。',
        },
        pid: {
          type: 'number',
          description: '目标进程 pid。与 window 二选一，更精确。',
        },
        x: {
          type: 'number',
          description: 'click 用：横坐标。',
        },
        y: {
          type: 'number',
          description: 'click 用：纵坐标。',
        },
        space: {
          type: 'string',
          description: "click 用：坐标口径 —— 'physical'（默认，截图/OCR 那种）或 'logical'（GetWindowRect 那种）。",
        },
        text: {
          type: 'string',
          description: 'type 用：要发送的文本（SendKeys 语法，特殊字符需自行转义，如 {ENTER}）。',
        },
        width: {
          type: 'number',
          description: 'prepare 用（可选）：改窗口宽度；给了 width/height 才会移动或改尺寸。',
        },
        height: {
          type: 'number',
          description: 'prepare 用（可选）：改窗口高度。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            data: { type: 'json' },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok === false) {
            return [{ type: 'text', text: `gui_guard ${String(value.action)} 失败：${String(value.error ?? '未知错误')}` }];
          }
          return [{ type: 'text', text: renderText(String(value.action), value.data) }];
        },
      },
      async execute(args) {
        const a = args ?? {};
        const action = String(a.action ?? 'probe').trim().toLowerCase();
        if (!['probe', 'prepare', 'click', 'type', 'list'].includes(action)) {
          return { ok: false, action, error: `unknown action: ${action}` };
        }

        const payload = {};
        if (typeof a.window === 'string' && a.window !== '') payload.window = a.window;
        if (typeof a.pid === 'number') payload.pid = a.pid;
        if (typeof a.x === 'number') payload.x = a.x;
        if (typeof a.y === 'number') payload.y = a.y;
        if (typeof a.space === 'string' && a.space !== '') payload.space = a.space;
        if (typeof a.text === 'string') payload.text = a.text;
        if (typeof a.width === 'number') payload.width = a.width;
        if (typeof a.height === 'number') payload.height = a.height;

        if (action !== 'list' && payload.window === undefined && payload.pid === undefined) {
          return { ok: false, action, error: '需要 window（标题子串）或 pid 来定位目标窗口' };
        }
        if (action === 'click' && (payload.x === undefined || payload.y === undefined)) {
          return { ok: false, action, error: 'click 需要 x 与 y' };
        }
        if (action === 'type' && payload.text === undefined) {
          return { ok: false, action, error: 'type 需要 text' };
        }

        try {
          const data = await runAction(action, payload);
          return { ok: data.ok !== false, action, data, error: data.ok === false ? String(data.error ?? '') : undefined };
        } catch (err) {
          return { ok: false, action, error: err instanceof Error ? err.message : String(err) };
        }
      },
    })));
  }

  if (cfg.announceToAgent !== false && ctx.systemPrompt !== undefined
    && typeof ctx.systemPrompt.section === 'function') {
    disposers.push(ctx.systemPrompt.section({
      name: 'plugin:gui-guard',
      order: SECTION_ORDER,
      text: GUI_GUARD_GUIDANCE,
    }));
  }

  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
    }, 'dsh-gui-guard: teardown');
  }
}

/** 供测试直接使用。 */
export { runAction };
