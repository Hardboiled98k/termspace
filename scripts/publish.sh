#!/bin/bash
# 把打好的包发到自建更新源。支持两种后端，按 ~/.termspace-publish.env 里填了什么自动选。
#
# 【A】Cloudflare R2（当前用的）—— S3 兼容，出站免费，没有 Pages 那个 25 MiB 单文件上限
#      （我们的 zip 是 124 MB，Pages 根本传不上去）：
#
#   R2_ENDPOINT=https://<账号ID>.r2.cloudflarestorage.com
#   R2_BUCKET=termspace-updates
#   R2_ACCESS_KEY_ID=...
#   R2_SECRET_ACCESS_KEY=...
#   PUBLISH_URL=https://updates.termspace.app/
#
# 【B】自己的服务器（ssh + rsync）：
#
#   PUBLISH_HOST=user@your-vps
#   PUBLISH_PATH=/var/www/updates/termspace/
#   PUBLISH_URL=https://updates.你的域名/termspace/
#
# 这个文件**不进仓库**，建好后 chmod 600。
# 用法：先 npm run dist:signed，再跑这个脚本。
set -euo pipefail

CONF="$HOME/.termspace-publish.env"
[ -f "$CONF" ] || { echo "缺 $CONF —— 见本脚本头部的配置说明" >&2; exit 1; }
# 权限自查：里面有 R2 的 Secret Access Key，全局可读等于把发布权交出去 ——
# 而发布目录的控制权就是整条自动更新链路的信任根
# **硬失败，不是警告**：这个文件下一行就要被 `.` 进来执行。
# 全局可读 = R2 的 secret 泄漏；组/他人可写 = 别人能在你的权限下跑任意 shell，
# 进而劫持整条更新链路。警告完照样 source，等于这段检查不存在。
PERM=$(stat -f '%Lp' "$CONF" 2>/dev/null || stat -c '%a' "$CONF" 2>/dev/null || echo '?')
OWNER=$(stat -f '%u' "$CONF" 2>/dev/null || stat -c '%u' "$CONF" 2>/dev/null || echo '?')
case "$PERM" in
  600|400) ;;
  *) echo "❌ $CONF 权限是 ${PERM}，必须是 600 或 400。修：chmod 600 $CONF" >&2; exit 1 ;;
esac
[ "$OWNER" = "$(id -u)" ] || { echo "❌ $CONF 的属主不是你（uid ${OWNER}），拒绝 source" >&2; exit 1; }
[ -L "$CONF" ] && { echo "❌ $CONF 是符号链接，拒绝 source" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${PUBLISH_URL:?PUBLISH_URL 必填}"
# **必须走 https 且以斜杠结尾**。https：这个地址会被写进 app 的更新源，
# 明文意味着路上任何人都能换掉那个要替换整个 app 的包。
# 斜杠：后面全靠 "${PUBLISH_URL}latest-mac.yml" 拼接。
# 两条都在上传**之前**查 —— 否则传完 250 MB 才发现地址不对。
case "$PUBLISH_URL" in
  https://*/) ;;
  https://*) echo "PUBLISH_URL 结尾要带斜杠：${PUBLISH_URL}/" >&2; exit 1 ;;
  *) echo "PUBLISH_URL 必须是 https" >&2; exit 1 ;;
esac

# 选后端
if [ -n "${R2_BUCKET:-}" ]; then
  BACKEND=r2
  : "${R2_ENDPOINT:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}"
  command -v rclone >/dev/null || { echo "缺 rclone：brew install rclone" >&2; exit 1; }
  # **凭证走环境变量，绝不进 argv** —— ps 对同机所有用户可见。
  # rclone 的 :s3: 即用即弃后端会读这些 RCLONE_S3_* 变量。
  export RCLONE_S3_PROVIDER=Cloudflare
  export RCLONE_S3_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export RCLONE_S3_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export RCLONE_S3_ENDPOINT="$R2_ENDPOINT"
  # R2 不支持 S3 的分块校验头，不关掉会传一半报错
  export RCLONE_S3_NO_CHECK_BUCKET=true
elif [ -n "${PUBLISH_HOST:-}" ]; then
  BACKEND=ssh
  : "${PUBLISH_PATH:?}"
else
  echo "配置里既没有 R2_BUCKET 也没有 PUBLISH_HOST —— 见本脚本头部" >&2; exit 1
fi
echo "后端：$BACKEND"

