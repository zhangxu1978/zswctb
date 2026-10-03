// 考试：开始/交卷/历史/详情/错题本/类似题练习
const { db, genId, now } = require('./db');
const papers = require('./papers');
const questions = require('./questions');
const grading = require('./grading');
const ai = require('./ai');
const site = require('./site');

// 开始考试（同一试卷进行中的考试直接续答；已完成的试卷通过 retake=true 开启全新一次考试，历史记录保留）
function start(paperId, studentName, { retake = false } = {}) {
  const paper = papers.getPaperRow(paperId);
  if (!paper) throw new Error('试卷不存在：' + paperId);
  const existing = db.get("SELECT * FROM exams WHERE paper_id=? AND status='ongoing'", paperId);
  if (existing) {
    const name = String(studentName || '').trim();
    if (name && name !== existing.student_name) {
      db.run('UPDATE exams SET student_name=? WHERE id=?', name, existing.id);
      existing.student_name = name;
    }
    return { exam: existing, resumed: true };
  }
  if ((paper.status === 'completed' || paper.status === 'graded') && !retake) {
    throw new Error(`该试卷${paper.statusZh}，如需再次考试请点击「重新考试」`);
  }
  const name = String(studentName || '').trim();
  if (!name) throw new Error('请先写下你的名字');
  const id = genId('e');
  db.run(
    "INSERT INTO exams (id, paper_id, student_name, started_at, status) VALUES (?,?,?,?, 'ongoing')",
    id, paperId, name, now()
  );
  // 重置试卷到考试状态，开始新一轮（旧考试记录保留在 exams 表中作为历史）
  db.run("UPDATE papers SET status='started', graded_at=NULL WHERE id=?", paperId);
  return { exam: db.get('SELECT * FROM exams WHERE id=?', id), resumed: false };
}

// 交卷
async function submit(examId, answers) {
  const exam = db.get('SELECT * FROM exams WHERE id=?', examId);
  if (!exam) throw new Error('考试记录不存在：' + examId);
  if (exam.status !== 'ongoing') throw new Error('该考试已提交，请勿重复提交');
  const paper = papers.getPaperRow(exam.paper_id);
  const pqs = db.all('SELECT question_id FROM paper_questions WHERE paper_id=?', exam.paper_id);
  if (!pqs.length) throw new Error('试卷没有题目，无法提交');

  const list = Array.isArray(answers) ? answers : [];
  const map = new Map(list.map((a) => [String(a.questionId), a]));
  for (const pq of pqs) {
    const a = map.get(pq.question_id) || {};
    db.run(
      'INSERT INTO exam_answers (exam_id, question_id, answer, time_spent) VALUES (?,?,?,?)',
      examId, pq.question_id,
      JSON.stringify(a.answer == null ? null : a.answer),
      Math.max(0, Math.round(Number(a.timeSpent) || 0))
    );
  }
  const startedMs = Date.parse(exam.started_at);
  const totalTime = Number.isFinite(startedMs)
    ? Math.max(0, Math.round((Date.now() - startedMs) / 1000))
    : 0;
  db.run("UPDATE exams SET status='submitted', submitted_at=?, total_time=? WHERE id=?", now(), totalTime, examId);
  db.run("UPDATE papers SET status='completed' WHERE id=?", exam.paper_id);

  if (paper.source === 'web') {
    const result = await grading.grade(exam.paper_id, { mode: 'ai' });
    return { graded: true, examId, result };
  }
  return {
    graded: false,
    examId,
    paperId: exam.paper_id,
    status: '已完成答题',
    message: '试卷已提交，等待外部 agent 通过 MCP 判卷'
  };
}

// 考试历史（同一试卷可有多条记录，attempt 为该试卷的第几次考试）
const EXAM_STATUS_ZH = { ongoing: '进行中', submitted: '待判卷', graded: '已判卷' };

function history() {
  const rows = db.all(`
    SELECT e.*, p.title AS paper_title, p.subject, p.total_score AS paper_total, p.status AS paper_status
    FROM exams e JOIN papers p ON p.id = e.paper_id
    ORDER BY e.started_at ASC, e.id ASC
  `);
  const counter = new Map();
  for (const r of rows) {
    const n = (counter.get(r.paper_id) || 0) + 1;
    counter.set(r.paper_id, n);
    r.attempt = n;
  }
  rows.reverse(); // 恢复倒序展示
  return rows.map((r) => ({
    ...r,
    attempt: r.attempt,
    examStatusZh: EXAM_STATUS_ZH[r.status] || r.status,
    paperStatusZh: papers.STATUS_ZH[r.paper_status] || r.paper_status
  }));
}

