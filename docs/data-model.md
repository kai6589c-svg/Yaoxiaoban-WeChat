# 数据模型

本文描述 beta.5 当前代码使用的服务端集合、客户端 DTO 和关键业务字段。所有服务端集合使用 `yxb_` 前缀；集合、客户端规则和索引以 [`cloudbase-database-manifest.json`](cloudbase-database-manifest.json) 为唯一配置清单。

## 设计原则

- 账号边界由云函数从可信微信运行上下文取得 `OPENID` 后计算 `accountId`，客户端不能提供或覆盖身份字段。
- 除账号映射和删除墓碑外，业务文档都带 `accountId`；所有读取、更新、删除均带所有权条件。
- 写请求带稳定 `requestId`，更新带 `expectedVersion`；重试返回同一业务结果，过期版本返回冲突而不是覆盖其他设备的修改。
- 客户端不直连数据库。`yxb_*` 集合的客户端 `read` / `write` 都必须为 `false`，只有 `medicine-api` 云函数访问业务数据。
- 业务数据使用服务端字段名持久化，兼容入口再转换为小程序 DTO；服务端不会把内部 `OPENID`、原始 `accountId` 或云存储内部路径放进公开响应。

## 集合清单

当前清单包含 12 个集合、23 个复合索引。

| 集合                   | 作用                                           | 关键字段                                                                                                                                             |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yxb_accounts`         | 服务端身份映射、账号状态和版本                 | `_id`, `openid`, `status`, `version`, `createdAt`, `updatedAt`                                                                                       |
| `yxb_profiles`         | 本人或已获授权的家庭成员档案                   | `accountId`, `displayName`, `relation`, `color`, `archivedAt`, `version`                                                                             |
| `yxb_medications`      | 用户确认的药盒记录                             | `accountId`, `profileId`, `name`, `unit`, `expiry`, `openedOn`, `afterOpenDays`, `photo`, `status`, `activePlanId`, `version`                        |
| `yxb_plans`            | 不覆盖历史的固定 / 按需计划版本                | `accountId`, `medicationId`, `kind`, `dose`, `unit`, `times`, `weekdays`, `startDate`, `endDate`, `effectiveFrom`, `supersededAt`, `revision`        |
| `yxb_snapshots`        | 用户手动确认的库存盘点基线                     | `accountId`, `medicationId`, `quantity`, `unit`, `capturedAt`, `source`, `version`                                                                   |
| `yxb_intake_logs`      | 已服、未服、额外使用和撤销记录                 | `accountId`, `medicationId`, `planId`, `scheduledAt`, `occurrenceKey`, `status`, `quantity`, `occurredAt`, `undoneAt`, `version`                     |
| `yxb_settings`         | 隐私同意、风险阈值和提醒 / 日历偏好            | `accountId`, `privacyAcceptedVersion`, `privacyAcceptedAt`, `expiryLeadDays`, `shortageLeadDays`, `privateCalendarTitle`, `subscriptions`, `version` |
| `yxb_calendar_exports` | 系统日历逐事件写入账本                         | `accountId`, `medicationId`, `planId`, `fingerprint`, `eventTitle`, `exportedAt`, `staleAt`, `version`                                               |
| `yxb_idempotency`      | 写请求幂等结果和过期时间                       | `accountId`, `action`, `requestId`, `requestHash`, `state`, `response`, `expiresAt`                                                                  |
| `yxb_reminder_tasks`   | 到期 / 预计不足的低频订阅任务                  | `accountId`, `kind`, `medicationId`, `dueAt`, `status`, `leaseUntil`, `nextAttemptAt`, `attempts`                                                    |
| `yxb_media`            | 药盒照片上传任务、校验结果、绑定和延迟清理账本 | `accountId`, `medicationId`, `kind`, `cloudPath`, `fileId`, `status`, `byteSize`, `mimeType`, `width`, `height`, `expiresAt`, `version`              |
| `yxb_deletion_jobs`    | 账号删除任务墓碑；不保存可逆身份               | `ownerHash`, `accountIdHash`, `requestIdHash`, `state`, `expiresAt`, `completedAt`                                                                   |

`yxb_accounts.openid` 只由服务端使用，不能出现在导出结果、响应 DTO 或业务日志。`yxb_deletion_jobs` 只保存不可逆 hash，便于删除请求重试而不留下原始身份。

## 药盒与照片字段

小程序使用的药盒 DTO 是稳定的、面向页面的结构：

```ts
{
  id: string;
  profileId: string;
  name: string;
  specification: string;
  storageLocation?: string; // 去空格后最多 30 字，旧数据可缺省
  unit: string;
  mode: "expiry_only" | "scheduled" | "as_needed";
  expiryPrecision: "day" | "month";
  expiryValue: string;
  openedDate: string | null;
  afterOpenDays: number | null;
  note: string;
  photo: {
    mediaId: string;
    fileId: string;
    updatedAt: string;
  } | null;
  archivedAt: string | null;
  version: number;
}
```

照片字段只是一条经过服务端校验的引用，不是客户端可以任意写入的 URL。添加照片的写入顺序是：

```text
prepareMedicationPhoto
  → 生成账号隔离的 cloudPath 和 24 小时票据，media.status = prepared
  → 客户端调用 wx.cloud.uploadFile 上传
  → commitMedicationPhoto 校验完整 fileId、大小、格式和尺寸
  → media.status = validated
  → medication.photo 绑定 mediaId + fileId
  → media.status = attached（收尾失败可由后续 prepare 对账）