# 上传一个文件。第三个参数是可选的 Cache-Control。
put() {
  local src="$1" name="$2" cc="${3:-}"
  case "$BACKEND" in
    r2)
      local args=(copyto "$src" ":s3:${R2_BUCKET}/${name}")
      [ -n "$cc" ] && args+=(--header-upload "Cache-Control: $cc")
      rclone "${args[@]}" --progress ;;
    ssh)
      rsync -avP "$src" "$PUBLISH_HOST:$PUBLISH_PATH" ;;
  esac
}

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

# **yml 里列的每一个文件都必须在本地**，不分类型。
#
# ⚠️ 这里原来只查 .zip，理由写在注释里：「dmg 也在 files 里，但 updater
# 只挑 zip，不影响」。那句话在**只有自动更新、没有下载页**的时候是对的。
# 有了官网之后，下载页的主按钮就是从这份 yml 里挑 dmg —— 于是 0.3.0 发布后
# 两个 dmg 从没上传过、线上 404，而发布脚本一路绿灯。
# 教训：**判据不要按用途做类型白名单**，用途会变而白名单不会跟着变。
# yml 广播了什么，就必须传什么、验什么。
FILES=()
while read -r u; do
  [ -f "dist/$u" ] || { echo "yml 列了 $u 但 dist/ 里没有" >&2; exit 1; }
  FILES+=("$u")
done < <(awk '/^  - url: /{print $3}' "$YML")
[ ${#FILES[@]} -gt 0 ] || { echo "latest-mac.yml 的 files 是空的" >&2; exit 1; }

# **反方向也要查：两个架构都必须出现在 yml 的 files 里。**
# 这条是踩出来的：分两次 electron-builder 调用（先 x64 后 arm64）时，
# **后一次会把 latest-mac.yml 整个重写**，只剩它自己那个架构 ——
# 两个 zip 都好端端躺在 dist/ 里，上面那条正向检查全过，
# 而 Intel 用户拿到的 yml 里根本没有他们能用的文件。
# 只有分架构构建（比如某一架构签名失败后单独补打）才会触发，
# 一次性双架构构建不会 —— 所以更容易漏。
for z in "$ZIP_ARM" "$ZIP_X64"; do
  b=$(basename "$z")
  grep -q "url: ${b}\$" "$YML" || {
    echo "❌ $b 不在 latest-mac.yml 的 files 里 —— 那个架构的用户更新会失败" >&2
    echo "   多半是分了两次 electron-builder 调用，后一次重写了 yml。" >&2
    echo "   要么一次性 --arm64 --x64 重打，要么跑 scripts/merge-latest-mac.sh 合并。" >&2
    exit 1
  }
done

# yml 里写的版本必须和包一致，否则客户端下下来的和它以为的不是一个东西
YML_VER=$(grep -m1 '^version:' "$YML" | awk '{print $2}')
[ "$YML_VER" = "$VERSION" ] || { echo "latest-mac.yml 写的是 ${YML_VER}，包是 $VERSION —— 重新打包" >&2; exit 1; }

# **yml 里的 sha512 / size 必须和本地 zip 逐字节对得上。**
# 原来只查"文件名列了没、文件在不在"—— 于是 zip 在生成 yml 之后被替换、被截断，
# 或者 yml 来自另一轮构建，所有检查都过，最后是**客户端下载完才失败**，
# 而那时错误只出现在用户机器上。sha512 是 base64 不是 hex（electron-updater 的格式）。
b64sha512() { shasum -a 512 "$1" | awk '{print $1}' | xxd -r -p | base64; }
while read -r name; do
  case "$name" in *.zip) ;; *) continue ;; esac
  want_sha=$(awk -v n="$name" '$0 ~ "url: "n"$"{f=1} f&&/sha512:/{print $2; exit}' "$YML")
  want_size=$(awk -v n="$name" '$0 ~ "url: "n"$"{f=1} f&&/size:/{print $2; exit}' "$YML")
  got_sha=$(b64sha512 "dist/$name")
  got_size=$(stat -f '%z' "dist/$name" 2>/dev/null || stat -c '%s' "dist/$name")
  [ "$want_sha" = "$got_sha" ] || { echo "❌ $name 的 sha512 和 yml 对不上（yml 与包不是同一轮构建？）" >&2; exit 1; }
  [ "$want_size" = "$got_size" ] || { echo "❌ $name 的 size 和 yml 对不上：yml=${want_size} 实际=${got_size}" >&2; exit 1; }
  echo "   $name sha512/size ✅"
