// 端到端业务场景：一盘 1986 年抗联口述磁带的入藏、数字化、切分、误录、核正与分级开放。
// 所有事实通过命令产生，事件标识稳定显式指定，便于测试引用与 API 联调。

import { OralHistoryService } from "./domain/commands.js";

export const ACTORS = {
  cataloger: { id: "u-zhao", role: "cataloger", name: "赵编目" },
  tech: { id: "u-qian", role: "digitization_tech", name: "钱技术" },
  reviewer: { id: "u-sun", role: "reviewer", name: "孙校订" },
  rights: { id: "u-li", role: "rights_officer", name: "李权利" },
  release: { id: "u-zheng", role: "release_officer", name: "郑开放" },
  admin: { id: "u-admin", role: "admin", name: "系统管理员" },
};

export const IDS = {
  carrier: "tape-1986-kanglian-07",
  agreement: "da-1986-07",
  batch: "batch-2026-0917",
  original: "f-1986-07-original.wav",
  noiseReduced: "f-1986-07-denoise.wav",
  accessProxy: "f-1986-07-access.mp3",
  people: { hengshan: "p-li-hengshan", liheng: "p-li-heng", family: "p-zhang-family" },
  songs: { camping: "song-luying" },
  segments: {
    opening: "seg-07-01",
    westMarch: "seg-07-02",
    familyTalk: "seg-07-03",
    taiwanKin: "seg-07-04",
    memorial: "seg-07-05",
    pending: "seg-07-06",
  },
};

