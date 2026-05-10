# 🐺 Werewolf GM Bot with Gemini AI

Discordのボイスチャンネル上で動作する、完全フルボイス進行の全自動・人狼ゲームマスターボットです。
進行のアナウンスから役職配布、夜のDM投票処理までを完全自動化。さらに、ゲーム終了後には **Google Gemini AI** が全プレイヤーの音声を解析し、その試合の「MVP」を選出・講評してくれます。

## ✨ 主な特徴 (Features)

* 🗣️ **完全フルボイス進行:** Google Cloud TTS (Neural2) を使用し、自然でミステリアスな音声でゲームを進行します。設定からGMの声（男性/女性）の切り替えも可能です。
* 🧠 **AIによるMVP解析:** 議論フェーズの音声を録音・解析し、試合終了後にGemini AIが「最も村に貢献したプレイヤー」を心理学的な観点から講評します。
* 🛡️ **堅牢なクラッシュリカバリ:** 1アクションごとに状態（State）をJSONに自動セーブ。万が一ボットがダウンしても、`/再開` コマンドで中断したフェーズから安全に復旧（さらに復旧ボーナス時間を自動追加）します。
* 👁️ **観戦者（霊界）モード:** 試合の途中から参加したユーザーでも、`/観戦` コマンドを打つだけで自動的にニックネームが変更され、霊界VCから試合を観戦できます。
* ⚙️ **GUIによるゲーム設定:** `/設定` コマンドから、各議論時間、日ごとの短縮時間、夜の行動猶予などをGUIのポップアップで直感的に変更できます（次回ゲームから適用される安全設計）。
* 🤖 **バイトBot（ワーカー）連携:** 人数が足りない場合、自動的にサブBotをVCに召喚して人数合わせを行うデバッグ専用機能を搭載しています。

## 🛠 動作環境 (Prerequisites)

* **Docker** および **Docker Compose**
* Discord Bot Token (メインGM用 ＋ アシスタント霊界用　+ ワーカー用(Max13))
* Google Cloud サービスアカウントキー (`gcp-key.json` / Cloud TTS用)
* Google Gemini API Key

## 🚀 セットアップ (Installation)

本アプリケーションは Docker を使用して簡単にデプロイできます。

### 1. リポジトリのクローン
```bash
git clone https://github.com/yourusername/werewolf-gm-bot.git
cd werewolf-gm-bot
```

### 2. 環境変数の設定
ディレクトリのルートに .env ファイルを作成し、各種キーを設定します。コード スニペット
# Discord Bot Tokens
```bash
GM_BOT_TOKEN="your_main_gm_bot_token"
GM_CLIENT_ID="your_main_gm_client_id"
ASSISTANT_BOT_TOKEN="your_assistant_bot_token"

# (任意) 人数合わせ用のサブBotトークン（カンマ区切り）
WORKER_TOKENS="token1,token2"

# API Keys
GEMINI_API_KEY="your_gemini_api_key"

# Google Cloud Project ID (TTS用)
GOOGLE_CLOUD_PROJECT="your_gcp_project_id"
GOOGLE_APPLICATION_CREDENTIALS="/app/gcp-key.json"

# デプロイ先サーバーのID（スラッシュコマンド登録用）
TEST_GUILD_ID="your_discord_server_id"
```

### 3. GCPキーの配置
   Google Cloud Consoleから発行したTTS用のサービスアカウントキーを gcp-key.json という名前でルートディレクトリに配置してください。
   
### 4. コンテナの起動
```bash
docker-compose up -d --build
```
data/ ディレクトリが自動生成され、設定やセーブデータ、音声キャッシュがホスト側に永続化されます。

### 💬 コマンド一覧 (Commands)

|コマンド|説明|備考|
| --- | --- | --- | 
|/開始|　隔離環境（カテゴリやVC）を構築し、ゲームを開始します。||
|/再開| [ゲームid]クラッシュ等で中断されたゲームを再開します。||
|/観戦|　進行中のゲームに観戦者として途中参加します。|進行中のみ可能|
|/設定|議論時間やGMの声をGUI画面で設定します。||
|/廃村| [ゲームid]指定したゲームのチャンネルとセーブデータを強制削除します。プレイヤーをロビーへ強制送還||
|/再解析| [ゲームid]終了したゲームの録音データから、MVP解析のみをやり直します。||
|/ミュート解除|【緊急用】全員のサーバーミュートを強制解除します。|バグ発生時用|

### 📁 データ永続化とキャッシュ
Docker環境下では、以下のデータが data/ ディレクトリに保存されます。

| フォルダ | 保存されるデータ | 
| --- | --- | 
|games/| 各試合のセーブデータ（JSON）|
|audio/| 議論中の録音データ|
|tts_cache/| 生成済み音声のMD5キャッシュ（APIコスト削減・高速化）|
|settings.json| グローバルなゲーム設定|

### 📜 ライセンス (License)
This project is licensed under the MIT License - see the LICENSE file for details.
