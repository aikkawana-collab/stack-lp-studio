# STACK LP Studio

Codex内蔵の画像生成を使い、画像主体のランディングページをローカルで制作するWebアプリです。

画像候補の生成・選定、セクションの並べ替え、ペルソナ別プロジェクト管理、単一HTMLへの書き出しに対応しています。

## 特徴

- 利用者自身のChatGPT/Codexアカウントで画像を生成
- OpenAI APIキーの共有は不要
- 生成画像を横長3:2、1536×1024pxへ固定
- 既存画像を画風の基準として指定可能
- ペルソナごとにプロジェクトと画像を分離
- 採用画像をBase64で埋め込んだ単一HTMLを出力
- データはすべて利用者のPC内へ保存

## 必要環境

- Node.js 20以上
- Codex CLIまたはCodexアプリ
- 利用者自身のChatGPT/Codexアカウント

画像生成は各利用者の契約・利用枠で実行されます。配布者の認証情報やAPIキーは使用しません。

## セットアップ

```bash
git clone https://github.com/aikkawana-collab/stack-lp-studio.git
cd stack-lp-studio
npm run check
npm start
```

`npm run check`でNode.js、Codex CLI、ログイン状態、画像生成スキルを確認できます。

Codexへ未ログインの場合：

```bash
codex login
```

起動後、ブラウザで次を開きます。

```text
http://127.0.0.1:8765/stack-lp-studio-codex.html
```

Codexアプリを利用している場合は、アプリ内ブラウザで同じURLを開けます。

macOSでは`start.command`、Windowsでは`start.bat`からも起動できます。

## 基本操作

1. ヘッダーの3点メニューから新規プロジェクトを作成
2. 設定欄でLP名とペルソナ名を入力
3. 基準画像と画風ルールを設定
4. パートを選び「再生成」を実行
5. 候補から採用画像を選択
6. 「プロジェクト保存」で作業状態を保存
7. 「HTMLを書き出す」で完成HTMLを作成

## 保存構造

```text
projects/
└── <プロジェクトID>/
    ├── project.json
    ├── images/
    │   └── generated/
    └── exports/
```

`projects/`、`exports/`、`images/generated/`はGit管理から除外されます。利用者の制作データが誤って公開リポジトリへ入ることを防ぎます。

## 共有時の注意

- `.codex/auth.json`などの認証情報をリポジトリへ追加しないでください。
- ChatGPT/OpenAIアカウントを他人と共有しないでください。
- 同梱する画像や素材について、再配布可能な権利があることを確認してください。
- 生成結果は公開前に人間が確認してください。

## 開発

外部npmパッケージは使用していません。

```bash
node --check server.mjs
npm run check
```

詳しい設計・運用方針は[stack-lp-studio-codex.md](./stack-lp-studio-codex.md)を参照してください。

## License

MIT License
