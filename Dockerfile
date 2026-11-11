FROM node:22-alpine
# gh gives the relay the gh login of the host (mounted read-only, see docker-compose.yml).
RUN apk add --no-cache github-cli \
 && mkdir -p /data/shots && chmod 777 /data/shots
WORKDIR /app
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src
COPY widget ./widget
USER node
ENV PORT=8000 HOME=/tmp PAPERCUTS_SHOTS_DIR=/data/shots
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1
CMD ["node", "bin/papercuts.js", "serve"]
