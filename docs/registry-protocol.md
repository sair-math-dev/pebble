# 注册发布协议实施契约

本文件记录本轮实现采用的 HTTP / 客户端契约；功能完成状态以代码和测试为准。
后续架构修订：用户已明确研究仓库完整基于 Git；本文件仍记录已实现的快照接口，尚未迁移为从精确 commit 派生的统一发布入口。Git 来源锁定、受保护发布引用与全局定理绑定以 [定理图设计](theorem-index.md#git-来源版本与图规模) 为约束；下列端点不能被描述为已有 Git 托管能力。
用户已明确要求面向公网服务及部署交付。本轮采用 PostgreSQL，发布、权限变更、
审核、撤回及任务回传使用同一事务协议；本地测试同样运行实际 PostgreSQL。
交付还包括容器、HTTPS、密钥、持久化、备份恢复、健康检查及升级回滚。

## 固定输入

JSON 规范编码：对象键仅允许协议固定的 ASCII 字段，按字典序排序，UTF-8，
无多余空白；数值仅非负安全整数；数组按下述顺序，字符串不改变 Unicode 内容。
`snapshot_digest = SHA256("Pebble.PackageSnapshot.v1\0" + canonical(snapshot))`。
snapshot 不含自身摘要，不含任何验证或发布结果。

```text
snapshot = {
  schema: "Pebble.PackageSnapshot.v1",
  package_id: UUID, version: "0.1.0",
  toolchain_digest: hex SHA256,
  dependencies: [{package_id, version, snapshot_digest}],  // 直接依赖，按 package_id 排序
  files: [{path, byte_length, sha256}],                   // 全部源码/附件，按 ASCII path 排序
  research: {
    title, summary, license, authors: [string], formalizers: [string],
    maintainers: [string], kind: "formalization" | "original",
    claims, assumptions, citations: [string], usage
  }
}
```

文件允许可移植 ASCII 相对路径，不接纳链接/缓存/对象；路径不能碰撞。
全部 `.slate` 必须检查，附件仅接纳明确的研究说明 `.md` / `.txt`；元数据审核
另检查源码分类，程序不能通过改后缀获得形式化接受。客户端自己的 `slate.toml`
与 `slate.lock` 是单独的包意图/锁定协议对象，不递归进入 `files`；除此之外没有
ignore 源码的机制，隐藏文件同样枚举。首轮拒绝任意构建脚本和外部证据输入。

外部依赖精确引用已发布版本；服务和客户端沿每份 snapshot 的直接依赖取得全图，
拒绝环、同 package_id 不同版本/摘要、错误来源、撤回或验证撤销的新选择。
最终 ModuleId 冲突由 Slate 完整检查器确认。更换传递依赖不能沿用旧快照。

## HTTP

除公开读取与下述邀请兑换外需要 `Authorization: Bearer TOKEN`。其他写请求都需要
`Idempotency-Key`；作用域是 principal + 方法 + 资源路径。服务器先复查当前权限，
再返回同请求的保存响应；同键不同请求体返回 409。错误为 `{error: code, message}`。

| 方法 / 路径 | 输入 / 输出 |
| --- | --- |
| GET `/api/v1/meta` | `{registry_id, registration:"invitation_only", toolchain_digest, toolchain, policy_digest}` |
| POST `/api/v1/invitations/redeem` | `{invitation_code, token}` → 200 `{id,name}`；无需已有 Bearer 或 Idempotency-Key，按下述凭据重试 |
| POST `/api/v1/packages` | `{name}` → `{id, name, visibility:"private"}` |
| GET `/api/v1/packages/:id` | 当前权限下的包资料 |
| PUT `/api/v1/packages/:id/members/:principal` | `{role:"viewer"|"maintainer"}`，owner 管理 |
| DELETE `/api/v1/packages/:id/members/:principal` | 撤销成员读取和操作权 |
| PUT `/api/v1/packages/:id/visibility` | `{visibility:"private"|"public"}`，显式公开/收回 |
| POST `/api/v1/packages/:id/snapshots` | `{snapshot, blobs:[{sha256, content_base64}]}` → `{snapshot_digest}` |
| GET `/api/v1/packages/:id/snapshots/:digest` | `{snapshot, blobs:[...]}`；每次授权完整依赖图 |
| POST `/api/v1/packages/:id/candidates` | `{snapshot_digest}` → 202 `{id, revision, status}` |
| GET `/api/v1/candidates/:id` | 候选、修订、检查状态和诊断 |
| POST `/api/v1/candidates/:id/retry` | 创建新检查尝试，输入不变 |
| POST `/api/v1/candidates/:id/review` | `{approved, note, source_classification_confirmed}`；审核研究说明和文件分类 |
| POST `/api/v1/candidates/:id/publish` | `If-Match: "revision"`，body `{}` → 正式版本记录 |
| GET `/api/v1/packages/:id/versions?limit=50&cursor=...` | `{versions:[...],next_cursor}`；limit 1–100，完整依赖权限过滤先于分页 |
| GET `/api/v1/packages/:id/versions/:version` | 精确版本，保留撤回/撤销状态和引用路径 |
| POST `/api/v1/packages/:id/versions/:version/withdrawals` | `{reason}`，附加撤回状态 |
| POST `/api/v1/packages/:id/versions/:version/revocations` | `{reason}`，附加验证撤销状态 |

上传不自动检查、发布或公开。候选输入不可变；状态变化提升 revision。
发布事务重新检查调用者权限、候选修订、快照、完整验证、审核、当前政策与工具链、
全依赖状态和版本唯一性，同时写 release 和 outbox。公开包不能发布依赖私有材料
的版本。下载、索引和引用读取不因已知摘要或旧权限而跳过当前授权。

## 邀请兑换

邀请码仅由运维 `invite --name NAME [--expires-in-hours HOURS]` 签发，默认 168 小时，允许 1–720 小时；名称绑定一个尚未存在的账户。随机码包含 32 bytes 随机性，编码为 43 字符 base64url。数据库仅保存码的 SHA256；`revoke-invite --id UUID` 使未兑换邀请失效，已兑换账户的撤销使用独立账户操作。没有 HTTP 邀请签发或普通注册端点；邀请码的持有者可兑换绑定账户，它不等于已核实的学术身份。

客户端先生成并私有持久保存 32 bytes 随机登录 token（64 字符小写 hex），再通过请求体兑换；服务端只存 token hash，不回显秘密。同一码与同一当前有效 token 重试返回相同账户；其他 token 重放、未兑换码过期/撤销或未知码返回 410 `invalid_invitation`。已有同名账户或 token 冲突返回 409，不覆盖账户，也不消费邀请。账户 token 轮换/撤销后，旧兑换请求不能恢复它。邀请码消费和账户创建在同一 SERIALIZABLE 事务完成，重试响应不写入含秘密的通用幂等表。

兑换请求体最多 1 KiB；每 API 进程单 IP 每分钟 5 次，查询字符串不产生新额度。只允许标准兑换路径，拒绝经 dot-segment 归一化落到该路径的通用 API 请求。码/token 不放 URL、命令行参数或日志。已提供 [邀请客户端](../deployment/accept-invite.mjs)，支持 HTTPS 和本机 HTTP，拒绝重定向；凭据文件先同步到磁盘再发送，重复执行复用相同秘密。迁移 002 必须由运维执行，新服务在旧 schema 上拒绝启动。

## Slate 客户端

`tools/slate` Rust crate 提供 `slate` 二进制，责任为包意图、精确版本选择、锁图、
源码下载及本地检查；Pebble 不提供竞争 resolver。

`slate.toml` 使用 `[package] id, version`、`[registry] url`、上述 `[research]`，
`[dependencies.ALIAS] package_id, version`；首轮 version 是明确的完整版本，范围
暂不支持。`slate.lock` 是生成的 JSON，绑定 registry_id/url、toolchain_digest、
作者清单实际 bytes 摘要和完整 dependency nodes；不包含根包 snapshot digest。

命令：`slate lock --manifest PATH` 获取精确闭包；`slate fetch --manifest PATH [--offline]`
按锁下载；`slate check --manifest PATH --slatec PATH [--offline]` 在新目录物化并真实检查；
`slate package --manifest PATH --output FILE` 生成 `{snapshot,blobs}`；
`slate publish --manifest PATH` 上传并创建候选，查询、审核和正式 publish 是明确动作。
所有需要已有锁的操作不隐式重解析；`PEBBLE_TOKEN` 提供凭据，不进清单或锁。

## 受控检查

服务只接受源码和检查请求，没有上传“通过报告”的公共端点。协调器用租约和
attempt token 领取任务；只有当前未过期尝试可写结果。源包、依赖、固定工具链和
政策构成实际验证输入。超时和基础设施失败保持未解决，可以重试，旧回传不能覆盖。

工具链由实际二进制及动态运行库复制成固定根文件系统并计算描述符摘要；运行时
仅只读挂载该根和本任务源码，无网络、无服务数据目录和凭据，使用私有临时目录。
报告经受控输出管道收集，逐文件核对实际输入和 Slate 明确形式化检查字段。
Slate 数学状态、形式化检查资格、平台完整 gate 和正式发布是不同字段。

## 资源边界

当前按小型源码包运行：每包 32 MiB/4,096 文件、服务端依赖闭包 256 MiB/16,384 文件/1,024 包；先按元数据检查完整闭包预算，再顺序取得对象。HTTP JSON 体最多 48 MiB。S3 单次操作有超时，下载体独立限制字节和读取时间；检查本身默认 30 秒、2 GiB 地址空间和 32 MiB 输出，超限不产生通过结果。

API 在解析请求体前限制每进程总并发 64、包含大源码或报告的请求并发 2；饱和返回 503 与 Retry-After。单 IP 本地限读 180 次/分钟、写 30 次/分钟，真实代理网段仅通过显式 `TRUST_PROXY_CIDRS` 信任。数据库以同一入队规则限制本次请求者最多 4 个待处理任务、全局 1,024 个，创建与重试均复查。每进程限制不宣称为跨副本账户限流；健康端点不占业务额度。

更大对象的流式上传/下载、续传和授权 CDN 是后续协议演进，尚无对应 HTTP 端点。当前客户端实际使用上述有界 bundle 接口。容量假设、局部测量与生产部署条件见 [capacity.md](capacity.md) 和 [deployment.md](deployment.md)。
