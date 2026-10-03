import assert from "node:assert/strict";
import test from "node:test";

import { buildSeed } from "../data/seed-story.js";
import { CatalogQuery, queryFromService } from "../src/access/catalog-query.js";
import { ROLES } from "../src/access/access-policy.js";

const NOW = "2026-10-03T09:00:00+08:00";

function setup() {
  const { service, ids } = buildSeed();
  return { service, ids, q: new CatalogQuery(service.state, { now: NOW }) };
}

test("读者搜索获准人物的现名与旧名都能直达片段与可信文字", () => {
  const { q, ids } = setup();
  for (const term of ["李长林", "李长生"]) {
    const hits = q.search({ q: term });
    assert.ok(hits.some((h) => h.segment_id === ids.segMain), `“${term}”应命中主片段`);
  }
  const byPerson = q.search({ person: "李长林" });
  assert.ok(byPerson.some((h) => h.segment_id === ids.segMain));
  const main = q.getSegment(ids.segMain);
  assert.equal(main.speaker.status, "confirmed");
  assert.equal(main.speaker.person.name, "李长林");
  assert.match(main.transcript.text, /李长林/);
});

test("误录为另一人的旧版逐字稿仍可按稳定引用取得，并能解释版本变化", () => {
  const { q, ids } = setup();
  const ref = q.resolve(ids.citationV1);
  assert.equal(ref.resolvable, true);
  assert.match(ref.quoted.text, /王长河/); // 被引原文原样保留
  assert.equal(ref.quoted.revision_id, ids.revisionV1);
  assert.equal(ref.current_revision_id, ids.revisionV2);
  const change = ref.superseded.newer_revisions[0].changes.find((c) => c.kind === "speaker_name");
  assert.equal(change.from, "王长河");
  assert.match(change.reason, /音近误录/);
  assert.ok(ref.bibliographic.citation.includes(ids.citationV1));
  // 版本历史含校验值，可证明文字未被事后改写
  assert.equal(ref.version_history.length, 2);
  assert.match(ref.version_history[0].checksum16, /^[0-9a-f]{16}$/);
});

test("背景第三人家事按亲属隐私遮蔽：文字脱敏、音频消音，且不进检索索引", () => {
  const { q, ids } = setup();
  const seg = q.getSegment(ids.segKin);
  assert.equal(seg.access.state, "masked");
  assert.equal(seg.access.basis, "kin_privacy");
  assert.doesNotMatch(seg.transcript.text, /周淑珍/);
  assert.doesNotMatch(seg.transcript.text, /齐齐哈尔/);
  assert.match(seg.transcript.text, /█████/);
  assert.equal(seg.files[0].muted_ranges_ms.length, 1);
  assert.equal(q.search({ q: "周淑珍" }).length, 0);
  assert.equal(q.search({ q: "齐齐哈尔" }).length, 0);
  // 说话人对公众不具名
  assert.notEqual(seg.speaker.status, "confirmed");
});

test("歌曲权利未结清的录音暂缓，对任何角色都不开放音频，但引用仍可解释", () => {
  const { q, ids } = setup();
  const seg = q.getSegment(ids.segSong);
  assert.equal(seg.access.state, "withheld");
  assert.equal(seg.files.length, 0);
  assert.equal(seg.transcript.text, null);
  const segCurator = q.getSegment(ids.segSong, { role: ROLES.CURATOR });
  assert.equal(segCurator.files.length, 0); // 馆员也不从开放接口取受限音频
  assert.equal(segCurator.workspace.song_rights[0].status, "denied");

  const ref = q.resolve("nlc-oh:seg-kl-03-03@rev-seg03-001");
  assert.equal(ref.resolvable, true);
  assert.equal(ref.quoted.text, null);
  assert.match(ref.quoted.blocked_reason, /暂缓/);
});

test("捐赠限制按协议暂缓；协议与库位等内部信息不越过授权边界", () => {
  const { q, ids } = setup();
  assert.equal(q.getSegment(ids.segDonor).access.state, "withheld");

  const pub = q.getSegment(ids.segMain);
  assert.ok(!("internal" in pub));
  assert.ok(!("workspace" in pub));
  const out = JSON.stringify(pub);
  assert.doesNotMatch(out, /总库/);
  assert.doesNotMatch(out, /李卫国/);

  const editorView = q.getSegment(ids.segMain, { role: ROLES.EDITOR });
  assert.ok(editorView.workspace);
  assert.ok(!("internal" in editorView)); // 编辑看不到库位
  assert.equal(editorView.workspace.review_notes.length, 3);

  const curatorView = q.getSegment(ids.segMain, { role: ROLES.CURATOR });
  assert.match(curatorView.internal.storage_location, /总库/);
});

