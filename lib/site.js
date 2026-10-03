// 站点配置：端口与 URL（config.json 可选 server.port 覆盖，默认 3211）
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function port() {
  const cfg = readConfig();
  return (
    Number(process.env.PORT) ||
    Number(cfg.server && cfg.server.port) ||
    3211
  );
}

function localUrl(pathname) {
  return `http://127.0.0.1:${port()}${pathname}`;
}

module.exports = { port, localUrl, readConfig };
