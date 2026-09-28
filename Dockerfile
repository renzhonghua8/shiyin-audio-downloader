FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production SHIYIN_PORT=3000 SHIYIN_HOST=0.0.0.0
COPY deployment/runtime/package.json deployment/runtime/package-lock.json ./
# Runtime dependencies are JavaScript-only; native build tools are not required.
RUN npm ci --legacy-peer-deps --ignore-scripts --omit=optional --no-audit --no-fund
COPY --chown=node:node deployment/prebuilt/dist ./dist
COPY --chown=node:node server.mjs ./server.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
