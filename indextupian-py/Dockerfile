FROM python:3.12-slim

# 安装系统依赖（unzip 用于解压 nezha-agent，ca-certificates 用于 HTTPS）
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装 Python 依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码
COPY app.py .
COPY index.html .

# 创建可写目录
RUN mkdir -p /app/.npm_logs /app/agent_cache /app/.tmp_dl && \
    chmod -R 777 /app/.npm_logs /app/agent_cache /app/.tmp_dl

# 环境变量默认值
ENV SERVER_PORT=4567 \
    NODE_ENV=production \
    TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1

EXPOSE 4567

# 用 gunicorn 生产环境跑
CMD ["gunicorn", "--bind", "0.0.0.0:4567", "--workers", "1", "--threads", "4", "--timeout", "120", "app:app"]
