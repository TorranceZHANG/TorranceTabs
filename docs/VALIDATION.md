# 1.7.0 验证记录

- 基线：`7e450e5b73aef1af6dfc3a4ddde7a1542dd47598`（1.6.1）。
- 用户已审核的 UI 副本完整 extension 指纹：`af5a9a99251135c7386b91e9a0841c8cd710df7c02373d25e9ae262656cd81a9`；发布扩展与该副本逐文件一致，仅 manifest/package 版本调整为 1.7.0。
- 源码内容指纹 SHA-256：`51a076bde572b00200ba5b9a7718fe026039f1e0b65d4f88ac11098c097ab304`。算法为相对路径到文件 SHA-256 映射，排序且紧凑 JSON 再取 SHA-256；排除 `.git`、`dist`、`__pycache__`、`node_modules`、`.pyc` 和本记录自身。
- 发布 ZIP：`TorranceTabs-v1.7.0.zip`，SHA-256：`e35bcc95853dfc4cd322c442d5844188539820d9c5b7064fecda4ad7143bc22b`。
- 构建模式：原生 ES Modules / Manifest V3，无新增生产依赖；安装器仅 Python 标准库和 curl。检查无额外 flags。

## 执行证据

| 环境 | 实际命令 / 检查 | 结果 |
| --- | --- | --- |
| macOS：`/opt/homebrew/bin/node` 24.10.0，Homebrew Python 3.13.7 | `make check test package` | 退出 0；161 项扩展测试、20 项安装器测试通过，无跳过 |
| zhr Linux：`/usr/local/bin/node` 22.9.0，`/usr/bin/python3` 3.6.8 | `make check test package` | 退出 0；161 项扩展测试、20 项安装器测试通过，无跳过 |
| macOS / zhr | ZIP SHA-256 比较与 ZIP CRC 检查 | 退出 0；两台机器的正式包字节一致 |
| 发布边界 | 已审核 UI 逐文件比较、manifest 字段比较、ZIP 条目检查 | 退出 0；权限和快捷命令不变，无新标签页接管；`ui.css`、`ui-dialog.js` 已打包，不含测试、预览服务器或 API 模拟桩 |
| Chrome 本机 HTTP 预览 | 使用合成数据操作实际界面源码 | 快捷清理反馈、确认/取消/Escape、删除后的焦点、浮层失败重试和保留均已观察；五类页面在 390px 下无横向控件溢出 |

快捷面板常规状态约 576px，清理成功状态约 594px。确认框取消和 Escape 后返回触发按钮，确认删除导致按钮消失时返回主内容。已检查空状态、错误反馈以及加载提示。UI 小字和 placeholder 使用共享可读颜色。

日志保存在维护工作区；zhr 验证日志位于仓库外。源码传输及 Git 推送使用 SSH 标准输入流，经 zhr 执行，不使用 scp。

## 限制与更新方式

HTTP 预览使用隔离的模拟 Chrome API，不等同于真实扩展的跨窗口关闭、恢复、注入、文件选择或授权联调。未改变这些核心业务协议和存储格式。未重复真实网页破坏性操作，也未验证其他系统或屏幕阅读器。

本机文件更新沿用原加载路径和扩展注册，并保留旧文件备份。Chrome 仍需重新加载扩展才会使用新版本；规则和链接继续保存在原扩展的本机存储中，新标签页保持原样。

GitHub CI、正式 Release 与公网下载在推送后另行核对，不以本地打包结果替代。其他机器运行 README 中的安装/更新命令，再在 Chrome 扩展管理页重新加载。
