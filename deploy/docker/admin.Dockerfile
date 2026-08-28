FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies

WORKDIR /build
COPY admin-app/package.json admin-app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV NODE_ENV=production
WORKDIR /var/home/oknotika/admin-app

COPY --from=dependencies --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node admin-app/package.json admin-app/package-lock.json ./
COPY --chown=node:node admin-app/migrations ./migrations
COPY --chown=node:node admin-app/scripts ./scripts
COPY --chown=node:node admin-app/src ./src
COPY --chown=node:node admin-app/templates ./templates
COPY --chown=node:node public-app/style.css /var/home/oknotika/style.css
COPY --chown=node:node public-app/img/logo-oknotika.svg /var/home/oknotika/img/logo-oknotika.svg
COPY deploy/docker/admin-entrypoint.sh /usr/local/bin/oknotika-admin-entrypoint

RUN install -d -o node -g node -m 0755 /var/home/oknotika/public-app \
    && install -d -o node -g node -m 0700 \
      /var/home/oknotika/admin-app/data/db \
      /var/home/oknotika/admin-app/data/uploads \
      /var/home/oknotika/admin-app/data/previews \
      /var/home/oknotika/admin-app/data/backups \
    && install -d -o node -g node -m 0750 \
      /var/home/oknotika/admin-app/data/article-releases

USER node:node
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/oknotika-admin-entrypoint"]
CMD ["node", "src/http/start.js"]
