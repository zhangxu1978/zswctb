// MCP 工具注册表：5 个工具的实现，mcp.js（stdio）与 server.js（HTTP /api/tools/:name）共用
const { z } = require('zod');
const questions = require('./questions');
const papers = require('./papers');
const exams = require('./exams');
const grading = require('./grading');

const typeEnum = z.enum(['single', 'multiple', 'judge', 'fill', 'qa', 'writing']);

const questionShape = {
  type: typeEnum.describe('题型：single单选 multiple多选 judge判断 fill填空 qa问答 writing写作'),
  content: z.string().min(1).describe('题干；填空题用 ____ 表示空位'),
  options: z.array(z.string()).optional().describe('选项文本数组（仅单选/多选需要，不带 A. 前缀）'),
  answer: z.any().describe('答案：单选"A"；多选["A","C"]；判断"对"/"错"；填空["空1","空2"]；问答/写作为参考答案文本'),
  analysis: z.string().optional().describe('解析/评分要点'),
  score: z.number().positive().optional().describe('分值，默认 5'),
  difficulty: z.number().int().min(1).max(5).optional().describe('难度 1-5，默认 3')
};

const distItem = z.object({
  type: typeEnum.describe('题型'),
  count: z.number().int().positive().describe('数量'),
  scoreEach: z.number().positive().describe('每题分值')
});

const TOOLS = {
  save_question: {
    title: '存入题目到题库',
    description: '把一道题目存入考试系统题库。支持语文/数学/英语等科目，题型：单选(single)、多选(multiple)、判断(judge)、填空(fill)、问答(qa)、写作(writing)。',
    inputSchema: z.object({
      subject: z.string().min(1).describe('科目，如：语文/数学/英语'),
      ...questionShape,
      source: z.string().optional().describe('题目来源标记，默认 manual')
    }),
    handler: (args) => {
      const q = questions.create(args);
      return { questionId: q.id, message: '题目已存入题库' };
    }
  },

  generate_paper: {
    title: '生成试卷',
    description: 'AI 参考题库中的题目风格与知识点生成全新试题并组装成试卷，返回试卷 id 和可访问的答题地址。distribution 留空则创建空白试卷（之后可用 add_question_to_paper 逐题添加）。',
    inputSchema: z.object({
      title: z.string().optional().describe('试卷标题，默认自动命名'),
      subject: z.string().min(1).describe('科目，如：数学'),
      durationMinutes: z.number().int().positive().optional().describe('考试时长（分钟），不填为不限时'),
      distribution: z.array(distItem).optional().describe('题型分布，如 [{type:"single",count:5,scoreEach:3}]；留空创建空白试卷')
    }),
    handler: async (args) => {
      const r = await papers.createFromDistribution(args);
      return {
        paperId: r.paperId,
        url: r.url,
        totalScore: r.totalScore,
        questionCount: r.questionCount,
        warnings: r.warnings
      };
    }
  },

  add_question_to_paper: {
    title: '添加题目到试卷',
    description: '根据试卷 id 向试卷添加一道题目（客观题：单选/多选/判断；主观题：填空/问答/写作），返回更新后的题目数与总分。',
    inputSchema: z.object({
      paperId: z.string().min(1).describe('试卷 id'),
      saveToBank: z.boolean().optional().describe('是否同时存入题库，默认 false'),
      ...questionShape
    }),
    handler: (args) => {
      const { paperId, saveToBank, ...q } = args;
      const r = papers.addQuestion(paperId, q, { saveToBank: !!saveToBank });
      return { questionId: r.questionId, questionCount: r.questionCount, totalScore: r.totalScore };
    }
  },

  get_paper_status: {
    title: '查看试卷状态',
    description: '根据试卷 id 查看试卷状态：题目数、总分、答题状态（未开始答题/已开始答题/已完成答题/已判卷）、学生姓名、得分等。',
    inputSchema: z.object({
      paperId: z.string().min(1).describe('试卷 id')
    }),
    handler: (args) => papers.statusOf(args.paperId)
  },

  grade_paper: {
    title: '评卷判卷',
    description: '根据试卷 id 找到全部答题并判卷：客观题（单选/多选/判断）自动比对答案；主观题（填空/问答/写作）默认调用本地 AI 打分并给出打分理由（mode="ai"），也可由调用方直接提交分数与理由（mode="manual" + manualScores）。',
    inputSchema: z.object({
      paperId: z.string().min(1).describe('试卷 id'),
      mode: z.enum(['ai', 'manual']).optional().describe('判卷模式：ai=本地AI判主观题（默认）；manual=调用方提交分数'),
      manualScores: z.array(z.object({
        questionId: z.string().describe('题目 id'),
        score: z.number().min(0).describe('得分'),
        reason: z.string().optional().describe('打分理由')
      })).optional().describe('mode=manual 时的逐题分数与理由（客观题也可用此覆盖）')
    }),
    handler: async (args) => grading.grade(args.paperId, { mode: args.mode || 'ai', manualScores: args.manualScores })
  }
};

function listTools() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    title: t.title,
    description: t.description
  }));
}

// 统一调用入口：返回 {ok:true, data} 或抛错
async function callTool(name, args) {
  const t = TOOLS[name];
  if (!t) throw new Error(`未知工具：${name}，可用工具：${Object.keys(TOOLS).join(', ')}`);
  const parsed = t.inputSchema.safeParse(args || {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '参数'}: ${i.message}`).join('；');
    throw new Error(`参数校验失败：${detail}`);
  }
  return await t.handler(parsed.data);
}

module.exports = { TOOLS, listTools, callTool };
