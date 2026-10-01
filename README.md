# 舞台监督提示单系统（Stage Cue Manager）

供舞台监督在**排演**与**现场执行**中使用的 Web 应用：录入场次与执行单（灯光 / 音效 / 布景提示及其前置提示），校验后发布不可变执行单；每场演出从某一已发布版本启动独立记录，现场按依赖关系触发或跳过提示，全程留痕。

## 功能

- **场次与执行单管理**：按序编排提示（编号、类型、描述、前置提示）
- **发布前校验**：缺失引用（前置编号不存在）、编号重复、自依赖、循环依赖（给出环路径）
- **不可变执行单**：发布后内容锁定（含每个提示的「需双人复核」标记）；修改须新建草稿再发布新版本
- **双人复核触发（关键提示）**：草稿中可把个别提示标记为「需双人复核」，发布后标记随版本锁定，旧版本提示一律按无需复核处理
  - 现场不能直接触发：先由一位操作人**发起触发申请**（记录申请人与时间），此时提示仍未触发、下游前置继续受阻
  - 另一位操作人**确认**且**前置当前均已触发**后，才写入有效触发流水；前置失效（如被撤回）时确认被拒，申请保持待处理
  - 申请人可**撤销**待处理申请，其他操作人可填原因**驳回**；申请与处置全程留痕
  - 待处理期间拒绝跳过、重复申请与撤回；确认 / 撤销 / 驳回并发只有一个结局；直接调用既有触发接口无法绕过复核
  - 已确认触发的提示仍受现有撤回规则与下游保护约束；普通提示的原接口、响应与执行台字段完全兼容
- **现场执行台**：实时展示 待执行 / 已触发 / 已跳过 / 受阻（前置未触发） / 待复核 状态及待处理复核申请面板
  - 仅当前置全部**已触发**时才可触发；受阻项触发按钮禁用且服务端同样拒绝
  - 跳过必须填写原因；每次结果留存操作人与时间
  - **撤回误触发**：对当前「已触发」的提示可撤回（须填撤回人与原因）；若其下游（沿前置关系可达的后续提示）仍有有效「已触发」，则整体拒绝并列出受影响编号，任何记录都不改变。撤回后原触发与撤回流水全部保留，提示按当前前置结果回到「待执行 / 受阻」，可再次触发或跳过；已跳过与未触发的提示不可撤回
  - 多人并发操作同一提示只记一次有效结果，冲突方会收到当前状态提示
- **版本隔离与回看**：演出锁定启动时的已发布版本；排演改草稿不影响进行中的演出，历史演出始终按当时版本回看
- **明确错误**：无已发布版本、非法依赖、前置未满足、缺少操作人 / 原因等均有中文错误提示

## 一键启动（Docker Compose）

```bash
docker compose up --build
```

启动后访问：**http://localhost:3000**

- 首次启动自动初始化数据库（建表），空库时写入一份演示数据（可用 `SEED_DEMO: "0"` 关闭）
- SQLite 数据保存在名为 `cue-data` 的卷中（容器内 `/app/data/app.db`），删除容器不丢数据

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Web 服务端口（compose 中映射为 `宿主机:容器`，改宿主机端口请改 `ports`，如 `"8080:3000"`） |
| `DB_PATH` | `/app/data/app.db`（本地运行为 `./data/app.db`） | SQLite 数据库文件路径 |
| `SEED_DEMO` | `1` | 空库时是否写入演示数据，`0` 关闭 |
| `HOST` | `0.0.0.0` | 监听地址 |

## 本地开发（不用 Docker）

要求 Node.js ≥ 22.13（推荐 24，使用内置 `node:sqlite`，**无任何第三方依赖**）：

```bash
npm start          # 或 node server.js
# 打开 http://localhost:3000
```

## 使用流程

1. **新建场次** → 进入场次后「新建草稿」
2. 在草稿编辑器中按序录入提示，前置提示填编号（逗号分隔）；关键提示可勾选「需复核」；随时「校验」
3. 「校验并发布」→ 生成不可变执行单（如 v1，复核标记一并锁定）
4. 回到场次页「启动演出」，选择已发布版本 → 进入执行台
5. 执行台中填写操作人，对普通提示执行「触发 / 跳过」；对**需复核**提示点「发起复核」，由另一位操作人在上方「待双人复核申请」面板中确认（或由申请人撤销、他人填原因驳回）；误触发可点「撤回」并填写撤回人与原因；页面每 2.5 秒自动刷新，多人可同时操作；右侧展示完整执行流水（含复核触发与撤回记录）
6. 排演中要改执行单：新建草稿（自动复制最新版本，含复核标记）→ 修改 → 发布为 v2；新演出即可选 v2，旧演出仍按 v1 回看（旧版本提示均按无需复核处理）

