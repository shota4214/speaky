# Update channel

アプリ内バージョン通知のためのメタデータ置き場。`latest.json` を GitHub Raw 経由で
Speaky が起動時に読みに来る。

公開 URL（実コードが見ている先）:

```
https://raw.githubusercontent.com/shota4214/speaky/main/update-channel/latest.json
```

## リリース手順

1. 通常の流れで version bump + DMG ビルド + 配布先（Google Drive / iCloud 等）に DMG をアップロード
2. このディレクトリの `latest.json` を編集:
   - `version`: 新バージョン番号（例: `0.0.8`）
   - `releasedAt`: リリース日（YYYY-MM-DD）
   - `downloadUrl`: その回の配布 URL（共有リンクや直リンク）
   - `releaseNotesUrl`: 任意（GitHub Releases ページ等）
   - `summary`: 短い変更概要（通知バナーに表示される 1〜2 行）
3. `main` に PR でマージ → 既存ユーザーの次回起動時に通知が表示される

## 注意

- `latest.json` の `version` が `app.getVersion()` より新しい場合に通知が出る。
  ダウングレード方向には通知しない。
- `version` は **`数字.数字.数字`** の 3 パーツ（例: `0.0.8`）で必ず書く。
  `parseInt` で読むので `"0.0.8a"` などは末尾が無視され、`"abc"` 等は `0.0.0` 扱いに
  なり「新版なし」判定で通知が出ない事故になる。
- ユーザーが「このバージョンをスキップ」を押すと、その `version` 値での通知だけが
  永続的に抑制される（localStorage）。さらに新しい版を出せば再度通知される。
- 「あとで」はその起動セッション中だけ通知を抑える（sessionStorage）。アプリ再起動で再表示。
- 起動ごとに無条件で raw.githubusercontent.com を叩かないよう、24h スロットリング済み。
- ネットワーク失敗時はサイレントに無視する（オフライン起動を壊さない）。

## マージ前の表示確認（dev 専用）

`latest.json` の `version` を一時的に書き換えて戻すと戻し忘れリスクがあるので、
dev サーバで通知 UI を確認するための強制表示フラグを用意してある。

```bash
npm run dev    # backend と frontend を起動
# ブラウザで http://localhost:5173/?force-update-check=1 を開く
```

`import.meta.env.DEV === true` かつクエリ `?force-update-check=1` が付いている時だけ、
version 比較・スロットリング・skip / dismiss を全部バイパスして
**現在の `latest.json` の内容そのまま** で通知を表示する。
本番ビルドではこのフラグは無効。
