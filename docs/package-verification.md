# Slate 包管理、验证与 Pebble 发布协议

记录：TECH-0002；状态：proposed；研究日期：2026-09-08。

当前核心方向：Cargo 式的本地包管理与构建检查，Pebble 提供注册分发、验证发布及 GitHub 风格的包浏览。完整 Git 托管不作为前置条件。

本文件是可供下一步实现讨论的协议草案，不是现有 Slate 命令或已接受的持久格式。平台架构见 [技术研究](technical-research.md)。

## 1. 对当前 Slate 的实际核查

核查基线：Slate `main` 的 `bab9a76e7864c33e4a90ec6f1b41ba972920d4bf`。通过本地 Git 读取该提交，未改变 Slate 工作树。不能沿用改名提交的 Java 依赖或旧工具链版本。

| 能力 | 源码证据 | 对 Pebble 的影响 |
| --- | --- | --- |
| Rust 内解析、源输入准备 | `source_cli.rs` 调用 `antlr_frontend`；Cargo 使用 Rust ANTLR runtime/codegen | Worker 不需要 Java；语法输出仍不是证明 |
| 固定编译工具链 | `TOOLCHAIN.lock` 固定 Rust 1.95.0、host 和 compiler commit | 平台需要分发精确工具链/镜像身份，不能只写 `slate >= 0.1` |
| `check` 与 `compile` | CLI 处理 theorem/program、theory、source-root、module-source、module-object、output | 已有工作区构建基础，尚不是远程包管理器 |
| 完整可达依赖选择 | `source_driver.rs` 的候选绑定及 `ModuleDependencyProviderConflict` | 同名 ModuleId 不能靠安装顺序消歧；不能任意把两个版本挂进一个图 |
| `.slateobj` 与 `.slatecache` | `module_cache.rs`、`module_cache_store.rs` | 外来 bytes 没有本地受信任缓存来源；下载成功不赋予接受权 |
| prefer / replay / rebuild | `SourceDependencyMode` | 本地精确命中、证据重放、源重建是不同操作，平台要分别记录 |
| 详细的单结果输出 | `main.rs::print_published_source` | 有精确 target、certificate、dependency/assumption closure 和 provenance 等字段可供结构化适配 |
| 开发假设状态 | 同一输出函数仅在开发分支打印 `release_eligible=false` | 不可把缺少此字段理解为通用 `release_eligible=true`，也不可只看 `ProvedStatement` |
| 内部模块编译/发布 | API 多为 `pub(crate)`；Cargo 当前是 compiler package | 尚不能声称已有稳定的外部 library API 或 package-wide JSON 报告 |

