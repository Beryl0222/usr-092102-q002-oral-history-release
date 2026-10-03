/**
 * 故事化种子：以一盘磁带（car-kl-03）贯通题目中的全部场景。
 *
 *  S1 李长林讲述抗联经历：旧名“李长生”被误录为另一人“王长河”，
 *     后代在中国记忆网页听到后提出异议；候选并存、撤销错误认定、校订逐字稿；
 *  S2 背景里儿媳周淑珍谈家事：亲属隐私 → 遮蔽开放（文字脱敏+区间消音）；
 *  S3 演唱《露营之歌》：歌曲权利未结清 → 暂缓；
 *  S4 纪念敏感期讲话：在期限内遮蔽，到期自动回落至早先开放决定；
 *  S5 捐赠协议限制段：暂缓；
 *  S6 曾临时下架、核明后恢复：稳定引用全程可解释。
 *
 * 所有事件使用显式标识与固定时间，便于测试与重放。
 */
import { CatalogService } from "../src/domain/catalog-service.js";

const sha = (s) => {
  // 确定性的 64 位十六进制伪校验值，仅用于种子
  let h = "";
  for (let i = 0; i < 64; i += 1) h += ((s.charCodeAt(i % s.length) * 7 + i * 13) % 16).toString(16);
  return h;
};

const curator = { id: "u-yu", name: "于馆员", role: "curator" };
const editor = { id: "u-shen", name: "沈编目", role: "editor" };
const auditor = { id: "u-gu", name: "顾编审", role: "editor" };

function span(text, sub) {
  const start = text.indexOf(sub);
  if (start < 0) throw new Error(`种子文本中找不到“${sub}”`);
  return { start, end: start + sub.length };
}

