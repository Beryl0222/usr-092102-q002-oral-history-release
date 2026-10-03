import assert from "node:assert/strict";
import test from "node:test";

import { Catalog } from "../src/catalog/projector.js";
import { evaluateSegment } from "../src/domain/policy.js";
import { buildScenario, ACTORS, IDS } from "../src/scenario.js";

const PUBLIC = { role: "public" };
const I = IDS.segments;
const carrier = IDS.carrier;

function setup() {
  return new Catalog(buildScenario().state());
}

test("场景基线：六个片段、权属链与派生链齐备", () => {
  const cat = setup();
  const st = cat.state;
  assert.equal(st.segments.size, 6);
  assert.deepEqual(st.carriers.get(IDS.carrier).agreement_ids, [IDS.agreement]);
  assert.equal(st.custodies.get(IDS.carrier).length, 1);
  const access = st.files.get(IDS.accessProxy);
  assert.equal(access.source_file_id, IDS.noiseReduced);
  assert.equal(st.files.get(IDS.noiseReduced).source_file_id, IDS.original);
});

test("开放片段：公开可获访问代理与文字，但拿不到原始采集/降噪件与库位", () => {
  const cat = setup();
  const v = cat.segmentAccess(I.opening, PUBLIC);
  assert.equal(v.status, "open");
  assert.deepEqual(v.audio.assets.map((a) => a.file_id), [IDS.accessProxy]);
  assert.ok(v.audio.assets.every((a) => a.role !== "original_capture"));
  assert.equal(v.transcript.mode, "full");

  const carrierView = cat.describeCarrier(carrier, PUBLIC);
  assert.equal(carrierView.status, "resolved");
  assert.equal(carrierView.original_location, undefined);
  assert.equal(carrierView.agreements, undefined);
  assert.deepEqual(carrierView.files.map((f) => f.file_id), [IDS.accessProxy]);

  const staffView = cat.describeCarrier(carrier, ACTORS.cataloger);
  assert.match(staffView.original_location, /地下库/);
  assert.ok(staffView.files.some((f) => f.file_id === IDS.original));
  assert.equal(staffView.custody.length, 1);
});

test("误录核正：旧引用 @v1 仍取得到旧文并解释版本变化，当前版为更正文本", () => {
  const cat = setup();
  const oldRef = `nlc-oh/${carrier}/${I.westMarch}@v1`;
  const old = cat.resolveCitation(oldRef, PUBLIC);
  assert.equal(old.status, "resolved");
  assert.match(old.cited_transcript.text, /李衡/);
  assert.equal(old.superseded, true);
  const v2 = old.version_history.find((x) => x.version === 2);
  assert.match(v2.change_summary, /误名/);
  assert.deepEqual(v2.corrections.map((c) => c.type), ["speaker_name", "dating"]);

  const current = cat.resolveCitation(`nlc-oh/${carrier}/${I.westMarch}`, PUBLIC);
  assert.match(current.cited_transcript.text, /李恒山/);
  assert.doesNotMatch(current.cited_transcript.text, /李衡/);
  assert.equal(current.speaker.confirmed.name, "李恒山");
  // 旧称（别名/曾用名）仍可检索到本人
  const byAlias = cat.search({ q: "李恒三" }, PUBLIC);
  assert.ok(byAlias.results.some((r) => r.segment_id === I.westMarch));
});

test("误名'李衡'不再把该片段检索到另一人身上；旧误录文字也不能经全文检索命中", () => {
  const cat = setup();
  const byWrongPerson = cat.search({ person_id: IDS.people.liheng }, PUBLIC);
  assert.equal(byWrongPerson.results.length, 0);
  const byWrongName = cat.search({ q: "李衡" }, PUBLIC);
  assert.equal(byWrongName.results.length, 0);
  const byRightName = cat.search({ q: "李恒山" }, PUBLIC);
  assert.ok(byRightName.results.some((r) => r.segment_id === I.westMarch));
});

test("第三人隐私：遮蔽音频区间与文字区间，家事全文不可检索", () => {
  const cat = setup();
  const v = cat.segmentAccess(I.familyTalk, PUBLIC);
  assert.equal(v.status, "masked");
  assert.ok(v.audio.muted_ranges.length >= 1);
  assert.match(v.transcript.text, /█/);
  assert.doesNotMatch(v.transcript.text, /三亩好地/);
  assert.equal(v.audio.assets[0].file_id, IDS.accessProxy);

  const res = cat.search({ q: "三亩好地" }, PUBLIC);
  assert.equal(res.results.length, 0);
  // 私人人物不可被检索
  assert.equal(cat.search({ person_id: IDS.people.family }, PUBLIC).results.length, 0);
  // 工作人员可见全文
  const staff = cat.segmentAccess(I.familyTalk, ACTORS.reviewer);
  assert.match(staff.transcript.text, /三亩好地/);
});

test("捐赠限制：协议带期限的片段暂缓，效力高于开放决定；其他片段不受影响", () => {
  const cat = setup();
  const v = cat.segmentAccess(I.taiwanKin, PUBLIC);
  assert.equal(v.status, "withheld");
  assert.equal(v.audio.mode, "none");
  assert.equal(v.withheld_reasons[0].kind, "donation_restriction");
  // 即使作了开放决定也仍被协议拦截（场景里决定本身即 withheld；此处验证引用正文不泄露）
  const ref = cat.resolveCitation(`nlc-oh/${carrier}/${I.taiwanKin}@v1`, PUBLIC);
  assert.equal(ref.cited_transcript.text, null);
  assert.equal(ref.cited_transcript.text_mode, "withheld");
  // 同盘其他片段照常开放
  assert.equal(cat.segmentAccess(I.opening, PUBLIC).status, "open");
});

