#!/usr/bin/env node
/**
 * 服务入口：PORT=8080 node src/server.js [--seed] [--store data/eventlog.jsonl]
 * 默认加载故事化种子便于联调；生产可指定 JSONL 事件日志持久化。
 */
import { startServer } from "./http/server.js";
import { buildSeed } from "../data/seed-story.js";

const argv = process.argv.slice(2);
const useSeed = argv.includes("--seed") || !argv.includes("--store");
const storeIdx = argv.indexOf("--store");
const storeFile = storeIdx >= 0 ? argv[storeIdx + 1] : null;
const port = Number(process.env.PORT ?? 8080);

const { service } = await startServer({
  port,
  storeFile,
  seed: useSeed ? buildSeed : null,
});

console.log(`抗联录音开放编目后端已启动：http://localhost:${port}`);
console.log(`事件数：${service.store.all().length}（角色头 X-Role: public|researcher|editor|curator）`);