test("纪念敏感期内遮蔽，期满自动回落至早先的开放决定", () => {
  const { service, ids } = setup();
  const during = queryFromService(service, { asOf: "2026-12-01T00:00:00+08:00" });
  assert.equal(during.accessOf(ids.segMemorial).state, "masked");
  const seg = during.getSegment(ids.segMemorial);
  assert.equal(seg.files[0].muted_ranges_ms.length, 1);

  const after = queryFromService(service, { asOf: "2027-02-01T00:00:00+08:00" });
  assert.equal(after.accessOf(ids.segMemorial).state, "open");
  assert.equal(after.getSegment(ids.segMemorial).files[0].muted_ranges_ms.length, 0);
});

test("临时下架只影响相应片段与其衍生文件，兄弟片段与整盘其他内容不受影响", () => {
  const { service, ids } = setup();
  const during = queryFromService(service, { asOf: "2026-10-01T09:00:00+08:00" });
  assert.equal(during.accessOf(ids.segTakedown).state, "withdrawn");
  // 兄弟段仍开放，其访问件仍可取
  assert.equal(during.getSegment(ids.segMain).access.state, "open");
  assert.deepEqual(
    during.getSegment(ids.segMain).files.map((f) => f.file_id),
    ["f-acc-01"],
  );
  // 下架段无文件（其访问件与整盘降噪件闭包被连带）
  assert.equal(during.getSegment(ids.segTakedown).files.length, 0);
});

test("下架期间稳定引用不失效（不 404），恢复后同一引用再次可用", () => {
  const { service, q, ids } = setup();
  const during = queryFromService(service, { asOf: "2026-10-01T09:00:00+08:00" });
  const ref = "nlc-oh:seg-kl-03-06@rev-seg06-001";
  const blocked = during.resolve(ref);
  assert.equal(blocked.resolvable, true);
  assert.equal(blocked.access_state, "withdrawn");
  assert.equal(blocked.quoted.text, null);
  assert.match(blocked.files_status, /临时下架/);

  const restored = q.resolve(ref);
  assert.equal(restored.access_state, "open");
  assert.equal(restored.files.length, 1);
  assert.match(restored.quoted.text, /三个师/);
});

test("无法确认的身份不对公众强制定论；候选仅校订工作区可见", () => {
  const { service } = buildSeed();
  const svc = service;
  const editor = { id: "e", name: "编目", role: "editor" };
  const curator = { id: "c", name: "馆员", role: "curator" };
  svc.defineSegment({ segment_id: "seg-unknown", carrier_id: "car-kl-03", start_ms: 0, end_ms: 1000, source_file_ids: [], actor: editor });
  svc.approveRelease({ segment_id: "seg-unknown", decision_id: "dec-u", actor: curator });
  svc.proposeSpeakerCandidate({ segment_id: "seg-unknown", person_id: "p-wang", confidence: 0.55, evidence: "音近，待考", actor: editor });

  const q = new CatalogQuery(svc.state, { now: NOW });
  const pub = q.getSegment("seg-unknown");
  assert.equal(pub.speaker.status, "undetermined");
  assert.deepEqual(pub.speaker.candidates, []);
  const ed = q.getSegment("seg-unknown", { role: ROLES.EDITOR });
  assert.equal(ed.speaker.candidates.length, 1);
});

test("研究读者可取得切分降噪件，匿名读者只能取得访问件；整盘降噪件不按片段外放", () => {
  const { q, ids } = setup();
  const pub = q.getSegment(ids.segMain);
  assert.deepEqual([...new Set(pub.files.map((f) => f.role))], ["access"]);
  const researcher = q.getSegment(ids.segMain, { role: ROLES.RESEARCHER });
  assert.ok(researcher.files.some((f) => f.role === "denoised" && f.file_id === "f-dn-seg01"));
  // 整盘降噪件含其他受限片段，即使研究读者也不能借开放片段旁路取得
  assert.ok(!researcher.files.some((f) => f.file_id === "f-dn-03"));
  // 母带/原始采集对研究读者同样不可见
  assert.ok(!researcher.files.some((f) => ["original_capture", "preservation_master"].includes(f.role)));
});

test("按时间与主题检索只返回当前可访问片段", () => {
  const { q } = setup();
  assert.deepEqual(q.search({ year: "1932" }).map((r) => r.segment_id), ["seg-kl-03-01"]);
  const kangri = q.search({ subject: "抗联歌曲" });
  // 歌曲段权利未清，不得作为可访问结果出现
  assert.equal(kangri.length, 0);
});
