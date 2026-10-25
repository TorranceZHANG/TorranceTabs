# 1.6.0 验证记录

- 基线：`1b8655ecef1e3eef193be691cf0f8464e791f606` 加本次六项功能及审查修复。
- 源码内容指纹 SHA-256：`5fc10e430582dbdb94b17066988942b7ccbf13d74234d238171a4d6c0fc33154`。相对路径到文件 SHA-256 映射，排序且紧凑的 JSON 再取 SHA-256；排除 `.git`、`dist`、`__pycache__`、`node_modules`、`.pyc`、macOS 元数据和本记录自身。
- 发布 ZIP：`TorranceTabs-v1.6.0.zip`，SHA-256：`d8a3b6fdb8a75b7e2cf29502eb2f98bdbf22fcb380ed7bbb58f59d16edd8b85e`。
- 构建模式：原生 ES Modules / Manifest V3，无生产依赖；安装器仅 Python 标准库和 curl。检查命令无额外 flags。

## 最终执行结果

| 环境 | 命令 / 检查 | 结果 |
| --- | --- | --- |
| macOS：`/opt/homebrew/bin/node` 24.10.0，`/opt/homebrew/bin/python3` 3.13.7 | `make check test package` | 退出0；158扩展测试、20安装器测试通过，无跳过 |
| zhr Linux：`/usr/local/bin/node` 22.9.0，`/usr/bin/python3` 3.6.8 | `make check test package` | 退出0；158扩展测试、20安装器测试通过，无跳过 |
| zhr | `python3 -m zipfile -t dist/TorranceTabs-v1.6.0.zip`；dist内`sha256sum -c TorranceTabs-v1.6.0.zip.sha256` | 均退出0；两台机器ZIP SHA相同 |
| macOS 隔离目录 | 真实1.5.1 ZIP安装→最终1.6.0 ZIP更新 | 退出0；旧版备份保留，新版无新标签页接管，工具箱及核心模块齐全 |
| 静态发布边界 | 新旧manifest权限比较、4个快捷命令、ZIP内容检查 | 退出0；必要及可选权限不变，不包含测试或UI预览桩 |
| 独立审查 | 最终核心定向68项及工作区8项，源码/权限/版本/界面消息核对 | 退出0；已发现的关闭、恢复、并发导航、普通窗口选择及编辑保护问题均修复，无剩余阻断 |

Lead亲自执行最终两台机器的完整检查和实包升级。源码传输与Git推送通过SSH，未使用scp。

日志保存在维护工作区：本机 `outputs/TorranceTabs-v1.6.0-local-validation.log`，zhr `code/TorranceTabs-v1.6.0-validation.log`。

## 功能回归与限制

测试覆盖导入预览后并发编辑、跨worker token、合并冲突/上限/旧数据兼容、完整URL复核、忽略参数编码保真、关闭前journal、容量拒绝与清空、恢复claim前后导航、预期loading/pending分组、目标共享状态变化、跨会话窗口复用、操作互斥和更新响应验证。

真实Chrome中的HTTP合成API预览检查了工具箱、快捷面板、参数比较、恢复结果反馈，以及延迟保存时禁用编辑、完成后恢复控件；这是界面验证，不等同于真实Chrome扩展API联调。文件选择UI因自动化连接未开放文件URL访问而未完成，未更改权限或绕过限制。未在真实网页批量关闭/恢复标签；未验证Chrome原生关闭确认、实际注入与权限弹窗。Chrome最终状态读取到分组/关闭调用之间仍非原子。

正式GitHub CI、Release和公网最新版本下载应在推送后另行核对；该记录不以离线检查替代公网检查。用户仍需在Chrome扩展管理页重新加载扩展，新标签页继续保持原样。