export function buildSeed(service = new CatalogService()) {
  const svc = service;
  const at = (s) => ({ occurred_at: s });
  const ev = (eventId) => ({ eventId });

  // ---------- 载体 / 协议 / 保管（原始库位仅登记，不出授权边界） ----------
  svc.accessionCarrier({
    carrier_id: "car-kl-03",
    title: "抗联老战士李长林口述磁带（第3盘）",
    medium: "compact cassette",
    storage_location: "总库B区-抗联专柜-箱17-位04",
    actor: curator,
    ...at("2026-03-01T09:00:00+08:00"),
  });

  svc.recordDonationAgreement({
    agreement_id: "agr-kl-03",
    carrier_id: "car-kl-03",
    donor_name: "李长林家属（捐赠代表：李卫国）",
    donor_contact: "（联系方式从略·内部留存）",
    signed_at: "2026-03-02T10:00:00+08:00",
    access_grant: "同意用于中国记忆项目公益开放与学术研究",
    restrictions: [
      {
        basis: "donor_restriction",
        scope_segment_id: "seg-kl-03-05",
        note: "第五段涉及在世家属病情与联系方式，捐赠方要求在其生前不开放",
      },
    ],
    applies_segment_ids: ["seg-kl-03-05"],
    actor: curator,
    ...at("2026-03-02T10:00:00+08:00"),
  });

  svc.recordCustody({
    carrier_id: "car-kl-03",
    keeper: "国家图书馆中国记忆项目中心",
    storage_location: "总库B区-抗联专柜-箱17-位04",
    change_type: "transfer",
    note: "由家属捐赠入馆",
    actor: curator,
    ...at("2026-03-01T09:30:00+08:00"),
  });

  // ---------- 数字化批次 / 载体文件 / 校验值 ----------
  svc.recordDigitizationBatch({
    batch_id: "batch-2026-031",
    carrier_id: "car-kl-03",
    operator: "数字化组·冯工",
    equipment: "Studer A721 / RME ADI-2 Pro",
    started_at: "2026-03-05T09:00:00+08:00",
    actor: curator,
    ...at("2026-03-05T09:00:00+08:00"),
  });

  svc.recordFile({
    file_id: "f-cap-03",
    carrier_id: "car-kl-03",
    batch_id: "batch-2026-031",
    role: "original_capture",
    filename: "KL03_96k24_raw.wav",
    sha256: sha("KL03-original-capture"),
    channels: "stereo",
    duration_ms: 1842000,
    mime: "audio/wav",
    actor: curator,
    ...at("2026-03-05T11:00:00+08:00"),
  });

  svc.recordFile({
    file_id: "f-mst-03",
    carrier_id: "car-kl-03",
    batch_id: "batch-2026-031",
    role: "preservation_master",
    filename: "KL03_master_96k24.wav",
    sha256: sha("KL03-preservation-master"),
    channels: "stereo",
    duration_ms: 1842000,
    mime: "audio/wav",
    actor: curator,
    ...at("2026-03-05T12:00:00+08:00"),
  });

  // 一次失败校验（抓录软件写出的文件与留存校验值不符）留痕，然后重抓、通过
  svc.verifyDigitization({
    file_id: "f-mst-03",
    actual_sha256: sha("KL03-corrupt-transfer"),
    actor: curator,
    ...at("2026-03-06T09:00:00+08:00"),
  });
  svc.verifyDigitization({
    file_id: "f-mst-03",
    actual_sha256: sha("KL03-preservation-master"),
    actor: curator,
    ...at("2026-03-06T10:30:00+08:00"),
  });

  // ---------- 声道切分：6 个时间片段 ----------
  const segs = [
    ["seg-kl-03-01", "李长林讲述参加抗联", 0, 480000, ["抗联", "口述", "周保中", "传令兵"], "1932年", "L"],
    ["seg-kl-03-02", "背景亲属谈家事", 480000, 720000, ["家事", "亲属"], null, "R"],
    ["seg-kl-03-03", "演唱《露营之歌》", 720000, 960000, ["抗联歌曲", "露营之歌"], null, "L"],
    ["seg-kl-03-04", "纪念活动讲话", 960000, 1200000, ["纪念活动", "讲话"], null, "L"],
    ["seg-kl-03-05", "家属近况（捐赠限制）", 1200000, 1500000, ["家事"], null, "R"],
    ["seg-kl-03-06", "部队建制回忆", 1500000, 1842000, ["抗联", "部队建制"], null, "L"],
  ];
  for (const [segment_id, label, start_ms, end_ms, subjects, period, channel] of segs) {
    svc.defineSegment({
      segment_id,
      carrier_id: "car-kl-03",
      label,
      channel,
      start_ms,
      end_ms,
      source_file_ids: ["f-mst-03"],
      subjects,
      recorded_period: period,
      language: "zh-cmn",
      actor: editor,
      ...at("2026-03-06T14:00:00+08:00"),
    });
  }

  // 派生文件：每段访问件 + 整盘降噪件（均派生自保存母带）
  for (let i = 1; i <= 6; i += 1) {
    const id = `seg-kl-03-0${i}`;
    svc.recordFile({
      file_id: `f-acc-0${i}`,
      carrier_id: "car-kl-03",
      batch_id: "batch-2026-031",
      role: "access",
      filename: `KL03_seg0${i}_access.mp3`,
      sha256: sha(`KL03-access-${id}`),
      derived_from_file_id: "f-mst-03",
      segment_id: id,
      duration_ms: 240000,
      mime: "audio/mpeg",
      actor: editor,
      ...at("2026-03-07T09:00:00+08:00"),
    });
  }
  svc.recordFile({
    file_id: "f-dn-03",
    carrier_id: "car-kl-03",
    batch_id: "batch-2026-031",
    role: "denoised",
    filename: "KL03_denoised_full.wav",
    sha256: sha("KL03-denoised-full"),
    derived_from_file_id: "f-mst-03",
    duration_ms: 1842000,
    mime: "audio/wav",
    actor: editor,
    ...at("2026-03-07T10:00:00+08:00"),
  });
  // 主片段的切分降噪件：绑定到片段，研究读者可经开放接口取得（遮蔽时同样需消音）
  svc.recordFile({
    file_id: "f-dn-seg01",
    carrier_id: "car-kl-03",
    batch_id: "batch-2026-031",
    role: "denoised",
    filename: "KL03_seg01_denoised.wav",
    sha256: sha("KL03-denoised-seg01"),
    derived_from_file_id: "f-mst-03",
    segment_id: "seg-kl-03-01",
    duration_ms: 480000,
    mime: "audio/wav",
    actor: editor,
    ...at("2026-03-07T10:30:00+08:00"),
  });

  // ---------- 人物 ----------
  svc.recordPerson({
    person_id: "p-li",
    display_name: "李长林",
    names: [
      { value: "李长林", type: "primary" },
      { value: "李长生", type: "old_name", note: "旧名（乳名），录音中口述所用" },
    ],
    born: "1918",
    public: true,
    description_public: "东北抗日联军老战士，新中国成立后在东北工作。",
    actor: editor,
    ...at("2026-03-08T09:00:00+08:00"),
  });
  svc.recordPerson({
    person_id: "p-wang",
    display_name: "王长河",
    names: [{ value: "王长河", type: "primary" }],
    born: "1915",
    public: true,
    description_public: "东北抗日联军老战士（另一位历史当事人）。",
    actor: editor,
    ...at("2026-03-08T09:10:00+08:00"),
  });
  svc.recordPerson({
    person_id: "p-zhoukin",
    display_name: "周淑珍",
    names: [{ value: "周淑珍", type: "primary" }],
    is_kin: true,
    public: false,
    actor: editor,
    ...at("2026-03-08T09:20:00+08:00"),
  });

  // ---------- S1：说话人候选并存，先误定为“王长河” ----------
  svc.proposeSpeakerCandidate({
    segment_id: "seg-kl-03-01",
    person_id: "p-li",
    confidence: 0.82,
    evidence: "捐赠家属辨认嗓音，并提供家谱记载旧名‘李长生’",
    actor: editor,
    ...at("2026-03-10T09:00:00+08:00"),
  });
  svc.proposeSpeakerCandidate({
    segment_id: "seg-kl-03-01",
    person_id: "p-wang",
    confidence: 0.6,
    evidence: "初录转录员据‘李长生’与‘王长河’音近，且王长河有同期在该地区活动记录",
    actor: editor,
    ...at("2026-03-10T09:05:00+08:00"),
  });
  svc.resolveSpeaker({
    segment_id: "seg-kl-03-01",
    person_id: "p-wang",
    certainty: "confirmed",
    reason: "初录阶段采信音近判断（后被推翻）",
    actor: editor,
    ...at("2026-03-10T09:20:00+08:00"),
  });

  // ---------- 逐字稿 ----------
  const text1 = "我叫王长河，民国二十年参加抗联，在周保中的部队当传令兵。";
  svc.recordTranscript({
    revision_id: "rev-seg01-001",
    segment_id: "seg-kl-03-01",
    text: text1,
    mentions: [{ person_id: "p-wang", ...span(text1, "王长河") }],
    editor: "沈编目",
    note: "初录：据初判说话人署名",
    actor: editor,
    ...at("2026-03-10T10:00:00+08:00"),
  });

  const text2 =
    "隔壁屋里，周淑珍跟来人说：咱家老二现在在齐齐哈尔治病，地址你们可别往外说。";
  svc.recordTranscript({
    revision_id: "rev-seg02-001",
    segment_id: "seg-kl-03-02",
    text: text2,
    mentions: [{ person_id: "p-zhoukin", ...span(text2, "周淑珍") }],
    editor: "沈编目",
    actor: editor,
    ...at("2026-03-10T10:30:00+08:00"),
  });

  svc.recordTranscript({
    revision_id: "rev-seg03-001",
    segment_id: "seg-kl-03-03",
    text: "（唱）铁岭绝岩，林木丛生，暴雨狂风……《露营之歌》",
    editor: "沈编目",
    actor: editor,
    ...at("2026-03-10T11:00:00+08:00"),
  });
  svc.recordTranscript({
    revision_id: "rev-seg04-001",
    segment_id: "seg-kl-03-04",
    text: "今天纪念老战友，我讲几句……",
    mentions: [],
    editor: "沈编目",
    actor: editor,
    ...at("2026-03-10T11:30:00+08:00"),
  });
  svc.recordTranscript({
    revision_id: "rev-seg05-001",
    segment_id: "seg-kl-03-05",
    text: "家里的电话和住院的安排是这样的……",
    editor: "沈编目",
    actor: editor,
    ...at("2026-03-10T12:00:00+08:00"),
  });
  svc.recordTranscript({
    revision_id: "rev-seg06-001",
    segment_id: "seg-kl-03-06",
    text: "我们那个军下面有三个师，一师在依兰一带活动……",
    editor: "沈编目",
    actor: editor,
    ...at("2026-03-10T12:30:00+08:00"),
  });

  // ---------- 歌曲权利 ----------
  svc.recordSongRights({
    rights_id: "song-001",
    segment_id: "seg-kl-03-03",
    song_title: "露营之歌",
    rights_holder: "权属待查（歌词整理者继承人主张中）",
    status: "denied",
    note: "继承人未授权开放演唱录音，协商中",
    actor: curator,
    ...at("2026-03-12T09:00:00+08:00"),
  });

  // ---------- 开放决定（依据各自独立） ----------
  // S1：既有 RELEASE_APPROVED 事件落公开
  svc.approveRelease({
    segment_id: "seg-kl-03-01",
    reason: "老战士本人与家属同意公益开放",
    decision_id: "dec-seg01-open",
    actor: curator,
    ...at("2026-03-15T09:00:00+08:00"),
  });

  // S2：亲属隐私 → 遮蔽（文字两段 + 音频区间消音）
  const familyDetail = "咱家老二现在在齐齐哈尔治病，地址你们可别往外说";
  svc.decideRelease({
    segment_id: "seg-kl-03-02",
    action: "masked",
    basis: "kin_privacy",
    reason: "背景中第三人家属家事随整段录入，遮蔽后开放，音频对应区间消音",
    mask: {
      text_spans: [{ ...span(text2, familyDetail), reason: "亲属病情与住址信息" }],
      audio_ranges_ms: [
        { start_ms: 5000, end_ms: 18000, reason: "家属谈话区间消音" },
      ],
    },
    actor: curator,
    ...at("2026-03-15T09:10:00+08:00"),
  });

  // S3：歌曲权利未结清 → 暂缓
  svc.decideRelease({
    segment_id: "seg-kl-03-03",
    action: "withheld",
    basis: "rights_clearance",
    reason: "《露营之歌》演唱录音权利未结清",
    actor: curator,
    ...at("2026-03-15T09:20:00+08:00"),
  });

  // S4：先开放；纪念敏感期内改为遮蔽至年底
  svc.decideRelease({
    segment_id: "seg-kl-03-04",
    action: "open",
    basis: "public_interest",
    reason: "纪念讲话公益开放",
    actor: curator,
    ...at("2026-03-20T09:00:00+08:00"),
  });
  svc.decideRelease({
    segment_id: "seg-kl-03-04",
    action: "masked",
    basis: "memorial_sensitivity",
    reason: "临近纪念敏感期，敏感期内遮蔽逝者姓名段落，期满自动回落开放",
    valid_from: "2026-09-25T00:00:00+08:00",
    valid_until: "2027-01-01T00:00:00+08:00",
    mask: {
      text_spans: [{ ...span("今天纪念老战友，我讲几句……", "老战友"), reason: "纪念敏感期内逝者相关称谓暂缓公开" }],
      audio_ranges_ms: [{ start_ms: 30000, end_ms: 55000, reason: "纪念敏感期消音" }],
    },
    actor: curator,
    ...at("2026-09-25T10:00:00+08:00"),
  });

  // S5：捐赠限制 → 暂缓
  svc.decideRelease({
    segment_id: "seg-kl-03-05",
    action: "withheld",
    basis: "donor_restriction",
    reason: "捐赠协议限定该段在家属生前不开放",
    actor: curator,
    ...at("2026-03-15T09:40:00+08:00"),
  });

  // S6：开放 → 临时下架 → 恢复
  svc.approveRelease({
    segment_id: "seg-kl-03-06",
    reason: "部队建制回忆，公益开放",
    decision_id: "dec-seg06-open",
    actor: curator,
    ...at("2026-03-20T09:30:00+08:00"),
  });
  svc.withdrawSegment({
    segment_id: "seg-kl-03-06",
    reason: "有研究者反映建制表述可能涉及尚未核实的牺牲者姓名，临时下架核验",
    basis: "kin_privacy",
    until: "2026-10-10T00:00:00+08:00",
    actor: curator,
    ...at("2026-09-30T15:00:00+08:00"),
  });
  svc.restoreSegment({
    segment_id: "seg-kl-03-06",
    reason: "经与军史资料核对无此问题，恢复开放",
    actor: curator,
    ...at("2026-10-02T11:00:00+08:00"),
  });

  // ---------- 校订意见并存（谁也不覆盖谁） ----------
  svc.addReviewNote({
    note_id: "note-001",
    segment_id: "seg-kl-03-01",
    note_kind: "objection",
    body: "我是李长林的孙子。录音里说的是我爷爷的旧名‘李长生’，不是‘王长河’，请核查。——中国记忆网页留言",
    author: "李卫国（家属）",
    actor: { id: "u-family", name: "李卫国（家属）", role: "kin" },
    ...at("2026-09-20T20:10:00+08:00"),
  });
  svc.addReviewNote({
    note_id: "note-002",
    segment_id: "seg-kl-03-01",
    note_kind: "verification",
    body: "比对家谱与同批第1、2盘嗓音，支持家属意见，建议撤销原认定。",
    author: "于馆员",
    actor: curator,
    ...at("2026-09-22T09:00:00+08:00"),
  });
  svc.addReviewNote({
    note_id: "note-003",
    segment_id: "seg-kl-03-01",
    note_kind: "dissent",
    body: "音近说并非毫无依据，建议保留两候选与证据链，结论措辞留有余地。",
    author: "顾编审",
    actor: auditor,
    ...at("2026-09-23T14:00:00+08:00"),
  });

  // ---------- 撤销错误认定 → 认定李长林；校订逐字稿（旧版保留） ----------
  svc.resolveSpeaker({
    segment_id: "seg-kl-03-01",
    person_id: null,
    certainty: "undetermined",
    reason: "原认定证据被新证据推翻，先行撤销，不强行定案",
    actor: curator,
    ...at("2026-09-28T10:00:00+08:00"),
  });
  svc.resolveSpeaker({
    segment_id: "seg-kl-03-01",
    person_id: "p-li",
    certainty: "confirmed",
    reason: "家属辨认、家谱旧名与多盘嗓音比对一致；王长河同期不在该部队驻防地",
    actor: curator,
    ...at("2026-10-01T10:00:00+08:00"),
  });

  const text3 =
    "我叫李长林，旧名李长生，民国二十年（1931年）参加东北抗日联军，在周保中将军的部队当传令兵。";
  svc.correctTranscript({
    revision_id: "rev-seg01-002",
    segment_id: "seg-kl-03-01",
    text: text3,
    mentions: [{ person_id: "p-li", ...span(text3, "李长林") }],
    editor: "于馆员",
    changes: [
      {
        kind: "speaker_name",
        from: "王长河",
        to: "李长林（旧名李长生）",
        reason: "家属在中国记忆网页提出异议；家谱旧名与多盘嗓音比对证实，原‘王长河’系音近误录为另一人",
        evidence_event: "note-001",
      },
      {
        kind: "terminology",
        from: "抗联",
        to: "东北抗日联军",
        reason: "规范全称，含义不变",
      },
    ],
    note: "旧版 rev-seg01-001 保留以维持既有研究引用；差异以本 changes 为准",
    actor: curator,
    ...at("2026-10-01T11:00:00+08:00"),
  });

  return {
    service: svc,
    ids: {
      carrier: "car-kl-03",
      agreement: "agr-kl-03",
      batch: "batch-2026-031",
      original: "f-cap-03",
      master: "f-mst-03",
      denoised: "f-dn-03",
      accessFiles: ["f-acc-01", "f-acc-02", "f-acc-03", "f-acc-04", "f-acc-05", "f-acc-06"],
      segments: segs.map((s) => s[0]),
      segMain: "seg-kl-03-01",
      segKin: "seg-kl-03-02",
      segSong: "seg-kl-03-03",
      segMemorial: "seg-kl-03-04",
      segDonor: "seg-kl-03-05",
      segTakedown: "seg-kl-03-06",
      personLi: "p-li",
      personWrong: "p-wang",
      personKin: "p-zhoukin",
      revisionV1: "rev-seg01-001",
      revisionV2: "rev-seg01-002",
      citationV1: "nlc-oh:seg-kl-03-01@rev-seg01-001",
    },
  };
}
