# 1.7.1 验证记录

- 基线：`c87553db77d3ba73910421d1abe00ea115b37914`（1.7.0）。生产差异仅 `quick.css` 和 manifest/package 版本号；业务 JS、存储协议、权限和四个快捷命令均不变，无新标签页接管。
- 源码内容指纹 SHA-256：`b43593bc42d24ba38f4d7e6c64aa1c5c3fcad8d7189bf64ef2ed5bcb2905e736`。算法为相对路径到文件 SHA-256 映射，排序且紧凑 JSON 再取 SHA-256；排除 `.git`、`dist`、`__pycache__`、`node_modules`、`.pyc` 和本记录自身。
- 发布 ZIP：`TorranceTabs-v1.7.1.zip`，SHA-256：`7dbb87e83943e1606e4bac0dd7b3a844449d0e757788c9b09e29b74725876c14`。
- 构建模式：原生 ES Modules / Manifest V3，无新增生产依赖，检查无额外 flags。

## 根因与针对性验证

1.7.0 的 `body { width:400px; max-width:100vw }` 会在内容自动定宽时被较小的初始视口钳住。Chrome 工具栏弹窗会[按内容自动确定大小](https://developer.chrome.com/docs/extensions/reference/api/action#popup)；原 CSS 无法向宿主请求设计宽度，头部“工具箱”因此分成三行。修复为文档和内容的明确 400px 最小宽度，移除视口上限，并禁止头部操作区收缩或换行。

在本机 Chrome 中，使用真实 quick.html/quick.css 和合成数据，通过内容宽度反馈模拟自动定宽，得到：

| 初始视口 | 1.7.0 最终宽度 / 工具箱行数 | 1.7.1 最终宽度 / 工具箱行数 |
| --- | --- | --- |
| 25px | 228px / 3 行 | 400px / 1 行 |
| 230px | 230px / 3 行 | 400px / 1 行 |
| 320px | 320px / 1 行 | 400px / 1 行 |
| 400px | 400px / 1 行 | 400px / 1 行 |

每种初始宽度均反复测量六轮，修复后文档、body 和宿主宽度稳定为 400px。“工具箱”按钮高度为 32px。旧版表现与用户截图中的约 228px 弹窗和三行按钮一致。独立只读审查复核了证据、CSS 作用域及发布包，无阻断项。

## 构建与回归

| 环境 | 实际命令 / 检查 | 结果 |
| --- | --- | --- |
| macOS：`~/.nvm/versions/node/v22.22.3/bin/node` 22.22.3，Homebrew Python 3.13.7 | `make check test package` | 退出 0；161 项扩展测试和 20 项安装器测试通过，无跳过 |
| zhr Linux：`/usr/local/bin/node` 22.9.0，`/usr/bin/python3` 3.6.8 | `make check test package` | 退出 0；161 项扩展测试和 20 项安装器测试通过，无跳过 |
| macOS / zhr | ZIP SHA-256、CRC 与源码成员比较 | 退出 0；42 条目，两机打包字节一致；quick.css 修复已包含，不含测试、预览服务器或 API 模拟桩 |
| 独立审查 | 文件差异、manifest、CSS 引用及尺寸证据断言 | 退出 0；样式仅作用于工具栏 quick.html，其他扩展页面不受影响 |

完整日志及尺寸 JSON/对比图保存在维护工作区，zhr 日志位于仓库外。源码传输和 Git 推送使用 SSH，经 zhr 执行，不使用 scp。

## 边界

尺寸检查模拟内容自动定宽，未直接自动化检查受保护的原生 action popup。发布后需重新加载扩展并打开工具栏面板做一次目视确认。未覆盖其他操作系统、浏览器缩放或本地化；若在小于 400px 的普通 iframe 中手动打开专用 quick.html，会出现横向溢出。

本机更新沿用原加载目录和扩展注册，保留旧文件备份，不读写 Chrome 中的规则或配置。GitHub CI、Release 与公网更新链路在推送后另行核对。