// 考试详情（结果页）
function examDetail(examId) {
  const exam = db.get('SELECT * FROM exams WHERE id=?', examId);
  if (!exam) throw new Error('考试记录不存在：' + examId);
  const paper = papers.getPaperRow(exam.paper_id);
  const rows = db.all(`
    SELECT pq.question_id, pq.idx, pq.score AS max_score, pq.snapshot,
           ea.answer, ea.time_spent, ea.score AS got_score, ea.correct, ea.reason
    FROM paper_questions pq
    LEFT JOIN exam_answers ea ON ea.exam_id=? AND ea.question_id=pq.question_id
    WHERE pq.paper_id=? ORDER BY pq.idx
  `, examId, exam.paper_id);
  const items = rows.map((r) => {
    const snapshot = JSON.parse(r.snapshot);
    const stuAnswer = r.answer ? JSON.parse(r.answer) : null;
    return {
      questionId: r.question_id,
      idx: r.idx,
      type: snapshot.type,
      typeLabel: questions.TYPE_LABEL[snapshot.type] || snapshot.type,
      content: snapshot.content,
      options: snapshot.options,
      studentAnswer: stuAnswer,
      studentAnswerText: grading.fmtStudent(snapshot.type, stuAnswer),
      referenceAnswer: Array.isArray(snapshot.answer) ? snapshot.answer.join(' | ') : String(snapshot.answer),
      analysis: snapshot.analysis || null,
      timeSpent: r.time_spent || 0,
      score: r.got_score,
      maxScore: r.max_score,
      correct: r.correct == null ? null : r.correct === 1,
      reason: r.reason
    };
  });
  return {
    exam,
    paper: { ...paper, statusZh: papers.STATUS_ZH[paper.status] || paper.status },
    items,
    totalScore: exam.total_score,
    paperTotalScore: paper.total_score,
    objectiveScore: exam.objective_score,
    subjectiveScore: exam.subjective_score
  };
}

// 错题本：按题目聚合所有答错记录
function wrongBook() {
  const rows = db.all(`
    SELECT ea.id, ea.question_id, ea.exam_id, ea.answer, ea.reason,
           e.student_name, e.submitted_at,
           p.title AS paper_title, p.subject AS paper_subject,
           pq.snapshot, pq.score AS max_score,
           (SELECT COUNT(*) FROM exam_answers x WHERE x.question_id = ea.question_id AND x.correct = 0) AS wrong_count
    FROM exam_answers ea
    JOIN exams e ON e.id = ea.exam_id
    JOIN papers p ON p.id = e.paper_id
    LEFT JOIN paper_questions pq ON pq.paper_id = p.id AND pq.question_id = ea.question_id
    WHERE ea.correct = 0
    ORDER BY ea.id DESC
  `);
  const byQ = new Map();
  for (const r of rows) {
    if (!byQ.has(r.question_id)) byQ.set(r.question_id, r); // ea.id 倒序，首条即最近一次
  }
  return [...byQ.values()].map((r) => {
    const snap = r.snapshot ? JSON.parse(r.snapshot) : {};
    const bankQ = questions.get(r.question_id);
    return {
      id: r.id,
      questionId: r.question_id,
      wrongCount: r.wrong_count,
      type: (bankQ && bankQ.type) || snap.type,
      typeLabel: questions.TYPE_LABEL[(bankQ && bankQ.type) || snap.type] || '',
      subject: (bankQ && bankQ.subject) || snap.subject || r.paper_subject || '',
      content: snap.content || (bankQ && bankQ.content) || '',
      options: snap.options || (bankQ && bankQ.options) || null,
      referenceAnswer: Array.isArray(snap.answer) ? snap.answer.join(' | ') : String(snap.answer || (bankQ && bankQ.answer) || ''),
      myAnswer: grading.fmtStudent(snap.type || '', r.answer ? JSON.parse(r.answer) : null),
      analysis: snap.analysis || (bankQ && bankQ.analysis) || null,
      reason: r.reason,
      score: r.score,
      maxScore: r.max_score,
      sourcePaper: r.paper_title,
      examId: r.exam_id,
      lastWrongAt: r.submitted_at
    };
  });
}

