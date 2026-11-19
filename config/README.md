# 每台 Windows 的本地配置

推荐首次运行 `node scripts/ecom.mjs setup`，它会调用底层 `setup.mjs`，由 `local.example.json` 建立本机 `local.json`；旧配置不覆盖，私有配置被 `.gitignore` 排除。

## 新用户默认配置

```json
{
  "chromeMode": "project",
  "chromeDebugPort": 9222,
  "eagleMcpUrl": "http://127.0.0.1:41596/mcp",
  "outputRoot": "output"
}
```

- `chromeMode=project`：**项目内部管理 Chrome MCP 连接**，Chrome MCP 从本项目 `node_modules` 定位；项目自有浏览器通过 `node scripts/browser.mjs start` 启动，专属登录 Profile 位于 `runtime/chrome-profile`。
- `chromeDebugPort`：项目专用 Chrome CDP 端口，默认 `127.0.0.1:9222`，只允许本机访问。
- `chromeExecutablePath`：Chrome 未安装到常见目录时，可以手工指定电脑上已安装的 Chrome 程序路径。
- `eagleMcpUrl`：**官方 Eagle MCP Server 插件**地址，不是 41595 Web API。
- `outputRoot`：默认 `output/`，不会覆盖历史商品记录中的原始输出路径。
- `storageMode`：公共默认 `copy`，保留本地主图/详情切片；设置为 `eagle` 则常规原图只归档 Eagle，不再复制整套源图到项目内。
- `ffmpegExecutablePath`、`ffprobeExecutablePath`：按需为本机现有 FFmpeg 设置路径，供 `ecom stitch-eagle` 直接读取 Eagle 原图拼接，优先级低于 `STITCH_FFMPEG` / `STITCH_FFPROBE`。
- `ocrPython`：可选，本项目 `runtime/ocr/.venv/Scripts/python.exe`；自行建立 OCR 环境时不需填写。

**已有 PC1** 使用 `chromeMode=shared` 与 `chromeAgentSettings`，可以继续维持，不自动迁移。`chromeMode=autoConnect` 是 Chrome 144+ 的可选授权模式，不是公共版默认值。

可选环境变量：`CHROME_CONNECTION_MODE`、`CHROME_MCP_ENTRY`、`ECOM_CHROME_DEBUG_PORT`、`EAGLE_MCP_URL`、`ECOM_OUTPUT_ROOT`、`ECOM_OCR_PYTHON`。

完整说明：[MCP 依赖](../docs/MCP-DEPENDENCIES.md) · [Windows 安装](../docs/INSTALL-WINDOWS.md)。
