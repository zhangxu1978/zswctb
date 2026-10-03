// SQLite 访问层：优先 better-sqlite3，安装失败时回退 Node 22 内置 node:sqlite
// 统一暴露 exec/run/get/all 四个方法（均使用 ? 位置参数）
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'exam.db');

function wrapBetterSqlite3() {
  const BetterSqlite3 = require('better-sqlite3');
  const d = new BetterSqlite3(DB_PATH);
  d.pragma('journal_mode = WAL');
  return {
    _driver: 'better-sqlite3',
    exec: (sql) => d.exec(sql),
    run: (sql, ...params) => d.prepare(sql).run(...params),
    get: (sql, ...params) => d.prepare(sql).get(...params),
    all: (sql, ...params) => d.prepare(sql).all(...params)
  };
}

function wrapNodeSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(DB_PATH);
  d.exec('PRAGMA journal_mode = WAL;');
  return {
    _driver: 'node:sqlite',
    exec: (sql) => d.exec(sql),
    run: (sql, ...params) => d.prepare(sql).run(...params),
    get: (sql, ...params) => d.prepare(sql).get(...params),
    all: (sql, ...params) => d.prepare(sql).all(...params)
  };
}

let db;
try {
  db = wrapBetterSqlite3();
} catch (e) {
  try {
    db = wrapNodeSqlite();
  } catch (e2) {
    throw new Error(
      'SQLite 初始化失败：better-sqlite3 未安装且 node:sqlite 不可用。\n' +
      '请使用 npm start（已带 --experimental-sqlite 标志）启动，或重新 npm install。\n' +
      `原始错误：${e.message} / ${e2.message}`
    );
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  options TEXT,
  answer TEXT NOT NULL,
  analysis TEXT,
  score REAL NOT NULL DEFAULT 5,
  difficulty INTEGER DEFAULT 3,
  source TEXT DEFAULT 'manual',
  tags TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT,
  total_score REAL DEFAULT 0,
  duration_minutes INTEGER,
  source TEXT DEFAULT 'web',
  status TEXT DEFAULT 'published',
  created_at TEXT,
  graded_at TEXT
);
CREATE TABLE IF NOT EXISTS paper_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  score REAL NOT NULL,
  snapshot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  student_name TEXT NOT NULL,
  started_at TEXT,
  submitted_at TEXT,
  total_time INTEGER,
  status TEXT DEFAULT 'ongoing',
  total_score REAL,
  objective_score REAL,
  subjective_score REAL
);
CREATE TABLE IF NOT EXISTS exam_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  answer TEXT,
  time_spent INTEGER DEFAULT 0,
  score REAL,
  correct INTEGER,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_pq_paper ON paper_questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_ea_exam ON exam_answers(exam_id);
CREATE INDEX IF NOT EXISTS idx_ea_q ON exam_answers(question_id);
`);

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = { db, genId, now, DB_PATH };
