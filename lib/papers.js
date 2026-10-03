// 试卷：创建/AI 组卷/加题/状态
const { db, genId, now } = require('./db');
const questions = require('./questions');
const ai = require('./ai');
const site = require('./site');

const STATUS_ZH = {
  published: '未开始答题',
  started: '已开始答题',
  completed: '已完成答题',
  graded: '已判卷'
};
const TYPE_ORDER = ['single', 'multiple', 'judge', 'fill', 'qa', 'writing'];

function paperUrl(paperId, host) {
  // host 形如 "localhost:3211"，缺省用本机地址
  if (host) return `http://${host}/exam/${paperId}`;
  return site.localUrl(`/exam/${paperId}`);
}

function parsePaper(row) {
  if (!row) return null;
  return { ...row, statusZh: STATUS_ZH[row.status] || row.status };
}

function getPaperRow(id) {
  return parsePaper(db.get('SELECT * FROM papers WHERE id=?', id));
}

function getPaperQuestions(paperId) {
  const rows = db.all(
    'SELECT idx, score, snapshot FROM paper_questions WHERE paper_id=? ORDER BY idx',
    paperId
  );
  return rows.map((r) => ({ idx: r.idx, score: r.score, snapshot: JSON.parse(r.snapshot) }));
}

function recomputeTotal(paperId) {
  const sum = db.get('SELECT COALESCE(SUM(score),0) AS s FROM paper_questions WHERE paper_id=?', paperId).s;
  db.run('UPDATE papers SET total_score=? WHERE id=?', sum, paperId);
  return sum;
}

function createPaperRow({ title, subject, durationMinutes, source }) {
  const id = genId('p');
  db.run(
    `INSERT INTO papers (id, title, subject, total_score, duration_minutes, source, status, created_at)
     VALUES (?,?,?,0,?,?, 'published', ?)`,
    id, title, subject || null,
    durationMinutes ? Math.max(1, Math.round(Number(durationMinutes))) : null,
    source || 'web', now()
  );
  return getPaperRow(id);
}

function insertPaperQuestion(paperId, question, score) {
  const maxIdx = db.get('SELECT COALESCE(MAX(idx),0) AS m FROM paper_questions WHERE paper_id=?', paperId).m;
  db.run(
    'INSERT INTO paper_questions (paper_id, question_id, idx, score, snapshot) VALUES (?,?,?,?,?)',
    paperId, question.id, maxIdx + 1, score, JSON.stringify(question)
  );
}