## 技术栈与结构

- **后端**：Node.js 内置 `node:http`（API + 静态页面），零第三方依赖
- **数据库**：SQLite（Node 内置 `node:sqlite`），关系型 schema，WAL 模式，事务 + 唯一约束保证并发一致
- **前端**：原生 HTML/CSS/JS 单页应用（hash 路由），无需构建

```
server.js            # HTTP 入口：API 分发、静态文件、统一错误处理
src/db.js            # SQLite 连接、建表初始化、事务包装、演示数据
src/validate.js      # 执行单校验：缺失引用 / 重复编号 / 自依赖 / 循环依赖
src/api.js           # 全部 REST 接口与业务规则
public/              # 前端单页应用（index.html / app.js / style.css）
Dockerfile           # node:24-slim，零依赖构建
docker-compose.yml   # 一键启动 + 数据卷
```

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/shows` | 场次列表 / 新建场次 |
| GET | `/api/shows/:id` | 场次详情（版本 + 演出记录） |
| POST | `/api/shows/:id/versions` | 新建草稿（默认复制最新版本） |
| GET | `/api/versions/:id` | 版本快照（含提示与前置） |
| PUT | `/api/versions/:id/cues` | 保存草稿（已发布返回 409） |
| POST | `/api/versions/:id/validate` | 校验（缺失引用 / 循环依赖） |
| POST | `/api/versions/:id/publish` | 发布（校验失败 422 并附问题清单） |
| POST | `/api/shows/:id/performances` | 启动演出（无已发布版本返回 400） |
| GET | `/api/performances/:id` | 执行台状态（提示状态 + 事件流水） |
| POST | `/api/performances/:id/cues/:cueId/fire` | 触发普通提示（前置未满足 422；已有结果 409；**需复核提示 422 附 `review_required:true`，不绕过复核**） |
| POST | `/api/performances/:id/cues/:cueId/skip` | 跳过（缺原因 400；已有结果 409；该提示有待处理复核申请 409） |
| POST | `/api/performances/:id/cues/:cueId/retract` | 撤回已触发（含双人复核触发；缺撤回人/原因 400；非已触发 409；下游仍已触发 409 附 `affected`；有待处理申请 409） |
| POST | `/api/performances/:id/review-requests` | 发起双人复核触发申请（body：`cue_id`、`applicant`） |
| POST | `/api/review-requests/:rid/confirm` | 另一操作人确认（body：`confirmer`；须与申请人不同；前置当前均已触发才成功并写有效触发流水） |
| POST | `/api/review-requests/:rid/cancel` | 申请人撤销待处理申请（body：`operator`，须为申请人本人） |
| POST | `/api/review-requests/:rid/reject` | 其他人填原因驳回（body：`operator`、`reason`） |

> `GET /api/performances/:id` 的响应新增 `reviews` 数组（全部复核申请及处置），每个 `cues[]` 新增 `require_review` 与 `review_request`（待处理申请，无则为 `null`），并可能出现 `status: "review_pending"`（申请处理中、尚未触发）与事件动作 `"review_fired"`（复核确认后的有效触发）。原有字段与普通提示的响应结构保持不变。
>
> 草稿接口 `PUT /api/versions/:id/cues` 中每条提示新增可选布尔字段 `require_review`（缺省 `false`），`GET /api/versions/:id` 也返回该字段。

## 撤回误触发（本轮新增）

现场误触发需要可追溯地撤回：不删除任何记录，而是追加一条 `retracted` 流水，使该提示的当前有效结果失效。

**规则**

- 仅当前有效结果为「已触发」的提示可撤回；「已跳过」与「未触发（含已撤回）」返回 409
- 请求必须携带 `operator`（撤回人）与 `reason`（原因），缺一则 400
- 若沿前置关系可达的后续提示仍存在有效「已触发」，撤回整体拒绝（409），响应 `affected` 字段列出受影响提示编号，任何记录都不改变；需自下游向上游逐级撤回
- 撤回成功后：原触发与撤回流水全部保留（执行台右侧完整展示）；该提示按当前前置结果重新显示「待执行」或「受阻」，可再次触发或跳过
- 撤回、触发、跳过在同一有效状态上判定（`BEGIN IMMEDIATE` 事务内读最新事件再写入），至多一个当前有效结果，并发冲突方收到 409 及当前结果
- 仅影响本场演出；已发布版本与其他演出不受影响

**调用示例**（假设演出 id=1，提示 id=3）：

```bash
# 1) 触发（原有能力）
curl -X POST http://localhost:3000/api/performances/1/cues/3/fire \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张三"}'
# → 200 {"event":{"id":7,"action":"fired","operator":"张三",...}}

