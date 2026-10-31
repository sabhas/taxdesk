# TaxDesk developer shortcuts. Requires pnpm 10+ and just.
# Install just with: brew install just

default:
    @just --list

# Install dependencies exactly as recorded in pnpm-lock.yaml.
install:
    pnpm install --frozen-lockfile

# Remove generated node_modules folders and reinstall from the committed lockfile.
reinstall:
    rm -rf node_modules packages/*/node_modules
    pnpm install --frozen-lockfile

# Reinstall with optional native packages for all platforms (cross-OS node_modules).
reinstall-force:
    rm -rf node_modules packages/*/node_modules
    pnpm install --frozen-lockfile --force

# Intentionally regenerate pnpm-lock.yaml. Review and commit the result.
relock:
    rm -rf node_modules packages/*/node_modules pnpm-lock.yaml
    pnpm install

# Run the complete quality gate.
verify:
    pnpm verify

# Show the local platform and installed Rollup native packages.
doctor:
    @node -p "'platform=' + process.platform + ' arch=' + process.arch"
    @ls node_modules/.pnpm | grep '@rollup+rollup-' || true