test("纪念敏感期：到期前暂缓；到期进入复核清单但不自动开放", () => {
  const cat = setup();
  const before = cat.segmentAccess(I.memorial, PUBLIC, new Date("2026-10-03T00:00:00Z"));
  assert.equal(before.status, "withheld");
  assert.equal(before.audio.mode, "none");
  const due = cat.decisionsDueForReview(new Date("2027-09-02T00:00:00Z"));
  assert.ok(due.some((d) => d.segment_id === I.memorial));
  // 到期不等于自动公开：不作新决定前，状态仍为 withheld（决定 disposition）
  const after = cat.segmentAccess(I.memorial, PUBLIC, new Date("2027-09-02T00:00:00Z"));
  assert.equal(after.status, "withheld");
});

test("未作开放决定的片段公众不可见、不可检索，工作人员可见", () => {
  const cat = setup();
  assert.equal(cat.segmentAccess(I.pending, PUBLIC).status, "undecided");
  const res = cat.search({ q: "未编竣" }, PUBLIC);
  assert.equal(res.results.length, 0);
  assert.equal(cat.segmentAccess(I.pending, ACTORS.cataloger).status, "open");
});

test("临时下架只关相应片段与其衍生文件；引用仍可解析并说明状态；恢复后复原", () => {
  const svc = buildScenario();
  svc.withdrawSegment(
    ACTORS.release,
    I.opening,
    { reason: "读者质疑音源完整性，技术复核中", basis_refs: ["工单-20261003-09"], expected_restore_after: "2026-10-10T00:00:00+08:00" },
    "evt-w-opening",
  );
  const cat = new Catalog(svc.state());

  const gone = cat.segmentAccess(I.opening, PUBLIC);
  assert.equal(gone.status, "withdrawn");
  assert.equal(gone.audio.mode, "none");
  assert.equal(gone.transcript.mode, "none");

  // 同盘另一开放片段不受影响
  assert.equal(cat.segmentAccess(I.westMarch, PUBLIC).status, "open");
  // 下架片段不再出现在搜索
  assert.equal(cat.search({ q: "露营之歌" }, PUBLIC).results.length, 0);

  // 带版本的旧引用仍可解析：书目信息在、正文暂关、版本历史不失
  const ref = cat.resolveCitation(`nlc-oh/${carrier}/${I.opening}@v1`, PUBLIC);
  assert.equal(ref.status, "resolved");
  assert.equal(ref.access.status, "withdrawn");
  assert.equal(ref.cited_transcript.text_mode, "withheld");
  assert.equal(ref.version_history.length, 1);
  assert.equal(ref.access.withdrawal.active, true);

  // 恢复后一切如常，开放决定无需重作
  svc.restoreSegment(ACTORS.release, I.opening, "复核通过", "evt-restore-opening");
  const cat2 = new Catalog(svc.state());
  assert.equal(cat2.segmentAccess(I.opening, PUBLIC).status, "open");
  assert.equal(cat2.search({ q: "露营" }, PUBLIC).results.length, 1);
});

test("时间/主题/人物过滤直抵片段", () => {
  const cat = setup();
  const year = cat.search({ year: 1986 }, PUBLIC);
  assert.ok(year.results.length >= 3);
  const topic = cat.search({ topic: "西征" }, PUBLIC);
  assert.deepEqual(topic.results.map((r) => r.segment_id), [I.westMarch]);
  const person = cat.search({ person_id: IDS.people.hengshan }, PUBLIC);
  assert.ok(person.results.some((r) => r.segment_id === I.westMarch));
  const result = cat.search({ q: "依兰" }, PUBLIC).results[0];
  assert.ok(result.audio.assets[0].file_id);
  assert.ok(result.citation.includes("nlc-oh/"));
  assert.ok(result.time_range.end_ms > result.time_range.start_ms);
});

test("歌曲公有领域不收紧开放；未决权利则遮蔽音频", () => {
  const cat = setup();
  assert.equal(cat.segmentAccess(I.opening, PUBLIC).status, "open");
  const svc = buildScenario();
  svc.assessSongRights(
    ACTORS.rights,
    { song_id: IDS.songs.camping, title: "露营之歌", work_status: "unresolved", segment_ids: [I.opening], basis: "权利人主张待核" },
    "evt-song-reassess",
  );
  const v = evaluateSegment(svc.state(), I.opening, PUBLIC);
  assert.equal(v.status, "masked");
  assert.equal(v.transcript.mode, "full"); // 文字仍可读，仅音频收窄
});

test("引用格式校验", () => {
  const cat = setup();
  assert.equal(cat.resolveCitation("garbage", PUBLIC).status, "malformed");
  assert.equal(cat.resolveCitation(`nlc-oh/${carrier}/nope`, PUBLIC).status, "not_found");
  assert.equal(cat.resolveCitation(`nlc-oh/${carrier}/${I.opening}@v99`, PUBLIC).status, "version_not_found");
});
