#!/usr/bin/env node
// 启动入口：PORT=3000 node src/index.js [seed.json ...]
// 可选参数为事件 JSON 文件（单个事件或事件数组），启动时按顺序摄入。

import { readFile } from "node:fs/promises";

import { OralHistoryService } from "./domain/commands.js";
import { start } from "./server.js";

const service = new OralHistoryService();

for (const path of process.argv.slice(2)) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const events = Array.isArray(raw) ? raw : [raw];
  for (const e of events) service.appendRawEvent(e);
  console.log(`已摄入 ${events.length} 条事件：${path}`);
}

start(service);
