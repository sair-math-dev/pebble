# 首个注册、验证与复用闭环

记录日期：2026-09-09。以下区分实际运行结果和待上线验证的配置；源码改动尚未提交、推送或合并。

后续需求已修订为完整基于 Git：本文记录的是迁移前实际完成的快照注册闭环，不代表整个目标产品完成。Git clone/push、仓库/commit 绑定、受保护发布引用，以及 Git 与定理 DAG 的版本关联仍待实现。随后按用户决定新增邀请制实现与声誉设计，验证见下节；Git 迁移尚未开始。

## 邀请制增量验收

2026-09-09 已实现运维签发/撤销邀请码、原子兑换与安全重试、先持久保存私有 token 的邀请客户端，以及迁移 002 和旧 schema 启动拒绝。仅运维能签发邀请，无公共自主注册或用户转邀端点；尚无邀请/登录网页、邮箱发送或已核实学术身份。

本轮还修复了限流插件注册顺序：此前路由配置存在但实际限流钩子未安装。现在邀请每 IP 5 次/分钟、普通读取 180 次/分钟和写入 30 次/分钟会实际拒绝超额请求，读写分别计数；拒绝经 dot-segment 归一化绕过邀请专用路径限制。限额仍是每 API 进程口径。

Node v24.20.0 下类型检查、生产编译及全套 31 项测试通过、零跳过；记录在 `.artifacts/invitation-validation.log`。新增测试使用真实 PostgreSQL、HTTP 与实际客户端进程，覆盖并发兑换、重试、姓名冲突、过期/撤销、旧 token 不能恢复权限、凭据不回显、限流与迁移；既有真实 S3/Slate 检查及发布测试也通过。首轮全套因本地 S3 测试服务未运行而失败，启动本机隔离服务后重跑取得上述结果，未跳过集成检查。

修复后再次执行真实 HTTP/Rust CLI 三包闭环并通过：`.artifacts/registry-e2e-2026-09-09T20-07-09-067Z/summary.json`，3 个发布及 3 个通过任务；完整日志 `.artifacts/invitation-e2e.log`。该闭环仍采用快照服务，不代表 Git 托管已实现。声誉目前是可追溯成果/引用、形式化贡献和独立复用的设计；缺少已核实归属及引用数据，未实现 h-index 或声誉页面。未提交、推送或部署公网。

## 已实现

Pebble 的 Fastify API 使用真实 PostgreSQL 事务管理包、成员权限、不可变快照、候选、审核、任务尝试、正式版本、撤回与验证撤销。S3 保存按实际内容计算摘要的对象，上传不等于检查、发布或公开。发布使用候选修订、输入摘要、当前权限与政策复查，版本唯一性和发布事件在同一事务建立。幂等重试先重新授权，重复或过期 worker 结果不能覆盖新尝试。

Slate 的独立 Rust 客户端实现 `lock/fetch/check/package/publish`。作者的 `slate.toml`、生成的 `slate.lock`、内容快照和发布状态分别建模。当前版本选择是精确稳定 `X.Y.Z`，锁定全依赖图，拒绝替换、冲突、环和不可达节点；本地下载缓存不成为证明缓存。具体 HTTP 和清单契约见 [registry-protocol.md](registry-protocol.md)。

受控 worker 固定实际 Slate 二进制、动态库和政策。bubblewrap 只读挂载工具链与完整源码，在独立网络/PID 命名空间与清空的环境中运行检查，限制时间、内存、输出与文件描述符。协调器重新核对精确输入、全部文件摘要、源码分类及原生形式化资格；受控结果收集接口不向作者开放。

检查覆盖包内所有允许的文件，包括未被主入口导入的隐藏源码。原生报告保留声明、理论、公理、目标与证据身份；普通程序执行、元数据审核、本地检查与正式发布各有独立含义。未知或缺失的资格字段拒绝通过。

## 真实运行证据

`npm run test:e2e` 使用实际监听的 HTTP 服务、Rust `slate` 进程、PostgreSQL、S3 与隔离 Slate。最终成功记录保存在本地 `.artifacts/registry-e2e-2026-09-09T09-09-22-258Z/summary.json`，包含从实际内容生成的客户端、工具链和政策摘要，以及三个正式版本的快照身份。样例保留上游 Slate 的 Apache-2.0 许可证与形式化归属；客户端实际发布包内附带许可证及来源说明，不把经典结果或上游形式化改称为自己的新发现。

顺序是：发布含三个逆元结果的代数提供包；删除发布者源目录和缓存；独立消费者通过 HTTP 选择、下载并锁定该版本，导入其 ModuleId 检查逆元对合定理，再发布消费者包；最后独立检查和发布集合成员替换结果。消费者的在线检查与下载后离线重新检查均实际通过。测试结束清理数据库 schema，记录中的端口和版本 ID 是隔离验收身份，不是已上线可访问地址。

