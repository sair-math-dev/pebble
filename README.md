# Pebble

SAIR 的科研协作与发布平台：让研究从可阅读的论文，成为可引用、可验证、可复用的项目。

Pebble 围绕同一个研究项目连接论文阅读、形式化代码、数据、包发布、讨论和项目协作。它与 Slate 语言工具链及 Clay 科研工作环境协同，服务于开放科学模型计划。

当前重点是 Cargo 式的包管理、构建检查与发布能力。网站结构参考 Hugging Face Hub，以研究卡、包目录、结果页和使用入口组织内容，保留 GitHub 熟悉的文件/版本导航。研究问题、结论、假设、作者、精确引用和复用是页面中心；完整 Git 托管和复杂项目协作不是首个版本的前置条件。

当前处于产品与架构设计阶段，尚无可运行服务。写作编辑与实时协作属于 Clay；Pebble 提前准备项目、权限、版本、成果提交与引用接口，但不提供写作协作功能。论文由 Clay 或其他外部工具产出后提交到 Pebble。

- [产品与架构设计草案](docs/product-architecture.md)
- [设计依据与需求映射](docs/requirements.md)
- [技术研究与实现方案](docs/technical-research.md)
- [Slate 包管理、验证与发布协议](docs/package-verification.md)
- [定理依赖 DAG 与 agent 探索](docs/theorem-index.md)

本仓库承载 Pebble 平台。Slate 的编译器、可信内核和本地包管理客户端留在 Slate 仓库；双方通过明确的包与验证协议连接。