// 向试卷追加题目；saveToBank=true 时同时存入题库（source='mcp'）
function addQuestion(paperId, data, { saveToBank = false } = {}) {
  const paper = getPaperRow(paperId);
  if (!paper) throw new Error('试卷不存在：' + paperId);
  if (paper.status === 'started' || paper.status === 'completed' || paper.status === 'graded') {
    throw new Error('试卷已开始答题，不能再添加题目');
  }
  const q = questions.validateQuestion({
    ...data,
    subject: data.subject || paper.subject || '未分类',
    source: saveToBank ? 'mcp' : (data.source || 'manual')
  });
  let id = genId('q');
  if (saveToBank) {
    db.run(
      `INSERT INTO questions (id, subject, type, content, options, answer, analysis, score, difficulty, source, tags, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, q.subject, q.type, q.content, q.options, q.answer, q.analysis, q.score, q.difficulty, q.source, q.tags, now()
    );
  }
  const question = {
    id, subject: q.subject, type: q.type, content: q.content,
    options: q.options ? JSON.parse(q.options) : null,
    answer: JSON.parse(q.answer), analysis: q.analysis, difficulty: q.difficulty
  };
  const score = Number(data.score) > 0 ? Number(data.score) : q.score;
  insertPaperQuestion(paperId, question, score);
  const totalScore = recomputeTotal(paperId);
  const questionCount = db.get('SELECT COUNT(*) AS n FROM paper_questions WHERE paper_id=?', paperId).n;
  return { questionId: id, questionCount, totalScore };
}

// 用现成题目（含快照）创建试卷，供 AI 组卷与错题练习共用
function createPaperWithQuestions({ title, subject, durationMinutes, source, items }) {
  const paper = createPaperRow({ title, subject, durationMinutes, source });
  for (const it of items) {
    insertPaperQuestion(paper.id, it.question, it.score);
  }
  recomputeTotal(paper.id);
  return { paper: getPaperRow(paper.id), url: paperUrl(paper.id) };
}

// AI 组卷：参考题库样题生成全新题目
async function createFromDistribution({ title, subject, durationMinutes, distribution }) {
  subject = String(subject || '').trim();
  if (!subject) throw new Error('科目不能为空');
  const dist = (Array.isArray(distribution) ? distribution : [])
    .map((d) => ({
      type: d.type,
      count: Math.round(Number(d.count)),
      scoreEach: Number(d.scoreEach) > 0 ? Number(d.scoreEach) : 5
    }))
    .filter((d) => questions.TYPES.includes(d.type) && d.count > 0);

  if (!dist.length) {
    // 空白试卷（供外部 agent 通过 add_question_to_paper 逐步加题）
    const { paper, url } = createPaperWithQuestions({
      title: title || `${subject}试卷`, subject, durationMinutes, source: 'mcp', items: []
    });
    return { paperId: paper.id, url, totalScore: 0, questionCount: 0, warnings: ['未提供题型分布，已创建空白试卷'] };
  }

  const need = dist.reduce((s, d) => s + d.count, 0);
  if (need > 60) throw new Error('一次最多生成 60 道题');

  const samples = questions.sampleForReference(subject, 30);
  const distDesc = dist
    .map((d) => `${questions.TYPE_LABEL[d.type]} ${d.count} 道、每题 ${d.scoreEach} 分`)
    .join('；');
  const sampleDesc = samples.length
    ? samples.map((q, i) => {
        let s = `[${i + 1}]（${questions.TYPE_LABEL[q.type]}）${q.content}`;
        if (q.options) s += ` 选项：${q.options.join(' / ')}`;
        s += ` 参考答案：${Array.isArray(q.answer) ? q.answer.join(' | ') : q.answer}`;
        if (q.analysis) s += ` 解析：${String(q.analysis).slice(0, 80)}`;
        return s;
      }).join('\n')
    : '（题库中暂无该科目题目，请按常规难度命题）';

  const system = `你是一位资深的${subject}命题老师，负责命制中小学${subject}试题。你必须严格按用户要求的题型与数量出题，只输出一个 JSON 对象，不要输出任何其他文字。`;
  const user = `请为${subject}科目命制一份试卷，共 ${need} 道题：${distDesc}。

【题库参考样例】（用于把握题型风格、难度与知识点范围，严禁与样例重复或高度相似，必须命制全新题目）：
${sampleDesc}

【输出 JSON 格式】
{"questions":[{"type":"single|multiple|judge|fill|qa|writing","content":"题干","options":["选项1文本","选项2文本",...],"answer":答案,"analysis":"解析","difficulty":3}]}
说明：
- options 仅单选/多选需要，4 个左右，纯文本不带 A. 前缀；判断/填空/问答/写作不要 options 字段
- answer 格式：单选 "A"；多选 ["A","C"]；判断 "对" 或 "错"；填空 ["空1答案","空2答案"]（题干用 ____ 标出空位，一空一项，多解用 "答A|答B"）；问答/写作为参考答案文本，评分要点写入 analysis
- 数量必须精确：${dist.map((d) => `${questions.TYPE_LABEL[d.type]}${d.count}道`).join('、')}
- 答案必须准确无误，${subject === '数学' ? '计算过程需自行验算' : '语言表达需规范地道'}
- difficulty 为 1-5 整数`;

  const out = await ai.chatJson(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { timeout: 300000 }
  );
  const arr = Array.isArray(out) ? out : out.questions;
  if (!Array.isArray(arr) || !arr.length) throw new Error('AI 未生成任何题目');

  // 按题型收集，截取到需求数量
  const picked = {};
  const warnings = [];
  for (const d of dist) picked[d.type] = [];
  for (const q of arr) {
    if (!q || !questions.TYPES.includes(q.type) || picked[q.type] === undefined) continue;
    const slot = dist.find((d) => d.type === q.type);
    if (picked[q.type].length >= slot.count) continue;
    try {
      const qv = questions.validateQuestion({
        subject, type: q.type, content: q.content, options: q.options,
        answer: q.answer, analysis: q.analysis,
        score: slot.scoreEach, difficulty: q.difficulty, source: 'ai', tags: [subject, 'AI组卷']
      });
      picked[q.type].push(qv);
    } catch (e) {
      warnings.push(`丢弃 1 道${questions.TYPE_LABEL[q.type]}：${e.message}`);
    }
  }

  const items = [];
  for (const d of dist) {
    const got = picked[d.type].length;
    if (got < d.count) warnings.push(`${questions.TYPE_LABEL[d.type]}需 ${d.count} 道，实际生成 ${got} 道`);
    for (const q of picked[d.type]) {
      const id = genId('q');
      db.run(
        `INSERT INTO questions (id, subject, type, content, options, answer, analysis, score, difficulty, source, tags, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, q.subject, q.type, q.content, q.options, q.answer, q.analysis, q.score, q.difficulty, q.source, q.tags, now()
      );
      items.push({
        score: q.score,
        question: {
          id, subject: q.subject, type: q.type, content: q.content,
          options: q.options ? JSON.parse(q.options) : null,
          answer: JSON.parse(q.answer), analysis: q.analysis, difficulty: q.difficulty
        }
      });
    }
  }
  if (!items.length) {
    throw new Error('AI 生成的题目均未通过校验：' + warnings.slice(0, 3).join('；'));
  }

  const finalTitle = title || `${subject}练习卷 ${now().slice(0, 10)}`;
  const { paper, url } = createPaperWithQuestions({
    title: finalTitle, subject, durationMinutes, source: 'web', items
  });
  return {
    paperId: paper.id, url,
    totalScore: paper.total_score,
    questionCount: items.length,
    warnings: warnings.length ? warnings : undefined
  };
}

