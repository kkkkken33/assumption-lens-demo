import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDeepSeek } from './deepseek-client.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const provider = process.env.DEMO_PROVIDER === 'deepseek' ? 'deepseek' : 'codex';
const model = provider === 'deepseek' ? (process.env.DEEPSEEK_MODEL || 'deepseek-flash') : (process.env.CODEX_MODEL || 'gpt-6-luna');
const accessCode = process.env.DEMO_ACCESS_CODE || crypto.randomBytes(9).toString('base64url');
const sessionId = process.env.DEMO_SESSION_ID || crypto.randomUUID();
const codexBin = process.env.CODEX_BIN || 'codex';
const shareUrlFile = process.env.SHARE_URL_FILE || '';
const launcherPid = Number(process.env.LAUNCHER_PID || 0);
let busy = false;
let modelQueue = Promise.resolve();
let queuedJobs = 0;
const jobs = new Map();
setInterval(() => {
  for (const [id, job] of jobs) if (Date.now() - job.createdAt > 20 * 60 * 1000) jobs.delete(id);
}, 60000).unref();

if (launcherPid > 0) {
  setInterval(() => {
    try { process.kill(launcherPid, 0); }
    catch { process.exit(0); }
  }, 2000).unref();
}

function publicUrl() {
  if (!shareUrlFile) return null;
  try { return fs.readFileSync(shareUrlFile, 'utf8').trim() || null; }
  catch { return null; }
}

