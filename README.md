# 抗联录音开放编目后端

国家图书馆“中国记忆项目”抗联口述录音开放后端。围绕一盘磁带从入藏到开放的全生命周期，
把**捐赠协议、载体保管、数字化批次与校验值**与载体绑定，把**声道切分、说话人候选、逐字稿、
校订意见、歌曲权利与公开决定**落实到可单独控制的时间片段，并以事件溯源保证修正可溯、
引用稳定、临时下架只波及相应片段与衍生文件。

## 设计要点

### 事件溯源，只追加不改写
- 全部状态来自 `contracts/domain.schema.json` 登记的领域事件；初始五事件
  （`CARRIER_ACCESSIONED` / `DIGITIZATION_VERIFIED` / `SPEAKER_ANNOTATED` /
  `RELEASE_APPROVED` / `SEGMENT_WITHDRAWN`）与四聚合标识**原样保留**，新增类型仅做超集扩充。
- 事件按聚合流分配递增 `version`，带乐观并发控制；“修正/下架/恢复”都是新事件，
  历史版本永不删除。
- 初始事件语义延续：`RELEASE_APPROVED` 等价 `action=open` 的开放决定；
  `SEGMENT_WITHDRAWN` 仅作用于该片段及其衍生文件闭包。

### 载体关联（一盘磁带一条主链）
`physical_carrier` 关联：`donation_agreement`（捐赠协议与限制条款）、保管流转与库位、
`digitization_batch`（批次/设备/操作员）、`media_file`（原始采集、保存母带、降噪件、访问件
及其 `sha256` 与 `derived_from` 谱系）。数字化必须校验值比对通过才算 verified，失败留痕。

### 片段级控制
声道切分产生 `audio_segment`（声道 + 起止毫秒），片段之上各自独立挂载：
- **说话人**：多候选并存（`SPEAKER_CANDIDATE_PROPOSED`），认定只能基于带证据的已登记候选；
  证据不足只能撤销回“无法确认”，**不得强行定案**。
- **逐字稿**：初录与校订形成修订链（`supersedes_revision_id` + 逐条 `changes` 与理由）。
- **校订意见**：只追加、并存，任何意见都不覆盖他人意见。
- **歌曲权利**：`cleared | pending | denied`，独立于开放决定。
- **公开决定**：`open | masked | withheld`，每条必须携带各自依据
  `memorial_sensitivity | kin_privacy | donor_restriction | rights_clearance | public_interest`。

### 三类依据 → 开放 / 遮蔽 / 暂缓
- **亲属隐私**：即使决定漏配遮蔽，指向未公开人物（多为背景第三人/亲属）的文字仍被强制脱敏，
  对应音频区间消音；该信息不进入检索索引。
- **纪念敏感期**：决定带 `valid_from/valid_until` 窗口，期内遮蔽，**到期自动回落**到更早的开放决定；
  可用 `?at=` 重放任意时点状态。
- **捐赠限制 / 权利未清**：暂缓；受限录音对任何角色（含馆员）都不经过开放接口出音频字节。

### 衍生文件与临时下架
降噪件、访问件是派生版本，必须 `derived_from` 可溯源，原始采集不得被声明为派生。
临时下架的文件闭包 = 该片段访问件 + 同载体整盘派生件（如整盘降噪件）及其下游；
共享保存母带是各切分的“汇合点”，**不会**反向波及兄弟片段。

### 稳定引用（研究不失效）
引用形如 `nlc-oh:seg-kl-03-01@rev-seg01-001#t=12.5`：
- 钉住“片段 + 修订版本”，被引旧文（含被误录的姓名）原样可取，并附各版 `sha256` 摘要；
- 已被校订时返回接替链与修订点（谁、为什么、依据哪条意见）；
- 片段下架/暂缓时引用**不返回 404**：保留出处与状态解释，仅屏蔽正文与音频，恢复后立即复用。

### 授权边界（字段级）
| 角色 | 公开音频/文字 | 降噪件 | 候选与并存意见 | 库位/捐赠联系方式/母带 |
|---|---|---|---|---|
| public | 按决定（遮蔽渲染） | 否 | 否 | 否 |
| researcher | 是 | 是 | 否 | 否 |
| editor | 是 | 是 | 是 | 否 |
| curator | 是 | 是（工作区） | 是 | 是（元数据；受限音频仍不出开放接口） |

未公开亲属信息、原始库位、受限录音始终留在边界内。

## 目录

- `contracts/domain.schema.json`：事件信封与枚举（含依据、动作、文件角色词表）。
- `src/domain/`：事件工厂、事件存储、投影（归约/时点重放/衍生闭包）、应用服务与不变量。
- `src/access/`：开放策略与字段级授权、遮蔽渲染、检索投影、稳定引用解析、查询门面。
- `src/http/`、`src/server.js`：零依赖 HTTP 后端。
- `data/seed-story.js`：故事化种子（姓名旧称误录、第三人家事、歌曲权利、纪念期、捐赠限制、
  临时下架与恢复、并存异议）。
- `tests/`：契约、领域不变量、访问/引用/检索、HTTP 共 29 个测试。

## 运行

```bash
npm test                 # 29 个测试
npm start                # 载入故事种子，http://localhost:8080
npm run start:persistent # 事件落 data/eventlog.jsonl，重启重放
```

角色通过请求头 `X-Role: public|researcher|editor|curator` 声明（默认 public）。

## 主要接口

读：
- `GET /v1/search?q=&person=&year=&subject=` 仅索引当前可访问片段，命中直达音频锚点与可信文字。
- `GET /v1/segments/:id`、`/files`、`/history`（editor+）。
- `GET /v1/citations/:ref`（可带 `?at=ISO-8601` 做时点重放；下架不 404）。
- `GET /v1/carriers/:id`。

写（editor+ / curator，产出事件并返回事件版本）：
`notes`、`speaker-candidates`、`speaker-resolution`、`transcript`、
`transcript/corrections`、`song-rights`、`decisions`、`withdrawals`、`restorations`。

## 种子故事速览（car-kl-03）

| 片段 | 情形 | 当前状态 |
|---|---|---|
| seg-kl-03-01 | “李长生”被音近误录为另一人“王长河”，家属异议→撤销→认定李长林，逐字稿校订留两版 | 开放 |
| seg-kl-03-02 | 背景儿媳谈家人病情住址 | 遮蔽（文字脱敏+区间消音） |
| seg-kl-03-03 | 《露营之歌》演唱，权利被否 | 暂缓 |
| seg-kl-03-04 | 纪念讲话 | 2026-09-25～年底遮蔽，期满自动开放 |
| seg-kl-03-05 | 捐赠协议限定家属生前不开放 | 暂缓 |
| seg-kl-03-06 | 曾临时下架核验，2026-10-02 恢复 | 开放 |

旧版误录引用 `nlc-oh:seg-kl-03-01@rev-seg01-001` 至今可解析，并指向校订版
`@rev-seg01-002` 与修订理由——已引用旧版本的研究不会失去出处。
