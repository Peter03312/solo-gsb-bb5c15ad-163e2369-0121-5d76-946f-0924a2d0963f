# 舞台监督提示单系统（Stage Cue Manager）

供舞台监督在**排演**与**现场执行**中使用的 Web 应用：录入场次与执行单（灯光 / 音效 / 布景提示及其前置提示），校验后发布不可变执行单；每场演出从某一已发布版本启动独立记录，现场按依赖关系触发或跳过提示，全程留痕。

## 功能

- **场次与执行单管理**：按序编排提示（编号、类型、描述、前置提示）
- **发布前校验**：缺失引用（前置编号不存在）、编号重复、自依赖、循环依赖（给出环路径）
- **不可变执行单**：发布后内容锁定；修改须新建草稿再发布新版本
- **现场执行台**：实时展示 待执行 / 已触发 / 已跳过 / 受阻（前置未触发） 四种状态
  - 仅当前置全部**已触发**时才可触发；受阻项触发按钮禁用且服务端同样拒绝
  - 跳过必须填写原因；每次结果留存操作人与时间
  - **双人复核触发**：草稿中可将个别提示标记为「需双人复核」（发布后随版本锁定，旧版本提示按无需复核处理）。现场对这类提示发起的是**触发申请**（记录申请人与时间），提示仍不算已触发、下游前置仍受阻；须**另一操作人确认**且前置当前均已触发后，才写入有效触发流水。申请人可撤销待处理申请，其他人可填原因驳回，申请与处置全程留痕；待处理期间拒绝跳过、重复申请和撤回
  - **撤回误触发**：对当前「已触发」的提示可撤回（须填撤回人与原因）；若其下游（沿前置关系可达的后续提示）仍有有效「已触发」，则整体拒绝并列出受影响编号，任何记录都不改变。撤回后原触发与撤回流水全部保留，提示按当前前置结果回到「待执行 / 受阻」，可再次触发或跳过；已跳过与未触发的提示不可撤回
  - 多人并发操作同一提示只记一次有效结果，冲突方会收到当前状态提示；复核的确认与撤销 / 驳回并发时也只有一种结局
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
2. 在草稿编辑器中按序录入提示，前置提示填编号（逗号分隔）；危险或关键提示勾选「复核」列；随时「校验」
3. 「校验并发布」→ 生成不可变执行单（如 v1），复核标记随版本锁定
4. 回到场次页「启动演出」，选择已发布版本 → 进入执行台
5. 执行台中填写操作人，对提示执行「触发 / 跳过」；需复核提示点「申请触发」后在右侧「复核申请」面板由**另一操作人**确认（前置未齐会被拒并保持待复核），申请人可撤销、其他人可填原因驳回；误触发可点「撤回」并填写撤回人与原因；页面每 2.5 秒自动刷新，多人可同时操作；右侧展示复核申请处置记录与完整执行流水（含撤回记录）
6. 排演中要改执行单：新建草稿（自动复制最新版本，含复核标记）→ 修改 → 发布为 v2；新演出即可选 v2，旧演出仍按 v1 回看

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
| GET | `/api/performances/:id` | 执行台状态（提示状态 + 事件流水 + 复核申请；各提示附 `needs_review` 与 `pending_request`） |
| POST | `/api/performances/:id/cues/:cueId/fire` | 触发（前置未满足 422；已有结果 409 附当前状态）。**需复核提示调用本接口不会直接触发**，而是登记复核申请并返回 `{ request }`；普通提示响应保持 `{ event }` |
| POST | `/api/performances/:id/cues/:cueId/skip` | 跳过（缺原因 400；已有结果 409；待复核期间 409） |
| POST | `/api/performances/:id/cues/:cueId/retract` | 撤回已触发（缺撤回人/原因 400；非已触发 409；下游仍已触发 409 附 `affected` 编号列表；待复核期间 409） |
| POST | `/api/performances/:id/cues/:cueId/review-requests` | 登记触发申请（仅需复核提示可用，普通提示 400；重复申请 409） |
| POST | `/api/performances/:id/review-requests/:reqId/confirm` | 确认申请（确认人须与申请人不同 409；前置未触发 422 且申请保持待复核；已处置 409） |
| POST | `/api/performances/:id/review-requests/:reqId/cancel` | 撤销申请（仅申请人本人，否则 409；已处置 409） |
| POST | `/api/performances/:id/review-requests/:reqId/reject` | 驳回申请（缺原因 400；申请人请走撤销 409；已处置 409） |

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

排演时在草稿编辑器勾选提示的「复核」列（`needs_review`），发布后标记随版本锁定；旧版本提示一律按无需复核处理。现场对这类提示的触发改为**申请—确认**两步：