function lanUrl() {
  const candidates = [];
  for (const [name, net] of Object.entries(os.networkInterfaces())) for (const addr of net || []) {
    if (addr.family === 'IPv4' && !addr.internal) candidates.push({ name, address: addr.address });
  }
  candidates.sort((a, b) => Number(/vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback/i.test(a.name)) - Number(/vEthernet|WSL|Hyper-V|Docker|VirtualBox|VMware|Loopback/i.test(b.name)));
  return candidates.length && host !== '127.0.0.1' && host !== 'localhost' ? `http://${candidates[0].address}:${port}/` : null;
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 60000) throw new Error('请求内容过长');
  }
  return JSON.parse(body || '{}');
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型没有返回可解析的 JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function runCodex(prompt, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    const args = ['-a', 'never', '-c', 'model_reasoning_effort=none', 'exec', '-m', model, '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-s', 'read-only', '--json', prompt];
    const child = spawn(codexBin, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Codex 调用超时，请重试')); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > 1500000) child.kill(); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > 30000) stderr = stderr.slice(-30000); });
    child.on('error', e => { clearTimeout(timer); reject(new Error(`无法启动 Codex：${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text);
      const error = events.filter(e => e.type === 'error').at(-1)?.message;
      if (code !== 0 || !messages.length) return reject(new Error(error || stderr.trim().slice(-600) || `Codex 退出码 ${code}`));
      resolve(messages.at(-1));
    });
  });
}

function runModel(prompt, timeoutMs, jsonMode = false) {
  if (provider === 'deepseek') {
    return runDeepSeek(prompt, {
      apiKey: process.env.DEEPSEEK_API_KEY,
      model,
      endpoint: process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions',
      jsonMode,
      timeoutMs,
    });
  }
  return runCodex(prompt, timeoutMs);
}

function analyzePrompt(input) {
  return `You are drafting an inspectable coding-task plan for a human-computer interaction study. Respond in Simplified Chinese. Do not write code yet. Return ONLY valid JSON with this shape: {"summary":"string","steps":[{"id":"s1","label":"short task step","detail":"planned behavior","module":"coarse phase"}],"edges":[{"from":"s1","to":"s2"}],"assumptions":[{"id":"a1","title":"implementation decision","value":"initial proposed choice","source":"exact substring from request or empty","status":"uncertain","reason":"why decision matters","impact":"effect of initial choice","alternatives":[{"label":"option A","impact":"expected effect"},{"label":"option B","impact":"expected effect"}],"stepId":"s1"}]}. Use 3-7 steps in 2-4 ordered modules and 1-6 meaningful decisions. Keep module steps consecutive and edges forward in execution order. The initial steps, module order and edges are important starting structure; users may still change them after seeing possible consequences. Provide at least two distinct concrete alternatives with a specific expected effect for every decision. Decisions are review items, not questions about model confidence. Source must be an exact substring of the request. User request:\n${input}`;
}

function askPrompt(data) {
  return `你是 Assumption Lens 的节点助手。用简体中文回答用户针对当前模块或步骤的追问，先给直接答案，再说明对实现的影响，最多 220 字。不要擅自修改计划，也不要声称已经运行代码。\n原始任务：${data.input}\n当前计划：${JSON.stringify(data.plan).slice(0, 18000)}\n当前节点：${JSON.stringify(data.context || {}).slice(0, 4000)}\n选中的预设方案：${String(data.preset || '').slice(0, 1000)}\n用户追问：${String(data.question || '').slice(0, 2000)}`;
}

function outputPrompt(data) {
  return `You are a coding assistant. Respond in Simplified Chinese. Generate an implementation for the user request using the explicitly reviewed plan. Respond with a concise explanation, then complete runnable code in Markdown code blocks, then a short usage note. Do not access files or tools. If the plan conflicts with the original request, prefer the user's explicit corrections and flag unresolved ambiguity.\n\nORIGINAL REQUEST:\n${data.input}\n\nREVIEWED PLAN:\n${JSON.stringify(data.plan)}\n\nREVIEW MODE: ${data.mode}`;
}

function impactPrompt(data) {
  return `你是 Assumption Lens 的结构变更解释器。用户刚刚在可编辑的分层任务图中进行了一次操作。请用简体中文、最多 120 字解释这次变更可能如何影响任务流程、依赖关系和最终代码。指出具体受影响的步骤；如果无法确定实际结果，明确说明需要检查什么。不要要求用户确认模型的“不确定假设”，不要声称代码已经运行。\n原始需求：${data.input}\n操作：${String(data.change || '').slice(0, 500)}\n修改前：${JSON.stringify(data.before).slice(0, 18000)}\n修改后：${JSON.stringify(data.after).slice(0, 18000)}`;
}

const files = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/graph-routing.js', ['graph-routing.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && files.has(url.pathname)) {
    const [name, type] = files.get(url.pathname);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(root, 'web', name)).pipe(res);
    return;
  }
  if (url.pathname === '/api/health') return json(res, 200, { ok: true, sessionId, provider, model, busy, lanUrl: lanUrl(), publicUrl: publicUrl(), requiresCode: true });
  if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
  if (accessCode && req.headers.authorization !== `Bearer ${accessCode}`) return json(res, 401, { error: '访问码无效。请使用启动窗口中显示的完整链接。' });
  if (req.method === 'GET' && url.pathname === '/api/session-check') return json(res, 200, { ok: true, sessionId });
  if (req.method === 'GET' && url.pathname.startsWith('/api/job/')) {
    const job = jobs.get(url.pathname.slice('/api/job/'.length));
    return job ? json(res, 200, job) : json(res, 404, { error: '任务不存在或已过期。' });
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
  try {
    const data = await readBody(req);
    if (typeof data.input !== 'string' || data.input.length < 5 || data.input.length > 10000) throw new Error('需求长度应为 5–10000 字');
    if (!['/api/analyze', '/api/impact', '/api/ask', '/api/generate'].includes(url.pathname)) return json(res, 404, { error: 'Not found' });
    if (queuedJobs >= 30) return json(res, 429, { error: '待处理的模型请求过多，请稍后再试。' });
    queuedJobs++;
    busy = true;
    const id = crypto.randomBytes(12).toString('base64url');
    const job = { status: 'pending', createdAt: Date.now() };
    jobs.set(id, job);
    json(res, 202, { jobId: id });
    modelQueue = modelQueue.then(async () => {
      try {
        if (url.pathname === '/api/analyze') job.result = parseJson(await runModel(analyzePrompt(data.input), provider === 'deepseek' ? 120000 : 150000, true));
        if (url.pathname === '/api/impact') job.result = { output: await runModel(impactPrompt(data), provider === 'deepseek' ? 90000 : 120000) };
        if (url.pathname === '/api/ask') job.result = { output: await runModel(askPrompt(data), provider === 'deepseek' ? 90000 : 120000) };
        if (url.pathname === '/api/generate') job.result = { output: await runModel(outputPrompt(data), provider === 'deepseek' ? 180000 : 240000) };
        job.status = 'complete';
      } catch (error) { job.status = 'failed'; job.error = error.message; }
      finally { queuedJobs--; busy = queuedJobs > 0; }
    });
  } catch (e) { json(res, 400, { error: e.message }); }
});

server.listen(port, host, () => {
  console.log(`\nAssumption Lens Demo · ${model}`);
  console.log(`本机：http://localhost:${port}/${accessCode ? `?code=${accessCode}` : ''}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    for (const net of Object.values(os.networkInterfaces())) for (const addr of net || []) {
      if (addr.family === 'IPv4' && !addr.internal) console.log(`局域网：http://${addr.address}:${port}/${accessCode ? `?code=${accessCode}` : ''}`);
    }
  }
  console.log('将完整链接发给受信任的同一网络用户。按 Ctrl+C 停止。\n');
});
