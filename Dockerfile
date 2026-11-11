FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src
COPY widget ./widget
USER node
ENV PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1
CMD ["node", "bin/papercuts.js", "serve"]
