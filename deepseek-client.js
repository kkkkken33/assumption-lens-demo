const defaultEndpoint = 'https://api.deepseek.com/chat/completions';

async function checkBalance(apiKey, endpoint, fetchImpl) {
  try {
    const url = new URL('/user/balance', endpoint);
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const result = await response.json();
    return typeof result?.is_available === 'boolean' ? result.is_available : null;
  } catch { return null; }
}

export async function runDeepSeek(prompt, {
  apiKey,
  model = 'deepseek-flash',
  endpoint = defaultEndpoint,
  jsonMode = false,
  timeoutMs = 120000,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('缺少 DeepSeek API Key。请重新启动 API 版并录入密钥。');
  const request = {
    model,
    messages: [
      { role: 'system', content: jsonMode ? '请用简体中文回答，只输出有效 JSON，不要使用 Markdown。' : '请用简体中文回答。' },
      { role: 'user', content: prompt },
    ],
    thinking: { type: 'disabled' },
    stream: false,
    max_tokens: jsonMode ? 5000 : 8000,
  };
  if (jsonMode) request.response_format = { type: 'json_object' };

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('DeepSeek 响应超时，请重试。');
    throw new Error(`无法连接 DeepSeek：${error.message}`);
  }

  let data;
  try { data = await response.json(); }
  catch { throw new Error(`DeepSeek 返回了无法解析的响应（HTTP ${response.status}）。`); }
  if (!response.ok) {
    const detail = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 300).replaceAll(apiKey, '[已隐藏]') : '';
    if (response.status === 401) throw new Error('DeepSeek API Key 无效。请在本机运行“重设API密钥.cmd”后重新录入。');
    if (response.status === 402) {
      const available = await checkBalance(apiKey, endpoint, fetchImpl);
      const requestId = detail.match(/request[_\s]?id\s*[:：]\s*([a-z0-9-]+)/i)?.[1];
      const suffix = requestId ? ` 请求 ID：${requestId}。` : '';
      if (available === true) throw new Error(`DeepSeek 模型请求返回 HTTP 402，但当前启动所用密钥的余额接口显示可用。请把请求 ID 提供给 DeepSeek 支持核查。${suffix}`);
      if (available === false) throw new Error(`当前启动所用密钥的余额接口显示不可用。请确认它与查询余额时使用的是同一把密钥。${suffix}`);
      throw new Error(`DeepSeek 模型请求返回 HTTP 402，暂时无法核对当前密钥余额。请确认启动时使用的密钥，并保留请求 ID。${suffix}`);
    }
    throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek 返回了空内容，请重试。');
  return content;
}
