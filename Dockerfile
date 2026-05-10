# ==========================================
# Stage 1: Build Environment
# ==========================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# パッケージ定義をコピーして依存関係をインストール
COPY package*.json ./
RUN npm install -g npm
RUN npm install

# ソースコードをコピーしてTypeScriptをコンパイル
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ==========================================
# Stage 2: Production Environment
# ==========================================
FROM node:20-bookworm-slim

WORKDIR /app

# 音声処理（@discordjs/voice, prism-media）に必要なシステムライブラリをインストール
# ※軽量化のため --no-install-recommends を付与し、キャッシュを削除
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libsodium23 && \
    rm -rf /var/lib/apt/lists/*

# 本番用のパッケージのみをインストール (dev dependencies を除外)
COPY package*.json ./
RUN npm install --omit=dev

# Stage 1 でビルドしたコンパイル済みコードをコピー
COPY --from=builder /app/dist ./dist

# Stateファイルや録音データ（OGG/TTS）を保存するディレクトリを作成
RUN mkdir -p /app/data
# 永続データ用ディレクトリの作成
RUN mkdir -p /app/data/games /app/data/audio /app/data/tts_cache

# コンテナ起動時の実行コマンド
CMD ["node", "dist/index.js"]

