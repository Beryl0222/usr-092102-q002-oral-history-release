import assert from "node:assert/strict";
import test from "node:test";
import { after, before } from "node:test";

import { createApp } from "../src/http/server.js";
import { buildSeed } from "../data/seed-story.js";
import { CatalogService } from "../src/domain/catalog-service.js";

let app;
let base;

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

before(async () => {
  const service = new CatalogService();
  buildSeed(service);
  app = createApp({ service });
  const server = await listen();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => app.close());

async function req(path, { method = "GET", role = "public", body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "X-Role": role, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("匿名检索与片段读取：直达开放音频与文字，敏感字段不外泄", async () => {
  const { json: search } = await req("/v1/search?q=李长生");
  assert.ok(search.results.some((r) => r.segment_id === "seg-kl-03-01"));

  const { status, json: seg } = await req("/v1/segments/seg-kl-03-01");
  assert.equal(status, 200);
  assert.match(seg.transcript.text, /李长林/);
  assert.ok(!("internal" in seg));
  assert.ok(!("workspace" in seg));
});

test("引用解析在临时下架的历史时点仍返回 200 与解释", async () => {
  const at = encodeURIComponent("2026-10-01T09:00:00+08:00");
  const { status, json } = await req(`/v1/citations/nlc-oh:seg-kl-03-06@rev-seg06-001?at=${at}`);
  assert.equal(status, 200);
  assert.equal(json.resolvable, true);
  assert.equal(json.access_state, "withdrawn");
  assert.equal(json.quoted.text, null);
});

test("角色边界：匿名不能写；编辑不能作开放决定；馆员可以", async () => {
  const anon = await req("/v1/segments/seg-kl-03-01/notes", {
    method: "POST",
    body: { note_id: "n-hack", body: "x" },
  });
  assert.equal(anon.status, 403);

  const editor = await req("/v1/segments/seg-kl-03-01/decisions", {
    method: "POST",
    role: "editor",
    body: { action: "open", basis: "public_interest" },
  });
  assert.equal(editor.status, 403);

  // 编辑可以提候选、并存意见
  const note = await req("/v1/segments/seg-kl-03-01/notes", {
    method: "POST",
    role: "editor",
    headers: { "X-User-Id": "editor-gu", "X-User-Name": "gu-bianshen" }, // HTTP 头仅 Latin-1，中文名走命令体
    body: { note_id: "note-http-1", note_kind: "dissent", author: "顾编审", body: "再补充一条不同意见，与既有意见并存" },
  });
  assert.equal(note.status, 201);
  assert.equal(note.json.events[0].event_type, "REVIEW_NOTE_ADDED");
});

test("馆员校订逐字稿：旧引用持续可用，新决定随事件版本返回", async () => {
  const correction = await req("/v1/segments/seg-kl-03-06/transcript/corrections", {
    method: "POST",
    role: "curator",
    body: {
      revision_id: "rev-seg06-002",
      text: "我们那个军下面有三个师，一师在依兰、勃利一带活动……",
      changes: [{ kind: "geo_detail", from: "依兰", to: "依兰、勃利", reason: "据部队沿革资料补全驻防地" }],
    },
  });
  assert.equal(correction.status, 201);
  assert.equal(correction.json.events[0].version >= 1, true);

  const old = await req("/v1/citations/nlc-oh:seg-kl-03-06@rev-seg06-001");
  assert.equal(old.status, 200);
  assert.match(old.json.quoted.text, /依兰一带/);
  assert.equal(old.json.superseded.current_revision_id, "rev-seg06-002");
});

test("临时下架写命令只影响目标片段：随后该段 403 式不可读音频、他段正常", async () => {
  const wd = await req("/v1/segments/seg-kl-03-01/withdrawals", {
    method: "POST",
    role: "curator",
    body: { reason: "临时核验录音异本", basis: "rights_clearance" },
  });
  assert.equal(wd.status, 201);

  const seg = await req("/v1/segments/seg-kl-03-01");
  assert.equal(seg.json.access.state, "withdrawn");
  assert.equal(seg.json.files.length, 0);

  const other = await req("/v1/segments/seg-kl-03-06");
  assert.equal(other.json.access.state, "open");

  // 恢复
  const rs = await req("/v1/segments/seg-kl-03-01/restorations", {
    method: "POST",
    role: "curator",
    body: { reason: "核验完毕" },
  });
  assert.equal(rs.status, 201);
  assert.equal((await req("/v1/segments/seg-kl-03-01")).json.access.state, "open");
});

test("非法命令返回校验错误而非 500", async () => {
  const bad = await req("/v1/segments/seg-kl-03-03/decisions", {
    method: "POST",
    role: "curator",
    body: { action: "masked", basis: "rights_clearance" }, // 缺 mask
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.reasons.join("；").includes("mask"));
});