// 错题 → AI 参考原题生成类似题 → 组成练习卷
async function similarPractice(wrongAnswerIds, perQuestion = 1) {
  const ids = (Array.isArray(wrongAnswerIds) ? wrongAnswerIds : [])
    .map((x) => Number(x)).filter(Number.isFinite);
  if (!ids.length) throw new Error('请先勾选要练习的错题');
  perQuestion = Math.min(5, Math.max(1, Math.round(Number(perQuestion) || 1)));

  const rows = db.all(`
    SELECT ea.id, ea.question_id, ea.answer, pq.snapshot, pq.score AS pq_score, p.subject AS paper_subject
    FROM exam_answers ea
    JOIN exams e ON e.id = ea.exam_id
    JOIN papers p ON p.id = e.paper_id
    LEFT JOIN paper_questions pq ON pq.paper_id = p.id AND pq.question_id = ea.question_id
    WHERE ea.correct = 0 AND ea.id IN (${ids.map(() => '?').join(',')})
  `, ...ids);
  if (!rows.length) throw new Error('所选错题不存在');

  const wrongs = [];
  for (const r of rows) {
    const snap = r.snapshot ? JSON.parse(r.snapshot) : null;
    const bankQ = questions.get(r.question_id);
    const w = {
      refIndex: wrongs.length + 1,
      origId: r.question_id,
      score: r.pq_score || (bankQ && bankQ.score) || 5,
      type: (bankQ && bankQ.type) || (snap && snap.type),
      subject: (bankQ && bankQ.subject) || (snap && snap.subject) || r.paper_subject || '综合',
      content: (snap && snap.content) || (bankQ && bankQ.content),
      options: (snap && snap.options) || (bankQ && bankQ.options) || null,
      answer: (snap && snap.answer) || (bankQ && bankQ.answer),
      analysis: (snap && snap.analysis) || (bankQ && bankQ.analysis),
      difficulty: (bankQ && bankQ.difficulty) || 3,
      myWrongAnswer: r.answer ? grading.fmtStudent((snap && snap.type) || '', JSON.parse(r.answer)) : ''
    };
    if (w.content && w.type) wrongs.push(w);
  }
  if (!wrongs.length) throw new Error('错题数据不完整，无法生成类似题');

  const wrongDesc = wrongs.map((w) => {
    let s = `[${w.refIndex}]（${questions.TYPE_LABEL[w.type]}）${w.content}`;
    if (w.options) s += ` 选项：${w.options.join(' / ')}`;
    s += ` 正确答案：${Array.isArray(w.answer) ? w.answer.join(' | ') : w.answer}`;
    if (w.analysis) s += ` 解析：${String(w.analysis).slice(0, 100)}`;
    s += ` 学生错答：${w.myWrongAnswer || '（未作答）'}`;
    return s;
  }).join('\n');

  const system = '你是一位资深命题老师，擅长针对学生的错题命制变式训练题。只输出一个 JSON 对象，不要输出其他文字。';
  const user = `以下是学生的 ${wrongs.length} 道错题，请为每道错题命制 ${perQuestion} 道"类似题"：保持相同题型、相近知识点与难度，但情境、数值或文本必须与原题不同，答案必须准确。

【错题列表】
${wrongDesc}

【输出 JSON 格式】
{"questions":[{"refIndex":1,"type":"single|multiple|judge|fill|qa|writing","content":"题干","options":["选项1",...],"answer":答案,"analysis":"解析","difficulty":3}]}
答案格式：单选 "A"；多选 ["A","C"]；判断 "对"/"错"；填空 ["空1","空2"]（题干用 ____ 标空）；问答/写作为参考答案文本。
输出题目总数必须等于 ${wrongs.length * perQuestion} 道，refIndex 对应原题编号。`;

  const out = await ai.chatJson(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { timeout: 300000 }
  );
  const arr = Array.isArray(out) ? out : out.questions;
  if (!Array.isArray(arr) || !arr.length) throw new Error('AI 未生成类似题');

  const items = [];
  const skipped = [];
  for (const q of arr) {
    const w = wrongs.find((x) => x.refIndex === q.refIndex) || wrongs[0];
    try {
      const qv = questions.validateQuestion({
        subject: w.subject, type: q.type || w.type, content: q.content,
        options: q.options, answer: q.answer, analysis: q.analysis,
        score: w.score, difficulty: q.difficulty || w.difficulty,
        source: 'similar', tags: [w.origId, '错题练习']
      });
      const id = genId('q');
      db.run(
        `INSERT INTO questions (id, subject, type, content, options, answer, analysis, score, difficulty, source, tags, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, qv.subject, qv.type, qv.content, qv.options, qv.answer, qv.analysis,
        qv.score, qv.difficulty, qv.source, qv.tags, now()
      );
      items.push({
        score: qv.score,
        question: {
          id, subject: qv.subject, type: qv.type, content: qv.content,
          options: qv.options ? JSON.parse(qv.options) : null,
          answer: JSON.parse(qv.answer), analysis: qv.analysis, difficulty: qv.difficulty
        }
      });
    } catch (e) {
      skipped.push(e.message);
    }
  }
  if (!items.length) {
    throw new Error('AI 生成的类似题均未通过校验：' + skipped.slice(0, 3).join('；'));
  }

  const subjects = [...new Set(items.map((i) => i.question.subject))];
  const { paper, url } = papers.createPaperWithQuestions({
    title: `错题强化练习 ${now().slice(0, 10)}`,
    subject: subjects.length === 1 ? subjects[0] : '综合',
    durationMinutes: null,
    source: 'web',
    items
  });
  return {
    paperId: paper.id,
    url,
    questionCount: items.length,
    totalScore: paper.total_score,
    skipped: skipped.length ? skipped : undefined
  };
}

module.exports = { start, submit, history, examDetail, wrongBook, similarPractice, EXAM_STATUS_ZH };
