#!/bin/bash
# 把打好的包发到自建更新源。
#
# 配置放在 ~/.termscape-publish.env（**不进仓库**），一次填好：
#
#   PUBLISH_HOST=user@your-vps            # ssh 目标
#   PUBLISH_PATH=/var/www/updates/termscape/   # 服务器上的目录（结尾带斜杠）
#   PUBLISH_URL=https://updates.你的域名/termscape/  # 对应的公开地址，用来验收
#
# 用法：先 npm run dist:signed，再跑这个脚本。
set -euo pipefail

CONF="$HOME/.termscape-publish.env"
[ -f "$CONF" ] || { echo "缺 $CONF —— 见本脚本头部的三个变量" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${PUBLISH_HOST:?}" "${PUBLISH_PATH:?}" "${PUBLISH_URL:?}"

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
ZIP="dist/Termscape-${VERSION}-arm64-mac.zip"
YML="dist/latest-mac.yml"

# ── 1. 产物齐不齐 ──
# zip 是 Squirrel 用的，yml 是客户端判断"有没有新版本"用的。
# **只传一个都会坏**：只有 zip 客户端不知道有新版本；只有 yml 客户端会 404。
for f in "$ZIP" "$YML"; do
  [ -f "$f" ] || { echo "缺 $f —— 先跑 npm run dist:signed" >&2; exit 1; }
done

# yml 里写的版本必须和包一致，否则客户端下下来的和它以为的不是一个东西
YML_VER=$(grep -m1 '^version:' "$YML" | awk '{print $2}')
[ "$YML_VER" = "$VERSION" ] || { echo "latest-mac.yml 写的是 $YML_VER，包是 $VERSION —— 重新打包" >&2; exit 1; }

# ── 2. 签名与公证 ──
# **未签名的包发出去等于发一个装不上的东西**：Squirrel 要求候选包满足
# 当前 app 签名导出的 designated requirement，签名不对客户端会静默失败。
APP="dist/mac-arm64/Termscape.app"
if [ -d "$APP" ]; then
  codesign --verify --deep --strict "$APP" || { echo "签名校验没过，别发" >&2; exit 1; }
  if ! spctl --assess --type execute "$APP" 2>&1 | grep -q "Notarized"; then
    echo "⚠️  这个包**没过公证**。自己用没问题，但别人下载会被 Gatekeeper 拦。" >&2
    read -r -p "确定要发吗？[y/N] " ok
    [ "$ok" = "y" ] || exit 1
  fi
fi

# ── 3. 上传 ──
# **先传 zip 再传 yml**：反过来的话，客户端在这两次传输之间检查更新，
# 会读到新版本的 yml 却下载到一个还不存在的 zip。
echo "→ $PUBLISH_HOST:$PUBLISH_PATH"
rsync -avP "$ZIP" "$PUBLISH_HOST:$PUBLISH_PATH"
[ -f "${ZIP}.blockmap" ] && rsync -avP "${ZIP}.blockmap" "$PUBLISH_HOST:$PUBLISH_PATH"
rsync -avP "$YML" "$PUBLISH_HOST:$PUBLISH_PATH"

# ── 4. 验收 ──
# 传上去不等于取得到：目录权限、nginx 配置、MIME 类型都可能挡住。
echo "→ 验收 $PUBLISH_URL"
code=$(curl -sS -o /tmp/pub-check.yml -w '%{http_code}' "${PUBLISH_URL}latest-mac.yml")
[ "$code" = "200" ] || { echo "取不到 latest-mac.yml（HTTP $code）" >&2; exit 1; }
diff -q "$YML" /tmp/pub-check.yml >/dev/null || { echo "线上的 yml 和本地不一致" >&2; exit 1; }

zcode=$(curl -sS -o /dev/null -w '%{http_code}' -r 0-1 "${PUBLISH_URL}$(basename "$ZIP")")
[ "$zcode" = "200" ] || [ "$zcode" = "206" ] || { echo "取不到 zip（HTTP $zcode）" >&2; exit 1; }

echo "✅ $VERSION 已发布。客户端 6 小时内会自己发现，或在设置 → 更新里点「立即检查」。"
