FROM node:22-alpine
ENV NODE_ENV=production \
    TZ=Europe/Berlin \
    PORT=8723 \
    DATA_DIR=/data
RUN apk add --no-cache tzdata && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --chown=node:node package.json server.js lib.js smtp.js alerts.js auth.js ./
COPY --chown=node:node public ./public
USER node
VOLUME /data
EXPOSE 8723
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8723/api/health || exit 1
CMD ["node", "server.js"]
