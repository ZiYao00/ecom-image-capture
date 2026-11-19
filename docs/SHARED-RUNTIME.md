# 可选共享 FFmpeg、FFprobe 与 OCR 运行时

采集主流程仅要求 Windows、Node、Chrome MCP 与 Eagle MCP。图片 OCR 和详情长图拼接是可选能力。

## 1. 不复制原图的 Eagle 直读拼接

`node scripts/ecom.mjs stitch-eagle <商品ID> [宽度] [--date YYYY-MM-DD] [--check]`

程序直接读取 Eagle 当前库的已分类图片路径、SHA-256、尺寸和序号；使用本机 FFmpeg 进行拼接，仅将结果导入 Eagle 商品 ID 根目录。**无须先用 `ecom export` 导出整套原图。**

> JPEG 长图只能使用动画素材的静态帧。GIF/动画 WebP 仍在 Eagle 中保留原文件与连续预览。

## 2. FFmpeg 路径优先级

在被 Git 忽略的 `config/local.json` 中按需设置：

```json
{
  "ffmpegExecutablePath": "C:/your-tools/ffmpeg/bin/ffmpeg.exe",
  "ffprobeExecutablePath": "C:/your-tools/ffmpeg/bin/ffprobe.exe"
}
```

优先级：环境变量 `STITCH_FFMPEG` / `STITCH_FFPROBE` > 本机配置中的路径 > 系统 PATH。普通 JPEG/GIF 的拼接可用旧版 FFmpeg，但部分 **动画 WebP** 需要 FFmpeg 9 或经实际验证的其他支持版本。

Eagle 内置 FFmpeg 插件属于 Eagle 管理的依赖；不要通过直接覆盖其目录来升级。Agent 直接使用本机独立 FFmpeg，既支持新格式又避免影响其他 Eagle 插件。

## 3. OCR 可选运行时

支持环境变量 `SHARED_PYTHON`、`ECOM_OCR_PYTHON` 及本机配置 `sharedPython`、`ocrPython`。不存在时按项目安装说明使用可选 OCR 安装流程，不使 OCR 依赖阻止正常图片采集。

## 4. 核验

```powershell
node scripts/ecom.mjs doctor
node scripts/ecom.mjs archive <商品ID> --check
node scripts/ecom.mjs stitch-eagle <商品ID> --check
node --test tests/*.test.mjs
```

真实导入必须通过 Eagle 回读实体文件、宽高、SHA-256、目标文件夹关联；如 Eagle 返回 ID 但缺少实体文件，保留状态并停止自动重复提交。
