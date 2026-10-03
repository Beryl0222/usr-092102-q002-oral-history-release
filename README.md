# 抗联录音开放编目后端

国家图书馆"中国记忆"抗联口述录音开放后端。围绕**只追加事件日志**建设：捐赠协议、载体保管、数字化批次与校验值随磁带保持关联；声道切分、说话人候选、逐字稿、校订意见、歌曲权利与开放决定全部落实到**可单独控制的时间片段**；临时下架只影响相应片段及其衍生文件，稳定引用在修订与下架后仍能解释版本变化。

## 设计纪律

1. **事件即事实**。一切状态由 `contracts/domain.schema.json` 约定的事件信封表达（`event_id` 全局唯一、永不复用；`version` 在每个聚合流内从 1 递增）。事件只能追加，不能修改删除；核正、改判、遮蔽、下架均通过追加新事件完成。
2. **降噪件只是派生件**。`DERIVATIVE_RECORDED` 必须沿溯源链最终到达 `original_capture`，派生件不得冒充原始采集；原始采集与降噪母版不对公众发放，公开侧只给访问代理（access proxy）。
3. **身份不得强行定案**。说话人先以候选存在（机器、馆员可各提各的），确认必须附判定依据；仍有争议且未标注解决的候选禁止确认，无法确认时公开侧显示"待考"。误录候选撤回、新确认推翻旧确认均留痕。
4. **校订只增不删**。逐字稿每次校订是新版本，`@vN` 稳定引用永久指向当时文本；当前引用附带从 vN 到现行版的修订链（更正项、依据事件）。校订意见（含读者后代反馈）独立成流，可并存。
5. **开放决定按依据分级**。
   - `open`：开放（须有 `donor_consent` 等正向依据）；
   - `masked`：遮蔽——音频给时间区间静音表，文字给字符涂黑区间；
   - `withheld`：暂缓——不出音频不出文字。
   依据各自独立：`memorial_sensitivity`（纪念敏感期，可带 `review_after`，到期进复核清单但不自动开放）、`family_privacy`（背景第三人家事等亲属隐私）、`donation_restriction`（捐赠协议限制，可带期限与片段范围，效力高于既有开放决定）、`song_rights`、`identity_uncertainty`。
6. **临时下架与开放决定正交**。`SEGMENT_WITHDRAWN` / `SEGMENT_RESTORED` 只作用于该片段时间窗及其派生文件，磁带与其他片段不受影响，逐字稿版本历史不删；恢复后原开放决定继续有效。
7. **授权边界**。未公开亲属信息（`visibility: private` 人物）、原始库位与保管细节、捐赠协议与捐赠人、原始采集文件始终不进入公开响应；被遮蔽文字同样不进入全文检索索引。

## 目录

- `contracts/domain.schema.json`：事件信封、21 个事件类型与 11 类聚合的稳定枚举。
- `src/validator.js`：信封校验（事件/聚合枚举、ISO 时间、版本、actor）。
- `src/domain/store.js`：只追加事件存储（event_id 唯一、流内版本连续、乐观并发）。
- `src/domain/reduce.js`：事件→聚合状态归约，任何状态可由日志重建。
- `src/domain/commands.js`：命令层（角色授权 + 业务不变量 + 事件构造）。
- `src/domain/policy.js`：开放策略，按查看者与三类依据计算 open/masked/withheld/withdrawn。
- `src/domain/identifiers.js`：稳定引用格式 `nlc-oh/<磁带>/<片段>[@v<逐字稿版本>]`。
- `src/catalog/projector.js`：编目投影——检索、稳定引用解析、磁带视图、到期复核。
- `src/server.js` / `src/index.js`：HTTP 后端与启动入口。
- `src/scenario.js`：完整业务场景（误录→后代发现→核正→分级开放），同时是种子生成器。
- `data/scenario-events.json`：36 条场景事件（`npm start` 自动载入）。
- `tests/`：领域不变量、开放策略/编目、HTTP 端到端、种子回放共 35 项测试。

## 本地运行

```bash
npm test          # 35 项测试
npm start         # 载入场景事件启动于 http://localhost:3000（PORT 可改）
node src/scenario.js   # 重新生成 data/scenario-events.json
```

## HTTP 接口

身份以网关注入的 `x-user-id` / `x-user-role` 头表达（角色：cataloger、digitization_tech、reviewer、rights_officer、release_officer、admin）；无身份即为公众读者。

读者侧：

- `GET /search?q=&person_id=&topic=&year=&from=&to=` — 只返回查看者可抵达片段，结果直带音频资产、文字与稳定引用。
- `GET /citations/nlc-oh/<磁带>/<片段>[@vN]` — 解析稳定引用：旧版本返回当时文字 + 修订链；下架/暂缓时书目可解析、正文按边界关闭。
- `GET /carriers/<id>` — 磁带编目（公开视图剥离库位、协议、原始文件）。
- `GET /segments/<id>` / `/audio` / `/transcript` — 片段状态、授权音频（200 / 遮蔽 200 带静音表 / 403 / 下架 410）与文字。

馆员侧：

- `POST /events` — 摄入事件（单条或数组），服务端指派流内版本，执行信封、角色与全部不变量校验。
- `POST /segments/<id>/withdraw|restore` — 临时下架/恢复（理由、依据、预计恢复时间）。
- `GET /events` — 全量事件审计流（馆员）。

## 场景示例（本仓库数据）

磁带 `tape-1986-kanglian-07`（1986 年抗联老战士李恒山口述）：

| 片段 | 情形 | 公开状态 |
|---|---|---|
| seg-07-01 | 野营唱歌，歌曲公有领域 | open |
| seg-07-02 | 旧转录误作"李衡"，后代发现，校订为"李恒山" | open；`@v1` 旧文仍可引、附更正链 |
| seg-07-03 | 背景右声道第三人谈家事 | masked（音频区间静音、文字涂黑、不可检索） |
| seg-07-04 | 在台亲属，捐赠协议限三十年 | withheld（协议效力，至 2036） |
| seg-07-05 | 殉难者名单，纪念敏感期 | withheld，2027-09 到期复核（不自动开放） |
| seg-07-06 | 编目未竣 | undecided，公众不可见 |
