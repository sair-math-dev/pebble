# 本地 Slate 包检查接入实验

这是源码快照、真实检查报告和干净目录复用的开发实验。没有注册服务、版本解析器、生产 worker 隔离或正式发布。`package_snapshot.py` 的实验格式不是拟议的 `slate.toml` / `slate.lock`，也不是冻结的 Pebble 注册协议。

## 运行

需要 Python 3.10+ 和带有 `check-package ROOT` 的 Slate 编译器。本轮 Slate 改动位于独立仓库工作树 `/home/farmer/slate-pebble`，分支 `integrate/pebble-package-report`，从远端 main 的 `bab9a76e7864c33e4a90ec6f1b41ba972920d4bf` 开始；接口属于该分支，不能假定上游 main 已提供。

先按 Slate README 安装其固定工具链，在 Slate 仓库构建：

```sh
cargo build --locked --release --manifest-path tools/slate-dev/Cargo.toml
tools/slate-dev/target/release/slate-dev setup
tools/slate-dev/target/release/slate-dev cargo build --locked --release --manifest-path tools/slatec/Cargo.toml
```

已有独立工具链时用 `setup --check` 检查，避免重复安装。在 Pebble 仓库运行：

```sh
python3 experiments/package_reuse.py --slatec /home/farmer/slate-pebble/tools/slatec/target/release/slatec
python3 -m unittest discover -s experiments -p 'test_*.py'
```

`--slatec` 可指向其他位置的同一接口构建。`--timeout` 设置每次检查的秒数，默认 30；`--output` 可指定尚不存在的产物目录，默认写入忽略的 `.artifacts/package-reuse-<UTC时间>/`。已有目录不会覆盖。失败时保留输入、原始报告和诊断，并返回非零退出码。

## 实际检查路径

1. 将每个样例包全部文件记录为相对路径、长度及实际 SHA-256，存储内容 blobs。快照不包含自己的摘要，也不包含未来的检查结果。
2. 仅凭固定快照及 blobs 在新客户端目录重建 provider，调用 Slate 检查其完整目录。
3. 在另一个新目录中物化相同 provider 和 consumer，后者通过显式 import 证明新结果。另在独立成员关系理论中检查集合样例。
4. 把 Slate 原生 JSON 报告的完整文件清单与固定输入逐项核对，保留精确目标、环境、证据摘要及原始依赖信息。每次调用身份同时绑定编译器二进制摘要，检查前后核对源文件和二进制。
5. 比较同一内容重定位后的输入与全部定理证据绑定；检查隐藏失败文件、替换依赖环境和外来缓存拒绝路径。

样例及学术归属见 [fixtures/package-reuse/README.md](fixtures/package-reuse/README.md)。代数包含三个定理，consumer 增加逆运算对合律，独立集合样例增加一个定理。这是已有数学结果的形式化样例，不声称科学新颖性。

2026-09-09 已实测以上五个定理通过：相同内容重定位后输入及证据绑定一致；未被导入的隐藏坏文件使检查不完整；替换依赖理论产生新的输入及证据绑定；外来缓存在源码转移前被拒绝。Pebble 的六项单元测试覆盖快照完整性、路径/链接/缓存、损坏 blob、格式与目录边界、真实进程超时、缺失或不合约报告。Slate 的针对性回归另覆盖完整声明与跨模块导入、尾部坏定义及未用坏理论、缺外部证据与开发假设参数、普通程序、重复 ModuleId 和不支持的文件。未运行无关编译器全套测试，也未测试尚未实现的注册、权限撤销和发布事务。

## 报告与限制

`summary.json` 是实验结果；每次调用另有 `input.json`、`invocation.json`、Slate 原始 `report.json` 和 `stderr.txt`。`snapshots.json` 与 `blobs/` 保留实际转移的内容。所有摘要在运行时生成，不把一次运行的摘要复制进源码维护。

`checked` 表示真实 Slate 报告声明当前支持范围内的源码检查完整，并通过了输入关联核对；`incomplete` 表示检查报告明确未完成；`timeout` 和 `error` 表示未解决。超时会终止整个检查进程组，不能解释为数学命题为假。单元测试中的 sleep 进程仅验证超时收集行为，不模拟数学接受。

Slate 报告中的 `complete` 是源码检查覆盖，`release_eligible` 保持 `false`；Pebble 实验始终记录 `published: false`。正式发布还需要精确依赖锁、受控工具链与政策、权限、审核、隔离执行及发布事务。本轮没有实现这些服务，也没有安装或信任作者提交的 `.slateobj` / `.slatecache`。

这是受控本地文件实验：只接受有限大小的普通文件和可移植 ASCII 路径，拒绝链接、路径碰撞及对象/缓存路径。没有网络上传、归档解包或敌对并发文件系统接口。干净目录和精简子进程环境不能替代生产沙箱；编译器二进制摘要及报告中的工具链身份也不能替代完整部署镜像身份。

当前 Slate 接口以一个目录作为完整检查范围，因此消费时把已固定的多个包物化到同一工作区；未实现 SemVer 求解、多包锁文件或注册版本冲突策略。报告中的直接证明依赖保留 Slate 原始证据引用，部分引用仍带事务内身份，尚不能直接当作全球定理 DAG 的稳定端点。本轮没有声称完成 DAG、远程发布或 HTTP 下载。
