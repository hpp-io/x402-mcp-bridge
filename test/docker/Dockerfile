FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      gnome-keyring dbus-x11 libsecret-1-0 curl ca-certificates jq procps \
    && rm -rf /var/lib/apt/lists/*
# Install via the PUBLIC one-liner (tests installer + published npm package).
RUN curl -fsSL https://raw.githubusercontent.com/hpp-io/x402-tools/main/install/install.sh | bash
COPY test.sh /test.sh
RUN chmod +x /test.sh
ENTRYPOINT ["/bin/bash", "/test.sh"]
