# ==========================================
# Stage 1: Build Environment
# ==========================================
FROM node:26.1.0-trixie-slim AS builder

WORKDIR /app
# 🚨 追加：GitHubからのパッケージ取得に必要な git をインストール
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential && \
    rm -rf /var/lib/apt/lists/*

# パッケージ定義をコピーして依存関係をインストール
COPY package*.json ./
RUN npm install -g npm
RUN npm install
RUN npm audit fix || true

# ソースコードをコピーしてTypeScriptをコンパイル
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ==========================================
# Stage 2: Production Environment
# ==========================================
FROM node:26.1.0-trixie-slim

WORKDIR /app

# 音声処理（@discordjs/voice, prism-media）に必要なシステムライブラリをインストール
# ※軽量化のため --no-install-recommends を付与し、キャッシュを削除
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libsodium23 build-essential python3 pkg-config libopus-dev && \
    rm -rf /var/lib/apt/lists/*

# 本番用のパッケージのみをインストール (dev dependencies を除外) opusだけはPackageからいれようとするとエラーになるので、個別にインストール
COPY package*.json ./
RUN npm cache clean --force
RUN npm install -g npm
RUN npm install --omit=dev
RUN npm install @discordjs/opus

# Stage 1 でビルドしたコンパイル済みコードをコピー
COPY --from=builder /app/dist ./dist

# Stateファイルや録音データ（OGG/TTS）を保存するディレクトリを作成
RUN mkdir -p /app/data
# 永続データ用ディレクトリの作成
RUN mkdir -p /app/data/games /app/data/audio /app/data/tts_cache /app/logs

# コンテナ起動時の実行コマンド
CMD ["sh", "-c", "echo \"[$(date '+%Y-%m-%d %H:%M:%S')] --- Bot Starting/Restarting ---\" >> /app/logs/bot.log && node dist/index.js 2>&1 | tee -a /app/logs/bot.log"]
# デバッグ用コマンド（プロファイリング有効化）
#CMD ["node", "--cpu-prof", "--cpu-prof-dir=/app/data", "dist/index.js"]