# 2) 发现误触发，撤回
curl -X POST http://localhost:3000/api/performances/1/cues/3/retract \
  -H 'Content-Type: application/json' \
  -d '{"operator":"李四","reason":"误触发，未到cue点"}'
# → 200 {"event":{"id":9,"action":"retracted","operator":"李四","reason":"误触发，未到cue点",...}}

# 3) 若下游仍有已触发提示，撤回被拒并列出受影响编号（任何记录不变）
# → 409 {"error":"无法撤回：以下后续提示仍处于已触发状态，请先撤回：S1、B1","affected":["S1","B1"]}

# 4) 查看完整流水与提示状态（撤回后该提示回到 待执行/受阻，可再次触发或跳过）
curl http://localhost:3000/api/performances/1
# events 中同时保留 fired 与 retracted 记录；cues[].status 为 pending 或 blocked
```

## 双人复核触发（本轮新增）

用于灯光总控、大幕升降等**关键提示**：排演时在草稿中把该提示勾选为「需双人复核」，发布后标记随版本不可变地锁定；旧版本提示没有该标记，一律按无需复核处理。现场触发这类提示必须经过「申请 → 另一人确认」两步，且确认瞬间前置必须全部已触发。

**规则**

- **发起申请**：仅对发布版本中需复核、且当前无有效结果（未触发/未跳过）的提示；记录申请人与申请时间。发起后提示**不算已触发**、不产生触发流水，其下游前置检查继续受阻；前置尚未满足时也允许先申请
- **确认**：确认人必须是**申请人之外**的另一位操作人；且确认瞬间所有前置的**当前有效结果**均为已触发（普通 `fired` 或复核 `review_fired`，已撤回不算）。满足后申请置为 `confirmed` 并写入动作 `review_fired` 的有效触发流水（操作人记确认人）
- **前置失效**：确认时若有前置不再是已触发（如被撤回），返回 422 并附 `unmet`，**申请保持 `pending`**，前置恢复后可再次确认
- **撤销 / 驳回**：申请人可撤销自己的待处理申请（403 若非本人）；其他操作人可填原因驳回（申请人不能驳回自己）。申请及三种处置（确认/撤销/驳回）全部留痕，被撤销或驳回后可重新申请
- **待处理期间互斥**：同一提示拒绝重复申请（409）、拒绝跳过（409）、拒绝撤回（409），直接调用 `fire` 同样被拒（422 附 `review_required:true`）
- **并发唯一结局**：确认 / 撤销 / 驳回并发时由 `BEGIN IMMEDIATE` 事务 + 条件更新保证只有一个成功，其余收到 409；同一提示至多一条 `pending` 申请（部分唯一索引兜底）
- **确认之后**：`review_fired` 与普通触发在前置满足、下游保护、撤回规则上完全等价——可被撤回（撤回后回到待执行/受阻，流水保留），其下游仍有效触发时撤回同样被整体拒绝
- 普通提示（`require_review=false`）走原有 `fire/skip/retract`，接口路径、请求体、响应字段与执行台展示完全兼容

**执行台**：需复核提示的操作按钮为「发起复核」；页面顶部在存在待处理申请时出现「待双人复核申请」面板，可确认 / 撤销 / 驳回；提示卡显示「待复核」状态、申请人与时间；右侧流水中复核触发显示「已触发（双人复核）」。

**调用示例**（假设演出 id=1，需复核提示 B1 的 cue id=3；前置 L1=1、S1=2）：

```bash
# 0) 前置触发（普通提示，原接口不变）
curl -X POST http://localhost:3000/api/performances/1/cues/1/fire \
  -H 'Content-Type: application/json' -d '{"operator":"张三"}'
