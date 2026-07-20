# Publishing to a public GitHub repository

Do not publish credentials or local runtime state. The destination repository
must be empty and must not be created with an extra README or license commit.

## 1. Verify the source tree

```bash
git status --short
node scripts/check-public-release.mjs
node scripts/check-layout.mjs
git diff --check
```

Review the author identity that GitHub will display:

```bash
git log -1 --format='%an <%ae>'
```

For an existing repository history, also run a dedicated history scanner such
as gitleaks before making the GitHub repository public. A later deletion does
not remove a secret from old commits.

## 2A. Publish a prepared clean `public-main` branch

If the source checkout already contains `public-main`, verify that it has one
root commit and push it as GitHub's `main`:

```bash
git rev-list --count public-main
git remote add github https://github.com/OWNER/REPOSITORY.git
git push -u github public-main:main
```

The count must be `1`.

## 2B. Publish the existing audited history

```bash
git remote add github https://github.com/OWNER/REPOSITORY.git
git push -u github main
```

Use this only after the complete reachable history has been audited.

## 2C. Create a clean one-commit snapshot manually

Run these commands from the source repository. They create a separate temporary
repository and do not modify the source branch or its remotes.

```bash
PUBLIC_DIR="$(mktemp -d)"
git archive HEAD | tar -x -C "$PUBLIC_DIR"
git -C "$PUBLIC_DIR" init -b main
git -C "$PUBLIC_DIR" add -A
git -C "$PUBLIC_DIR" commit -m "Initial public release"
git -C "$PUBLIC_DIR" remote add origin https://github.com/OWNER/REPOSITORY.git
git -C "$PUBLIC_DIR" push -u origin main
```

The snapshot contains only files tracked by the selected commit. It excludes
the original `.git` history, ignored credentials and local state.

## 3. GitHub settings

- Enable private vulnerability reporting.
- Enable secret scanning and push protection when available.
- Protect `main` and require the `CI` workflow for pull requests.
- Do not attach runtime logs, account files or `.env` files to releases/issues.

After publishing, clone the public repository into a fresh directory and run
the README installation procedure once. This catches accidental dependencies
on ignored local files.
