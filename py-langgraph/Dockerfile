# Build stage
FROM python:3.11-slim AS builder

WORKDIR /app

# 安装构建依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 缓存依赖层
COPY pyproject.toml ./
RUN pip install --no-cache-dir --prefix=/install -e .

# Runtime stage
FROM python:3.11-slim

WORKDIR /app

# 从 builder 复制已安装的包
COPY --from=builder /install /usr/local

# 复制源码
COPY src/ ./src/

EXPOSE 6002

CMD ["uvicorn", "src.api.main:app", "--host", "0.0.0.0", "--port", "6002"]