`tests/registry.test.ts` 使用真实 PostgreSQL/S3 与 Slate 检查成功路径，覆盖完整发布、审核缺失、事务中途故障回滚、竞争同版本、相同幂等键并发、私有依赖、撤权后的保存响应与延迟下载、隐藏坏文件、固定传递版本冲突、租约回收、重试额度、失效回传、撤回和验证撤销。故障测试可删改一份实际报告以确认拒绝，不用伪造成功结果补齐未实现能力。

`tests/isolation.test.ts` 用独立的受信诊断程序执行与 worker 相同的隔离启动器，实际验证源码/根目录只读、宿主文件和 shell 不可见、宿主 loopback 服务不可连接、服务凭据不进入环境、PID 隔离及超时终止，并拒绝工具链根目录内未登记文件。诊断程序不生成 Slate 报告，也不用于任何数学接受。这些测试覆盖已测机制，不等于宿主内核或目标云环境的完整安全审计。

容量工作负载和测量边界见 [capacity.md](capacity.md)，备份恢复及生产运行配置见 [deployment.md](deployment.md)。本机的进程运行和配置校验不替代目标 Node 容器、systemd、TLS、故障域及公网容量验收。

另外从 Node 官方下载并核对发布清单 SHA256 的 Node 24.20.0 Linux 二进制已实际运行 TypeScript 类型检查、生产编译、协议/隔离/数据库集成测试及 Rust HTTP E2E。最终回归 18/18 通过、0 跳过，记录在 `.artifacts/final-validation.log`；生产编译记录也保留在 `.artifacts/node24-validation.log`。这是 Node 24 运行时验证，仍未构建或启动部署镜像。

## 重现

Pebble 位于 `design/product-architecture` 分支；Slate 改动在独立 `integrate/pebble-package-report` 工作树，起点为实际 `origin/main` 提交 `bab9a76e7864c33e4a90ec6f1b41ba972920d4bf`。没有修改其他 Slate/Loom 用户工作树。Slate 上游尚未合并这些接口，必须使用本次构建的二进制。

在 Slate 工作树按其固定工具链构建：

```sh
tools/slate-dev/target/release/slate-dev cargo build --locked --release --manifest-path tools/slatec/Cargo.toml
tools/slate-dev/target/release/slate-dev cargo build --locked --release --manifest-path tools/slate/Cargo.toml
```

Pebble 安装、构建后，按部署文档启动实际 PostgreSQL/S3，创建私有测试 bucket，准备固定工具链。测试环境 JSON 文件权限应为 0600，包含 `DATABASE_URL`、`S3_BUCKET`、`S3_REGION`、可选兼容端点和标准 AWS 凭据。测试数据库身份需要在其独立测试库创建/删除 schema 的权限；不使用生产数据库。

```sh
npm ci
npm run build
node dist/main.js toolchain --slatec /absolute/path/to/slatec --output .artifacts/toolchain-pinned
export PEBBLE_TEST_ENV=/absolute/path/to/private-test-environment.json
export PEBBLE_TEST_TOOLCHAIN=/absolute/path/to/toolchain-pinned
export SLATE_CLIENT=/absolute/path/to/slate
export SLATEC=/absolute/path/to/slatec
npm run typecheck
npm test
npm run test:e2e
npx tsx tests/capacity-probe.ts
```

环境文件未提供时，`npm test` 的基础设施集成部分明确跳过；E2E 与容量脚本则失败退出，不能把未执行的检查计为成功。隔离测试要求 Linux、C 编译器和非特权 user namespace。测试产物写入被 Git 忽略的 `.artifacts/`；其中实际研究内容和检查报告需按数据权限管理，凭据不写入摘要或测量报告。

## 当前边界

这是可部署的首个包管理闭环，尚未开放公网或达到长期平台规模。当前支持运维邀请及客户端兑换，公开自主注册按初期产品决策不开放；尚无 OIDC 登录、组织邀请界面或完整账户恢复。网页、全局结果身份/定理 DAG、搜索投影、讨论和 Collections 是后续工作。

源码包采用有界 JSON/Base64 传输：每包 32 MiB/4,096 文件，服务闭包 256 MiB/16,384 文件/1,024 包。支持 `.slate`、`.md`、`.txt`；不支持任意构建脚本、外来受信缓存、数据集大对象或自动论文编译。流式分块传输、断点续传与授权 CDN 分发应在扩大包/数据规模前落实，不能单纯调大请求体上限。源分类审核负责确认附件没有掩盖未检查的形式化内容。

限流与待检查配额已经提供首层保护；累计存储/下载记账、分布式账户小时额度、过载监控、持续可用性和云端故障切换仍需按上线环境实施和验收。已提供的单机 Compose 不是双故障域高可用。长期目标为 Hugging Face 级科研 Hub，不意味着本轮实现 Spaces、推理、训练系统或 Clay 写作协作。
