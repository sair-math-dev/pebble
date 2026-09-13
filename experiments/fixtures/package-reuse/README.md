# 真实包复用样例

这些目录是本地集成测试输入，不是注册服务中的正式发布。目录分别代表分发单位；具体包清单、锁文件、版本和内容摘要由实际工具链与实验运行生成，本文不手工维护摘要，也不定义第二套 Slate 依赖解析语义。

| 输入目录 | 精确身份 | 数学内容与依赖 |
| --- | --- | --- |
| `algebra-provider` | 理论 `Pebble.Fixtures.Algebra.Group`；模块 `Pebble.Fixtures.Algebra.Inverses` | 左逆唯一性、右逆唯一性、左逆也是右逆；无外部包依赖 |
| `algebra-consumer` | 模块 `Pebble.Fixtures.Algebra.Involution` | 显式导入 provider，以其右逆唯一性证明逆运算是对合；同一精确群理论 |
| `set-membership` | 理论 `Pebble.Fixtures.Sets.Membership`；模块 `Pebble.Fixtures.Sets.Transport` | 等式替换保持成员关系；无外部包或群理论依赖 |

群理论显式给出结合律、左右单位元与左右逆元五条公理。实际使用的假设由 Slate 检查报告导出，不以此处的理论公理列表替代。集合样例只声明 `Set` 和 `member`，无非逻辑公理；它用于检验不同环境的通用检查路径，不声称提供完整 ZF/ZFC 集合论。

## 来源和归属

provider 的理论与三个证明改编自 `sair-math-dev/slate` 在提交 `bab9a76e7864c33e4a90ec6f1b41ba972920d4bf` 的以下源码：

- `examples/algebra/magma.slate`
- `examples/algebra/monoid.slate`
- `examples/algebra/group.slate`
- `examples/algebra/inverse_uniqueness.slate`

原形式化来源为 Slate 项目贡献者；本次为 Pebble 集成样例合并理论层级并更名，源文件已标明修改。上游代码采用 Apache-2.0，本目录附带其 [许可证](LICENSE)。具体研究成果属于经典初等群论，本样例不声明数学新颖性，也不从 Git 操作者推断原结果作者。

consumer 和集合成员替换证明是本次集成任务新增的样例形式化，数学内容分别是经典逆运算对合律和一阶逻辑等式替换，不声明为新发现。样例由 Pebble 项目维护；这一身份与原数学结果作者、上游形式化贡献者分开。

## 现有单目标 CLI 的检查入口

从 Pebble 仓库根目录运行；`SLATEC` 指向已构建的固定 Slate 工具链。每次使用新临时缓存目录。以下命令是逐个定理的诊断入口；它们不能替代覆盖所有文件和声明的完整包报告，更不自动形成正式发布。

```sh
SLATEC=/absolute/path/to/slatec
FIXTURE=experiments/fixtures/package-reuse
SLATE_FIXTURE_CACHE=$(mktemp -d)
"$SLATEC" check "$FIXTURE/algebra-provider/src/inverses.slate" \
  --theorem Pebble.Fixtures.Algebra.Inverses.LeftInverseUnique \
  --theory "$FIXTURE/algebra-provider/theory/group.slate" \
  --module-cache-mode replay --module-cache-root "$SLATE_FIXTURE_CACHE" --explain
```

同一源文件中的另外两个目标是 `Pebble.Fixtures.Algebra.Inverses.RightInverseUnique` 和 `Pebble.Fixtures.Algebra.Inverses.LeftInverseIsRightInverse`，都必须单独检查。

```sh
SLATE_FIXTURE_CACHE=$(mktemp -d)
"$SLATEC" check "$FIXTURE/algebra-consumer/src/involution.slate" \
  --theorem Pebble.Fixtures.Algebra.Involution.InverseInvolution \
  --theory "$FIXTURE/algebra-provider/theory/group.slate" \
  --module-source "$FIXTURE/algebra-provider/src/inverses.slate" \
  --module-cache-mode replay --module-cache-root "$SLATE_FIXTURE_CACHE" --explain

SLATE_FIXTURE_CACHE=$(mktemp -d)
"$SLATEC" check "$FIXTURE/set-membership/src/transport.slate" \
  --theorem Pebble.Fixtures.Sets.Transport.MembershipPreserved \
  --theory "$FIXTURE/set-membership/theory/sets.slate" \
  --module-cache-mode replay --module-cache-root "$SLATE_FIXTURE_CACHE" --explain
```

生成的对象、缓存、诊断和检查报告放在临时运行目录，不提交到 fixture。干净客户端复用时应复制固定源码与依赖到新的位置，再由 Slate 重新构建和检查；修改依赖内容必须改变输入身份并重新检查。