export function buildScenario(service = new OralHistoryService()) {
  const s = service;
  const A = ACTORS;
  const I = IDS;

  // —— 权属链：捐赠协议 ——
  s.recordDonationAgreement(
    A.rights,
    {
      agreement_id: I.agreement,
      agreement_no: "捐赠字第1986-07号",
      donor: "李恒山",
      signed_on: "1986-07-10",
      scope_carrier_id: I.carrier,
      restrictions: [
        {
          code: "embargo_kin_consent",
          scope: "segments",
          segment_ids: [IDS.segments.taiwanKin],
          effect: "withhold",
          until: "2036-01-01",
          note: "片段涉及在台亲属，捐赠人书面要求三十年内暂缓公开",
        },
      ],
    },
    "evt-da-07",
  );

  // —— 载体入藏与协议关联（原始库位为受限信息） ——
  s.accessionCarrier(
    A.cataloger,
    {
      carrier_id: I.carrier,
      title: "抗联老战士李恒山口述（1986年7月）",
      tape_no: "录音磁带-抗联-0007",
      media_type: "cassette",
      duration_ms: 1_800_000,
      recorded_on: "1986-07-15",
      original_location: "地下库三区七排四层（不公开）",
    },
    "evt-carrier-07",
  );
  s.linkCarrierAgreement(A.cataloger, { carrier_id: I.carrier, agreement_id: I.agreement }, "evt-link-07");
  s.fileCustody(
    A.cataloger,
    {
      record_id: "cu-07-01",
      carrier_id: I.carrier,
      location_code: "善本库 B3-12-04",
      transferred_from: "老馆磁带柜",
      received_on: "2026-09-02",
      condition: "带基轻度老化，需低温保存",
      handler: "u-zhao",
    },
    "evt-custody-07",
  );

  // —— 数字化批次、原始采集校验值 ——
  s.recordDigitizationBatch(
    A.tech,
    {
      batch_id: I.batch,
      batch_no: "DIG-2026-0917",
      digitized_on: "2026-09-17",
      operator: "u-qian",
      equipment: "Studer A721 / RME ADI-2",
      file_ids: [I.original],
    },
    "evt-batch-07",
  );
  s.verifyDigitization(
    A.tech,
    {
      batch_id: I.batch,
      file_id: I.original,
      carrier_id: I.carrier,
      codec: "pcm_s24le",
      sample_rate: 96000,
      channels: 2,
      byte_size: 1_036_800_000,
      checksums: [
        { algorithm: "sha512", value: "9f2c7a41b8d60e3a5c7f1d2b4e6a8c0f2d4b6e8a0c2f4d6b8e0a2c4f6d8b0e2a4c6e8a0b2d4f6c8e0a2b4d6f8c0e2a4b6d8f0c2e4a6b8d0f2c4e6a8b0d2f4c6e8a" },
        { algorithm: "md5", value: "3e1a2b4c6d8e0f2a4c6e8b0d2f4a6c8e" },
      ],
    },
    "evt-verify-07",
  );

  // —— 降噪件与公开访问代理：均为派生件，溯源到原始采集 ——
  s.recordDerivative(
    A.tech,
    {
      file_id: I.noiseReduced,
      source_file_id: I.original,
      kind: "noise_reduced",
      process: "spectral-denoise-v3（不改变人声内容）",
      carrier_id: I.carrier,
      codec: "flac",
      byte_size: 520_000_000,
      checksums: [{ algorithm: "sha512", value: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90" }],
    },
    "evt-derivative-nr",
  );
  s.recordDerivative(
    A.tech,
    {
      file_id: I.accessProxy,
      source_file_id: I.noiseReduced,
      kind: "access_proxy",
      process: "mp3-128k 公开访问代理",
      carrier_id: I.carrier,
      codec: "mp3",
      byte_size: 28_800_000,
      checksums: [{ algorithm: "sha512", value: "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f" }],
    },
    "evt-derivative-access",
  );

  // —— 人物：李恒山（本人）、李衡（旧转录误作的另一人）、不公开的第三人家属 ——
  s.registerPerson(
    A.cataloger,
    { person_id: I.people.hengshan, display_name: "李恒山", roles: ["narrator", "donor"] },
    "evt-person-hengshan",
  );
  s.notePersonAlias(
    A.cataloger,
    { person_id: I.people.hengshan, alias: "李恒三", period: "1940年代户籍曾用名", note: "旧档案中偶见，非另一人" },
    "evt-alias-hengshan",
  );
  s.registerPerson(
    A.cataloger,
    {
      person_id: I.people.liheng,
      display_name: "李衡",
      roles: ["historical_figure"],
      note: "另一抗联人物，旧转录将本盘讲述者误作此人",
    },
    "evt-person-liheng",
  );
  s.registerPerson(
    A.cataloger,
    { person_id: I.people.family, display_name: "张某家属（背景声）", visibility: "private" },
    "evt-person-family",
  );

  // —— 声道与时间片切分 ——
  const segInput = (segment_id, time_range, channel, extra = {}) => ({
    segment_id,
    carrier_id: I.carrier,
    source_file_id: I.original,
    time_range,
    channel,
    ...extra,
  });
  s.cutSegment(
    A.cataloger,
    segInput(IDS.segments.opening, { start_ms: 0, end_ms: 300_000 }, "L", {
      topics: ["野营密营", "抗联歌曲"],
      song_ids: [IDS.songs.camping],
    }),
    "evt-seg-01",
  );
  s.cutSegment(
    A.cataloger,
    segInput(IDS.segments.westMarch, { start_ms: 300_000, end_ms: 900_000 }, "L", {
      topics: ["西征", "依兰"],
      people_mentioned: [{ person_id: I.people.hengshan }],
    }),
    "evt-seg-02",
  );
  s.cutSegment(
    A.cataloger,
    segInput(IDS.segments.familyTalk, { start_ms: 900_000, end_ms: 1_200_000 }, "R", {
      topics: ["背景谈话", "家事"],
      people_mentioned: [{ person_id: I.people.family, relationship: "背景第三人" }],
    }),
    "evt-seg-03",
  );
  s.cutSegment(
    A.cataloger,
    segInput(IDS.segments.taiwanKin, { start_ms: 1_200_000, end_ms: 1_500_000 }, "mixed", {
      topics: ["在台亲属"],
    }),
    "evt-seg-04",
  );
  s.cutSegment(
    A.cataloger,
    segInput(IDS.segments.memorial, { start_ms: 1_500_000, end_ms: 1_700_000 }, "mixed", {
      topics: ["战友殉难"],
    }),
    "evt-seg-05",
  );
  s.cutSegment(
    A.cataloger,
    segInput(IDS.segments.pending, { start_ms: 1_700_000, end_ms: 1_800_000 }, "mixed", {
      topics: ["未编竣"],
    }),
    "evt-seg-06",
  );

  // —— 歌曲权利 ——
  s.assessSongRights(
    A.rights,
    {
      song_id: IDS.songs.camping,
      title: "露营之歌",
      work_status: "public_domain",
      rights_holders_note: "抗联集体创作，词作者均已逝世逾五十年",
      segment_ids: [IDS.segments.opening],
      basis: "版权处 2026 年第 118 号查核意见",
    },
    "evt-song-01",
  );

  // —— 初版逐字稿（seg-02 含姓名误录） ——
  s.draftTranscript(
    A.cataloger,
    {
      segment_id: IDS.segments.opening,
      text: "一九三七年冬天，我们在林海雪原里头扎营，唱起《露营之歌》：火烤胸前暖，风吹背后寒。",
    },
    "evt-tr-01-v1",
  );
  s.draftTranscript(
    A.cataloger,
    {
      segment_id: IDS.segments.westMarch,
      text: "说话人李衡回忆：民国二十五年，我们队伍在依兰一带西征，雪没过大腿根。",
      corrections: [],
    },
    "evt-tr-02-v1",
  );
  s.draftTranscript(
    A.cataloger,
    {
      segment_id: IDS.segments.familyTalk,
      text: "（背景声，右声道）张家儿媳在灶屋跟人说，家里那三亩好地民国二十三年分到家，这话本不是讲给采访者的。",
    },
    "evt-tr-03-v1",
  );
  s.draftTranscript(
    A.cataloger,
    { segment_id: IDS.segments.taiwanKin, text: "我有个弟弟跟着退到台湾，这些年……（此处暂缓）" },
    "evt-tr-04-v1",
  );
  s.draftTranscript(
    A.cataloger,
    { segment_id: IDS.segments.memorial, text: "那一年西征，一排的同志都牺牲在山前，名字我一个个都记得。" },
    "evt-tr-05-v1",
  );

  // —— 说话人候选：机器先误提"李衡"，馆员另提"李恒山"，均不定案 ——
  s.proposeSpeakers(
    A.cataloger,
    IDS.segments.westMarch,
    [
      {
        candidate_id: "cand-02-liheng",
        person_id: I.people.liheng,
        proposed_name: "李衡",
        basis: "语音转写自动对齐旧档案",
        confidence: 0.42,
        disputed: true,
        note: "自动转写所得，与捐赠人姓名不符，存疑",
      },
    ],
    "add",
    "evt-spk-prop-1",
  );
  s.proposeSpeakers(
    A.reviewer,
    IDS.segments.westMarch,
    [
      {
        candidate_id: "cand-02-hengshan",
        person_id: I.people.hengshan,
        basis: "捐赠协议签名与磁带封面题字",
        confidence: 0.8,
        note: "尚待亲属听辨确认",
      },
    ],
    "add",
    "evt-spk-prop-2",
  );

  // —— 校订意见并存：听众（老战士后代）反馈 + 校订者意见 ——
  s.addReviewNote(
    A.reviewer,
    {
      segment_id: IDS.segments.westMarch,
      category: "identity",
      note: "中国记忆网页听众李援朝（李恒山之子）来电：录音是其父李恒山，逐字稿误作李衡，要求核正。",
      transcript_version: 1,
    },
    "evt-note-descendant",
  );
  s.addReviewNote(
    A.cataloger,
    {
      segment_id: IDS.segments.westMarch,
      category: "identity",
      note: "比对 1986 年采访登记本，当日受访人确为李恒山；李衡当时在另一驻地，不可能在录音中。",
      transcript_version: 1,
    },
    "evt-note-register",
  );

  // —— 核正：逐字稿 v2（旧版保留），误录候选撤回，李恒山凭依据确认 ——
  s.reviseTranscript(
    A.reviewer,
    {
      segment_id: IDS.segments.westMarch,
      based_on_version: 1,
      change_summary: "据后代辨听与采访登记本，更正讲述者误名；纪年纪元改为公元",
      text: "说话人李恒山回忆：一九三六年，我们队伍在依兰一带西征，雪没过大腿根。",
      corrections: [
        {
          type: "speaker_name",
          from: "李衡",
          to: "李恒山",
          reason: "旧转录同音误作另一人；经捐赠协议、采访登记本与亲属辨听三方证实",
          evidence_event_ids: ["evt-note-descendant", "evt-note-register"],
        },
        { type: "dating", from: "民国二十五年", to: "一九三六年", reason: "公元纪年便于读者检索" },
      ],
    },
    "evt-tr-02-v2",
  );
  s.proposeSpeakers(
    A.reviewer,
    IDS.segments.westMarch,
    [{ candidate_id: "cand-02-liheng", note: "经核正为误录，撤回该候选" }],
    "withdraw",
    "evt-spk-withdraw-liheng",
  );
  s.confirmSpeaker(
    A.reviewer,
    IDS.segments.westMarch,
    {
      candidate_id: "cand-02-hengshan",
      person_id: I.people.hengshan,
      evidence: ["捐赠字第1986-07号签名", "1986年采访登记本", "亲属李援朝辨听（evt-note-descendant）"],
      note: "争议已据三方依据解决",
      dispute_resolved: true,
    },
    "evt-spk-confirm",
  );

  // —— 分级开放决定 ——
  s.approveRelease(
    A.release,
    { segment_id: IDS.segments.opening, disposition: "open", bases: ["donor_consent"], rationale: "捐赠协议同意开放，歌曲已属公有领域" },
    "evt-rel-01",
  );
  s.approveRelease(
    A.release,
    { segment_id: IDS.segments.westMarch, disposition: "open", bases: ["donor_consent"], rationale: "讲述者本人捐赠；核正后开放" },
    "evt-rel-02",
  );

  // seg-03：背景第三人家事——音频时间区间静音、文字字符区间涂黑
  const famText = "（背景声，右声道）张家儿媳在灶屋跟人说，家里那三亩好地民国二十三年分到家，这话本不是讲给采访者的。";
  const redactFrom = famText.indexOf("张家儿媳");
  const redactTo = famText.indexOf("，这话本不是讲给采访者的");
  s.approveRelease(
    A.release,
    {
      segment_id: IDS.segments.familyTalk,
      disposition: "masked",
      bases: ["family_privacy"],
      rationale: "背景声中第三人的家事非受访内容，依个人信息保护遮蔽其可识别部分",
      masking: {
        audio_muted_ranges: [{ start_ms: 912_000, end_ms: 970_000, note: "第三人可辨认语音段静音" }],
        redact_spans: [{ start_offset: redactFrom, end_offset: redactTo, reason: "第三人及其家事信息" }],
      },
    },
    "evt-rel-03",
  );

  // seg-04：捐赠限制——协议自带期限，效力高于开放决定
  s.approveRelease(
    A.release,
    {
      segment_id: IDS.segments.taiwanKin,
      disposition: "withheld",
      bases: ["donation_restriction"],
      rationale: "捐赠人书面要求涉及在台亲属内容三十年内暂缓（至2036年）",
    },
    "evt-rel-04",
  );

  // seg-05：纪念敏感期——到期前暂缓，到期复核
  s.approveRelease(
    A.release,
    {
      segment_id: IDS.segments.memorial,
      disposition: "withheld",
      bases: ["memorial_sensitivity"],
      rationale: "殉难者名单涉及烈士亲属纪念敏感期，暂缓至纪念活动结束后复核",
      review_after: "2027-09-01T00:00:00+08:00",
    },
    "evt-rel-05",
  );
  // seg-06 故意不作开放决定：编目未竣，公众不可见

  return s;
}

/** 直接运行时把场景事件导出为种子 JSON */
if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFile } = await import("node:fs/promises");
  const service = buildScenario();
  await writeFile(
    new URL("../data/scenario-events.json", import.meta.url),
    JSON.stringify(service.store.log.map(({ seq, ...e }) => e), null, 2) + "\n",
    "utf8",
  );
  console.log(`已导出 ${service.store.log.length} 条场景事件到 data/scenario-events.json`);
}
