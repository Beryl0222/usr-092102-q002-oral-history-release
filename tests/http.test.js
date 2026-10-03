import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after } from "node:test";

import { createApp } from "../src/server.js";
import { buildScenario, ACTORS, IDS } from "../src/scenario.js";

const I = IDS.segments;
const servers = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise((res) => s.close(res))));
});

async function withServer(service) {
  const server = createServer(createApp(service));
  servers.push(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return { base, service };
}

const staffHeaders = (actor) => ({ "x-user-id": actor.id, "x-user-role": actor.role, "content-type": "application/json" });

test("读者：健康检查、检索直抵音频与可信文字", async () => {
  const { base } = await withServer(buildScenario());
  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  assert.equal(health.ok, true);
  assert.ok(health.events > 30);

  const res = await fetch(`${base}/search?q=${encodeURIComponent("依兰")}`).then((r) => r.json());
  assert.equal(res.count, 1);
  const hit = res.results[0];
  assert.equal(hit.segment_id, I.westMarch);
  assert.equal(hit.speaker.confirmed.name, "李恒山");
  assert.equal(hit.audio.assets[0].kind, "access_proxy");
  assert.match(hit.citation, /^nlc-oh\//);
});

test("读者：稳定引用解析核正后的版本变化；@v1 仍是旧文", async () => {
  const { base } = await withServer(buildScenario());
  const ref = `nlc-oh/${IDS.carrier}/${I.westMarch}@v1`;
  const body = await fetch(`${base}/citations/${encodeURIComponent(ref)}`).then((r) => {
    assert.equal(r.status, 200);
    return r.json();
  });
  assert.match(body.cited_transcript.text, /李衡/);
  assert.equal(body.superseded, true);
  assert.equal(body.current_version, 2);
  assert.match(body.version_history[1].change_summary, /误名/);

  const current = await fetch(`${base}/citations/${encodeURIComponent(`nlc-oh/${IDS.carrier}/${I.westMarch}`)}`).then((r) => r.json());
  assert.match(current.cited_transcript.text, /李恒山/);
});

test("读者：受限/暂缓/遮蔽片段的音频边界（403/410/200 遮蔽）", async () => {
  const { base } = await withServer(buildScenario());

  const open = await fetch(`${base}/segments/${I.opening}/audio`);
  assert.equal(open.status, 200);
  const openBody = await open.json();
  assert.deepEqual(openBody.assets.map((a) => a.role), ["derived"]);

  const masked = await fetch(`${base}/segments/${I.familyTalk}/audio`).then((r) => r.json());
  assert.equal(masked.mode, "masked");
  assert.ok(masked.muted_ranges.length >= 1);
  const maskedText = await fetch(`${base}/segments/${I.familyTalk}/transcript`).then((r) => r.json());
  assert.match(maskedText.transcript.text, /█/);

  const withheld = await fetch(`${base}/segments/${I.taiwanKin}/audio`);
  assert.equal(withheld.status, 403);

  const undecided = await fetch(`${base}/segments/${I.pending}/audio`);
  assert.equal(undecided.status, 403);
});

test("读者：磁带页不泄漏原始库位、捐赠人信息与原始文件", async () => {
  const { base } = await withServer(buildScenario());
  const pub = await fetch(`${base}/carriers/${IDS.carrier}`).then((r) => r.json());
  assert.equal(pub.original_location, undefined);
  assert.equal(pub.agreements, undefined);
  assert.ok(pub.files.every((f) => f.kind === "access_proxy"));
  assert.ok(!pub.segments.some((s) => ["withheld", "undecided"].includes(s.status)));

  const staff = await fetch(`${base}/carriers/${IDS.carrier}`, { headers: staffHeaders(ACTORS.cataloger) }).then((r) => r.json());
  assert.match(staff.original_location, /地下库/);
  assert.ok(staff.files.some((f) => f.role === "original_capture"));
});

test("馆员：临时下架 → 读者 410 且旧引用仍可解释 → 恢复后 200；其他片段全程不受影响", async () => {
  const service = buildScenario();
  const { base } = await withServer(service);

  const otherBefore = await fetch(`${base}/segments/${I.westMarch}/audio`);
  assert.equal(otherBefore.status, 200);

  const w = await fetch(`${base}/segments/${I.opening}/withdraw`, {
    method: "POST",
    headers: staffHeaders(ACTORS.release),
    body: JSON.stringify({ reason: "技术复核", basis_refs: ["ticket-1"], expected_restore_after: "2026-10-10T00:00:00+08:00" }),
  });
  assert.equal(w.status, 201);

  const gone = await fetch(`${base}/segments/${I.opening}/audio`);
  assert.equal(gone.status, 410);
  const goneBody = await gone.json();
  assert.match(goneBody.error, /临时下架/);

  const ref = await fetch(
    `${base}/citations/${encodeURIComponent(`nlc-oh/${IDS.carrier}/${I.opening}@v1`)}`,
  ).then((r) => r.json());
  assert.equal(ref.status, "resolved");
  assert.equal(ref.access.status, "withdrawn");
  assert.equal(ref.cited_transcript.text_mode, "withheld");
  assert.equal(ref.version_history.length, 1);

  // 其他片段不受影响
  assert.equal((await fetch(`${base}/segments/${I.westMarch}/audio`)).status, 200);

  const restored = await fetch(`${base}/segments/${I.opening}/restore`, {
    method: "POST",
    headers: staffHeaders(ACTORS.release),
    body: JSON.stringify({ note: "复核通过" }),
  });
  assert.equal(restored.status, 201);
  assert.equal((await fetch(`${base}/segments/${I.opening}/audio`)).status, 200);

  service.store.log.length; // 保持 service 引用
});

test("鉴权：无身份不能写入；编目员不能下架；越权返回 4xx", async () => {
  const { base } = await withServer(buildScenario());
  const noAuth = await fetch(`${base}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event_type: "SEGMENT_CUT" }),
  });
  assert.equal(noAuth.status, 401);

  const forbidden = await fetch(`${base}/segments/${I.opening}/withdraw`, {
    method: "POST",
    headers: staffHeaders(ACTORS.cataloger), // 编目员无下架权
    body: JSON.stringify({ reason: "越权尝试" }),
  });
  assert.equal(forbidden.status, 422);
  const body = await forbidden.json();
  assert.match(body.error, /无权/);

  assert.equal((await fetch(`${base}/events`)).status, 401);
});

test("馆员：经 POST /events 追加开放决定，读者视图随之改变", async () => {
  const { base } = await withServer(buildScenario());
  // seg-06 原本未决定 → 公众 403
  assert.equal((await fetch(`${base}/segments/${I.pending}/audio`)).status, 403);

  const payload = {
    event_id: "evt-rel-06-http",
    event_type: "RELEASE_APPROVED",
    aggregate_type: "release_decision",
    aggregate_id: `rd-${I.pending}`,
    occurred_at: "2026-10-03T09:00:00+08:00",
    summary: "开放未编竣片段",
    payload: { segment_id: I.pending, disposition: "open", bases: ["donor_consent"], rationale: "补审通过" },
  };
  const r = await fetch(`${base}/events`, {
    method: "POST",
    headers: staffHeaders(ACTORS.release),
    body: JSON.stringify(payload),
  });
  assert.equal(r.status, 201, await r.text());
  assert.equal((await fetch(`${base}/segments/${I.pending}/audio`)).status, 200);

  // 违规事件不落地：身份争议未解决不能定案（此处直接测一个缺依据的确认）
  const bad = await fetch(`${base}/events`, {
    method: "POST",
    headers: staffHeaders(ACTORS.reviewer),
    body: JSON.stringify({
      event_id: "evt-bad-confirm",
      event_type: "SPEAKER_CONFIRMED",
      aggregate_type: "audio_segment",
      aggregate_id: I.familyTalk,
      occurred_at: "2026-10-03T09:05:00+08:00",
      summary: "试图无候选定案",
      payload: { candidate_id: "不存在", evidence: [] },
    }),
  });
  assert.equal(bad.status, 422);
});

test("馆员审计流包含全部事件，event_id 不重复", async () => {
  const { base } = await withServer(buildScenario());
  const body = await fetch(`${base}/events`, { headers: staffHeaders(ACTORS.admin) }).then((r) => r.json());
  const ids = body.events.map((e) => e.event_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(body.events.every((e) => e.version >= 1));
});