function statusOf(paperId) {
  const paper = getPaperRow(paperId);
  if (!paper) throw new Error('试卷不存在：' + paperId);
  const questionCount = db.get('SELECT COUNT(*) AS n FROM paper_questions WHERE paper_id=?', paperId).n;
  const exam = db.get(
    'SELECT * FROM exams WHERE paper_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1', paperId
  );
  return {
    paperId: paper.id,
    title: paper.title,
    subject: paper.subject,
    source: paper.source,
    questionCount,
    totalScore: paper.total_score,
    durationMinutes: paper.duration_minutes,
    status: paper.status,
    statusZh: paper.statusZh,
    createdAt: paper.created_at,
    examId: exam ? exam.id : null,
    studentName: exam ? exam.student_name : null,
    startedAt: exam ? exam.started_at : null,
    submittedAt: exam ? exam.submitted_at : null,
    gradedAt: paper.graded_at,
    score: exam && exam.total_score != null ? exam.total_score : null
  };
}

function listPapers() {
  const rows = db.all(`
    SELECT p.*, (SELECT COUNT(*) FROM paper_questions pq WHERE pq.paper_id=p.id) AS question_count
    FROM papers p ORDER BY p.created_at DESC, p.id DESC
  `);
  return rows.map((r) => ({ ...parsePaper(r), questionCount: r.question_count }));
}

module.exports = {
  STATUS_ZH, TYPE_ORDER,
  paperUrl, getPaperRow, getPaperQuestions, createPaperRow,
  createPaperWithQuestions, createFromDistribution, addQuestion, statusOf, listPapers, recomputeTotal
};
