# 发版

## 一次发版要做的事

```bash
# 1. 改版本号（package.json 的 version）—— 更新检查靠 semver 比大小
#    改小或不改，客户端不会认为有新版本（allowDowngrade 是 false，见 updater.ts）

# 2. 打包。四个环境变量缺一个就不会公证
export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_APPLE_KEY_ID.p8
export APPLE_API_KEY_ID=APPLE_KEY_ID
export APPLE_API_ISSUER=APPLE_ISSUER_ID
export APPLE_TEAM_ID=85V88J2F3F
npm run dist:signed

# 3. 验收三连
codesign --verify --deep --strict dist/mac-arm64/Termscape.app
spctl --assess --type execute dist/mac-arm64/Termscape.app   # 要看到 source=Notarized Developer ID
xcrun stapler validate dist/Termscape-<版本>-arm64.dmg

# 4. 传这两个文件到更新源目录（dmg 可选，给人手动下载用）
#    latest-mac.yml
#    Termscape-<版本>-arm64-mac.zip
```

**zip 是自动更新用的，dmg 是给人手动装的。** Squirrel.Mac 只认 zip，
少传它的话客户端能查到新版本但下载不下来。

`latest-mac.yml` 里有 zip 的 sha512 和文件名，两者必须同时更新 ——
只传 zip 不传 yml，客户端不知道有新版本；只传 yml 不传 zip，客户端会 404。

## 更新源

在 app 里配（设置 → 更新 → 更新源），不在打包配置里。指向一个存着上面两个文件的
**HTTPS 目录**，结尾要有斜杠。

`electron-builder.yml` 里的 `https://updates.invalid/` 是占位 ——
`.invalid` 是 RFC 6761 保留的 TLD，不能被任何人注册，所以即使漏配也不会打到别人的服务器上。

### 这条链路的信任根是发布目录本身

| | |
|---|---|
| https | 只保证"连上了填的那台服务器"，不保证那台服务器可信 |
| `latest-mac.yml` 的 sha512 | **下载完整性**，不是发布者认证 —— 控制了目录就能给恶意包算一个匹配的 |
| Squirrel.Mac 的签名校验 | 候选包必须满足**当前 app 签名导出的 designated requirement**。这是最后一道 |

所以：**发布目录的写权限要当成签名私钥一样管**。

## 公证会卡

Apple 的公证队列说慢就慢，实测排过 40 分钟还是 `In Progress`，
而 electron-builder 等不到时报的是**一条空错误**（`Failed with unexpected result:` 后面什么都没有）。

看到它先查真实状态，别去查代码：

```bash
xcrun notarytool history --key $APPLE_API_KEY --key-id $APPLE_API_KEY_ID --issuer $APPLE_API_ISSUER
xcrun notarytool wait <id> --key ... --timeout 30m
```

公证完成后 app 已经签好在 `dist/mac-arm64/`，可以手动 staple 而不必重新打包。

另一个间歇性错误：`codesign` 报 **"The timestamp service is not available"** ——
`timestamp.apple.com` 连不上（可能与全局代理有关）。重试即可，先确认恢复：

```bash
curl -o /dev/null -w '%{http_code}\n' http://timestamp.apple.com/ts01   # 302 = 正常
```

## 自用不需要公证

```bash
npm run dist:local   # 签名，跳过公证
```

quarantine 属性只有浏览器/AirDrop 下载才加，本机构建和 `scp` 传过去的包都没有，
直接 `cp -R` 到 `/Applications` 就能跑。`spctl --assess` 会报 `rejected`，那是预期的。

**但要测自动更新就得签名** —— Squirrel 会校验候选包与当前包的签名同源。

## 装到另一台机

```bash
scp dist/Termscape-<版本>-arm64-mac.zip 那台机:/tmp/
ssh 那台机 'cd /tmp && unzip -q Termscape-*.zip && rm -rf /Applications/Termscape.app && cp -R Termscape.app /Applications/'
ssh 那台机 'open -a /Applications/Termscape.app'   # 用 open，不要 launchctl asuser（要 root）
```

传大文件断了要续传，**macOS 自带的 rsync 2.6.9 不支持 `--append-verify`**，用：

```bash
HAVE=$(ssh 那台机 "stat -f %z /tmp/包.zip")
tail -c +$((HAVE+1)) 本地包.zip | ssh 那台机 "cat >> /tmp/包.zip"
# 传完一定要校验
shasum -a 512 本地包.zip; ssh 那台机 'shasum -a 512 /tmp/包.zip'
```
