# 1.5.1 验证记录

- 基线：`3e571d3bc41ab2af341b06da0ac88237e76593a0` 加本次补丁：移除新标签页接管、版本升至 1.5.1、更新说明与发布包测试版本读取。
- 源码内容指纹 SHA-256：`15c8013a130dcb4708a7371328b16bee0fb711a82ebdefbe0cad2d1aad88f786`。计算相对路径到文件 SHA-256 的映射，使用排序且紧凑的 JSON 再取 SHA-256；排除 `.git`、`dist`、`__pycache__`、`node_modules`、`.pyc`、macOS 元数据及本记录自身。
- 发布 ZIP：`TorranceTabs-v1.5.1.zip`，SHA-256：`ed333080d69de4d8818ded31d21a502c1139c3a3a748bd4640d60d4790263247`。
- 构建模式：原生 ES Modules / Manifest V3，无生产依赖；安装器只使用 Python 标准库和 curl。检查命令未使用额外 flags。

## 实际执行

| 环境 | 命令 / 检查 | 结果 |
| --- | --- | --- |
| macOS，`/opt/homebrew/bin/node` 24.10.0、`/opt/homebrew/bin/python3` 3.13.7 | `make check test package` | 退出码 0；116 扩展测试、20 安装器测试通过，无跳过 |
| zhr Linux，`/usr/local/bin/node` 22.9.0、`/usr/bin/python3` 3.6.8 | `make check test package` | 退出码 0；116 扩展测试、20 安装器测试通过，无跳过 |
| zhr Linux | `python3 -m zipfile -t dist/TorranceTabs-v1.5.1.zip`；在 dist 中执行 `sha256sum -c TorranceTabs-v1.5.1.zip.sha256` | 均退出码 0；两台机器的发布包 SHA-256 一致 |
| macOS，隔离临时目录 | 使用真实 1.5.0 发布 ZIP 安装，再使用 1.5.1 发布 ZIP 更新并检查安装结果 | 退出码 0；新版不含 `chrome_url_overrides`，旧版备份仍保留该配置；权限、后台、工具栏、快捷键及设置入口与旧版一致，看板文件保留 |

日志保存在维护工作区：本机 `outputs/TorranceTabs-v1.5.1-local-validation.log`，zhr `code/TorranceTabs-v1.5.1-validation.log`。检查的是本次相同源码；传输仅使用 SSH 标准输入。1.5.0 的历史验证记录保留在 Git 标签中。

## 范围

安装器和升级检查使用隔离临时目录，不操作真实 Chrome 配置、扩展注册、规则或稍后读。扩展测试模拟 Chrome API；本次未在真实 Chrome 中重新加载验证。实际更新仍需在 Chrome 扩展管理页点击“重新加载”，再新建标签页。GitHub Actions 与正式资产应在推送发布后另行核对，离线验证不替代公网下载验证。