**规则**

- 对需复核提示调用 `fire`（或 `POST .../review-requests`）只登记**触发申请**：记录申请人与时间，提示**不算已触发**，下游前置仍受阻；普通提示 `fire` 行为与响应（`{ event }`）不变，直接调用既有触发接口无法绕过复核
- **确认**：须由申请人之外的另一操作人执行，且前置当前均已触发才写入有效 `fired` 流水（事件关联申请）；前置失效（未触发或已撤回）时确认返回 422，**申请保持待复核**，前置恢复后可再次确认
- **撤销 / 驳回**：申请人本人可撤销待处理申请；其他人可填原因驳回（申请人驳回返回 409，请走撤销）；申请与处置（处置人、时间、原因）全部留痕
- **待处理期间**：该提示拒绝跳过、重复申请和撤回（均 409）；确认与撤销 / 驳回在事务内串行判定，并发只有一种结局，后到者收到 409 及当前处置结果
- 已确认（已触发）的提示与普通提示一样受现有撤回及下游保护；撤回后可重新申请
- 执行台右侧展示待复核申请（确认 / 驳回 / 撤销按钮）与处置记录，提示卡片上标注「双人复核」与待复核状态

**调用示例**（假设演出 id=1，需复核提示 id=6，申请 id=2）：

```bash
# 1) 申请人发起触发申请（对需复核提示调 fire 自动转为登记申请，不会直接触发）
curl -X POST http://localhost:3000/api/performances/1/cues/6/fire \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张三"}'
# → 200 {"request":{"id":2,"status":"pending","requested_by":"张三","requested_at":"...",...}}
#    提示仍未触发，下游前置仍受阻；重复申请 / 跳过 / 撤回该提示均 409

# 2) 另一操作人确认：前置未全部触发时拒绝，申请保持待复核
curl -X POST http://localhost:3000/api/performances/1/review-requests/2/confirm \
  -H 'Content-Type: application/json' \
  -d '{"operator":"李四"}'
# → 422 {"error":"前置提示未触发，无法确认：B1、L2","unmet":["B1","L2"],...}
#    申请人自己确认 → 409「复核确认人不能与申请人相同」

# 3) 前置全部触发后再次确认 → 写入有效触发流水
# → 200 {"request":{"status":"confirmed","event_id":12,...},"event":{"action":"fired","operator":"李四",...}}

# 4) 申请人撤销待处理申请（非申请人撤销 409）
curl -X POST http://localhost:3000/api/performances/1/review-requests/2/cancel \
  -H 'Content-Type: application/json' \
  -d '{"operator":"张三"}'

# 5) 其他人填原因驳回（缺原因 400；申请人驳回 409，请走撤销）
curl -X POST http://localhost:3000/api/performances/1/review-requests/2/reject \
  -H 'Content-Type: application/json' \
  -d '{"operator":"李四","reason":"时机不对"}'

# 6) 执行台状态含复核申请流水与每提示的待复核申请
curl http://localhost:3000/api/performances/1
# review_requests：全部申请及处置留痕（最新在上）
# cues[].needs_review / cues[].pending_request：复核标记与当前待复核申请
```

## 数据与并发说明

- `cue_events` 为**流水表**：触发 / 跳过 / 撤回逐条追加，全量留痕；同一演出同一提示的「当前有效结果」由最新一条事件推导（`retracted` 表示已撤回、当前无有效结果），至多一个当前有效结果
- `cue_review_requests` 为**复核申请表**：申请（申请人、时间）与处置（确认 / 撤销 / 驳回、处置人、时间、原因、关联的触发流水 `event_id`）全量留痕；`pending → confirmed / cancelled / rejected` 为终态迁移，同一提示至多一条待复核申请
- 触发、跳过、撤回与复核申请的处理均在 `BEGIN IMMEDIATE` 事务内「读最新事件 / 申请 → 判定 → 写入」，并发操作串行判定，后到的冲突请求收到 409 及当前结果（操作人、时间、原因）
- 前置是否满足、提示状态（待执行/已触发/已跳过/受阻）均按**当前有效结果**计算：前置被撤回后，未执行的下游提示重新变为受阻；复核确认时同样按当前有效结果判定，前置失效则确认拒绝且申请保持待复核
- 旧版数据库启动时自动迁移：`cue_events` 唯一约束表重建为流水表、`cues` 补 `needs_review` 列（既有提示默认 0，按无需复核处理），全部历史记录保留，无需手工操作
- 演出与版本通过外键绑定，版本发布后无更新入口（含 `needs_review` 标记），因此历史回看永远呈现演出当时的执行单内容
