// MCP stdio 服务入口：node --experimental-sqlite mcp.js
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { TOOLS } = require('./lib/tools');

const server = new McpServer({
  name: 'exam-system',
  version: '1.0.0'
});

for (const [name, t] of Object.entries(TOOLS)) {
  server.registerTool(name, {
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema
  }, async (toolArgs) => {
    try {
      const data = await t.handler(toolArgs || {});
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, data }, null, 2) }]
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: String(e.message || e) }, null, 2) }]
      };
    }
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 模式下不要向 stdout 打印任何日志，避免破坏协议
  console.error('[exam-system] MCP stdio 服务已启动，工具：' + Object.keys(TOOLS).join(', '));
}

main().catch((e) => {
  console.error('[exam-system] MCP 启动失败：', e);
  process.exit(1);
});
