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
- ユーザーが「このバージョンをスキップ」を押すと、その `version` 値での通知だけが抑制される。
  さらに新しい版を出せば再度通知される。
- ネットワーク失敗時はサイレントに無視する（オフライン起動を壊さない）。
