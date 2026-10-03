// AI 客户端：OpenAI 兼容 /chat/completions，读取 config.json 的 agent 配置
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let _cfg = null;

function cfg() {
  if (!_cfg) {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    _cfg = raw.agent || {};
    if (!_cfg.apiKey || !_cfg.baseUrl || !_cfg.model) {
      throw new Error('config.json 缺少 agent.apiKey / agent.baseUrl / agent.model 配置');
    }
  }
  return _cfg;
}

// 剥离推理模型输出中的 <think> 段
function stripThink(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

// 从 AI 回复中提取 JSON（支持代码围栏与前后夹杂文字）
function extractJson(text) {
  let s = stripThink(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (_) { /* 继续尝试截取 */ }

  const open = s.search(/[{[]/);
  if (open === -1) throw new Error('AI 未返回 JSON：' + s.slice(0, 200));
  const openCh = s[open];
  const closeCh = openCh === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === openCh) {
      depth++;
    } else if (c === closeCh) {
      depth--;
      if (depth === 0) return JSON.parse(s.slice(open, i + 1));
    }
  }
  throw new Error('AI 返回的 JSON 不完整：' + s.slice(0, 200));
}

// 基础对话：返回文本内容
async function chat(messages, { temperature, timeout = 120000, retries = 1 } = {}) {
  const c = cfg();
  const url = c.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: c.model,
    messages,
    temperature: temperature != null ? temperature : (c.temperature != null ? c.temperature : 0.1)
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.apiKey}`
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`AI 接口错误 HTTP ${res.status}：${t.slice(0, 300)}`);
      }
      const data = await res.json();
      const content = data.choices && data.choices[0] && data.choices[0].message
        ? (data.choices[0].message.content || '')
        : '';
      if (!content) throw new Error('AI 返回内容为空');
      return content;
    } catch (e) {
      lastErr = e;
      const retriable = !(e.name === 'AbortError') || attempt < retries;
      if (attempt === retries || !retriable) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('AI 调用失败');
}

// 对话并解析 JSON
async function chatJson(messages, opts = {}) {
  const text = await chat(messages, opts);
  return extractJson(text);
}

module.exports = { chat, chatJson, extractJson, stripThink };