curl -X POST http://localhost:3000/api/performances/1/cues/2/fire \
  -H 'Content-Type: application/json' -d '{"operator":"张三"}'

# 1) 直接触发需复核提示 → 422，无法绕过
curl -X POST http://localhost:3000/api/performances/1/cues/3/fire \
  -H 'Content-Type: application/json' -d '{"operator":"张三"}'
# → 422 {"error":"该提示需双人复核：请先发起触发申请…","review_required":true,"review_request":null}

# 2) 申请人发起触发申请（此时 B1 仍未触发，下游继续受阻）
curl -X POST http://localhost:3000/api/performances/1/review-requests \
  -H 'Content-Type: application/json' -d '{"cue_id":3,"applicant":"张三"}'
# → 200 {"review_request":{"id":10,"status":"pending","applicant":"张三","applied_at":"…","label":"B1",…}}

# 3) 前置失效（S1 被撤回）时确认 → 422，申请保持 pending
curl -X POST http://localhost:3000/api/review-requests/10/confirm \
  -H 'Content-Type: application/json' -d '{"confirmer":"李四"}'
# → 422 {"error":"前置提示当前未全部触发，不能确认：S1；申请保持待处理","unmet":["S1"],"review_request":{…"status":"pending"}}

# 4) 前置恢复后，另一位操作人确认 → 写入有效触发流水
curl -X POST http://localhost:3000/api/review-requests/10/confirm \
  -H 'Content-Type: application/json' -d '{"confirmer":"李四"}'
# → 200 {"review_request":{"id":10,"status":"confirmed","confirmer":"李四",…},
#        "event":{"id":21,"action":"review_fired","operator":"李四",…}}

# 5) 申请人撤销（非本人 → 403）
curl -X POST http://localhost:3000/api/review-requests/11/cancel \
  -H 'Content-Type: application/json' -d '{"operator":"张三"}'
# → 200 {"review_request":{"id":11,"status":"cancelled","cancel_operator":"张三",…}}

# 6) 其他人填原因驳回（缺原因 400；申请人驳回自己 400）
curl -X POST http://localhost:3000/api/review-requests/12/reject \
  -H 'Content-Type: application/json' -d '{"operator":"王五","reason":"演员尚未到位"}'
# → 200 {"review_request":{"id":12,"status":"rejected","reject_operator":"王五","reject_reason":"演员尚未到位",…}}

# 7) 查看执行台：reviews 为全部申请（含处置结果），cues[].review_request 为待处理申请
curl http://localhost:3000/api/performances/1
# → {"performance":{…},"cues":[{…"label":"B1","status":"review_fired","require_review":true,…}],
#    "events":[{…"action":"review_fired","operator":"李四"…}],
#    "reviews":[{"id":10,"status":"confirmed","applicant":"张三","applied_at":"…","confirmer":"李四",…}]}
```

## 数据与并发说明

- `cue_events` 为**流水表**：触发 / 双人复核触发（`review_fired`）/ 跳过 / 撤回逐条追加，全量留痕；同一演出同一提示的「当前有效结果」由最新一条事件推导（`retracted` 表示已撤回、当前无有效结果），至多一个当前有效结果
- `review_requests` 为**复核申请表**：申请（申请人、时间）与确认 / 撤销 / 驳回的处置人、时间、原因全部留痕；`(performance_id, cue_id)` 上有条件唯一索引，同一提示至多一条 `pending` 申请
- 触发、跳过、撤回、复核确认均在 `BEGIN IMMEDIATE` 事务内「读最新事件 → 判定 → 写入」，并以条件更新（`… WHERE status='pending'` + `changes` 校验）收尾，并发操作串行判定；确认 / 撤销 / 驳回并发时恰好一个成功，冲突方收到 409 及当前状态
- 前置是否满足、提示状态（待执行/已触发/已跳过/受阻/待复核）均按**当前有效结果**计算：`review_fired` 与 `fired` 等价；前置被撤回后，未执行的下游提示重新变为受阻，待确认的复核申请也会因前置失效而无法确认（保持待处理）
- 旧版数据库启动时自动迁移：`cues` 补 `require_review` 列（既有提示默认 `0`，即旧版本按无需复核处理），`cue_events` 约束扩展支持 `review_fired`，并新建 `review_requests` 表；全部历史记录保留，无需手工操作
- 演出与版本通过外键绑定，版本发布后无更新入口，因此历史回看永远呈现演出当时的执行单内容（含当时锁定的复核标记）
