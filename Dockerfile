# Portboard in a container (c10dev/portboard#11): the read-only views of the host's ports.
#
#   docker build -t portboard .
#   docker run -d --name portboard --network host --pid host --user "$(id -u):$(id -g)" \
#     -v portboard-data:/data portboard
#
# --network host: ss sees the host's sockets and the dashboard binds the host's loopback (:8790).
# --pid host and the same uid as the host user: ss -p and /proc name the owners of that user's ports.
# Read-only by default (PORTBOARD_CONTAINER=1): no restart, stop, expose or dev servers from in here; there is no
# systemd user manager in a container. docs/platforms.md#docker has the details and the options.
#
# No npm install: Portboard has no runtime dependencies, and Node 22.18+ runs the TypeScript in src/ directly.

FROM node:22-bookworm-slim

# ss (iproute2) is the port reader; nothing else is needed for the read-only views
RUN apt-get update \
  && apt-get install -y --no-install-recommends iproute2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json CHANGELOG.md portboard.example.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public

# HOME holds ~/.config/portboard and ~/.local/state/portboard: one volume, writable for whichever --user runs it
RUN mkdir -p /data && chmod 1777 /data
ENV HOME=/data \
  PORTBOARD_CONTAINER=1 \
  NODE_ENV=production
VOLUME /data

# the image's unprivileged user unless --user says otherwise
USER node
EXPOSE 8790
ENTRYPOINT ["node", "--max-semi-space-size=16", "bin/portboard"]
CMD ["start"]