```

当前照片约束为：客户端压缩目标边长约 1280px、质量约 72，文件不超过 2 MiB；服务端还拒绝无法确认完整性的 JPG / PNG / WebP、超过 6000px 的单边或超过 20 MP 的图片。`cloudPath` 由服务端根据账号 hash 与媒体 ID 确定，提交的 `fileId` 必须与完整路径精确相等，不能用路径前缀、后缀、查询串、片段或路径穿越绕过校验。

媒体状态及含义：

| 状态              | 含义                                         | 后续处理                             |
| ----------------- | -------------------------------------------- | ------------------------------------ |
| `prepared`        | 已发上传票据，尚未确认有效文件               | 票据过期或取消时删除对象和账本       |
| `validated`       | 文件已通过服务端检查，但药盒引用尚未可靠收尾 | 下次照片操作会核对引用；无引用则清理 |
| `attached`        | 药盒已引用此媒体                             | 更换、移除、删除药盒或账号时进入清理 |
| `cleanup_pending` | 已进入删除流程，等待对象和账本收尾           | 可重试；清理失败不把媒体伪装成已删除 |

客户端取消上传、上传失败、版本冲突或保存失败时会尽力调用 discard；云端清理失败则保留 `cleanup_pending` 账本供后续重试。用户关闭小程序或网络在上传后、commit 前中断时，服务端无法知道客户端意图，过期媒体由后续媒体操作清理；上线前仍需在真实 CloudBase 与真机验证清理 SLA。

导出 JSON 不携带原始图片、`fileId`、`mediaId`、`cloudPath` 或本地缓存路径。若药盒曾有照片，导出只给出照片存在但文件未包含在文本导出中的说明。

## 计划与记录

计划版本不可覆盖：编辑固定计划会创建新版本，并将旧版本写入 `supersededAt`；旧版本仍用于解释已经发生的历史任务。计划的有效时间满足：

```text
effectiveFrom <= scheduledAt < effectiveTo
```

兼容接口当前支持：

- `daily`：按每天的指定时间展开；
- `weekdays` / 客户端 `weekly`：只在选中的 1–7 星期展开；
- `prn` / 客户端 `as_needed`：按需使用，不生成固定服药任务和自动预计用完日期。

固定计划每次用量与药盒库存单位必须一致。客户端界面最多提供 6 个提醒时间；服务端 schema 允许的上限为 12，以便兼容已有数据和未来页面能力，页面不会无提示地生成超过界面上限的时间。

`yxb_intake_logs.status` 的语义为：

- `taken`：用户确认该计划槽位已服，计划消耗不会再额外重复扣一次；
- `skipped`：用户确认该计划槽位未服，对应计划消耗从预计值中排除；
- `extra`：计划之外的用户确认使用，按记录数量单独扣减；
- `undoneAt` 非空：撤销该记录，计算恢复到没有这条有效记录的语义。

计划服药记录服务端只允许在计划时间到达前最多 10 分钟内写入；记录时间也不能明显晚于当前时间。所有日志保留版本和 requestId，便于重试与撤销。

## 数量与时间

- 小程序使用千分之一整数表示数量（例如 `1.25 片 = 1250`）；服务端通过整数上限和单位校验，避免浮点超精度。
- 不自动换算“盒、片、毫升”等单位；盘点、固定计划和额外使用必须使用同一单位，未选择单位时不能保存库存或剂量。
- 数据库存 UTC ISO 8601 字符串或 Unix 毫秒；业务日期固定按 `Asia/Shanghai`（UTC+8、无夏令时）解释。
- 月精度有效期保存 `YYYY-MM` 原值；风险、任务和库存计算临时使用当月最后一天，界面不把它伪装为具体日精度。
- 包装有效期与开封后期限取较早者；开封日期当天计为第 1 天。到期当天仍有效，下一个本地日才是 expired。

## 索引与清单校验

manifest 中的 23 个索引覆盖：

- 所有带 `accountId` 的业务集合按 `accountId ASC, _id ASC` 分页；
- 药盒按成员、状态以及成员 + 状态筛选；
- 计划、盘点、服药记录按药盒分页；
- 日历按 `fingerprint` 去重，并按药盒标记未失效记录为 stale；
- 提醒任务按药盒状态、到期时间和租约恢复时间领取；
- 媒体按账号、药盒和状态定位待清理对象。

幂等、账号和删除墓碑用确定性 `_id` 保证单键唯一，不依赖额外唯一索引。执行 `npm run verify:cloudbase-manifest` 可校验集合、索引、物理命名和客户端禁读写规则没有与仓库常量漂移；它不能代替在实际 CloudBase 控制台回读权限、索引可用状态和两账号隔离。

## beta.19 存放位置与本机盘点会话

`storageLocation` 是药盒可选字段。普通/快速兼容 RPC 与旧接口均支持；未传字段保留现值，明确传空字符串清除。本机模式、药箱搜索/筛选、详情和文字导出使用同一字段。无需数据库索引或历史迁移。

集中盘点进度保存在 `yaoxiaoban_inventory_session:<scope>`，云端使用账号同步范围，本机演示使用独立 `local-demo` 范围。步骤保存药盒 ID、输入、预期版本/单位及 draft/pending/done/skipped 状态。提交前持久化固定 requestId 和 recordedAt；响应未知时锁定输入并用原请求重试，确认后才标记 done。草稿不会自动上传；清除会话不会删除正式快照。删除账号同时清除该范围本机进度。

照片队列新增可选 failureCode/failureStage，保持旧任务兼容。重新选图前先核对旧票据、药盒版本并结束旧上传；替换任务使用新请求 ID 和票据，保留已确认的药盒 ID，不再次保存药盒字段或初始库存。
