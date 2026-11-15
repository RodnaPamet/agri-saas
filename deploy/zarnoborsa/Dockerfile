# The ZarnoBorsa fetch container (#3081).
#
# ## Why this image exists at all, and why it is built here
#
# `dist/zarnoborsa-fetch.mjs` needs a browser, and Playwright may NOT be in
# this product's runtime image: `scripts/verify-image-deps.mjs` fails the build
# if it is, and exists because `npm prune --omit=dev` cannot remove it — `next`
# declares `@playwright/test` as an optional peerDependency, so npm resolves it
# through a production edge and marks every node `dev: false`.
#
# ## The base image carries the BROWSERS and not the PACKAGE
#
# Measured on the VM 2026-11-16, which is the only reason this file exists.
# `mcr.microsoft.com/playwright:v1.64.1-jammy` ships Chromium and its system
# libraries under `/ms-playwright`, plus npm and yarn — and NO `playwright`
# npm package anywhere. It is built to have YOUR project (with its own
# node_modules) mounted into it.
#
# So running the bundle against the bare image fails with
# `ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'`. That is a runtime
# failure inside a container which reads three times a day with nobody
# watching, and its only symptom would have been prices that never appear —
# so it is worth saying plainly that a one-off trial run is what caught it,
# not a test.
#
# ## Built locally, like `agrent-db`
#
# `image: agrent-zarnoborsa:local` with a `build:` context, exactly as the
# `db` service builds `deploy/postgres`. No GHCR publish pipeline is involved,
# which keeps a scraper's image out of the product's release path.
#
# The version is pinned to the base image's tag ON PURPOSE: Playwright's
# package and its bundled browser revision are a coupled pair, and a floating
# `playwright@latest` against a pinned base is how a driver ends up talking to
# a browser it does not know. Change both lines together.
FROM mcr.microsoft.com/playwright:v1.64.1-jammy

# `--omit=optional` keeps the install to the driver: the browsers are already
# in the base image at `/ms-playwright`, and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`
# stops the postinstall fetching a second copy into the layer.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /opt/zarnoborsa
RUN npm init -y >/dev/null \
    && npm install --omit=optional --no-fund --no-audit playwright@1.64.1 \
    && npm cache clean --force

# The bundle is MOUNTED, not copied: `app`'s entrypoint publishes it into a
# shared volume on every start, so a Watchtower update to the app refreshes
# the script without rebuilding this image. A `COPY` here would pin it to
# build time and go stale silently.
