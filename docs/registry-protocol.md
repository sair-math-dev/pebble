# 注册发布协议实施契约

本文件记录 Pebble 当前实现的 HTTP、索引与 worker 契约；功能完成状态以代码和测试为准。协议本身由 Slate 仓库的 ADR-0188、SPEC-0227 与 SPEC-0226 §2/§5/§6 规定并已由 `slate` 客户端实现，Pebble 是它的服务端。此前以 UUID 与 `Pebble.PackageSnapshot` 为中心的快照接口已经移除，迁移 003 替换了对应表；本文不再描述它。Git 来源锁定与全局定理绑定仍以 [定理图设计](theorem-index.md#git-来源版本与图规模) 为约束，下列端点不能被描述为已有 Git 托管能力。

## 1. 三个公开根

| 根 | 生产默认值 | 环境变量 | 内容 |
| --- | --- | --- | --- |
| index | `https://index.verifiable.ai/` | `PEBBLE_INDEX_ROOT` | 稀疏索引：`config.json` 与每包一个文件 |
| static | `https://static.verifiable.ai/packages/{package}/{version}/{package}-{version}` | `PEBBLE_DL_TEMPLATE` | 不可变归档与工具链 |
| api | `https://slate.verifiable.ai/api/v1` | `PEBBLE_API_ROOT` | 写接口与只读查询 |

`config.json` 由服务在迁移和 `reindex` 时从上述变量生成：`{"dl": DL_TEMPLATE, "api": API_ROOT}`。客户端只接受 `https://`、`file:///`、`http://127.0.0.1` 和 `http://localhost` 作为索引根；本地联调与端到端测试把三个变量都指向同一个 API 进程的 `http://127.0.0.1:<port>/index/`、`.../static/...`、`.../api/v1`。

同一个 API 进程还只读地服务 `GET /index/*` 与 `GET /static/*`：直接从对象存储 `public/` 树读取，缺失返回 404，索引响应 `Cache-Control: no-cache`，静态响应 `public, max-age=31536000, immutable`。生产 Caddy 把三个主机分别改写到这两个前缀和 `/api/v1/`；也可以让 CDN 直接读取 `public/` 前缀，语义相同。

对象存储键固定为：

```text
staging/<name>/<version>/<cksum>.slatepkg           私有，候选上传的内容寻址副本
staging/<name>/<version>/<iface_cksum>.interface    私有
public/index/config.json
public/index/<cargo 路径>                            1/a、2/ab、3/a/abc、ab/cd/name
public/packages/<name>/<version>/<name>-<version>.slatepkg
public/packages/<name>/<version>/<name>-<version>.interface
public/toolchains/<tag>/<arch>-<os>/{slatec,slatec.sha256,TOOLCHAIN.lock}
```

`public/` 下的对象一律以 `If-None-Match: *` 写入，不覆盖、不删除。索引文件是从数据库派生的，每次变化在 `pg_advisory_lock('index:<name>')` 下整文件重写；`reindex` 运维命令可以从数据库重建全部索引与 `config.json`。

## 2. 名称、版本、前缀与索引行

包名 `^[a-z][a-z0-9_-]{0,63}$`，版本是无预发布后缀的 semver（预发布版本拒绝发布），前缀 `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$`，工具链标签 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。依赖需求是 cargo 语法（`^`、`~`、比较符、逗号合取），单独的 `*` 拒绝。

索引行是一行 JSON，字段顺序与客户端一致：

```json
{"name":"base","vers":"0.1.0","deps":[{"name":"core","req":"^1.2"}],"cksum":"<sha256 of .slatepkg>","iface_cksum":"<sha256 of .interface>","yanked":false,"prefixes":["Acme.Base"],"toolchain":"1.95.0"}
```

只有 `visibility='public'` 的包写入索引；设为 private 时其索引文件被重写为空文件，归档保留。

命名空间前缀的所有权在首次正式发布时确定：一个前缀归一个包；与已有前缀相互包含（`Acme` 与 `Acme.Base`）即冲突（409 `prefix_conflict`），没有仲裁。子前缀只能由持有包含前缀的包所有者通过 `POST /api/v1/prefixes/yield` 明确让出。`Std.`、`Math.`、`Slate.` 保留给维护者组织（非维护者 403 `prefix_reserved`）；编译器本身也拒绝 `Std.` 下的源码理论。worker 另外要求包内每个模块与理论的标识都落在声明的前缀之下（`ModuleOutsideDeclaredPrefixes`）。候选入队时按当前所有权预检，正式发布事务再复检一次；先发布者获得前缀，后到的候选被标为 `rejected` 并记录 `PrefixConflictAtPublication`。

## 3. HTTP

除 `GET /api/v1/meta`、邀请兑换与 `/index/*`、`/static/*` 外都需要 `Authorization: Bearer TOKEN`；客户端从 `SLATE_TOKEN` 读取它。`Idempotency-Key` 是可选的：客户端的 `publish` 不发送它（重复上传由相同 `cksum`/`iface_cksum` 的未终结候选去重，返回 200 与既有候选），带该头的写请求按 principal + 方法 + 路径保存响应，同键不同请求体 409。错误统一为 `{error, message}`。

| 方法 / 路径 | 输入 → 输出 |
| --- | --- |
| GET `/api/v1/meta` | `{registry_id, registration:"invitation_only", toolchain, toolchain_digest, policy_digest, index, dl, api}` |
| POST `/api/v1/invitations/redeem` | `{invitation_code, token}` → 200 `{id,name}`；见 [邀请兑换](#5-邀请兑换) |
| PUT `/api/v1/packages/new` | 客户端发布体（见下）→ 202 `{status:"candidate", id, name, version, level, revision, state:"queued", review_required}`；相同内容重复上传 200 |
| POST `/api/v1/packages` | `{name, visibility?}` → 201 `{name, visibility}`；仅预留名字，使前缀可以让给它 |
| POST `/api/v1/prefixes/yield` | `{prefix, to}` → `{prefix, package}`；调用者须拥有包含该前缀的包 |
| GET `/api/v1/packages/{name}` | `{name, owner, visibility, namespace_prefixes, versions:[{version, cksum, iface_cksum, deps, prefixes, toolchain, yanked, published_at}]}`；私有包需读取权限 |
| PUT `/api/v1/packages/{name}/visibility` | `{visibility:"public"\|"private"}`；提交后重写索引 |
| PUT / DELETE `/api/v1/packages/{name}/members/{principal}` | `{role:"viewer"\|"maintainer"}` / 撤销；owner 管理 |
| DELETE `/api/v1/packages/{name}/{version}/yank` | 空体 → `{name, version, yanked:true}`；索引行 `yanked` 改写，文件保留 |
| PUT `/api/v1/packages/{name}/{version}/unyank` | 空体 → `{..., yanked:false}` |
| GET `/api/v1/reviews/pending` | `{candidates:[...]}`：公开包中等待社区审核的候选，最多 100 |
| GET `/api/v1/candidates/{id}` | 候选状态、修订、`verification:{outcome, computed_level, diagnostic}`、`review` |
| POST `/api/v1/candidates/{id}/retry` | 仅 `error`/`timeout`/`incomplete` 可重试，同一输入新建尝试 |
| POST `/api/v1/candidates/{id}/review` | `{approved:boolean, note}`；发布者不能审核自己（403 `self_review`），批准即发布 |

发布体与客户端 `slate publish` 逐字段一致：

```json
{"name","version","level":"patch|minor|major","prefixes":[...],"toolchain":"1.95.0",
 "deps":[{"name","req"}],"cksum","iface_cksum","snapshot_base64","interface_base64"}
```

服务在事务外完成校验：两份 base64 解码后 SHA256 必须等于 `cksum`/`iface_cksum`；`.slatepkg` 是 gzip tar，含 `Slate.toml` 与源码文件（可移植相对路径，总量 32 MiB / 4,096 文件）；`.interface` 是 gzip tar，含 `interface` 与 `objects/<ModuleId>/<hash>.slateobj|.slatecache`。`Slate.toml` 按客户端子集解析：`[package] name, version, namespace_prefixes, toolchain, license`、`[registry] index`、必填 `[research]`、`[dependencies]`；`[workspace]`、path 依赖、预发布版本、通配需求都不能发布。请求字段与清单不一致返回 400 `manifest_mismatch`。然后按内容寻址写入 `staging/`，再在 SERIALIZABLE 事务内创建候选与任务：

- `toolchain` 必须等于本注册表的 `PEBBLE_TOOLCHAIN_TAG`（409 `toolchain_mismatch`）；
- 已存在的包需要写权限，不存在则由调用者创建为 public 包；
- 版本已发布 409 `immutable_version`；已撤回的版本同样不可重发；
- 每个依赖必须已有未撤回的正式版本（409 `dependency_unavailable`）；
- 前缀检查如第 2 节；
- 每 principal 最多 4 个待处理任务、全局 1,024 个（429）。

维护者组织的 principal（运维 `maintainer --name NAME --grant`）发布时 `review_required=false`，worker 通过后直接正式发布；其他候选进入 `pending_review`，由非发布者的任一账户审核。

## 4. Worker 检查

worker 用租约领取任务（默认 300 秒，可续租；过期由其他 worker 接管，旧尝试的回传被拒绝）。每次尝试：

1. 从 `staging/` 取回两份归档，核对摘要；解开 `.slatepkg` 到 `/work/project`，解析 `Slate.toml` 并与候选的 name/version/toolchain/prefixes 绑定核对。
2. 从数据库沿索引依赖闭包收集所有公开正式版本的索引行与归档，物化为 `file://` 镜像 `/work/registry/{index,dl}`，`config.json` 的 `dl` 指向 `file:///work/registry/dl/...`；写入 `/work/home/config.toml`，用客户端的源替换（`[source.registry] replace-with = "mirror"`）把清单里的索引根改到镜像。
3. 在 bubblewrap 中运行冻结的客户端：`/slate check --release --slatec /slatec --manifest /work/project/Slate.toml`。根文件系统只读挂载冻结的 rootfs（含 `slatec`、`slate` 与其动态库），只有 `/work` 可写，无网络、空环境、独立 PID 命名空间；策略为 120 秒、4 GiB 地址空间、32 MiB 输出。
4. 要求 stdout `status:"checked"`、`mode:"release"`、`dev_mode:false`，`.slate/report.json` 的 `complete=true`；否则 `incomplete`/`timeout`/`error`，可重试。
5. 读取 `.slate/interfaces/<name>.interface`，与上传的 `interface` 逐字节比较（`InterfaceMismatch`，诊断给出首个差异行）；上传包里每个 `objects/*` 条目必须与本次检查在 `.slate/cache/objects` 下持久化的对象逐字节相同，且不能多带（`StatementBundleMismatch`）。
6. 检查模块/理论标识落在声明前缀内；从数据库取上一正式版本的接口文本，按客户端 `compare` 的移植计算变更级别（删除、`target_hash`/`definition_environment_hash` 变化、kind 变化、转私有 → major；新增 → minor；否则 patch）。声明级别低于计算值时候选直接 `rejected`，诊断 `DeclaredLevelBelowComputed: declared patch but the interface change is major (Base.Core.Base.Core.Core statement changed)`。
7. 结束前复核 `/work/project` 中的源码字节未变（`VerificationSourcesChanged`）。

通过的尝试保存报告、计算级别与接口文本；候选进入 `pending_review`。正式发布事务复核候选修订、通过的尝试、级别、审核或维护者身份与前缀所有权，先把两份归档从 `staging/` 不可变复制到 `public/packages/...`，再插入 `package_versions`（触发器只允许 yank 字段变化），最后重写索引文件。任何一步失败都不留下索引行。

## 5. 邀请兑换

邀请码仅由运维 `invite --name NAME [--expires-in-hours HOURS]` 签发，默认 168 小时，允许 1–720 小时；名称绑定一个尚未存在的账户。随机码包含 32 bytes 随机性，编码为 43 字符 base64url。数据库仅保存码的 SHA256；`revoke-invite --id UUID` 使未兑换邀请失效，已兑换账户的撤销使用独立账户操作。没有 HTTP 邀请签发或普通注册端点。

客户端先生成并私有持久保存 32 bytes 随机登录 token（64 字符小写 hex），再通过请求体兑换；服务端只存 token hash，不回显秘密。同一码与同一当前有效 token 重试返回相同账户；其他 token 重放、未兑换码过期/撤销或未知码返回 410 `invalid_invitation`。已有同名账户或 token 冲突返回 409。账户 token 轮换/撤销后，旧兑换请求不能恢复它。兑换请求体最多 1 KiB；每 API 进程单 IP 每分钟 5 次。已提供 [邀请客户端](../deployment/accept-invite.mjs)。兑换得到的 token 通过私有运行环境提供为 `SLATE_TOKEN`。

## 6. 工具链托管

客户端在清单 `toolchain = "TAG"` 且未指定 `--slatec` 时，从 `static` 根下载 `toolchains/TAG/<arch>-<os>/slatec`、`slatec.sha256` 与 `TOOLCHAIN.lock`，核对摘要后安装到 `$SLATE_HOME/toolchains/TAG/`，并用 `TOOLCHAIN.lock` 核对报告中的工具链身份。运维用 `toolchain-publish --tag TAG --host x86_64-linux --slatec FILE --lock TOOLCHAIN.lock` 把这三个文件不可变地写入 `public/toolchains/...`。worker 的 rootfs 由 `toolchain --slatec FILE --slate FILE --output DIR` 冻结，描述符记录两者的 SHA256；注册表只接受 `PEBBLE_TOOLCHAIN_TAG` 对应的一个标签，升级标签与 rootfs 是一次受控操作。

## 7. 资源边界

包归档 32 MiB / 4,096 文件（解压与 base64 均按此上限校验）；HTTP JSON 体上限 96 MiB，请求超时 120 秒。API 每进程 `PUT /api/v1/packages/new` 与 `GET /static/*` 合计最多 4 个并发，其余请求并发 64，饱和返回 503 与 `Retry-After`。单 IP 限流：`/index/*`、`/static/*` 各 600 次/分钟，API 读 180 次/分钟、写 30 次/分钟；受信代理网段仅通过 `TRUST_PROXY_CIDRS` 声明。检查策略 120 秒、4 GiB、32 MiB 输出，超限不产生通过结果。更大对象的分块上传、断点续传与 CDN 签名分发尚未实现。