done < <(awk '/^  - url: /{print $3}' "$YML")

# ── 2. 签名与公证 ──
# **未签名的包发出去等于发一个装不上的东西**：Squirrel 要求候选包满足
# 当前 app 签名导出的 designated requirement，签名不对客户端会静默失败。
# 两个架构分别验：x64 那份在本机跑不起来，签名却照样要对，
# 而 x64 用户装到坏包时你这边什么都看不到。
# **缺一即失败**，不能 continue：原来任一目录不存在就跳过，
# 于是两个 zip 照传，只是其中一个从没被验过签名 —— 而"没验"在日志里
# 和"验过了"长得一模一样。
UNNOTARIZED=""
for APP in dist/mac-arm64/Termspace.app dist/mac/Termspace.app; do
  [ -d "$APP" ] || { echo "❌ 缺 $APP —— 两个架构都要验签名。先跑 npm run dist:signed" >&2; exit 1; }
  codesign --verify --deep --strict "$APP" || { echo "$APP 签名校验没过，别发" >&2; exit 1; }
  # **判据用 stapler，不用 spctl。** 两个原因：
  #  ① `spctl --assess` **不加 `--verbose` 时只打印 `path: accepted`** ——
  #     `source=Notarized Developer ID` 那行根本不出现，于是这个 grep **每次都误报**。
  #     比漏检更糟：它训练操作者对着一个吓人的警告按 y，闸门等于没有。
  #  ② 就算加了 --verbose，`spctl` 允许**在线**查询票据 —— 而用户下载时可能离线。
  #     `stapler validate` 验的是票据有没有真钉进包里，那才是分发要的东西。
  xcrun stapler validate "$APP" >/dev/null 2>&1 || UNNOTARIZED="$UNNOTARIZED $APP"
done
if [ -n "$UNNOTARIZED" ]; then
  echo "⚠️  这些包**没过公证**：$UNNOTARIZED" >&2
  echo "   自己用没问题，但别人下载会被 Gatekeeper 拦。" >&2
  read -r -p "确定要发吗？[y/N] " ok
  [ "$ok" = "y" ] || exit 1
fi

# ── 3. 上传 ──
# **不许把 feed 退回旧版本**。zip 文件名带版本号所以互不覆盖，但
# `latest-mac.yml` 是共享可变对象：两个发布进程并发时，旧版本那个若更晚完成，
# 就把线上 feed 从新版退回旧版 —— 而两边的"线上 yml == 本地"验收都能通过。
# 这里读一次线上版本做单调性检查；确实要降级（撤回一个坏版本）时用
# ALLOW_DOWNGRADE=1 显式声明。
ONLINE_VER=$(curl -sS -m 15 "${PUBLISH_URL}latest-mac.yml" 2>/dev/null | awk '/^version:/{print $2; exit}' || true)
if [ -n "$ONLINE_VER" ] && [ "$ONLINE_VER" != "$VERSION" ]; then
  # 用 sort -V 比版本；线上更高就是降级
  newest=$(printf '%s\n%s\n' "$ONLINE_VER" "$VERSION" | sort -V | tail -1)
  if [ "$newest" = "$ONLINE_VER" ]; then
    echo "❌ 线上已经是 ${ONLINE_VER}，你要发的是 ${VERSION} —— 这会把所有客户端退回旧版" >&2
    [ "${ALLOW_DOWNGRADE:-}" = "1" ] || { echo "   确实要降级请加 ALLOW_DOWNGRADE=1" >&2; exit 1; }
    echo "   ALLOW_DOWNGRADE=1，继续。" >&2
  fi
fi

# **先传 zip 再传 yml**：反过来的话，客户端在这两次传输之间检查更新，
# 会读到新版本的 yml 却下载到一个还不存在的 zip。
echo "→ 上传（先产物后 yml，共 ${#FILES[@]} 个）"
for b in "${FILES[@]}"; do
  # 文件名带版本号，内容永不改变 → 可以长缓存
  put "dist/$b" "$b" "public, max-age=31536000, immutable"
  [ -f "dist/${b}.blockmap" ] && put "dist/${b}.blockmap" "${b}.blockmap" "public, max-age=31536000, immutable"
done
# **yml 绝不能被缓存**：它是"有没有新版本"的唯一判据。缓存住了你发了新版
# 客户端也发现不了，而你自己那台机很可能命中另一个边缘节点、显示一切正常。
# Cloudflare 那条 Bypass cache 规则是第二道；对象自带的头是第一道，
# 换 CDN、直连 R2 端点时也照样成立。
put "$YML" "latest-mac.yml" "no-store, max-age=0"

