FROM python:3.11-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

COPY pyproject.toml ./
COPY src ./src
ARG PYPI_SOURCE_URL=https://mirrors.aliyun.com/pypi/simple/
RUN pip wheel --no-cache-dir \
    --index-url "$PYPI_SOURCE_URL" \
    --retries 5 \
    --timeout 120 \
    --wheel-dir /wheels .

FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

COPY --from=builder /wheels /wheels
COPY --from=builder /app/src ./src
RUN pip install --no-cache-dir /wheels/* \
    && rm -rf /wheels \
    && addgroup --system agent \
    && adduser --system --ingroup agent agent

USER agent
EXPOSE 6002

CMD ["uvicorn", "src.api.main:app", "--host", "0.0.0.0", "--port", "6002", "--proxy-headers", "--forwarded-allow-ips=*"]
