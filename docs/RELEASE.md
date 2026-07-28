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

# 3. 验收（两个架构都要 —— x64 那份在这台机上跑不起来，签名却照样得对）
codesign --verify --deep --strict dist/mac-arm64/Termspace.app
codesign --verify --deep --strict dist/mac/Termspace.app
spctl --assess --type execute dist/mac-arm64/Termspace.app   # 要看到 source=Notarized Developer ID

# 4. **打完包必须重编译 node-pty**，否则本机 npm run dev 起不来（见下）
npm run rebuild

# 只有要把 dmg 发给人手动下载时才需要下面两步。
# electron-builder 只公证 .app，**dmg 默认没有 ticket** —— 不做这两步就直接
# stapler validate 必然报 "does not have a ticket stapled to it"。
# 自动更新走的是 zip，不受影响；publish.sh 也只发 zip + yml。
xcrun notarytool submit dist/Termspace-<版本>-arm64.dmg \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple dist/Termspace-<版本>-arm64.dmg
xcrun stapler validate dist/Termspace-<版本>-arm64.dmg

# 5. 发布（第一次要先填 ~/.termspace-publish.env，见脚本头部）
./scripts/publish.sh
```

## 双架构打包会把 node_modules 留在 x64 状态

`electron-builder --mac` 出 arm64 + x64 时，**两轮各重编译一次 node-pty，
共用同一个 `node_modules`**。x64 是后跑的，所以打完包
`node_modules/node-pty/build/Release/pty.node` 是 **x86_64** ——
在 Apple Silicon 上 `npm run dev` 会起不来终端，而报错指向的是原生模块加载失败，
跟"我刚才只是打了个包"完全联系不起来。

打完包顺手 `npm run rebuild` 就行。

顺带两个不用管的：

- 包里有 `node-pty/bin/darwin-arm64-148/node-pty.node`（**arm64**，出现在 x64 包里）。
  node-pty 的搜索路径是 `build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>`
  （见 `node_modules/node-pty/lib/utils.js`），**`bin/` 不在里面** —— 死文件，86 KB，不会被加载。
- 日志里的 `duplicate dependency references` 是 electron-builder 对 npm 依赖树的提示，
  不是错误。

`publish.sh` 会替你把这几件事做掉：产物齐不齐、yml 里的版本和包一致不一致、
签名和公证过没过、**先传 zip 再传 yml**（反过来的话客户端可能在两次传输之间
读到新版本的 yml 却下载到一个还不存在的 zip）、传完再从公开地址取一次验收。

**zip 是自动更新用的，dmg 是给人手动装的。** Squirrel.Mac 只认 zip，
少传它的话客户端能查到新版本但下载不下来。

`latest-mac.yml` 里有 zip 的 sha512 和文件名，两者必须同时更新 ——
只传 zip 不传 yml，客户端不知道有新版本；只传 yml 不传 zip，客户端会 404。

### 两个架构的 zip 都要传

`latest-mac.yml` 会把四个产物（两个 zip + 两个 dmg）全列进 `files`，
而 electron-updater 的 `MacUpdater` 是**按 `process.arch` 挑**的：
arm64 机器只认 url 里带 `arm64` 的，Intel 机器只认不带的（Rosetta 下算 arm64）。

所以少传一个架构的 zip，那个架构的用户会**读到"有新版本"、然后去下一个 404** ——
而你这边什么都看不到，因为你自己那台机的更新是好的。`publish.sh` 两个都传、
两个都验，并且会拿 yml 里列的 zip 逐个对照本地有没有。

顶层的 `path:` 字段指向最后打的那个架构（现在是 x64），这是 electron-builder
的行为，不用管 —— `MacUpdater` 走的是 `files` 数组。

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
npm run dist:local   # 签名、跳过公证、**只出 arm64**、收尾自动 npm run rebuild
```

只出 arm64 是因为自用就装在这台机上，而双架构要跑两遍签名（几千个文件各盖一次
时间戳），实测 25 分钟 → 50 分钟。发版才需要 `dist:signed` 的双架构。
末尾串了 `npm run rebuild` 是因为打包会把 `node_modules` 里的 node-pty
留在最后那一轮的架构上（见上一节）。

quarantine 属性只有浏览器/AirDrop 下载才加，本机构建和 `scp` 传过去的包都没有，
直接 `cp -R` 到 `/Applications` 就能跑。`spctl --assess` 会报 `rejected`，那是预期的。

**但要测自动更新就得签名** —— Squirrel 会校验候选包与当前包的签名同源。

## 装到另一台机

```bash
scp dist/Termspace-<版本>-arm64-mac.zip 那台机:/tmp/
ssh 那台机 'cd /tmp && unzip -q Termspace-*.zip && rm -rf /Applications/Termspace.app && cp -R Termspace.app /Applications/'
ssh 那台机 'open -a /Applications/Termspace.app'   # 用 open，不要 launchctl asuser（要 root）
```

传大文件断了要续传，**macOS 自带的 rsync 2.6.9 不支持 `--append-verify`**，用：

```bash
HAVE=$(ssh 那台机 "stat -f %z /tmp/包.zip")
tail -c +$((HAVE+1)) 本地包.zip | ssh 那台机 "cat >> /tmp/包.zip"
# 传完一定要校验
shasum -a 512 本地包.zip; ssh 那台机 'shasum -a 512 /tmp/包.zip'
```
