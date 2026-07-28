# 阿里云 ECS 一键部署

这套配置可以选择部署 TypeScript、Python，或同时部署两个版本。Postgres 与 Qdrant 只在 Docker 内部网络开放，不会直接暴露到公网。

## 1. ECS 准备

- 推荐 64 位 Linux ECS，至少 2 核 CPU、4 GB 内存。
- 安装 Docker Engine 与 Docker Compose 插件，确保 `docker compose version` 可执行。
- 将本仓库上传或克隆到 ECS，并进入仓库根目录。

## 2. 配置环境变量

```bash
cp .env.ecs.example .env.ecs
vi .env.ecs
```

必须修改：

- `OPENAI_API_KEY`：模型服务密钥。
- `POSTGRES_PASSWORD`：部署 Python 版时使用由大小写字母和数字组成的长随机密码（该值会进入数据库连接 URL，应避免 `@`、`:`、`/` 等 URL 保留字符）。
- `CORS_ORIGIN`：允许访问 API 的前端完整来源，例如 `https://app.example.com`。多个来源使用英文逗号分隔，不要填写路径。

`.env.ecs` 已被 Git 忽略，不要把真实密钥提交到仓库。

## 3. 一键部署

```bash
# TypeScript 版，默认公网端口 6001
bash deploy-ecs.sh typescript

# Python 版，默认公网端口 6002
bash deploy-ecs.sh python

# 两个版本同时运行
bash deploy-ecs.sh all
```

部署结束后检查：

```bash
curl http://你的ECS公网IP:6001/api/v1/health
curl http://你的ECS公网IP:6002/api/v1/health
```

只需测试实际部署的端口。

## 4. 阿里云安全组

在 ECS 安全组入方向规则中，仅开放实际部署的 TCP 端口：

- TypeScript：`6001/TCP`
- Python：`6002/TCP`

如果接口只供固定服务器或办公网络调用，来源应限制为对应公网 IP，而不是 `0.0.0.0/0`。Postgres 的 `5432` 和 Qdrant 的 `6333/6334` 不需要加入安全组。

生产前端若通过 HTTPS 提供，浏览器会阻止它请求 HTTP API。此时应给 ECS API 配置域名与 HTTPS 反向代理（Nginx、Caddy 或阿里云负载均衡），前端再请求 `https://api.example.com/api/v1/...`。

## 5. 前端调用

```js
const apiBase = "http://你的ECS公网IP:6001/api/v1";

const response = await fetch(`${apiBase}/health`);
if (!response.ok) throw new Error(`API error: ${response.status}`);
console.log(await response.json());
```

创建会话示例：

```js
const response = await fetch(`${apiBase}/conversations`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Web conversation", mode: "chat" }),
});
```

## 6. 运维命令

```bash
# 查看容器状态
docker compose --env-file .env.ecs -f docker-compose.ecs.yml --profile typescript --profile python ps

# 查看日志
docker compose --env-file .env.ecs -f docker-compose.ecs.yml logs -f ts-agent
docker compose --env-file .env.ecs -f docker-compose.ecs.yml logs -f py-agent

# 更新代码后重新构建（选择对应版本）
git pull
bash deploy-ecs.sh typescript

# 停止容器；不会删除数据库和向量库数据卷
docker compose --env-file .env.ecs -f docker-compose.ecs.yml --profile typescript --profile python down
```
