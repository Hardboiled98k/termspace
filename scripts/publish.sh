#!/bin/bash
# 把打好的包发到自建更新源。
#
# 配置放在 ~/.termspace-publish.env（**不进仓库**），一次填好：
#
#   PUBLISH_HOST=user@your-vps            # ssh 目标
#   PUBLISH_PATH=/var/www/updates/termspace/   # 服务器上的目录（结尾带斜杠）
#   PUBLISH_URL=https://updates.你的域名/termspace/  # 对应的公开地址，用来验收
#
# 用法：先 npm run dist:signed，再跑这个脚本。
set -euo pipefail

CONF="$HOME/.termspace-publish.env"
[ -f "$CONF" ] || { echo "缺 $CONF —— 见本脚本头部的三个变量" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${PUBLISH_HOST:?}" "${PUBLISH_PATH:?}" "${PUBLISH_URL:?}"

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
# **两个架构的 zip 都要传**：electron-updater 的 MacUpdater 是按
# `process.arch` 过滤 yml 里的 files —— arm64 机器只认 url 里带 "arm64" 的，
# Intel 机器只认不带的。少传一个，那个架构的用户会读到"有新版本"、
# 然后去下一个 404，更新永远失败且错误信息毫无线索。
ZIP_ARM="dist/Termspace-${VERSION}-arm64-mac.zip"
ZIP_X64="dist/Termspace-${VERSION}-mac.zip"
YML="dist/latest-mac.yml"

# ── 1. 产物齐不齐 ──
# zip 是 Squirrel 用的，yml 是客户端判断"有没有新版本"用的。
# **只传一个都会坏**：只有 zip 客户端不知道有新版本；只有 yml 客户端会 404。
for f in "$ZIP_ARM" "$ZIP_X64" "$YML"; do
  [ -f "$f" ] || { echo "缺 $f —— 先跑 npm run dist:signed（要出双架构）" >&2; exit 1; }
done

# yml 里列的 zip 必须都在本地 —— 否则等于对外宣告一个下不到的文件。
# 反过来不必查：dmg 也在 files 里，但 updater 只挑 zip，不影响。
while read -r u; do
  case "$u" in
    *.zip) [ -f "dist/$u" ] || { echo "yml 列了 $u 但 dist/ 里没有" >&2; exit 1; } ;;
  esac
done < <(awk '/^  - url: /{print $3}' "$YML")

# yml 里写的版本必须和包一致，否则客户端下下来的和它以为的不是一个东西
YML_VER=$(grep -m1 '^version:' "$YML" | awk '{print $2}')
[ "$YML_VER" = "$VERSION" ] || { echo "latest-mac.yml 写的是 $YML_VER，包是 $VERSION —— 重新打包" >&2; exit 1; }

# ── 2. 签名与公证 ──
# **未签名的包发出去等于发一个装不上的东西**：Squirrel 要求候选包满足
# 当前 app 签名导出的 designated requirement，签名不对客户端会静默失败。
# 两个架构分别验：x64 那份在本机跑不起来，签名却照样要对，
# 而 x64 用户装到坏包时你这边什么都看不到。
UNNOTARIZED=""
for APP in dist/mac-arm64/Termspace.app dist/mac/Termspace.app; do
  [ -d "$APP" ] || continue
  codesign --verify --deep --strict "$APP" || { echo "$APP 签名校验没过，别发" >&2; exit 1; }
  spctl --assess --type execute "$APP" 2>&1 | grep -q "Notarized" || UNNOTARIZED="$UNNOTARIZED $APP"
done
if [ -n "$UNNOTARIZED" ]; then
  echo "⚠️  这些包**没过公证**：$UNNOTARIZED" >&2
  echo "   自己用没问题，但别人下载会被 Gatekeeper 拦。" >&2
  read -r -p "确定要发吗？[y/N] " ok
  [ "$ok" = "y" ] || exit 1
fi

# ── 3. 上传 ──
# **先传 zip 再传 yml**：反过来的话，客户端在这两次传输之间检查更新，
# 会读到新版本的 yml 却下载到一个还不存在的 zip。
echo "→ $PUBLISH_HOST:$PUBLISH_PATH"
for z in "$ZIP_ARM" "$ZIP_X64"; do
  rsync -avP "$z" "$PUBLISH_HOST:$PUBLISH_PATH"
  [ -f "${z}.blockmap" ] && rsync -avP "${z}.blockmap" "$PUBLISH_HOST:$PUBLISH_PATH"
done
rsync -avP "$YML" "$PUBLISH_HOST:$PUBLISH_PATH"

# ── 4. 验收 ──
# 传上去不等于取得到：目录权限、nginx 配置、MIME 类型都可能挡住。
echo "→ 验收 $PUBLISH_URL"
code=$(curl -sS -o /tmp/pub-check.yml -w '%{http_code}' "${PUBLISH_URL}latest-mac.yml")
[ "$code" = "200" ] || { echo "取不到 latest-mac.yml（HTTP $code）" >&2; exit 1; }
diff -q "$YML" /tmp/pub-check.yml >/dev/null || { echo "线上的 yml 和本地不一致" >&2; exit 1; }

# 两个 zip 都要真取得到 —— 只验一个的话，另一个架构的用户是唯一的发现者
for z in "$ZIP_ARM" "$ZIP_X64"; do
  b=$(basename "$z")
  zcode=$(curl -sS -o /dev/null -w '%{http_code}' -r 0-1 "${PUBLISH_URL}${b}")
  [ "$zcode" = "200" ] || [ "$zcode" = "206" ] || { echo "取不到 $b（HTTP $zcode）" >&2; exit 1; }
done

echo "✅ $VERSION 已发布。客户端 6 小时内会自己发现，或在设置 → 更新里点「立即检查」。"
