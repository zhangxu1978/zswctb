// 判卷：客观题程序比对 + 主观题 AI 打分（或外部 agent 提交 manual 分数）
const { db, now } = require('./db');
const papers = require('./papers');
const ai = require('./ai');
const { OBJECTIVE_TYPES, TYPE_LABEL } = require('./questions');

function normText(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '');
}

function normJudge(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['对', '正确', 'true', 't', 'yes', 'y', '√', 'a'].includes(s)) return '对';
  if (['错', '错误', 'false', 'f', 'no', 'n', '×', 'b'].includes(s)) return '错';
  return null;
}

function isEmptyAnswer(a) {
  if (a == null) return true;
  if (Array.isArray(a)) return a.every((x) => String(x || '').trim() === '');
  return String(a).trim() === '';
}

function fmtRef(a) {
  if (Array.isArray(a)) return a.join(' | ');
  return String(a);
}

function fmtStudent(type, a) {
  if (isEmptyAnswer(a)) return '（未作答）';
  if (type === 'multiple') return Array.isArray(a) ? a.join('、') : String(a);
  if (type === 'fill') return Array.isArray(a) ? a.map((x) => x || '（空）').join(' | ') : String(a);
  return String(a);
}

// 客观题比对：返回 true/false/null（null 表示非客观题）
function compareObjective(snapshot, studentAnswer) {
  const ref = snapshot.answer;
  switch (snapshot.type) {
    case 'single':
      return normText(studentAnswer) === normText(ref);
    case 'judge': {
      const s = normJudge(studentAnswer);
      return s != null && s === ref;
    }
    case 'multiple': {
      let arr = studentAnswer;
      if (!Array.isArray(arr)) {
        if (typeof studentAnswer === 'string' && studentAnswer.trim()) {
          arr = studentAnswer.split(/[,,，、\s]+/);
        } else return false;
      }
      const a = [...new Set(arr.map((x) => String(x).trim().toUpperCase()))].filter(Boolean).sort().join('');
      const b = [...ref].map((x) => String(x).toUpperCase()).sort().join('');
      return a === b;
    }
    default:
      return null;
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

// 主观题 AI 打分（填空按空给分后汇总；问答/写作整体打分）
async function aiScoreSubjective(snapshot, studentAnswer, maxScore) {
  if (isEmptyAnswer(studentAnswer)) return { score: 0, reason: '未作答' };
  const refDesc = fmtRef(snapshot.answer);
  const stuDesc = Array.isArray(studentAnswer) ? studentAnswer.map((x) => x || '（空）').join(' | ') : String(studentAnswer);
  const isFill = snapshot.type === 'fill';

  const system = '你是一位严谨公正的阅卷老师，根据参考答案给学生作答打分。只输出一个 JSON 对象，不要输出其他文字。';
  let user;
  if (isFill) {
    const blankCount = snapshot.answer.length;
    const stuArr = Array.isArray(studentAnswer) ? studentAnswer : [studentAnswer];
    const stuList = snapshot.answer.map((_, i) => `第${i + 1}空：${stuArr[i] != null && String(stuArr[i]).trim() !== '' ? stuArr[i] : '（空）'}`).join('\n');
    user = `【填空题】满分 ${maxScore} 分，共 ${blankCount} 空（每空 ${round1(maxScore / blankCount)} 分）。
题干：${snapshot.content}
参考答案（多解用 | 分隔，学生答出其中之一即该空得分）：${refDesc}
学生作答：
${stuList}

请判分。输出：{"scores":[每空得分比例0~1, 共${blankCount}项],"reason":"简要评语"}`;
  } else {
    user = `【${TYPE_LABEL[snapshot.type]}】满分 ${maxScore} 分。
题干：${snapshot.content}
参考答案与评分要点：${refDesc}${snapshot.analysis ? '\n评分标准：' + snapshot.analysis : ''}
学生作答：
${stuDesc}

请从要点覆盖、正确性、表达三方面打分（可为小数）。输出：{"score":0到${maxScore}的数字,"reason":"打分理由（50字内）"}`;
  }

  try {
    const out = await ai.chatJson([{ role: 'system', content: system }, { role: 'user', content: user }], { timeout: 120000 });
    if (isFill) {
      const scores = Array.isArray(out.scores) ? out.scores : [];
      const blankCount = snapshot.answer.length;
      const gained = scores.slice(0, blankCount).reduce((s, x) => s + (Number(x) > 0 ? Math.min(1, Number(x)) : 0), 0);
      const score = round1(Math.max(0, Math.min(maxScore, (maxScore / blankCount) * gained)));
      return { score, reason: String(out.reason || '').slice(0, 300) || 'AI 评阅' };
    }
    let score = Number(out.score);
    if (!Number.isFinite(score)) return { score: 0, reason: 'AI 评分解析失败，请人工复核' };
    score = round1(Math.max(0, Math.min(maxScore, score)));
    return { score, reason: String(out.reason || '').slice(0, 300) || 'AI 评阅' };
  } catch (e) {
    return { score: 0, reason: 'AI 评分调用失败：' + String(e.message).slice(0, 150) };
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const vals = await Promise.all(chunk.map((it, j) => fn(it, i + j)));
    vals.forEach((v, j) => { results[i + j] = v; });
  }
  return results;
}

// 判卷主流程
async function grade(paperId, { mode = 'ai', manualScores = [] } = {}) {
  const paper = papers.getPaperRow(paperId);
  if (!paper) throw new Error('试卷不存在：' + paperId);
  const exam = db.get(
    "SELECT * FROM exams WHERE paper_id=? AND status IN ('submitted','graded') ORDER BY submitted_at DESC, rowid DESC LIMIT 1",
    paperId
  );
  if (!exam) throw new Error('该试卷还没有已提交的答题记录，无法判卷');

  const pqs = db.all(
    'SELECT question_id, idx, score, snapshot FROM paper_questions WHERE paper_id=? ORDER BY idx',
    paperId
  );
  if (!pqs.length) throw new Error('试卷没有题目');
  const answerRows = db.all('SELECT * FROM exam_answers WHERE exam_id=?', exam.id);
  const answerMap = new Map(answerRows.map((r) => [r.question_id, r]));
  const manualMap = new Map(
    (Array.isArray(manualScores) ? manualScores : [])
      .filter((m) => m && m.questionId)
      .map((m) => [m.questionId, m])
  );

  const items = pqs.map((pq) => ({
    pq,
    snapshot: JSON.parse(pq.snapshot),
    ea: answerMap.get(pq.question_id) || null,
    manual: manualMap.get(pq.question_id) || null
  }));

  const judged = await mapLimit(items, 3, async (it) => {
    const maxScore = it.pq.score;
    const stuAnswer = it.ea ? JSON.parse(it.ea.answer || 'null') : null;
    let score, correct, reason;

    if (it.manual) {
      score = round1(Math.max(0, Math.min(maxScore, Number(it.manual.score) || 0)));
      reason = it.manual.reason ? String(it.manual.reason).slice(0, 500) : '外部 agent 评分';
      correct = maxScore > 0 && score >= maxScore ? 1 : 0;
    } else if (OBJECTIVE_TYPES.includes(it.snapshot.type)) {
      const ok = compareObjective(it.snapshot, stuAnswer);
      correct = ok ? 1 : 0;
      score = ok ? maxScore : 0;
      reason = ok ? '回答正确' : `正确答案：${fmtRef(it.snapshot.answer)}`;
    } else if (isEmptyAnswer(stuAnswer)) {
      correct = 0; score = 0; reason = '未作答';
    } else {
      const r = await aiScoreSubjective(it.snapshot, stuAnswer, maxScore);
      score = r.score;
      reason = r.reason;
      correct = maxScore > 0 && score >= maxScore * 0.6 ? 1 : 0;
    }
    return { ...it, score, correct, reason, stuAnswer };
  });

  let total = 0, objScore = 0, subjScore = 0;
  const results = judged.map((j) => {
    total += j.score;
    if (OBJECTIVE_TYPES.includes(j.snapshot.type)) objScore += j.score;
    else subjScore += j.score;
    if (j.ea) {
      db.run('UPDATE exam_answers SET score=?, correct=?, reason=? WHERE id=?', j.score, j.correct, j.reason, j.ea.id);
    } else {
      db.run(
        'INSERT INTO exam_answers (exam_id, question_id, answer, time_spent, score, correct, reason) VALUES (?,?,?,0,?,?,?)',
        exam.id, j.pq.question_id, 'null', j.score, j.correct, j.reason
      );
    }
    return {
      questionId: j.pq.question_id,
      idx: j.pq.idx,
      type: j.snapshot.type,
      typeLabel: TYPE_LABEL[j.snapshot.type],
      content: j.snapshot.content,
      studentAnswer: j.stuAnswer,
      studentAnswerText: fmtStudent(j.snapshot.type, j.stuAnswer),
      referenceAnswer: fmtRef(j.snapshot.answer),
      analysis: j.snapshot.analysis || null,
      timeSpent: j.ea ? j.ea.time_spent : 0,
      score: j.score,
      maxScore: j.pq.score,
      correct: j.correct === 1,
      reason: j.reason
    };
  });
  total = round1(total); objScore = round1(objScore); subjScore = round1(subjScore);

  db.run(
    'UPDATE exams SET status=?, total_score=?, objective_score=?, subjective_score=? WHERE id=?',
    'graded', total, objScore, subjScore, exam.id
  );
  db.run("UPDATE papers SET status='graded', graded_at=? WHERE id=?", now(), paperId);

  return {
    paperId,
    examId: exam.id,
    status: '已判卷',
    mode,
    totalScore: total,
    paperTotalScore: paper.total_score,
    objectiveScore: objScore,
    subjectiveScore: subjScore,
    studentName: exam.student_name,
    results
  };
}

module.exports = { grade, compareObjective, aiScoreSubjective, fmtStudent };