固定提交来源：[CLI](https://github.com/sair-math-dev/loom-lang/blob/bab9a76e7864c33e4a90ec6f1b41ba972920d4bf/tools/slatec/src/source_cli.rs)、[工作区与依赖](https://github.com/sair-math-dev/loom-lang/blob/bab9a76e7864c33e4a90ec6f1b41ba972920d4bf/tools/slatec/src/fol/source_driver.rs)、[缓存格式](https://github.com/sair-math-dev/loom-lang/blob/bab9a76e7864c33e4a90ec6f1b41ba972920d4bf/tools/slatec/src/fol/module_cache.rs)、[缓存来源边界](https://github.com/sair-math-dev/loom-lang/blob/bab9a76e7864c33e4a90ec6f1b41ba972920d4bf/tools/slatec/src/fol/module_cache_store.rs)、[结果打印](https://github.com/sair-math-dev/loom-lang/blob/bab9a76e7864c33e4a90ec6f1b41ba972920d4bf/tools/slatec/src/main.rs)、[工具链](https://github.com/sair-math-dev/loom-lang/blob/bab9a76e7864c33e4a90ec6f1b41ba972920d4bf/tools/slatec/TOOLCHAIN.lock)。

核查限度：本轮是源码与调用路径阅读，没有重新构建该 Slate 提交或运行编译器全套测试。这里只对读到的接口作结论，不把历史文档中 phase complete 等同于包发布能力完成。

## 2. Reservoir/Lake 和 Cargo 能借鉴什么

Lake 区分 package、workspace、依赖 manifest，并同步锁定依赖；Reservoir 是 Lean/Lake 的包注册来源。借鉴其本地工具与远程索引分工，不把 Pebble 的论文、社交和研究记录塞入编译器。[Lake 官方说明](https://lean-lang.org/doc/reference/latest/Build-Tools-and-Distribution/Lake/)。

Cargo registry 区分版本元数据与下载内容，记录 checksum、依赖及 yank 状态，并要求同一包版本唯一。Pebble 可借鉴不可变版本内容、可变撤回状态和按包读取索引；不会直接兼容 Cargo 包格式。[Cargo registry index](https://doc.rust-lang.org/cargo/reference/registry-index.html)。

关键差异来自 Slate：分发元数据之外，还必须绑定精确理论、ModuleId、声明、工具链和检查证据。Registry 的 checksum 能证明内容一致，不能证明结果为真。

## 3. 三份独立的数据

### 本地用户工作流：以 Cargo 的职责划分为参照

Cargo 将命令划分为构建、清单、包、发布和报告等类别，并区分作者维护的依赖清单与工具生成的精确锁文件。这里借鉴职责和使用习惯，Slate 的证明语义仍由自己的工具链决定。[Cargo 命令](https://doc.rust-lang.org/cargo/commands/index.html)、[清单与锁文件](https://doc.rust-lang.org/cargo/guide/cargo-toml-vs-cargo-lock.html)。

以下命令均为待设计的包级接口；现有 `slatec check/run` 的单文件接口不等于这些能力已实现。最终命令前缀需在 Slate 仓库决定。

| 建议操作 | 行为与边界 |
| --- | --- |
| `slate new / init` | 建立包清单、源码目录和 README；可选择 library 或 executable 用途 |
| `slate add / remove` | 修改依赖意图并解析更新锁文件；不靠全局安装使 import 偶然成功 |
| `slate fetch` | 按锁文件取得源码/数据；下载不自动运行用户构建脚本 |
| `slate update [package]` | 显式重新求解允许更新的版本，展示依赖与检查身份变化 |
| `slate build` | 根据精确工作区图构建产物，复用合法缓存；build 成功不等于所有程序都已证明正确 |
| `slate check` | 执行所选包检查目标，输出覆盖范围、精确结果、假设和未解决项 |
| `slate run` | 选择可执行目标并运行，保持现有 ordinary execution 与证明检查的区别 |
| `slate package` | 检查清单、枚举将上传的文件、生成不可变快照；可离线预览包内容 |
| `slate publish` | 上传同一快照，触发正式检查/审核，查询完成状态；可幂等重试 |
| `slate search / info / tree / metadata` | 搜索包、查看版本与安装信息、解释依赖图、向 IDE/agent 输出结构化工作区 |

`--locked` 禁止隐式改锁，缺锁或清单不一致直接失败；`--offline` 禁止网络，缺依赖明确报错；普通重复构建优先沿用已有锁，不自行追最新版。缓存可复用，但键需绑定源内容、依赖、工具链及相关检查配置。

Workspace 支持多个成员共享一个求解结果及锁文件，并可选择检查一个成员或全部成员；不可达成员不进入单个包的数学依赖闭包。发布多包按依赖顺序准备，仍遵循第 4 节的精确环境限制。

`test`、文档生成和类似 `cargo install` 的可执行工具安装需要分别定义目标模型，后续加入；有限输入测试通过不能冒充定理证明，当前不为了命令表完整而造假的验证状态。自动执行 build scripts、插件或可执行清单也不是采用 Cargo 风格所必需的功能。

网页采用 GitHub 熟悉的导航，但详情首页优先展示 Research card：学术标题、作者、问题、结论、假设、精确引用和使用示例；owner/name、源码树、版本与侧栏安装命令作为配套。包版本是默认浏览基线，源码直接来自对应发布快照；无需先创建远程 Git 仓库才可发布、安装或浏览一个引理包。结果拥有独立引用落点，分发仍以包为单位。

### A. 作者清单：意图

建议 `slate.toml` 作为本地包清单、`slate.lock` 作为生成的锁文件；名字与命令仍是提案。作者清单包含：

```toml
# 示例提案；这些字段不是当前 slatec 已支持的输入。
[package]
name = "@example/group-results"
version = "0.1.0"
description = "Reusable results about groups"
license = "Apache-2.0"

[source]
roots = ["src", "theories"]

[research]
readme = "README.md"
paper = "paper.md"

[dependencies]
algebra = { package = "@example/algebra", version = "^0.2.0" }
```

依赖 alias 仅供清单使用，不自动重命名 Slate 的 ModuleId。工具链选择由独立受控 toolchain descriptor 锁定，锁文件记录其摘要。理论文件与标准库也是精确内容依赖，不能从运行机器的任意安装位置取到“差不多一样”的版本。

源码 roots 是作者提出的包边界，不是验证覆盖的最终依据。最终发布内容由服务器从上传的固定包快照枚举（如果从 Git 导入，则先固定 tree 并物化为同一种快照），所有形式化源码均进入工具链清单；作者少写一个 root、用 ignore 排除坏定理不能得到正式发布。未支持的形式化内容使发布候选保持未就绪，并列出文件。

### B. 发布输入清单：固定内容

建议 `PackageSnapshot` 的字段：

| 字段 | 语义 |
| --- | --- |
| `schema` | 该分发格式版本；未知格式拒绝 |
| `package_id`, `version` | 注册服务的稳定包身份与版本，不以 slug 当身份 |
| `source_files[]` | 精确相对路径、文件类型/模式、长度、SHA-256 |
| `data_objects[]` | 必需数据的逻辑名称、长度、摘要、媒体类型；下载位置不作为内容身份 |
| `dependency_lock` | 直接依赖及完整可达图的稳定包 ID、版本、快照摘要、注册来源 |
| `toolchain_digest` | 可获取的精确工具链描述，不是人类可变标签 |
| `manifest_digest`, `research_metadata_digest` | 作者清单原始 bytes 与正式说明/作者/许可证快照 |

`snapshot_digest = SHA256(domain || canonical_snapshot)`；snapshot 不包含自己的摘要或将来的验证输出，避免 hash cycle。清单自身作为协议对象存储，不递归列入自己的 `source_files`。Git OID 单独作为来源记录，源码发布内容可以跨仓库保持相同内容身份。

生成的依赖锁只记录外部/先行依赖的快照摘要，不记录当前根包自己的 snapshot digest。多包发布先按无环依赖顺序确定快照，发布集合 ID 再绑定全部快照；任何快照都不反向引用该集合 ID。

建议 canonical_snapshot 使用 RFC 8785 JCS，限制数值为非负安全整数，摘要为固定小写 hex，数组按协议规定顺序排序；拒绝重复键、未知必需字段、非规范路径。JCS 本身不做 Unicode 归一化，因此路径规则要在编码之前验证，不能在下载后悄悄改名。[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)。

包格式采用 manifest + blobs，可附一个 `tar.zst` 下载便利包。便捷 archive 的传输摘要独立于解包后的 snapshot digest。校验重复成员、`..`、绝对路径、符号/硬链接逃逸、设备文件、大小写路径碰撞、文件/目录冲突及解压总量；首版不接纳 symlink、Git submodule 或任意 URL 数据引用进入正式包。数据必须已物化并能按固定摘要取得，不能让验证过程现抓远程数据。

### C. 检查报告与发布记录：结果

验证输出不写回 PackageSnapshot，而通过外层 `VerificationRun` 绑定 input digest。发布对象再绑定 snapshot 与检查记录，并带审核记录；不会改变包内容。

建议报告至少包含：

```text
schema, input_digest, toolchain_digest, policy_digest
attempt_id, outcome, diagnostics_ref
coverage:
  discovered_files, classified_files, checked_files, unsupported_files
declarations[]:
  module_id, module_interface_hash, declaration_id, declaration_kind
  source_binding, exact_target, target_hash, theory_hash
  proof_status, proof_source_kind, publication_profile
  certificate_ref, dependency_closure_ref, assumption_closure_ref
  cache_origin, replay_or_rebuild_mode
program_contracts[]:
  exact_owner_selector, contract_target_hash, program_identity
  verification_kind, semantics_ref, runtime_assumptions_ref, evidence_ref
```

这些字段需从可信工具链状态导出，不能让平台解析 stdout 的字符串自行推断缺失状态。声明种类不同要求不同字段：axiom 作为披露假设，不伪装成有证书的 theorem；普通程序执行成功不填 theorem evidence；ProgramCert 保持独立的程序验证身份。

同一批已检查声明导出 [定理目录](theorem-index.md)，供 Pebble 建立文本、公式结构及语义索引。目录关联完整作用域和环境；内部 arena 节点 ID 不作为跨进程身份。搜索特征是非权威投影，不加入内核接受路径。

平台记录来源的认证只说明哪个受控任务提供了报告；它不是执行 attestation，也不能代替 Slate kernel 检查。服务器签名若后续加入，只认证分发/报告身份，不增加内核规则或证明权威。

## 4. 依赖解析：先明确可接受图，再选择算法

首版建议每个完整发布闭包中一个 package ID 只有一个版本，同一个 Slate ModuleId 只有一个来源。构建图必须无环。registry metadata 宣称的 exports 仅用于提前报错，最终由工具链重新发现和确认。

**正式包版本固定它验证时的传递依赖闭包。** 作者清单允许范围，是解析输入；生成的发布清单保留准确选择。消费已发布包时不可偷偷重新解析它的内部依赖再沿用旧验证身份。替换内部依赖需要重新验证，并形成新的发布绑定。

例如：`A@1` 发布时使用 `C@1`，`B@1` 使用 `C@2`。新项目同时选择 A 和 B 时，不能只因 C@2 与 C@1 满足同一个 SemVer 区间就替换 A 的已检查环境；首版报冲突，展示 A→C@1 与 B→C@2 两条路径，作者选择已在共同环境下发布的版本。它牺牲了一部分升级灵活性，但保留了可引用的精确结果身份。未来若需多版本并存，先设计编译器级 namespace/identity 隔离，不能只改解包目录。

依赖算法可采用 Rust PubGrub，实现 package/version 约束求解和冲突解释；各发布版本的固定直接依赖作为精确约束，其传递闭包由此展开。先检测/约束 package 和 ModuleId 冲突，再调用 Slate 检查实际图；求解器没有数学权威。[PubGrub Rust 实现](https://github.com/pubgrub-rs/pubgrub)。

锁文件按 registry identity + package ID 固定来源，不跨 registry 自动寻找同名替代包，避免依赖混淆。完整图下载按拓扑调度并去重，图验证成本按 `V+E` 计，版本求解另计回溯复杂度。第一次可按包读取并缓存索引，不需要下载全站索引。

开发允许 path 或 Git commit 依赖，但正式发布要转换为明确可获得的固定包/物化内容，拒绝分支标签、工作树脏改动和未锁定的来源。用户 credentials 存在系统凭据存储，不进入清单、lock 或 Git。

## 5. 本地缓存与远端内容严格分开

| 存储 | 允许的作用 | 禁止的作用 |
| --- | --- | --- |
| 下载缓存 | 保存按摘要校验的源码、数据、证据 | 不能因位于缓存目录就被视为本地已检查 |
| 本地 Slate 检查缓存 | 同精确输入/工具链/政策下复用检查器生成的结果 | 不能把下载的 `.slatecache` 和本地 receipt 一起安装来伪造来源 |
| Pebble worker 缓存 | 受控 worker 历史检查的加速输入，有独立写权限 | 构建代码不能写入其他任务的受信任缓存 |
| CDN / mirror | 缓存不可变内容 | 不拥有最新版、撤销状态和私有读取授权的最终决定权 |

第一条公开分发路径优先“下载源码 → 本地重建和检查”；外来 `.slateobj` 仅在已有受控 replay 路径实际验证后进入本地缓存。远端预验证缓存作为未来显式信任选择，当前不默认引入。

本地正常 `prefer` 命中仍可保留，不强迫每次重放全部历史证明。正式发布首次构建使用干净来源和明确模式，后续受控缓存命中记录来源。离线可以重现固定内容，但不能获知之后的撤销；展示最后一次状态同步时间。

## 6. 正式发布 gate 必须检查完整覆盖

平台的 `FormalChecksPassed` 是发布 gate 的结果，不是新增 Slate 定理状态。条件必须同时满足：

1. 包内容全部物化，清单和实际文件/数据一致，依赖版本可取得且符合当前发布政策。
2. 工具链分类完整，所有形式化源码都有明确处理结果；没有漏文件、未解决义务、开发假设或不支持内容。
3. theorem 的精确目标通过已有检查路径；axiom、schema、理论假设全部显式披露。不能要求所有假设为空，也不能把声明 axiom 等同于证明 theorem。
4. 需要程序正确性验证的内容有精确 owner contract 的既有 ProgramCert 检查结果；普通 `Executed` 不能作为替代。
5. README/论文描述、作者、假设、数据来源、引用/使用说明通过基本审核；自然语言与形式化声明的忠实程度独立标记。

当前 Slate 的程序执行范围大于验证范围。因此不能承诺任何现有含程序的项目现在都能正式发布。没有对应验证路径的形式化代码留在开发项目，发布 gate 显示不支持；是否将一般计算工具作为独立的非形式化研究附件另设产品类别，需要明确产品政策，不能通过改后缀或把它叫数据绕过原始 gate。

仅编译一个 `.slateobj` 不等于所有结果已经正式发布。需要 Slate 侧增加完整声明清单/检查导出接口，通过现有内部路径检查每个所需对象并输出总体 coverage；不要用正则抓 `theorem`，也不要多次运行子命令却无法证明覆盖所有声明。

## 7. HTTP 协议草案

所有 mutation 都有身份、权限、结构验证、大小限制、审计和幂等语义。API schema 使用同一来源生成 TypeScript/Rust 客户端，内核格式仍由 Slate 定义。

这些接口同样供 Clay 使用。Pebble 提前准备稳定项目/结果身份、权限查询和固定成果版本提交；写作编辑与实时协作由 Clay 实现。具体边界见 [Clay 接入准备](technical-research.md#clay-接入准备共用成果协议独立写作状态)。

| 方法与路径 | 输入/响应核心 | 关键规则 |
| --- | --- | --- |
| `GET /api/v1/packages/{id}/versions` | 包版本、snapshot digest、撤回/撤销状态、ETag | 私有索引也鉴权，分页稳定排序 |
| `GET /api/v1/packages/{id}/versions/{version}` | 固定清单及当前状态引用 | 内容身份稳定；状态可以追加变化 |
| `POST /api/v1/projects/{id}/release-candidates` | snapshot digest、包集合、可选 Git 来源、expected project revision | 返回 202 + candidate ID；同幂等键换请求体返回 409 |
| `GET /api/v1/release-candidates/{id}` | 当前阶段、检查与审核记录、失败原因 | 失败阶段可诊断，不把 Timeout 显示为 False |
| `POST /api/v1/release-candidates/{id}/publish` | If-Match 候选修订、幂等键 | 检查输入不变且当前 gate 通过，事务提交全部包 |
| `POST /api/v1/releases/{id}/withdrawals` | 原因、替代发布引用 | 原版本不覆写，记录调用者权限 |
| `GET /api/v1/results/{id}/revisions/{revision}` | 精确声明、包版本、源位置、假设、证据引用 | ID 不依赖当前 slug；读取检查完整权限 |
| `GET /api/v1/objects/{digest}` | 对象下载或短时重定向 | 已知 digest 不等于有权下载；跨域不转发 registry 凭据 |

`Idempotency-Key` 的作用域包含 principal、操作和资源；服务器保存请求摘要和响应。任务重复是正常情况，重复发布必须返回同一结果或明确冲突，不能产生两个相同版本。`If-Match` 用于可变状态并发控制，不代替 input digest。

CLI 面向用户建议 `slate init/add/update/build/check/publish`，但具体命令前缀需 Slate 仓库决策。本仓库不另做一个与 Slate 竞争的本地 resolver。Pebble 的服务发布 API 与本地命令独立版本化。

## 8. 双仓库实施切分与验收

| Slate 仓库 | Pebble 仓库 |
| --- | --- |
| 包清单/锁文件、resolver、安装布局 | 注册 namespace、不可变版本和下载 |
| 完整源清单与声明分类 | 固定发布候选和元数据审核 |
| 工具链自身的结构化检查输出 | Worker 协调、报告关联与发布事务 |
| 现有内核、源重建、证据重放和本地缓存 | 页面、精确引用、搜索、权限和撤回 |

首个真实样例选一个小型代数理论/定理包，第二个项目导入它证明一个新结果；另用集合论包检验理论环境差异。首次分发不以全量 mathlib 迁移作为前置条件，也不声称已有能力替代 mathlib。

必须演示：同内容重定位身份一致；漏掉一个坏文件不能通过 coverage；替换依赖后旧证据不适用；同名模块不同版本明确拒绝；下载缓存不能伪造本地来源；`ProvedStatement` 开发假设不能通过发布；超时与基础设施失败保持未解决；两个发布者争同一版本只有一个事务提交；撤销后新解析不能无提示选中该版本。

本轮尚未实现这些接口。最先需要落地的是 Slate 的“完整包清单 + 结构化检查报告”适配实验，它决定真实发布 gate 能支持哪些内容；数据库表和 UI 可以并行开发，但不能用模拟绿灯填补这个缺口。
