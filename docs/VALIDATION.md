# 1.6.1 验证记录

- 基线：`f18bb61ca7ff6584fd8586c581ff131949de456b` 加更新检查兼容修复；六项功能沿用已审查的 1.6.0。
- 源码内容指纹 SHA-256：`a7d78a8304b570e6c52a723906d454338293b266dd93dc3013465f9529ffc4bd`。相对路径到文件 SHA-256 映射，排序且紧凑的 JSON 再取 SHA-256；排除 `.git`、`dist`、`__pycache__`、`node_modules`、`.pyc`、macOS 元数据和本记录自身。
- 发布 ZIP：`TorranceTabs-v1.6.1.zip`，SHA-256：`042bef6f20274f9034e5f87dbbf626317682a0693b52fca98b3e395c5283ac77`。
- 构建模式：原生 ES Modules / Manifest V3，无生产依赖；安装器仅 Python 标准库和 curl。检查命令无额外 flags。

## 最终执行结果

| 环境 | 命令 / 检查 | 结果 |
| --- | --- | --- |
| macOS：`/opt/homebrew/bin/node` 24.10.0，`/opt/homebrew/bin/python3` 3.13.7 | `make check test package` | 退出0；161扩展测试、20安装器测试通过，无跳过 |
| zhr Linux：`/usr/local/bin/node` 22.9.0，`/usr/bin/python3` 3.6.8 | `make check test package` | 退出0；161扩展测试、20安装器测试通过，无跳过 |
| zhr | `python3 -m zipfile -t dist/TorranceTabs-v1.6.1.zip`；dist内`sha256sum -c TorranceTabs-v1.6.1.zip.sha256` | 均退出0；两台机器ZIP SHA相同 |
| macOS 隔离目录 | 真实1.5.1 ZIP安装→1.6.0 ZIP更新（六项功能）；1.6.1 为相同生产布局的兼容修复 | 退出0；旧版备份保留，新版无新标签页接管，工具箱及核心模块齐全 |
| 静态发布边界 | 新旧manifest权限比较、4个快捷命令、ZIP内容检查 | 退出0；必要及可选权限不变，不包含测试或UI预览桩 |
| 独立审查 | 最终核心定向68项及工作区8项，源码/权限/版本/界面消息核对 | 退出0；已发现的关闭、恢复、并发导航、普通窗口选择及编辑保护问题均修复，无剩余阻断 |

Lead亲自执行最终两台机器的完整检查和实包升级。源码传输与Git推送通过SSH，未使用scp。

日志保存在维护工作区：本机 `outputs/TorranceTabs-v1.6.1-local-validation.log`，zhr `code/TorranceTabs-v1.6.1-validation.log`。

## 功能回归与限制

测试覆盖导入预览后并发编辑、跨worker token、合并冲突/上限/旧数据兼容、完整URL复核、忽略参数编码保真、关闭前journal、容量拒绝与清空、恢复claim前后导航、预期loading/pending分组、目标共享状态变化、跨会话窗口复用、操作互斥和更新响应验证。

真实Chrome中的HTTP合成API预览检查了工具箱、快捷面板、参数比较、恢复结果反馈，以及延迟保存时禁用编辑、完成后恢复控件；这是界面验证，不等同于真实Chrome扩展API联调。文件选择UI因自动化连接未开放文件URL访问而未完成，未更改权限或绕过限制。未在真实网页批量关闭/恢复标签；未验证Chrome原生关闭确认、实际注入与权限弹窗。Chrome最终状态读取到分组/关闭调用之间仍非原子。

正式GitHub CI、Release和公网最新版本下载应在推送后另行核对；该记录不以离线检查替代公网检查。用户仍需在Chrome扩展管理页重新加载扩展，新标签页继续保持原样。

## 更新检查兼容修复

1.6.0 正式安装已通过公网闭环，但本机实测 GitHub API 返回403。1.6.1 不新增权限：已有GitHub授权时才对固定发布页做HEAD并校验最终版本地址；没有该授权时明确返回手动查看入口，不误报“暂无更新”。新增3项测试，更新模块6/6通过，独立审查批准。curl固定最新发布页HEAD实测200，但不替代真实扩展权限/CORS验证。
