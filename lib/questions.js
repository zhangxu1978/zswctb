// 题库 CRUD 与题目校验
const { db, genId, now } = require('./db');

const TYPES = ['single', 'multiple', 'judge', 'fill', 'qa', 'writing'];
const TYPE_LABEL = {
  single: '单选题', multiple: '多选题', judge: '判断题',
  fill: '填空题', qa: '问答题', writing: '写作题'
};
const OBJECTIVE_TYPES = ['single', 'multiple', 'judge'];
const SUBJECTS = ['语文', '数学', '英语'];

function normalizeJudgeAnswer(v) {
  const s = String(v).trim().toLowerCase();
  if (['对', '正确', 'true', 't', 'yes', 'y', '√', 'a'].includes(s)) return '对';
  if (['错', '错误', 'false', 'f', 'no', 'n', '×', 'b'].includes(s)) return '错';
  throw new Error(`判断题答案不合法：${v}（应为 对/错）`);
}

function stripOptionPrefix(opt) {
  return String(opt).replace(/^\s*[A-Za-z]\s*[.、．:：]\s*/, '').trim();
}

// 校验并归一化题目数据，返回可直接入库的字段对象
function validateQuestion(data) {
  const type = data.type;
  if (!TYPES.includes(type)) throw new Error(`题型不合法：${type}（可选：${TYPES.join(',')}）`);
  const subject = String(data.subject || '').trim();
  if (!subject) throw new Error('科目不能为空');
  const content = String(data.content || '').trim();
  if (!content) throw new Error('题干不能为空');

  let options = null;
  let answer;

  if (type === 'single' || type === 'multiple') {
    if (!Array.isArray(data.options) || data.options.length < 2) {
      throw new Error('选择题必须提供至少 2 个选项');
    }
    options = data.options.map(stripOptionPrefix).filter(Boolean);
    if (options.length < 2) throw new Error('选择题选项不能全为空');
    const maxLetter = String.fromCharCode(64 + options.length);
    if (type === 'single') {
      let a = String(data.answer || '').trim().toUpperCase().replace(/^\s*([A-Z])\s*[.、．:：]?\s*$/, '$1');
      if (!/^[A-Z]$/.test(a) || a > maxLetter) {
        throw new Error(`单选题答案不合法：${data.answer}（应为 A-${maxLetter}）`);
      }
      answer = a;
    } else {
      let arr = Array.isArray(data.answer) ? data.answer : String(data.answer || '').split(/[,,，、\s]+/);
      arr = [...new Set(arr.map((x) => String(x).trim().toUpperCase().replace(/[.、．:：]/g, '')))].filter(Boolean).sort();
      if (!arr.length || arr.some((a) => !/^[A-Z]$/.test(a) || a > maxLetter)) {
        throw new Error(`多选题答案不合法（应为 A-${maxLetter} 内的字母组合）`);
      }
      answer = arr;
    }
  } else if (type === 'judge') {
    answer = normalizeJudgeAnswer(data.answer);
  } else if (type === 'fill') {
    answer = Array.isArray(data.answer)
      ? data.answer.map((x) => String(x).trim()).filter(Boolean)
      : String(data.answer || '').trim();
    if (typeof answer === 'string') answer = answer ? [answer] : [];
    if (!answer.length) throw new Error('填空题必须提供参考答案（数组，每空一项，支持 "答A|答B" 多写法）');
  } else {
    answer = String(data.answer || '').trim();
    if (!answer) throw new Error(`${TYPE_LABEL[type]}必须提供参考答案`);
  }

  const score = Number(data.score);
  const difficulty = Math.min(5, Math.max(1, Math.round(Number(data.difficulty) || 3)));
  return {
    subject,
    type,
    content,
    options: options ? JSON.stringify(options) : null,
    answer: JSON.stringify(answer),
    analysis: data.analysis ? String(data.analysis).trim() : null,
    score: Number.isFinite(score) && score > 0 ? score : 5,
    difficulty,
    source: data.source || 'manual',
    tags: data.tags ? JSON.stringify(data.tags) : null
  };
}

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    options: row.options ? JSON.parse(row.options) : null,
    answer: JSON.parse(row.answer),
    tags: row.tags ? JSON.parse(row.tags) : []
  };
}

function create(data) {
  const q = validateQuestion(data);
  const id = genId('q');
  db.run(
    `INSERT INTO questions (id, subject, type, content, options, answer, analysis, score, difficulty, source, tags, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, q.subject, q.type, q.content, q.options, q.answer, q.analysis, q.score, q.difficulty, q.source, q.tags, now()
  );
  return get(id);
}

function update(id, data) {
  const old = get(id);
  if (!old) throw new Error('题目不存在：' + id);
  const q = validateQuestion({ ...old, ...data, source: old.source });
  db.run(
    `UPDATE questions SET subject=?, type=?, content=?, options=?, answer=?, analysis=?, score=?, difficulty=?, tags=? WHERE id=?`,
    q.subject, q.type, q.content, q.options, q.answer, q.analysis, q.score, q.difficulty, q.tags, id
  );
  return get(id);
}

function remove(id) {
  const old = db.get('SELECT id FROM questions WHERE id=?', id);
  if (!old) throw new Error('题目不存在：' + id);
  db.run('DELETE FROM questions WHERE id=?', id);
  return { ok: true };
}

function get(id) {
  return parseRow(db.get('SELECT * FROM questions WHERE id=?', id));
}

function list({ subject, type, keyword, page = 1, pageSize = 50 } = {}) {
  const where = [];
  const params = [];
  if (subject) { where.push('subject=?'); params.push(subject); }
  if (type) { where.push('type=?'); params.push(type); }
  if (keyword) { where.push('(content LIKE ? OR analysis LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM questions ${w}`, ...params).n;
  const limit = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  const rows = db.all(
    `SELECT * FROM questions ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );
  return { total, items: rows.map(parseRow) };
}

// 随机取某科目的样题作为 AI 组卷参考
function sampleForReference(subject, limit = 30) {
  const rows = db.all(
    'SELECT * FROM questions WHERE subject=? ORDER BY RANDOM() LIMIT ?',
    subject, limit
  );
  return rows.map(parseRow);
}

function count() {
  return db.get('SELECT COUNT(*) AS n FROM questions').n;
}

module.exports = {
  TYPES, TYPE_LABEL, OBJECTIVE_TYPES, SUBJECTS,
  create, update, remove, get, list, count, validateQuestion, parseRow, sampleForReference
};
