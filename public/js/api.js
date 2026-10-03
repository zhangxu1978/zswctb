// 前端公共：API 封装 + 常量 + 工具函数
const TYPE_LABEL = {
  single: '单选题', multiple: '多选题', judge: '判断题',
  fill: '填空题', qa: '问答题', writing: '写作题'
};
const TYPE_ORDER = ['single', 'multiple', 'judge', 'fill', 'qa', 'writing'];
const STATUS_ZH = {
  published: '未开始答题', started: '已开始答题',
  completed: '已完成答题', graded: '已判卷'
};
const STATUS_CLS = { published: 'gray', started: 'blue', completed: 'orange', graded: 'green' };
const SUBJECTS = ['语文', '数学', '英语'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  let data = {};
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) throw new Error(data.error || `请求失败 HTTP ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  let t = document.getElementById('__toast');
  if (!t) {
    t = document.createElement('div');
    t.id = '__toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast' + (isErr ? ' err' : ''); }, 2600);
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}小时${m % 60}分${s}秒`;
  }
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function fmtClock(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function statusBadge(status, statusZh) {
  return `<span class="badge ${STATUS_CLS[status] || 'gray'}">${esc(statusZh || STATUS_ZH[status] || status)}</span>`;
}

// 单次考试（exam）级状态，与试卷状态区分
const EXAM_STATUS_ZH = { ongoing: '进行中', submitted: '待判卷', graded: '已判卷' };
const EXAM_STATUS_CLS = { ongoing: 'blue', submitted: 'orange', graded: 'green' };

function examStatusBadge(status, statusZh) {
  return `<span class="badge ${EXAM_STATUS_CLS[status] || 'gray'}">${esc(statusZh || EXAM_STATUS_ZH[status] || status)}</span>`;
}

// 按大题顺序排序题目
function sortQuestions(qs) {
  return [...qs].sort((a, b) => {
    const d = TYPE_ORDER.indexOf(a.snapshot.type) - TYPE_ORDER.indexOf(b.snapshot.type);
    return d !== 0 ? d : a.idx - b.idx;
  });
}
