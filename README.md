# Pebble

SAIR 的科研协作与发布平台：让研究从可阅读的论文，成为可引用、可验证、可复用的项目。

Pebble 围绕同一个研究项目连接论文阅读、形式化代码、数据、包发布、讨论和项目协作。它与 Slate 语言工具链及 Clay 科研工作环境协同，服务于开放科学模型计划。

当前重点是 Cargo 式的包管理、构建检查与发布能力，以及 GitHub 风格的包浏览界面。完整 Git 托管和复杂项目协作不是首个版本的前置条件。

当前处于产品与架构设计阶段，尚无可运行服务。当前范围不包含论文写作编辑器或实时共同编辑；论文在外部工具中写作后提交到 Pebble。

- [产品与架构设计草案](docs/product-architecture.md)
- [设计依据与需求映射](docs/requirements.md)
- [技术研究与实现方案](docs/technical-research.md)
- [Slate 包管理、验证与发布协议](docs/package-verification.md)

本仓库承载 Pebble 平台。Slate 的编译器、可信内核和本地包管理客户端留在 Slate 仓库；双方通过明确的包与验证协议连接。
