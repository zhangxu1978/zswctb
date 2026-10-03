// 考试系统 Web 服务入口：node --experimental-sqlite server.js
const path = require('path');
const express = require('express');
const { db } = require('./lib/db');
const questions = require('./lib/questions');
const papers = require('./lib/papers');
const exams = require('./lib/exams');
const site = require('./lib/site');
const tools = require('./lib/tools');

const app = express();
app.use(express.json({ limit: '4mb' }));

// async 路由包装，统一错误处理
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const api = express.Router();

// ---------- 统计 ----------
api.get('/stats', h(async (req, res) => {
  res.json({
    questions: questions.count(),
    papers: db.get('SELECT COUNT(*) AS n FROM papers').n,
    exams: db.get('SELECT COUNT(*) AS n FROM exams').n,
    graded: db.get("SELECT COUNT(*) AS n FROM exams WHERE status='graded'").n,
    driver: db._driver
  });
}));

// ---------- 题库 ----------
api.get('/questions', h(async (req, res) => {
  res.json(questions.list(req.query));
}));

api.post('/questions', h(async (req, res) => {
  res.json(questions.create(req.body));
}));

api.put('/questions/:id', h(async (req, res) => {
  res.json(questions.update(req.params.id, req.body));
}));

api.delete('/questions/:id', h(async (req, res) => {
  res.json(questions.remove(req.params.id));
}));

// ---------- 试卷 ----------
// AI 组卷（distribution 为空则创建空白试卷）
api.post('/papers/generate', h(async (req, res) => {
  res.json(await papers.createFromDistribution(req.body || {}));
}));

api.get('/papers', h(async (req, res) => {
  res.json(papers.listPapers());
}));

api.get('/papers/:id', h(async (req, res) => {
  const paper = papers.getPaperRow(req.params.id);
  if (!paper) throw new Error('试卷不存在：' + req.params.id);
  const qs = papers.getPaperQuestions(paper.id);
  const exam = db.get(
    "SELECT * FROM exams WHERE paper_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1", paper.id
  );
  res.json({
    paper,
    questions: qs,
    exam: exam || null,
    url: papers.paperUrl(paper.id, req.headers.host)
  });
}));

// 手动向试卷加题
api.post('/papers/:id/questions', h(async (req, res) => {
  res.json(papers.addQuestion(req.params.id, req.body, { saveToBank: !!req.body.saveToBank }));
}));

// ---------- 考试 ----------
api.post('/exams', h(async (req, res) => {
  const { paperId, studentName, retake } = req.body || {};
  res.json(exams.start(paperId, studentName, { retake: !!retake }));
}));

api.post('/exams/:id/submit', h(async (req, res) => {
  res.json(await exams.submit(req.params.id, (req.body || {}).answers));
}));

api.get('/exams/:id', h(async (req, res) => {
  res.json(exams.examDetail(req.params.id));
}));

api.get('/history', h(async (req, res) => {
  res.json(exams.history());
}));

api.get('/wrongbook', h(async (req, res) => {
  res.json(exams.wrongBook());
}));

// 错题 → AI 类似题练习卷
api.post('/practice/similar', h(async (req, res) => {
  const { ids, perQuestion } = req.body || {};
  res.json(await exams.similarPractice(ids, perQuestion));
}));

// ---------- 本地 agent 工具通道（与 MCP stdio 同一套实现） ----------
api.post('/tools/:name', h(async (req, res) => {
  const data = await tools.callTool(req.params.name, req.body);
  res.json({ ok: true, data });
}));

// 工具列表（便于本地 agent 发现）
api.get('/tools', h(async (req, res) => {
  res.json(tools.listTools());
}));

app.use('/api', api);

// ---------- 页面路由 ----------
app.get('/exam/:paperId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'exam.html')));
app.get('/result/:examId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'result.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 错误处理 ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[exam-system]', err.message || err);
  res.status(400).json({ error: err.message || '服务器内部错误' });
});

const PORT = site.port();
app.listen(PORT, () => {
  console.log(`考试系统已启动：http://localhost:${PORT}`);
  console.log(`数据库：data/exam.db（驱动 ${db._driver}）`);
  console.log(`MCP stdio 入口：node --experimental-sqlite mcp.js`);
});
