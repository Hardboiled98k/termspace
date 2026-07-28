#!/bin/bash
# 从 dist/ 里**真实存在的文件**重新生成 latest-mac.yml。
#
# 什么时候需要：分了两次 electron-builder 调用（例如某个架构签名失败后单独补打），
# **后一次会把 latest-mac.yml 整个重写**，只剩它自己那个架构。
# 两个 zip 都在 dist/ 里，但 yml 里只有一个 —— 另一个架构的用户更新会失败。
#
# 为什么不手改 yml：sha512 和 size 必须和字节流严格对应，
# 手抄一位就变成"客户端下下来校验不过"，而那个错误信息毫无线索。
# 这里全部现算，并在写完后逐条复核。
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
YML=dist/latest-mac.yml

# electron-updater 只挑 zip，但 electron-builder 生成的 yml 里 dmg 也在 files。
# 保持一致：两者都列，顺序按 electron-builder 的习惯（arm64 zip / x64 zip / dmg）。
FILES=(
  "Termspace-${VERSION}-arm64-mac.zip"
  "Termspace-${VERSION}-mac.zip"
  "Termspace-${VERSION}-arm64.dmg"
  "Termspace-${VERSION}.dmg"
)

# sha512 用 **base64**，不是 hex —— electron-updater 就是这么比的，
# 给成 hex 会让每次更新都在校验那一步失败
b64sha512() { shasum -a 512 "$1" | awk '{print $1}' | xxd -r -p | base64; }

present=()
for f in "${FILES[@]}"; do [ -f "dist/$f" ] && present+=("$f"); done
[ ${#present[@]} -gt 0 ] || { echo "dist/ 里没有 $VERSION 的产物" >&2; exit 1; }

# 两个 zip 缺一不可 —— 这个脚本存在的全部理由就是补全它们
for must in "Termspace-${VERSION}-arm64-mac.zip" "Termspace-${VERSION}-mac.zip"; do
  [ -f "dist/$must" ] || { echo "缺 dist/$must —— 先把那个架构打出来" >&2; exit 1; }
done

# 临时文件建在 dist/ 里而不是系统临时目录：mv 要**同一个文件系统**才是原子替换，
# 跨盘的 mv 是"复制+删除"，中途被杀就留下半份 yml。trap 兜住失败路径的残留。
TMP=$(mktemp "dist/.latest-mac.yml.XXXXXX")
trap 'rm -f "$TMP"' EXIT
{
  echo "version: ${VERSION}"
  echo "files:"
  for f in "${present[@]}"; do
    echo "  - url: ${f}"
    echo "    sha512: $(b64sha512 "dist/$f")"
    echo "    size: $(stat -f %z "dist/$f")"
  done
  # 顶层 path 是旧版 electron-updater 的兜底；MacUpdater 走的是 files 数组。
  # 指向 arm64 zip（本机架构），不影响 Intel —— 它按 arch 从 files 里挑。
  echo "path: Termspace-${VERSION}-arm64-mac.zip"
  echo "sha512: $(b64sha512 "dist/Termspace-${VERSION}-arm64-mac.zip")"
  echo "releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'"
} > "$TMP"
mv "$TMP" "$YML"
trap - EXIT

# ── 复核：每条 sha512/size 都要和磁盘上的文件重新对一遍 ──
# 生成完就信自己是这类脚本最容易犯的错
echo "复核 ${YML}："
fail=0
while read -r name; do
  want_sha=$(awk -v n="$name" '$0 ~ "url: "n"$"{getline; sub(/.*sha512: /,""); print; exit}' "$YML")
  want_size=$(awk -v n="$name" '$0 ~ "url: "n"$"{getline; getline; sub(/.*size: /,""); print; exit}' "$YML")
  real_sha=$(b64sha512 "dist/$name"); real_size=$(stat -f %z "dist/$name")
  if [ "$want_sha" = "$real_sha" ] && [ "$want_size" = "$real_size" ]; then
    printf '  ✅ %-42s %s 字节\n' "$name" "$real_size"
  else
    printf '  ❌ %-42s 对不上\n' "$name"; fail=1
  fi
done < <(awk '/^  - url: /{print $3}' "$YML")
[ $fail -eq 0 ] || { echo "复核失败，别发" >&2; exit 1; }
echo "✅ $VERSION 的 latest-mac.yml 已重建，两个架构都在"