# ── 4. 验收 ──
# 传上去不等于取得到：桶的公开访问、自定义域、CDN 规则、MIME 类型都可能挡住。
echo "→ 验收 $PUBLISH_URL"

TMP_YML=$(mktemp); TMP_HDR=$(mktemp)
trap 'rm -f "$TMP_YML" "$TMP_HDR"' EXIT
code=$(curl -sS -D "$TMP_HDR" -o "$TMP_YML" -w '%{http_code}' "${PUBLISH_URL}latest-mac.yml")
[ "$code" = "200" ] || { echo "取不到 latest-mac.yml（HTTP ${code}）" >&2; exit 1; }
diff -q "$YML" "$TMP_YML" >/dev/null || { echo "线上的 yml 和本地不一致" >&2; exit 1; }

# yml 到底有没有被缓存住 —— 这是本脚本最该验的一件事。
# 缓存住的症状是"发了新版没人收到"，而发布者自己往往命中另一个边缘节点、
# 看到的一切正常，所以必须在发布时当场验，不能等用户报。
# **这里必须硬失败**。原来只 echo 警告，然后无条件打印"✅ 已发布" ——
# 注释写着"最该验的一件事"，代码却让它通过，正是"写了验收但不生效"。
# 确实需要放行时用 ALLOW_CACHED_YML=1 显式豁免。
CACHE_BAD=""
if grep -qiE '^cache-control:.*(no-store|no-cache|max-age=0)' "$TMP_HDR"; then
  echo "   yml Cache-Control ✅"
else
  echo "❌ yml 的 Cache-Control 不是 no-store：$(grep -i '^cache-control:' "$TMP_HDR" || echo '（没有这个头）')" >&2
  echo "   检查 Cloudflare 的 Bypass cache 规则，以及对象上传时的 --header-upload" >&2
  CACHE_BAD=1
fi
CFC=$(grep -i '^cf-cache-status:' "$TMP_HDR" | tr -d '\r' || true)
if [ -n "$CFC" ]; then
  echo "   $CFC   （应为 BYPASS 或 DYNAMIC，出现 HIT 就是被缓存了）"
  case "$CFC" in *[Hh][Ii][Tt]*) echo "❌ yml 被 CDN 缓存了（HIT）—— 发了新版用户收不到" >&2; CACHE_BAD=1 ;; esac
fi
if [ -n "$CACHE_BAD" ] && [ "${ALLOW_CACHED_YML:-}" != "1" ]; then
  echo "   明知故犯请加 ALLOW_CACHED_YML=1 重跑" >&2
  exit 1
fi

# **yml 广播的每一个文件都要真取得到** —— 传上去 ≠ 取得到（桶权限、自定义域、
# CDN 规则都可能挡），而漏验哪一个，用哪一个的人就是唯一的发现者：
# 漏验 x64 的 zip → Intel 用户更新永远失败；漏验 dmg → 官网下载按钮是死链。
# 000 是 curl 自己没连上（超时/DNS），不是服务器的答复 —— 必须重试再判，
# 否则一次网络抖动会把一次好端端的发布判成失败。
for b in "${FILES[@]}"; do
  fcode=000
  for try in 1 2 3; do
    # ⚠️ 别写 `$(curl -w '%{http_code}' ... || echo 000)`：curl 连不上时
    # **`-w` 已经打印了 `000`**，`|| echo 000` 会再追加一个 → 变量是 "000000"，
    # 于是 `[ "$fcode" != "000" ]` 成立、重试循环第一次就退出。
    # 判成功只认 200/206，其余（含空、含 000）一律继续重试。
    fcode=$(curl -sS -o /dev/null -w '%{http_code}' -r 0-1 -m 40 "${PUBLISH_URL}${b}" 2>/dev/null)
    case "$fcode" in 200|206) break ;; esac
    sleep 3
  done
  case "$fcode" in
    200|206) printf '   %-44s %s ✅\n' "$b" "$fcode" ;;
    *) echo "❌ 取不到 ${b}（HTTP ${fcode:-无响应}）—— yml 在广播一个下不到的文件" >&2; exit 1 ;;
  esac
done

echo "✅ $VERSION 已发布。客户端 6 小时内会自己发现，或在设置 → 更新里点「立即检查」。"
