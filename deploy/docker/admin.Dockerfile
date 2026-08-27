FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies

WORKDIR /build
COPY admin-app/package.json admin-app/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV NODE_ENV=production
WORKDIR /opt/oknotika/admin-app

COPY --from=dependencies --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node admin-app/package.json admin-app/package-lock.json ./
COPY --chown=node:node admin-app/migrations ./migrations
COPY --chown=node:node admin-app/scripts ./scripts
COPY --chown=node:node admin-app/src ./src
COPY --chown=node:node admin-app/templates ./templates
COPY deploy/docker/admin-entrypoint.sh /usr/local/bin/oknotika-admin-entrypoint

RUN install -d -o node -g node -m 0700 \
      /var/lib/oknotika-admin/db \
      /var/lib/oknotika-admin/uploads \
      /var/lib/oknotika-admin/previews \
      /var/lib/oknotika-admin/backups \
    && install -d -o node -g node -m 0750 \
      /var/lib/oknotika-admin/article-releases \
      /srv/oknotika/public

USER node:node
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/oknotika-admin-entrypoint"]
CMD ["node", "src/http/start.js"]
