# Pebble

SAIR 的科研协作与发布平台：让研究从可阅读的论文，成为可引用、可验证、可复用的项目。

Pebble 围绕同一个研究项目连接论文阅读、形式化代码、数据、包发布、讨论和项目协作。它与 Slate 语言工具链及 Clay 科研工作环境协同，服务于开放科学模型计划。

当前架构以完整 Git 研究仓库为基础，clone、fetch、push、提交历史、分支和标签是核心能力；Cargo 式包管理负责固定版本的构建、检查与交付。发布和依赖绑定稳定 `repo_id`、精确 commit 及必要的包路径，包快照从该 commit 导出。同一仓库在一次验证中使用同一 commit 的完整源码，不按每条定理最后修改的 commit 混装；分支或标签变化不改写旧发布和引用。网站结构参考 Hugging Face Hub，以研究问题、结论、假设、作者和复用入口为中心。

已实现 ADR-0188 协议的包注册服务：按名字发布的包、cargo 式稀疏索引（`index.verifiable.ai`）、不可变归档与工具链静态树（`static.verifiable.ai`）、`slate.verifiable.ai/api/v1` 写接口，PostgreSQL 元数据与任务，S3 内容存储，以及在隔离沙箱内运行真实 `slate check --release` 的 worker。Slate 仓库提供 `Slate.toml`、`Slate.lock` 与 Rust 客户端。已用真实客户端通过 HTTP 发布、由 worker 复检、审核发布、干净消费者在开发与发布模式下检查、撤回与级别把关的闭环；见 [验收记录](docs/implementation-status.md)。当前运行代码、数据库 schema 和部署配置尚无 Git 托管及 commit→snapshot 发布绑定；Git 部分目前只有设计修订。网站界面与全球定理 DAG 也尚未实现。

初期采用邀请制，已提供运维签发/撤销、一次性 HTTP 兑换与保存私有凭据的客户端；普通用户不能自行注册或签发邀请。账户扩额初期由运维批准，累计资源记账尚待补齐。学术声誉参考 Google Scholar 的成果与引用档案，另列形式化贡献和独立复用；目前是设计，尚无可信引用指标或声誉页面。操作见 [邀请准入](docs/deployment.md#邀请准入)。

服务按 **1 万注册用户**建立容量模型，长期向 Hugging Face 级科研平台演进。注册数、日活、请求量、下载流量和验证任务分别计量。现有快照服务的部署资产包含固定镜像输入、HTTPS 入口、独立 worker、密钥配置、健康检查及备份恢复；Git 部署仍待实现，尚未部署公网。

安装与编译：`npm ci`、`npm run build`。启动 PostgreSQL/S3、准备固定 Slate 工具链及执行迁移的方法见 [部署说明](docs/deployment.md)。真实集成验收使用 `npm test` 和 `npm run test:e2e`，依赖实际 PostgreSQL、S3 和 Slate；环境配置见 [验收记录与重现](docs/implementation-status.md)。缺少集成环境时测试会明确跳过，不能记为通过。

写作编辑与实时协作属于 Clay；Pebble 提前准备项目、权限、版本、成果提交与引用接口，但不提供写作协作功能。论文由 Clay 或其他外部工具产出后提交到 Pebble。

- [产品与架构设计草案](docs/product-architecture.md)
- [设计依据与需求映射](docs/requirements.md)
- [技术研究与实现方案](docs/technical-research.md)
- [Slate 包管理、验证与发布协议](docs/package-verification.md)
- [定理依赖 DAG 与 agent 探索](docs/theorem-index.md)
- [仓库开发约定](AGENTS.md)
- [注册发布协议实施契约](docs/registry-protocol.md)
- [部署与运维](docs/deployment.md)
- [容量目标与实测范围](docs/capacity.md)
- [验收记录与剩余缺口](docs/implementation-status.md)

本仓库承载 Pebble 平台。Slate 的编译器、可信内核和本地包管理客户端留在 Slate 仓库；双方通过明确的包与验证协议连接。
